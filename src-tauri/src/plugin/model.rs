//! Agent 插件的数据模型（ADR-006）
//!
//! 与磁盘上 `{app_data_dir}/plugins/<id>/manifest.json` 的字段一一对应。
//!
//! ## 与 `src/plugins/`（内置模块）的关系
//!
//! 本模块属于 **Agent 插件**：运行时从磁盘装卸、经 `grants` 声明权限、
//! 贡献 Agent 画像。前端 `src/plugins/` 是编译期硬编码的**内置模块**，
//! 两者同名但互不相干——划界见 `docs/development/plugin-system.md`。
//!
//! ## 反序列化策略
//!
//! 一律**严格**：未知字段拒绝（`deny_unknown_fields` 会对插件作者不友好，
//! 故仅对关键字段做必填校验），未知 `grants` 取值直接报错而非静默忽略——
//! 权限声明必须是封闭集合，否则「未声明即不注入」的保证会被拼写错误击穿。

use serde::{Deserialize, Serialize};

/// 插件权限项（`manifest.json` 的 `grants[]`）
///
/// 取值即**宿主注入面的分组键**：运行时宿主只注入声明过的分组
/// （ADR-006 决策 4 · 能力最小化）。
///
/// ⚠️ `log` 刻意**不在**此列：日志不读不写数据、无副作用、不构成数据出口，
/// 恒定注入。把它列为可选项只会让安装确认界面多一个无需决策的噪音项。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Grant {
    /// 调用 LLM（`host.llm.complete`）
    #[serde(rename = "llm")]
    Llm,
    /// 读取书籍与章节（`host.book` 的读方法）
    #[serde(rename = "book.read")]
    BookRead,
    /// 检索世界观卡片（`host.card.search`）
    #[serde(rename = "card.search")]
    CardSearch,
    /// 写入世界观卡片（`host.card.create`）
    #[serde(rename = "card.write")]
    CardWrite,
    /// 插件私有键值存储（`host.storage`）
    #[serde(rename = "storage")]
    Storage,
}

impl Grant {
    /// 稳定字符串（与 `serde` 的 `rename` 一致，用于校验与 UI 展示）
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Llm => "llm",
            Self::BookRead => "book.read",
            Self::CardSearch => "card.search",
            Self::CardWrite => "card.write",
            Self::Storage => "storage",
        }
    }

}

/// 工具所需的最小权限
///
/// 键为 L0 工具注册表（`commands::agent::tools`）中的工具名。
///
/// **为什么这张表必须存在**：插件画像是*声明式*的——它只声明工具名，
/// 由 Rust 引擎代为执行，全程不跑插件 JS。若不把工具映射回 `grants`，
/// 插件就能绕过权限声明直接借 L0 的原子能力读写数据，
/// `grants` 对声明式插件形同虚设。加载时按此表校验，未覆盖即拒绝加载。
pub fn grant_for_tool(tool: &str) -> Option<Grant> {
    match tool {
        "read_chapter"
        | "read_chapter_summary"
        | "read_chapter_chunk"
        | "list_book_chapters"
        | "get_book_context"
        | "split_chapter" => Some(Grant::BookRead),
        "search_world_cards" => Some(Grant::CardSearch),
        "create_note_card" => Some(Grant::CardWrite),
        _ => None,
    }
}

/// 插件贡献的 Agent 画像（`manifest.json` 的 `profiles[]` 元素）
///
/// 固定为 **ability（能力）** 类型，不开放 `domain`：
/// 领域由作品类型（`book_type`）决定、是系统级概念，
/// 第三方插件不应插手「处理什么作品」的分类。
///
/// 字段与 L1 的 `AgentProfile` 对齐，但**必须带 UI 元数据**
/// （`label` / `icon` / `color` / `quick_actions`）——插件画像同样经
/// L3 `list_agent_profiles` 下发前端渲染，缺了前端无法展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProfile {
    /// 画像 id。加载时校验不与内置画像撞车，撞车即拒绝（ADR-006 follow-up）
    pub id: String,
    pub label: String,
    pub description: String,
    /// 字符串图标名，沿用现有约定（如 `pen-tool` / `search`）
    pub icon: String,
    pub color: String,
    #[serde(default)]
    pub quick_actions: Vec<String>,
    pub base_prompt: String,
    /// 引用的 L0 工具名；每个都必须被 `grants` 覆盖
    #[serde(default)]
    pub tools: Vec<String>,
    /// 最大推理轮数。默认 8，上限 20（见 [`MAX_PLUGIN_ROUNDS`]）
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
}

fn default_max_rounds() -> usize {
    8
}

/// 插件画像允许的轮数上限
///
/// 第三方声明的轮数直接影响 LLM 开销与执行时长，必须夹断——
/// 否则一个 `max_rounds: 9999` 的插件能把单次会话拖到超时。
pub const MAX_PLUGIN_ROUNDS: usize = 20;

/// 插件画像的执行超时（秒）
///
/// 刻意**不**由插件声明：`max_rounds` 已是可调旋钮，再多一个 timeout
/// 只会增加作者负担与误配风险，而宿主需要一个可预期的上界。
pub const PLUGIN_TIMEOUT_SECS: u64 = 600;

/// 插件清单（`manifest.json`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// 插件 id，**必须与所在目录名一致**（目录即命名空间）
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub author: Option<String>,
    /// 权限声明；运行时宿主只注入其中的分组
    pub grants: Vec<Grant>,
    /// 贡献的 Agent 画像
    #[serde(default)]
    pub profiles: Vec<PluginProfile>,
    /// 入口文件（相对插件目录），默认 `index.js`
    #[serde(default = "default_entry")]
    pub entry: String,
}

fn default_entry() -> String {
    "index.js".to_string()
}

/// 已安装插件的运行时状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PluginStatus {
    /// 清单与入口均通过校验
    #[serde(rename = "ok")]
    Ok,
    /// 校验失败；`error` 字段给出具体原因（仍在列表中列出，便于用户处理）
    #[serde(rename = "error")]
    Error,
}

// 序列化取值由 serde 的 `rename` 决定，不另设 `as_str()`——
// 没有消费端的方法只会变成死代码。

/// 已安装插件（供 IPC `list_plugins` 下发前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    /// 是否启用（持久化在 `enabled.json`）
    pub enabled: bool,
    pub status: PluginStatus,
    /// `status == Error` 时的原因
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 插件 id 的合法模式
///
/// **必须与前端 `src/plugins/schema.ts` 的 `ID_PATTERN`
/// （`/^[a-z0-9][a-z0-9-]{1,63}$/`）保持一致**——跨语言无法共享常量，
/// 两侧各写一份，靠 `is_valid_id` 的边界单测与文档约定对齐。
/// 新增规则时两处都要改。
pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    // `[a-z0-9]` 1 个 + `[a-z0-9-]` 1~63 个 ⇒ 总长 2~64
    if bytes.len() < 2 || bytes.len() > 64 {
        return false;
    }
    // 首字符只认小写字母或数字（连字符不可开头）
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ID 规则与前端 `ID_PATTERN` 的等价性固化。
    ///
    /// 这是跨语言双份实现的唯一约束手段：改任一侧都要同步改另一侧。
    #[test]
    fn is_valid_id_matches_frontend_pattern() {
        // 合法：含正则长度上下界（2 与 64）
        for ok in ["ab", "my-plugin", "p1", "a-b-c-1"] {
            assert!(is_valid_id(ok), "{ok} 应合法");
        }
        assert!(is_valid_id(&"a".repeat(64)), "长度 64 应合法");

        // 非法：过短 / 过长 / 大写 / 下划线 / 点 / 冒号 / 斜杠 / 以连字符开头
        for bad in [
            "a",
            "",
            "My-Plugin",
            "my_plugin",
            "my.plugin",
            "my:plugin",
            "my/plugin",
            "-abc",
            "中文插件",
        ] {
            assert!(!is_valid_id(bad), "{bad} 应非法");
        }
        assert!(!is_valid_id(&"a".repeat(65)), "长度 65 应非法");
    }

    #[test]
    fn grant_serde_round_trips_to_dotted_names() {
        for g in [
            Grant::Llm,
            Grant::BookRead,
            Grant::CardSearch,
            Grant::CardWrite,
            Grant::Storage,
        ] {
            let s = serde_json::to_string(&g).unwrap();
            assert_eq!(s, format!("\"{}\"", g.as_str()));
            let back: Grant = serde_json::from_str(&s).unwrap();
            assert_eq!(back, g);
        }
    }

    /// 未知 grant 必须**报错**，而不是被静默忽略
    ///
    /// 这是「未声明即不注入」这条保证的地基：若拼写错误被悄悄吞掉，
    /// 插件作者以为自己声明了权限、宿主却没注入（或反之），边界就失守了。
    #[test]
    fn unknown_grant_is_rejected_not_ignored() {
        // "bok.read" 是 "book.read" 的拼写错误
        let json =
            r##"{"id":"x","name":"X","version":"1.0.0","description":"d","grants":["bok.read"]}"##;
        assert!(
            serde_json::from_str::<PluginManifest>(json).is_err(),
            "拼错的 grant 应导致解析失败，而非被忽略"
        );
    }

    #[test]
    fn grant_for_tool_covers_registered_tools() {
        // L0 注册表当前的 8 个工具必须全部有归属，
        // 否则插件声明该工具时会被误判为「无权限」而拒绝加载
        let tools = [
            "read_chapter",
            "read_chapter_summary",
            "read_chapter_chunk",
            "list_book_chapters",
            "get_book_context",
            "split_chapter",
            "search_world_cards",
            "create_note_card",
        ];
        for t in tools {
            assert!(
                grant_for_tool(t).is_some(),
                "工具 {t} 缺少 grant 映射，新增工具时必须同步本表"
            );
        }
        assert_eq!(grant_for_tool("no_such_tool"), None);
    }

    #[test]
    fn plugin_profile_defaults_apply() {
        // 用 r##"…"## 而非 r#"…"# ：JSON 里的 "#fff" 含 `#`，会提前终止 raw string
        let json = r##"{
            "id": "x", "label": "X", "description": "d",
            "icon": "pen-tool", "color": "#fff", "basePrompt": "p"
        }"##;
        let p: PluginProfile = serde_json::from_str(json).unwrap();
        assert_eq!(p.max_rounds, 8);
        assert!(p.tools.is_empty());
        assert!(p.quick_actions.is_empty());
    }

    #[test]
    fn manifest_entry_defaults_to_index_js() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0",
            "description": "d", "grants": ["llm"]
        }"#;
        let m: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.entry, "index.js");
        assert!(m.profiles.is_empty());
    }
}
