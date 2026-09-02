"""Agent 包入口

MirageInk Agent Server — 基于 LangGraph 的智能写作助手。
提供记忆体系统、动态 Prompt、历史压缩和选择性工具加载，
大幅减少 Token 消耗。

调试埋点：
- AGENT_TRACE_LEVEL=DEBUG  # 查看所有调用详情
- AGENT_TRACE_LEVEL=INFO   # 仅查看关键调用（默认）
- AGENT_TRACE_LEVEL=WARN   # 仅查看异常
"""

from .config import AgentConfig, ModelTier, SkillType, config
from .memory import HistorySummarizer, MemoryRetriever, MemoryStore
from .skills import SKILL_PROMPTS, execute_skill_stream, get_dynamic_prompt
from .tools import DB_TOOLS, SKILL_TOOLS_MAP
from .tracer import Traced, end_request, start_request, trace, trace_event

# 注意：log_call 属于 tracer 内部调试工具，签名含裸 dict（类型部分未知），
# 且无外部调用方，故不纳入包级公共 API（可用 from agent.tracer import log_call）。
__all__ = [
    "DB_TOOLS",
    "SKILL_PROMPTS",
    "SKILL_TOOLS_MAP",
    "AgentConfig",
    "HistorySummarizer",
    "MemoryRetriever",
    "MemoryStore",
    "ModelTier",
    "SkillType",
    "Traced",
    "config",
    "end_request",
    "execute_skill_stream",
    "get_dynamic_prompt",
    "start_request",
    "trace",
    "trace_event",
]
