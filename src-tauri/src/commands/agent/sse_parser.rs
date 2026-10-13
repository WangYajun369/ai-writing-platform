//! SSE 流解析（从 engine.rs 抽离）
//!
//! 负责把上游 HTTP SSE 字节流解析为「正文增量 + 工具调用累积」，
//! 与引擎的 ReAct 循环、取消竞争、trace 上报解耦。
//!
//! 解析函数是**纯计算**：
//! - 不触发任何事件推送（调用方拿到 delta 列表后自行 emit）
//! - 不依赖 AppHandle / tauri
//! - 可独立单元测试

use std::collections::BTreeMap;

use serde_json::Value;

// ─── 数据结构 ──────────────────────────────────────────────────────────────

/// SSE delta 增量累积的工具调用
#[derive(Debug, Clone)]
pub(crate) struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

pub(crate) type PendingToolCalls = BTreeMap<usize, PendingToolCall>;

// ─── 行缓冲拆分 ─────────────────────────────────────────────────────────────

/// 从 buffer 中取出下一个完整行（以 `\n` 分隔），返回该行内容；
/// 无分隔符时返回 `None`，由调用方追加更多字节后再试。
pub(crate) fn next_line(buffer: &mut String) -> Option<String> {
    let pos = buffer.find('\n')?;
    let line = buffer[..pos].trim().to_string();
    buffer.replace_range(..pos + 1, "");
    Some(line)
}

// ─── 解析单行 `data:` JSON ─────────────────────────────────────────────────

/// SSE 单行解析结果
pub(crate) struct LineParse {
    /// `[DONE]` 标记：服务端流正常结束
    pub done: bool,
    /// 本次行产生的正文 delta 列表（可能多个，当前契约下单行最多一个）
    pub deltas: Vec<String>,
}

/// 解析单行 SSE `data:` JSON。
///
/// 返回：
/// - `Err(())` → 解析失败或不是 `data:` 行，调用方应跳过
/// - `Ok(LineParse { done: true })` → 收到 `[DONE]`，服务端正常结束
/// - `Ok(LineParse { done: false, deltas })` → 有正文增量（已入列）
///
/// 工具调用增量累加到 `tool_calls`；正文增量返回给调用方处理。
pub(crate) fn parse_sse_data(
    json_str: &str,
    round_content: &mut String,
    tool_calls: &mut PendingToolCalls,
    full_response: &mut String,
) -> LineParse {
    if json_str == "[DONE]" {
        return LineParse { done: true, deltas: Vec::new() };
    }

    let data: Value = match serde_json::from_str(json_str) {
        Ok(d) => d,
        Err(e) => {
            crate::app_log_error!("[Agent] SSE JSON 解析失败: {} | {}", e, json_str);
            return LineParse { done: false, deltas: Vec::new() };
        }
    };

    let choice = &data["choices"][0];
    let mut deltas = Vec::new();

    // DeepSeek 思考内容（reasoning_content）不转发（与 Python 行为一致）
    // 仅透出正文 content
    if let Some(delta) = choice["delta"]["content"].as_str() {
        if !delta.is_empty() {
            round_content.push_str(delta);
            full_response.push_str(delta);
            deltas.push(delta.to_string());
        }
    }

    if let Some(tc_arr) = choice["delta"]["tool_calls"].as_array() {
        for tc in tc_arr {
            let idx = tc["index"].as_u64().unwrap_or(0) as usize;
            let slot = tool_calls.entry(idx).or_insert_with(|| PendingToolCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
            if let Some(id) = tc["id"].as_str() {
                if slot.id.is_empty() && !id.is_empty() {
                    slot.id = id.to_string();
                }
            }
            if let Some(name) = tc["function"]["name"].as_str() {
                if slot.name.is_empty() && !name.is_empty() {
                    slot.name = name.to_string();
                }
            }
            if let Some(args) = tc["function"]["arguments"].as_str() {
                slot.arguments.push_str(args);
            }
        }
    }

    LineParse { done: false, deltas }
}

/// 流结束（EOF / 中断 / 超时）后处理缓冲区内残留的最后一行
///
/// 返回 `(done_flag, deltas)`：`done_flag` 为 `true` 表示收到了 `[DONE]`。
pub(crate) fn flush_remaining_line(
    buffer: &mut String,
    round_content: &mut String,
    tool_calls: &mut PendingToolCalls,
    full_response: &mut String,
) -> (bool, Vec<String>) {
    let remaining = buffer.trim().to_string();
    buffer.clear();
    if remaining.is_empty() {
        return (false, Vec::new());
    }
    if !remaining.starts_with("data:") {
        return (false, Vec::new());
    }
    let json_str = remaining[5..].trim().to_string();
    let result = parse_sse_data(&json_str, round_content, tool_calls, full_response);
    (result.done, result.deltas)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_line(json: &str) -> String {
        format!("data: {json}\n")
    }

    #[test]
    fn next_line_splits_on_newline() {
        let mut buf = "hello\nworld\n".to_string();
        assert_eq!(next_line(&mut buf), Some("hello".to_string()));
        assert_eq!(next_line(&mut buf), Some("world".to_string()));
        assert_eq!(next_line(&mut buf), None);
    }

    #[test]
    fn next_line_handles_trailing_no_newline() {
        let mut buf = "incomplete".to_string();
        assert_eq!(next_line(&mut buf), None);
    }

    #[test]
    fn parse_sse_done_marker() {
        let mut round = String::new();
        let mut calls = PendingToolCalls::new();
        let mut full = String::new();
        let r = parse_sse_data("[DONE]", &mut round, &mut calls, &mut full);
        assert!(r.done);
        assert!(r.deltas.is_empty());
    }

    #[test]
    fn parse_sse_extracts_content_delta() {
        let json = r#"{"choices":[{"delta":{"content":"你好"}}]}"#;
        let mut round = String::new();
        let mut calls = PendingToolCalls::new();
        let mut full = String::new();
        let r = parse_sse_data(json, &mut round, &mut calls, &mut full);
        assert!(!r.done);
        assert_eq!(r.deltas, vec!["你好"]);
        assert_eq!(round, "你好");
        assert_eq!(full, "你好");
    }

    #[test]
    fn parse_sse_accumulates_tool_call_delta() {
        // 第一次：只有 id 和 name
        let json1 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_chapter","arguments":""}}]}}]}"#;
        let mut round = String::new();
        let mut calls = PendingToolCalls::new();
        let mut full = String::new();
        parse_sse_data(json1, &mut round, &mut calls, &mut full);
        let tc = calls.get(&0).unwrap();
        assert_eq!(tc.id, "call_1");
        assert_eq!(tc.name, "read_chapter");
        assert_eq!(tc.arguments, "");

        // 第二次：追加 arguments 片段
        let json2 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"book_id\":"}}]}}]}"#;
        parse_sse_data(json2, &mut round, &mut calls, &mut full);
        let tc = calls.get(&0).unwrap();
        assert_eq!(tc.arguments, "{\"book_id\":");
    }

    #[test]
    fn parse_sse_skips_invalid_json() {
        let mut round = String::new();
        let mut calls = PendingToolCalls::new();
        let mut full = String::new();
        let r = parse_sse_data("not json", &mut round, &mut calls, &mut full);
        assert!(!r.done);
        assert!(r.deltas.is_empty());
    }

    #[test]
    fn flush_handles_residual_data_line() {
        let mut buf = "data: [DONE]".to_string(); // 未加换行
        let mut round = String::new();
        let mut calls = PendingToolCalls::new();
        let mut full = String::new();
        let (done, deltas) = flush_remaining_line(&mut buf, &mut round, &mut calls, &mut full);
        assert!(done);
        assert!(deltas.is_empty());
        assert!(buf.is_empty());
    }

    #[test]
    fn flush_handles_empty_or_non_data() {
        let mut buf = String::new();
        let mut round = String::new();
        let mut calls = PendingToolCalls::new();
        let mut full = String::new();
        let (done, _) = flush_remaining_line(&mut buf, &mut round, &mut calls, &mut full);
        assert!(!done);

        let mut buf2 = "ping".to_string();
        let (done2, _) = flush_remaining_line(&mut buf2, &mut round, &mut calls, &mut full);
        assert!(!done2);
    }

    #[test]
    fn full_roundtrip_buffer_split_and_parse() {
        // 模拟真实 SSE 块：包含两行 data，一行 [DONE]
        let mut buf = format!(
            "{}{}{}",
            data_line(r#"{"choices":[{"delta":{"content":"第一"}}]}"#),
            data_line(r#"{"choices":[{"delta":{"content":"第二"}}]}"#),
            data_line("[DONE]"),
        );

        let mut round = String::new();
        let mut calls = PendingToolCalls::new();
        let mut full = String::new();
        let mut total_deltas = Vec::new();
        let mut stream_finished = false;

        while let Some(line) = next_line(&mut buf) {
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let json = line[5..].trim().to_string();
            let r = parse_sse_data(&json, &mut round, &mut calls, &mut full);
            if r.done {
                stream_finished = true;
                break;
            }
            total_deltas.extend(r.deltas);
        }

        assert!(stream_finished);
        assert_eq!(total_deltas, vec!["第一", "第二"]);
        assert_eq!(full, "第一第二");
    }
}
