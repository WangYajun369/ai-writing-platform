//! Telemetry 事件类型定义(单一真源)
//!
//! 统一 4+1 套可观测性通道:`Sql` / `Agent` / `Io` / `Error` / `System`。
//! 调试控制台按 [`TelemetryKind`] 聚合查看,替代原 `debug-log` 单一通道。

use serde::{Deserialize, Serialize};

/// 事件类别(对应 4+1 套通道)
///
/// 序列化为小写字符串(`sql` / `agent` / `io` / `error` / `system`),
/// 前端按 `kind` 字段过滤展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryKind {
    /// SQL 审计(替代散落的 `emit_sql_log`)
    Sql,
    /// Agent 推理轨迹(写表的同时并行 emit,实时推送给前端)
    Agent,
    /// IO 通道状态变化(acquire/release)
    Io,
    /// 命令错误事件(关键路径失败时记录)
    Error,
    /// 系统事件(启动 / 关闭 / 调度 / 后台任务)
    System,
}

impl TelemetryKind {
    /// 返回稳定的小写字符串(供 SQL 持久化与前端过滤)
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sql => "sql",
            Self::Agent => "agent",
            Self::Io => "io",
            Self::Error => "error",
            Self::System => "system",
        }
    }
}

impl std::fmt::Display for TelemetryKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for TelemetryKind {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "sql" => Ok(Self::Sql),
            "agent" => Ok(Self::Agent),
            "io" => Ok(Self::Io),
            "error" => Ok(Self::Error),
            "system" => Ok(Self::System),
            _ => Err(()),
        }
    }
}

/// 单条 Telemetry 事件
///
/// 既能放入内存缓冲(供调试控制台即时回放),也能持久化到 `telemetry_events` 表。
/// `id` 在持久化后填充;`payload` 携带类型化载荷(SQL 操作/Agent 轮次/错误码等)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub kind: TelemetryKind,
    /// `info` / `warn` / `error`
    pub level: String,
    /// 显示时间(`HH:MM:SS`)
    pub timestamp: String,
    pub message: String,
    /// 来源标签(file:line 或命令名)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// 类型化载荷(不同 kind 携带不同结构)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

impl TelemetryEvent {
    pub fn new(kind: TelemetryKind, level: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: None,
            kind,
            level: level.into(),
            timestamp: chrono::Local::now().format("%H:%M:%S").to_string(),
            message: message.into(),
            source: None,
            file: None,
            file_name: None,
            line: None,
            payload: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_serializes_to_lowercase() {
        assert_eq!(
            serde_json::to_string(&TelemetryKind::Sql).unwrap(),
            "\"sql\""
        );
        assert_eq!(
            serde_json::to_string(&TelemetryKind::Agent).unwrap(),
            "\"agent\""
        );
        assert_eq!(
            serde_json::to_string(&TelemetryKind::Error).unwrap(),
            "\"error\""
        );
    }

    #[test]
    fn kind_from_str_round_trips() {
        for k in [
            TelemetryKind::Sql,
            TelemetryKind::Agent,
            TelemetryKind::Io,
            TelemetryKind::Error,
            TelemetryKind::System,
        ] {
            let s = k.as_str();
            let back: TelemetryKind = s.parse().unwrap();
            assert_eq!(back, k);
        }
        assert!("unknown".parse::<TelemetryKind>().is_err());
    }

    #[test]
    fn event_serializes_with_camel_case() {
        let e = TelemetryEvent::new(TelemetryKind::Sql, "info", "test");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "sql");
        assert_eq!(v["level"], "info");
        assert_eq!(v["message"], "test");
        // id/payload/source 等可选字段在 None 时跳过
        assert!(v.get("id").is_none());
        assert!(v.get("payload").is_none());
    }
}
