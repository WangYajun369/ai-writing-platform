"""Agent 包入口

MirageInk Agent Server — 基于 LangGraph 的智能写作助手。
提供记忆体系统、动态 Prompt、历史压缩和选择性工具加载，
大幅减少 Token 消耗。

调试埋点：
- AGENT_TRACE_LEVEL=DEBUG  # 查看所有调用详情
- AGENT_TRACE_LEVEL=INFO   # 仅查看关键调用（默认）
- AGENT_TRACE_LEVEL=WARN   # 仅查看异常
"""

from .config import config, AgentConfig, SkillType, ModelTier
from .skills import execute_skill_stream, SKILL_PROMPTS, get_dynamic_prompt
from .tools import DB_TOOLS, SKILL_TOOLS_MAP
from .memory import MemoryStore, MemoryRetriever, HistorySummarizer
from .tracer import trace, Traced, log_call, start_request, end_request, trace_event
