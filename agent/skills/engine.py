"""Agent 执行引擎：LangGraph 驱动的 Skill 编排

每个 Skill 封装为独立的 Agent，拥有自己的 Tool 集和 System Prompt。

优化特性：
- 记忆体集成：检索相关记忆注入 Prompt，执行后自动提取保存
- 历史压缩：前端传入摘要时跳过 Agent 侧压缩（统一压缩策略）
- 选择性工具：按 Skill 类型加载专属工具集，减少 Agent 决策空间
- 动态 Prompt：根据用户意图注入场景提示
- DeepSeek 思考模式适配：无工具调用时剥离 reasoning_content 以节省 token
- KV Cache 友好：保持 System Prompt 前缀稳定，最大化缓存命中

调试：
- AGENT_TRACE_LEVEL=DEBUG 查看 Agent 每一步推理细节
"""

import logging
from typing import AsyncIterator
from datetime import datetime

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from langgraph.checkpoint.memory import MemorySaver as LangGraphMemorySaver

from ..config import config, SkillType
from ..models import get_model_for_skill
from ..tools import DB_TOOLS, SKILL_TOOLS_MAP
from ..memory import MemoryStore, MemoryRetriever, HistorySummarizer
from ..tracer import trace, trace_event, start_request, end_request
from .prompts import SKILL_PROMPTS, get_dynamic_prompt, estimate_prompt_tokens

logger = logging.getLogger(__name__)

# 共享内存（同一进程中 Agent 状态持久化）
_memory = LangGraphMemorySaver()

# 记忆体组件（懒加载单例）
_memory_store: MemoryStore | None = None
_memory_retriever: MemoryRetriever | None = None


def _get_memory_store() -> MemoryStore:
    global _memory_store
    if _memory_store is None:
        _memory_store = MemoryStore()
    return _memory_store


def _get_memory_retriever() -> MemoryRetriever:
    global _memory_retriever
    if _memory_retriever is None:
        _memory_retriever = MemoryRetriever(_get_memory_store())
    return _memory_retriever


def _get_tools_for_skill(skill: SkillType) -> list:
    """获取 Skill 专属工具集"""
    tools = SKILL_TOOLS_MAP.get(skill, DB_TOOLS)
    trace_event(
        "TOOLS_SELECT",
        f"Skill={skill.value} → {len(tools)}/{len(DB_TOOLS)} 工具: "
        f"{[t.name for t in tools]}",
        logging.DEBUG,
    )
    return tools


def _clean_history_for_context(history: list[dict]) -> list[dict]:
    """清理历史消息，遵循 DeepSeek 多轮对话最佳实践。

    参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
    参考：https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat

    规则：
    - 无工具调用时：DeepSeek 会自动忽略上一轮的 reasoning_content，
      但为节省 token 和避免潜在问题，我们主动剥离 reasoning_content 和 tool_calls 字段
    - 有工具调用时：LangGraph 的 checkpointer 会在 Agent 内部自行管理消息状态，
      我们不需要在传入的历史消息中保留这些字段
    - 仅保留 role 和 content 两个核心字段
    """
    cleaned = []
    for msg in history:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        cleaned.append({"role": role, "content": content})
    return cleaned


@trace(log_args=False, log_result=False, log_time=True)
async def _build_agent(skill: SkillType, book_id: str, user_message: str, ai_config: dict | None = None, conversation_summary: str | None = None):
    """构建 LangGraph ReAct Agent"""
    from langgraph.prebuilt import create_react_agent

    model = get_model_for_skill(skill, ai_config=ai_config)

    # 1. 动态 Prompt
    system_prompt = get_dynamic_prompt(skill, user_message)
    trace_event(
        "PROMPT_BUILD",
        f"基础 Prompt: {len(system_prompt)} chars",
        logging.DEBUG,
    )

    # 2. 记忆体检索
    memory_prompt = _get_memory_retriever().get_memory_prompt(
        book_id=book_id,
        skill_type=skill,
        user_message=user_message,
        max_tokens=config.memory_max_tokens,
    )
    if memory_prompt:
        trace_event(
            "MEMORY_INJECT",
            f"注入记忆 Prompt: {len(memory_prompt)} chars",
        )

    # 3. 组装 System Prompt（含前端对话摘要）
    # KV Cache 优化：保持 System Prompt 前缀结构稳定，有助于 DeepSeek 缓存命中
    # 参考：https://api-docs.deepseek.com/zh-cn/guides/kv_cache
    summary_section = ""
    if conversation_summary:
        summary_section = f"\n## 历史对话摘要\n{conversation_summary}\n"

    full_system = f"""{system_prompt}
:{memory_prompt}
{summary_section}当前书籍 ID: {book_id}
当前时间: {datetime.now().strftime('%Y年%m月%d日 %H:%M')}

重要提示：
- 使用工具读取数据时，务必传入正确的 book_id
- 优先使用 read_chapter_summary 了解概况，只在需要细节时才用完整读取
- 大章节（超过 2000 字）请使用 read_chapter_chunk 分段读取
- 生成内容保持与原著风格一致
"""

    # 4. 选择性工具
    tools = _get_tools_for_skill(skill)

    # 5. 估算 Token
    prompt_tokens = estimate_prompt_tokens(full_system)
    trace_event(
        "PROMPT_READY",
        f"System Prompt: {len(full_system)} chars, ~{prompt_tokens} tokens",
    )

    agent = create_react_agent(
        model=model,
        tools=tools,
        checkpointer=_memory,
    )
    return agent, full_system


async def execute_skill_stream(
    skill: SkillType,
    book_id: str,
    user_message: str,
    conversation_history: list[dict] | None = None,
    ai_config: dict | None = None,
    conversation_summary: str | None = None,
) -> AsyncIterator[str]:
    """流式执行 Agent Skill

    Args:
        skill: 技能类型
        book_id: 书籍 ID
        user_message: 用户消息
        conversation_history: 历史对话 [{role, content}, ...]
        ai_config: AI 模型配置 {provider, endpoint, model, api_key, temperature?, max_tokens?, thinking_enabled?}
        conversation_summary: 前端已生成的对话摘要（超出窗口的旧消息压缩结果）

    Yields:
        Agent 增量输出文本（逐 token）
    """
    # 开始请求追踪
    start_request(skill=skill.value, book_id=book_id)
    trace_event(
        "EXECUTE_START",
        f"skill={skill.value} book={book_id} "
        f"msg_len={len(user_message)} history_rounds={len(conversation_history or [])//2} "
        f"has_summary={conversation_summary is not None}",
    )

    # 提前初始化，避免 _build_agent 异常后 NameError
    full_response_parts: list[str] = []

    try:
        agent, system_prompt = await _build_agent(skill, book_id, user_message, ai_config, conversation_summary)

        # 构建消息列表
        messages = [SystemMessage(content=system_prompt)]

        if conversation_history:
            # 清理历史消息：剥离 reasoning_content 和 tool_calls，遵循 DeepSeek 最佳实践
            # 参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
            # 无工具调用时 DeepSeek 会自动忽略 reasoning_content，主动剥离可节省 token
            cleaned_history = _clean_history_for_context(conversation_history)
            history_total_chars = 0
            for msg in cleaned_history[-10:]:
                role = msg.get("role", "user")
                content = msg.get("content", "")
                history_total_chars += len(content)
                if len(content) > 2000:
                    content = content[:2000] + "\n... [内容过长，已截断]"
                if role == "user":
                    messages.append(HumanMessage(content=content))
                elif role == "assistant":
                    messages.append(AIMessage(content=content))
            trace_event(
                "HISTORY_LOAD",
                f"加载 {len(cleaned_history)} 条历史消息 "
                f"(总 {history_total_chars} chars, reasoning_content 已剥离)",
                logging.DEBUG,
            )

        messages.append(HumanMessage(content=user_message))

        # 历史压缩：前端已传入摘要时跳过 Agent 侧压缩
        if conversation_summary:
            trace_event("COMPRESS_SKIPPED", "前端已提供摘要，跳过 Agent 侧压缩", logging.DEBUG)
            compressed_messages = messages
        elif config.enable_history_compression:
            try:
                summary = await HistorySummarizer.summarize(messages)
                compressed_messages = HistorySummarizer.compress_messages(
                    messages=messages,
                    summary=summary,
                )
            except Exception as e:
                trace_event(
                    "COMPRESS_FALLBACK",
                    f"压缩失败({e})，使用原始历史",
                    logging.WARNING,
                )
                compressed_messages = messages
        else:
            trace_event("COMPRESS_DISABLED", "历史压缩已禁用", logging.DEBUG)
            compressed_messages = messages

        # 配置
        agent_config = {
            "configurable": {
                "thread_id": f"{book_id}_{skill.value}",
            },
            "recursion_limit": config.max_iterations,
        }

        trace_event(
            "AGENT_START",
            f"thread_id={book_id}_{skill.value} "
            f"max_iterations={config.max_iterations} "
            f"total_messages={len(compressed_messages)}",
        )

        # 收集完整响应（已在外层初始化）
        tool_calls_count = 0
        stream_start_time = None
        first_token_time = None

        import time
        stream_start_time = time.perf_counter()

        async for event in agent.astream_events(
            {"messages": compressed_messages},
            config=agent_config,
            version="v2",
        ):
            kind = event.get("event", "")
            data = event.get("data", {})

            if kind == "on_tool_start":
                tool_calls_count += 1
                tool_name = event.get("name", "unknown")
                tool_input = data.get("input", {})
                safe_input = {
                    k: v for k, v in tool_input.items()
                    if k not in ("book_id",)
                }
                trace_event(
                    "AGENT_TOOL_START",
                    f"[#{tool_calls_count}] {tool_name}({safe_input})",
                )

            elif kind == "on_tool_end":
                tool_name = event.get("name", "unknown")
                tool_output = str(data.get("output", ""))
                trace_event(
                    "AGENT_TOOL_END",
                    f"{tool_name} → {len(tool_output)} chars",
                    logging.DEBUG,
                )

            elif kind == "on_chat_model_stream":
                chunk = data.get("chunk", {})
                if hasattr(chunk, "content") and chunk.content:
                    content = chunk.content
                    if isinstance(content, str) and content:
                        if first_token_time is None:
                            first_token_time = time.perf_counter()
                            ttft = (first_token_time - stream_start_time) * 1000
                            trace_event(
                                "AGENT_FIRST_TOKEN",
                                f"首 Token 延迟: {ttft:.0f}ms",
                            )
                        full_response_parts.append(content)
                        yield content

        # 完成统计
        elapsed = (time.perf_counter() - stream_start_time) * 1000
        total_response_len = sum(len(p) for p in full_response_parts)
        trace_event(
            "AGENT_DONE",
            f"总耗时={elapsed:.0f}ms 工具调用={tool_calls_count}次 "
            f"输出={total_response_len} chars "
            f"首Token延迟={(first_token_time - stream_start_time)*1000:.0f}ms"
            if first_token_time else f"总耗时={elapsed:.0f}ms 工具调用={tool_calls_count}次",
        )

    except Exception as e:
        trace_event(
            "AGENT_ERROR",
            f"{type(e).__name__}: {e}",
            logging.ERROR,
        )
        logger.error(f"Agent 执行异常: {e}", exc_info=True)
        yield f"\n\n[错误] Agent 执行失败: {str(e)}"

    # 异步保存记忆（不阻塞响应）
    if full_response_parts:
        full_response = "".join(full_response_parts)
        try:
            await _get_memory_store().extract_and_save(
                book_id=book_id,
                skill_type=skill.value,
                user_message=user_message,
                assistant_response=full_response,
            )
        except Exception as e:
            trace_event(
                "MEMORY_SAVE_ERROR",
                f"记忆保存失败: {e}",
                logging.WARNING,
            )

    # 结束请求追踪
    end_request()
