"""SSE 流式端点

将 LangGraph Agent 的流式输出转换为 SSE 事件流推送给 Rust 端。

调试：
- AGENT_TRACE_LEVEL=DEBUG 查看每个 SSE 事件
"""

import asyncio
import json
import logging
import time
from typing import AsyncIterator

from sse_starlette.sse import EventSourceResponse

from ..config import SkillType
from ..skills import execute_skill_stream
from ..tracer import trace_event

logger = logging.getLogger(__name__)


async def sse_event_generator(
    skill: SkillType,
    book_id: str,
    user_message: str,
    conversation_history: list[dict] | None = None,
    ai_config: dict | None = None,
    conversation_summary: str | None = None,
) -> AsyncIterator[dict]:
    """生成 SSE 事件流

    Events:
        - chunk: 文本增量
        - done: 任务完成
        - cancelled: 任务取消
        - error: 错误信息
    """
    chunk_count = 0
    start_time = time.perf_counter()

    try:
        async for chunk in execute_skill_stream(
            skill=skill,
            book_id=book_id,
            user_message=user_message,
            conversation_history=conversation_history,
            ai_config=ai_config,
            conversation_summary=conversation_summary,
        ):
            if chunk.startswith("\n\n[错误]"):
                # 错误消息不包装为 chunk
                yield {"event": "error", "data": chunk}
            else:
                chunk_count += 1
                # DEBUG 模式每 20 个 chunk 记录一次进度
                if chunk_count % 20 == 0:
                    trace_event(
                        "SSE_PROGRESS",
                        f"已推送 {chunk_count} chunks",
                        logging.DEBUG,
                    )
                yield {"event": "chunk", "data": chunk}

        elapsed = (time.perf_counter() - start_time) * 1000
        trace_event(
            "SSE_DONE",
            f"共推送 {chunk_count} chunks, 耗时 {elapsed:.0f}ms",
        )
        yield {"event": "done", "data": ""}

    except asyncio.CancelledError:
        trace_event("SSE_CANCELLED", "用户取消")
        logger.info(f"任务被取消: skill={skill.value}, book={book_id}")
        yield {"event": "cancelled", "data": "任务已被用户取消"}
    except Exception as e:
        trace_event("SSE_ERROR", f"{type(e).__name__}: {e}", logging.ERROR)
        logger.error(f"SSE 流异常: {e}", exc_info=True)
        yield {"event": "error", "data": str(e)}


def create_sse_response(
    skill: SkillType,
    book_id: str,
    user_message: str,
    conversation_history: list[dict] | None = None,
    ai_config: dict | None = None,
    conversation_summary: str | None = None,
) -> EventSourceResponse:
    """创建 SSE 响应对象"""
    trace_event(
        "SSE_CREATE",
        f"skill={skill.value} book={book_id}",
        logging.DEBUG,
    )
    return EventSourceResponse(
        sse_event_generator(
            skill=skill,
            book_id=book_id,
            user_message=user_message,
            conversation_history=conversation_history,
            ai_config=ai_config,
            conversation_summary=conversation_summary,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
