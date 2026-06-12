"""Agent Server 配置

所有配置项支持环境变量覆盖，方便不同环境切换。
"""

import os
from dataclasses import dataclass, field
from enum import Enum


class ModelTier(str, Enum):
    """模型层级"""
    LOCAL = "local"    # 本地模型（Ollama），处理简单任务
    CLOUD = "cloud"    # 云端 API，处理复杂任务


class SkillType(str, Enum):
    """技能类型"""
    WRITING = "writing"        # 写作辅助：大纲生成、情节建议
    ANALYSIS = "analysis"      # 内容分析：文风、连贯性、伏笔
    RESEARCH = "research"      # 研究辅助：资料检索、世界观校验
    POLISH = "polish"          # 润色优化：语法、文笔、风格


# ─── 任务复杂度 → 模型层级映射 ───
# 简单任务走本地模型（快速、免费），复杂任务走云端（强推理能力）
TASK_COMPLEXITY_MAP: dict[SkillType, ModelTier] = {
    SkillType.POLISH:    ModelTier.LOCAL,   # 润色→本地模型即可
    SkillType.WRITING:   ModelTier.CLOUD,   # 大纲/情节→需强推理
    SkillType.ANALYSIS:  ModelTier.CLOUD,   # 内容分析→需深度理解
    SkillType.RESEARCH:  ModelTier.CLOUD,   # 研究→需强检索+推理
}


@dataclass
class AgentConfig:
    """Agent Server 全局配置"""

    # ─── 服务配置 ───
    host: str = field(default_factory=lambda: os.getenv("AGENT_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.getenv("AGENT_PORT", "9877")))

    # ─── 本地模型（Ollama） ───
    ollama_base_url: str = field(
        default_factory=lambda: os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    )
    local_model_name: str = field(
        default_factory=lambda: os.getenv("LOCAL_MODEL_NAME", "qwen2.5:7b")
    )

    # ─── 云端模型（兼容 OpenAI 协议） ───
    # 注意：默认值与前端 aiSlice.ts 保持一致（DeepSeek），
    # 但 ai_config 请求级配置始终优先于全局默认值。
    # 全局默认值仅在开发/调试或 ai_config 传入但部分字段缺失时使用。
    # DeepSeek API 文档：https://api-docs.deepseek.com/zh-cn/
    cloud_api_base: str = field(
        default_factory=lambda: os.getenv("CLOUD_API_BASE", "https://api.deepseek.com")
    )
    cloud_api_key: str = field(
        default_factory=lambda: os.getenv("CLOUD_API_KEY", "")
    )
    cloud_model_name: str = field(
        default_factory=lambda: os.getenv("CLOUD_MODEL_NAME", "deepseek-chat")
    )
    # DeepSeek 思考模式默认参数
    # thinking: { type: "enabled"/"disabled" } — 默认 enabled
    # reasoning_effort: high（默认）/ max（Agent 工具调用场景推荐）
    # 参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
    cloud_thinking_enabled: bool = field(
        default_factory=lambda: os.getenv("CLOUD_THINKING_ENABLED", "true").lower() == "true"
    )
    cloud_reasoning_effort: str = field(
        default_factory=lambda: os.getenv("CLOUD_REASONING_EFFORT", "max")
    )

    # ─── Agent 配置 ───
    max_iterations: int = 15          # Agent 最大推理步数
    task_timeout_seconds: int = 300   # 单任务超时（秒）
    max_context_chars: int = 80000    # 上下文最大字符数

    # ─── Rust 回调（数据桥接） ───
    rust_callback_url: str = field(
        default_factory=lambda: os.getenv(
            "RUST_CALLBACK_URL", "http://127.0.0.1:9876"
        )
    )

    # ─── 记忆体配置（新增） ───
    memory_db_path: str = field(
        default_factory=lambda: os.getenv(
            "MEMORY_DB_PATH", "data/agent_memory.db"
        )
    )
    memory_max_tokens: int = field(
        default_factory=lambda: int(os.getenv("MEMORY_MAX_TOKENS", "600"))
    )
    # 历史压缩：保留最近 N 轮完整对话
    history_keep_recent: int = field(
        default_factory=lambda: int(os.getenv("HISTORY_KEEP_RECENT", "4"))
    )
    # 历史压缩：超过此轮数触发压缩
    history_compress_threshold: int = field(
        default_factory=lambda: int(os.getenv("HISTORY_COMPRESS_THRESHOLD", "6"))
    )
    # 是否启用历史压缩（本地模型不可用时自动降级）
    enable_history_compression: bool = field(
        default_factory=lambda: os.getenv("ENABLE_HISTORY_COMPRESSION", "true").lower() == "true"
    )


# 全局单例
config = AgentConfig()
