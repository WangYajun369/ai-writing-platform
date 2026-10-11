//! L2 流水线执行器（ADR-005 阶段六）
//!
//! 自由 ReAct 无法稳定复现「读章节 → 提炼要点 → 生成卡片」这类固定流程：模型可能
//! 跳过取数直接开写，也可能把三步挤在一轮里草草了事。流水线把**步骤顺序**与**每步
//! 的工具边界**固化进画像（见 [`profiles::Step`]），模型只在步内自由行动。
//!
//! ## 与 ReAct 的关系
//!
//! 每一步本质上仍是一次 ReAct——复用 [`engine::react_loop`]，只是把工具表收窄到该步
//! 声明的子集、把轮数限制为 `Step::max_rounds`，并换上本步专属指令。因此 SSE 解析、
//! 取消竞争、trace 上报三条链路完全复用，不存在第二套实现。
//!
//! ## 失败语义：部分成功，不自动重试
//!
//! 单步失败时**停下并保留已完成步骤的产物**，最终文本给出结构化进度。
//!
//! ⚠️ 刻意**不做自动重试**：`create_note_card` 这类有副作用的工具不可重入，盲重试
//! 会造成重复卡片。宁可把半成品交还用户（已完成部分一目了然），由人决定是否续跑。
//!
//! ## 文本一致性
//!
//! 步骤标题、占位说明、收尾分隔一律经 [`step_header`] / [`step_tail`] 生成，**流式
//! 推送与最终渲染共用同一批函数**，使前端累积到的文本与 IPC 返回值逐字一致。

use std::sync::Arc;

use r2d2::Pool;
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::agent::engine::{emit_event, react_loop, AgentBudget, CancelToken};
use crate::commands::agent::profiles::Step;
use crate::db::SqliteConnectionManager;

// ── 结果类型 ────────────────────────────────────────────────────────────────

/// 单个步骤的执行结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Done,
    Failed,
    Cancelled,
}

/// 单个步骤的执行结果（含产物或错误）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOutcome {
    pub name: &'static str,
    pub status: StepStatus,
    /// `Done` 时为步骤输出；`Failed` 时为错误信息；`Cancelled` 时为空
    pub output: String,
}

impl StepOutcome {
    fn done(name: &'static str, output: String) -> Self {
        Self { name, status: StepStatus::Done, output }
    }
    fn failed(name: &'static str, error: String) -> Self {
        Self { name, status: StepStatus::Failed, output: error }
    }
    fn cancelled(name: &'static str) -> Self {
        Self { name, status: StepStatus::Cancelled, output: String::new() }
    }
}

/// 流水线总结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineOutcome {
    /// 已执行到的步骤（因失败/取消而未启动的步骤不在其中）
    pub steps: Vec<StepOutcome>,
    /// 步骤总数（渲染 `x/y` 进度用）
    pub total: usize,
}

impl PipelineOutcome {
    /// 已成功完成的步骤数
    pub fn done_count(&self) -> usize {
        self.steps
            .iter()
            .filter(|s| s.status == StepStatus::Done)
            .count()
    }

    /// 是否全部步骤成功
    pub fn all_done(&self) -> bool {
        self.done_count() == self.total
    }

    /// 是否因用户取消而中止
    pub fn cancelled(&self) -> bool {
        self.steps
            .last()
            .is_some_and(|s| s.status == StepStatus::Cancelled)
    }

    /// 渲染为最终回复文本（与前端累积到的流式文本逐字一致）
    pub fn render(&self) -> String {
        let mut out = String::new();
        for (idx, s) in self.steps.iter().enumerate() {
            match s.status {
                StepStatus::Done => {
                    out.push_str(&step_header(idx, s.name));
                    out.push_str(&s.output);
                    out.push_str(&step_tail(&s.output));
                }
                StepStatus::Failed => out.push_str(&failure_line(s.name, &s.output)),
                StepStatus::Cancelled => {}
            }
        }
        if !self.all_done() && !self.cancelled() {
            out.push_str(&incomplete_tail(self.done_count(), self.total));
        }
        out
    }
}

// ── 文本片段（流式与渲染共用）──────────────────────────────────────────────

/// 步骤序号符号（①②③…），超出 ⑨ 回退阿拉伯数字
fn step_marker(idx: usize) -> String {
    const CIRCLED: [char; 9] = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
    match CIRCLED.get(idx) {
        Some(c) => c.to_string(),
        None => format!("{}.", idx + 1),
    }
}

/// 步骤标题行
fn step_header(idx: usize, name: &str) -> String {
    format!("## {} {}\n\n", step_marker(idx), name)
}

/// 步骤收尾：空输出补占位说明，再补分隔换行
///
/// 模型输出通常自带换行，故按结尾已有的换行数补足到两个，避免堆出连续空行。
fn step_tail(body: &str) -> String {
    let placeholder = if body.trim().is_empty() {
        "（本步无输出）"
    } else {
        ""
    };
    let nl = if body.ends_with("\n\n") {
        ""
    } else if body.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    format!("{placeholder}{nl}")
}

/// 单步失败的说明行（同时进流式与最终文本，不额外发 error 事件——部分成功不是错误）
fn failure_line(name: &str, error: &str) -> String {
    format!("> ⚠️ 步骤「{name}」失败：{error}\n")
}

/// 未跑完时的收尾说明
fn incomplete_tail(done: usize, total: usize) -> String {
    format!("\n---\n⚠️ 流水线未完成：{done}/{total} 步已产出，以上为已完成部分。\n")
}

/// 该步的 system prompt：公共提示 + 本步指令（不带上一步的工具往返）
fn step_system_prompt(base: &str, step: &Step) -> String {
    format!("{base}\n\n## 当前步骤\n{}\n", step.instruction)
}

/// 把已完成步骤的产物拼成下一步的输入
fn render_artifacts(artifacts: &[(&'static str, String)]) -> String {
    let mut s = String::from("## 前序步骤产物\n");
    for (name, out) in artifacts {
        s.push_str(&format!("\n### {name}\n{out}\n"));
    }
    s
}

// ── 执行器 ──────────────────────────────────────────────────────────────────

/// 流水线执行上下文：各步骤共享、不随步骤变化的部分
pub struct PipelineCtx<'a> {
    pub app: &'a AppHandle,
    pub pool: &'a Pool<SqliteConnectionManager>,
    pub url: &'a str,
    pub api_key: &'a str,
    pub model: &'a str,
    pub temperature: f64,
    pub max_tokens: u32,
    pub request_id: &'a str,
    pub cancel_token: &'a Arc<CancelToken>,
    /// 整体预算；此处只用其 `sse_read_timeout_secs`（总超时由 engine 的 timeout 守卫统一施加）
    pub budget: &'a AgentBudget,
    pub skill: &'a str,
}

/// 按 `steps` 顺序执行流水线
///
/// 每一步用**收窄的工具表**与**本步轮数上限**跑一次 ReAct，产物依次向下传递。
/// 遇到失败或取消即停，已完成步骤的产物保留在返回的 [`PipelineOutcome`] 中。
pub async fn run_pipeline(
    ctx: &PipelineCtx<'_>,
    steps: &[Step],
    system_prompt: &str,
    message: &str,
) -> PipelineOutcome {
    let mut outcomes: Vec<StepOutcome> = Vec::new();
    // 已完成步骤的产物（步骤名 → 输出），作为后续步骤的输入
    let mut artifacts: Vec<(&'static str, String)> = Vec::new();

    for (idx, step) in steps.iter().enumerate() {
        if ctx.cancel_token.is_cancelled() {
            outcomes.push(StepOutcome::cancelled(step.name));
            break;
        }

        let header = step_header(idx, step.name);
        emit_event(ctx.app, "chunk", &header, ctx.request_id);

        // 每步独立构造消息：不带入上一步的工具往返，上下文长度始终可控
        let mut messages: Vec<Value> = vec![
            serde_json::json!({
                "role": "system",
                "content": step_system_prompt(system_prompt, step),
            }),
            serde_json::json!({ "role": "user", "content": message }),
        ];
        if !artifacts.is_empty() {
            messages.push(serde_json::json!({
                "role": "user",
                "content": render_artifacts(&artifacts),
            }));
        }

        // 轮数至少 1：否则 react_loop 一次都不跑，步骤静默产出空文本
        let step_budget = AgentBudget {
            max_rounds: step.max_rounds.max(1),
            ..*ctx.budget
        };
        let mut body = String::new();
        let mut rounds = 0usize;
        let result = react_loop(
            ctx.app.clone(),
            ctx.pool.clone(),
            ctx.url,
            ctx.api_key,
            ctx.model,
            ctx.temperature,
            ctx.max_tokens,
            crate::commands::agent::tools::build_tools_schema(step.tools),
            &mut messages,
            &mut body,
            &mut rounds,
            ctx.request_id,
            ctx.cancel_token,
            &step_budget,
            ctx.skill,
        )
        .await;

        match result {
            Ok(()) if ctx.cancel_token.is_cancelled() => {
                outcomes.push(StepOutcome::cancelled(step.name));
                break;
            }
            Ok(()) => {
                crate::app_log!(
                    "[Agent] 流水线步骤 {}/{}「{}」完成：{} 轮 / {} 字",
                    idx + 1,
                    steps.len(),
                    step.name,
                    rounds,
                    body.chars().count()
                );
                let tail = step_tail(&body);
                emit_event(ctx.app, "chunk", &tail, ctx.request_id);
                artifacts.push((step.name, body.clone()));
                outcomes.push(StepOutcome::done(step.name, body));
            }
            Err(e) => {
                // 有副作用的步骤不可重入，故不重试：停在此处，保留已完成产物
                crate::app_log_error!(
                    "[Agent] 流水线步骤 {}/{}「{}」失败：{}",
                    idx + 1,
                    steps.len(),
                    step.name,
                    e
                );
                let line = failure_line(step.name, &e.to_string());
                emit_event(ctx.app, "chunk", &line, ctx.request_id);
                outcomes.push(StepOutcome::failed(step.name, e.to_string()));
                break;
            }
        }
    }

    let outcome = PipelineOutcome {
        steps: outcomes,
        total: steps.len(),
    };
    if !outcome.all_done() && !outcome.cancelled() {
        let tail = incomplete_tail(outcome.done_count(), outcome.total);
        emit_event(ctx.app, "chunk", &tail, ctx.request_id);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done(name: &'static str, out: &str) -> StepOutcome {
        StepOutcome::done(name, out.to_string())
    }

    #[test]
    fn marker_and_header() {
        assert_eq!(step_marker(0), "①");
        assert_eq!(step_marker(8), "⑨");
        assert_eq!(step_marker(9), "10.", "超出 ⑨ 应回退阿拉伯数字");
        assert_eq!(step_header(1, "提炼要点"), "## ② 提炼要点\n\n");
    }

    #[test]
    fn tail_pads_to_two_newlines() {
        // 无结尾换行 → 补两个
        assert_eq!(step_tail("正文"), "\n\n");
        // 已有一个 → 补一个
        assert_eq!(step_tail("正文\n"), "\n");
        // 已有两个 → 不补
        assert_eq!(step_tail("正文\n\n"), "");
        // 空输出 → 补占位说明
        assert_eq!(step_tail(""), "（本步无输出）\n\n");
        assert_eq!(step_tail("   \n"), "（本步无输出）\n");
    }

    #[test]
    fn render_all_done_concatenates_headers_and_bodies() {
        let outcome = PipelineOutcome {
            steps: vec![done("拆章节", "片段 A"), done("提炼要点", "要点 B\n")],
            total: 2,
        };
        assert!(outcome.all_done());
        assert!(!outcome.cancelled());
        assert_eq!(
            outcome.render(),
            "## ① 拆章节\n\n片段 A\n\n## ② 提炼要点\n\n要点 B\n\n"
        );
    }

    #[test]
    fn render_partial_keeps_completed_and_marks_progress() {
        let outcome = PipelineOutcome {
            steps: vec![
                done("拆章节", "片段 A"),
                StepOutcome::failed("生成卡片", "连接超时".to_string()),
            ],
            total: 3,
        };
        assert_eq!(outcome.done_count(), 1);
        assert!(!outcome.all_done());
        let text = outcome.render();
        // 已完成步骤的产物保留
        assert!(text.contains("片段 A"), "{text}");
        // 失败步骤有说明，且未跑的步骤不出现
        assert!(text.contains("步骤「生成卡片」失败：连接超时"), "{text}");
        assert!(!text.contains("提炼要点"), "未启动的步骤不应出现: {text}");
        // 结构化进度
        assert!(text.contains("1/3 步已产出"), "{text}");
    }

    #[test]
    fn render_cancelled_omits_incomplete_notice() {
        let outcome = PipelineOutcome {
            steps: vec![done("拆章节", "片段 A"), StepOutcome::cancelled("提炼要点")],
            total: 3,
        };
        assert!(outcome.cancelled());
        let text = outcome.render();
        assert!(text.contains("片段 A"), "{text}");
        assert!(
            !text.contains("流水线未完成"),
            "取消由 cancelled 事件表达，不必再写未完成说明: {text}"
        );
    }

    #[test]
    fn step_prompt_carries_instruction_and_base() {
        let step = Step {
            name: "拆章节",
            instruction: "先定位章节再切分",
            tools: &["split_chapter"],
            max_rounds: 4,
        };
        let prompt = step_system_prompt("公共提示", &step);
        assert!(prompt.starts_with("公共提示"), "{prompt}");
        assert!(prompt.contains("## 当前步骤"), "{prompt}");
        assert!(prompt.contains("先定位章节再切分"), "{prompt}");
    }

    #[test]
    fn artifacts_are_fed_to_next_step() {
        let artifacts: Vec<(&'static str, String)> =
            vec![("拆章节", "片段 A".to_string()), ("提炼要点", "要点 B".to_string())];
        let text = render_artifacts(&artifacts);
        assert!(text.starts_with("## 前序步骤产物"), "{text}");
        assert!(text.contains("### 拆章节\n片段 A"), "{text}");
        assert!(text.contains("### 提炼要点\n要点 B"), "{text}");
        // 空产物列表不产生该段（由调用方保证，此处仅确认不 panic）
        assert_eq!(render_artifacts(&[]), "## 前序步骤产物\n");
    }
}
