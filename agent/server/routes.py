"""Agent Server API 路由

调试：
- AGENT_TRACE_LEVEL=DEBUG 查看每个 HTTP 请求的详情
"""

import logging
import math
from pydantic import BaseModel, Field

from ..config import SkillType, config
from ..memory.store import MemoryType
from ..tracer import trace, trace_event, get_request_id
from .sse import create_sse_response

logger = logging.getLogger(__name__)

# ─── 请求/响应模型 ───


class SkillExecuteRequest(BaseModel):
    skill: SkillType = Field(description="技能类型")
    book_id: str = Field(description="书籍 ID")
    message: str = Field(description="用户消息/指令")
    conversation_history: list[dict] | None = Field(
        default=None, description="历史对话 [{role, content}, ...]"
    )
    ai_config: dict | None = Field(
        default=None,
        description="AI 模型配置 {provider, endpoint, model, api_key, temperature?, max_tokens?, thinking_enabled?}",
    )
    conversation_summary: str | None = Field(
        default=None,
        description="前端已生成的对话摘要（超出窗口的旧消息压缩结果）",
    )


class MemoryUpdateRequest(BaseModel):
    """更新记忆的请求体"""
    content: str | None = Field(default=None, description="记忆内容")
    keywords: str | None = Field(default=None, description="逗号分隔的关键词")
    memory_type: str | None = Field(default=None, description="记忆类型: preference / decision / lesson")


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.1.0"
    config: dict


# ─── 路由注册 ───


def register_routes(app):
    """将路由注册到 FastAPI 应用"""

    @app.get("/health")
    @trace(log_args=False, log_result=True, max_result_len=200)
    async def health_check():
        """健康检查端点"""
        try:
            from ..memory import MemoryStore
            store = MemoryStore()
            memory_count = store.get_memory_count()
        except Exception:
            memory_count = -1

        return HealthResponse(
            status="ok",
            version="0.1.0",
            config={
                "local_model": config.local_model_name,
                "cloud_model": config.cloud_model_name,
                "ollama_url": config.ollama_base_url,
                "memory_count": memory_count,
                "history_compression": config.enable_history_compression,
                "max_iterations": config.max_iterations,
            },
        )

    @app.post("/skills/execute")
    async def execute_skill(req: SkillExecuteRequest):
        """执行 Agent Skill（SSE 流式响应）

        POST /skills/execute
        Body: { skill, book_id, message, conversation_history? }
        Response: text/event-stream
        """
        has_ai_config = req.ai_config is not None
        # 兼容 camelCase（前端）和 snake_case（Python）两种格式
        api_key_raw = (req.ai_config.get("api_key") or req.ai_config.get("apiKey")) if req.ai_config else None
        has_api_key = bool(api_key_raw)
        # 脱敏：仅输出 api_key 长度和前缀
        api_key_len = len(api_key_raw) if api_key_raw else 0
        api_key_prefix = (api_key_raw[:6] + "...") if api_key_raw and len(api_key_raw) > 6 else (api_key_raw or "(空)")

        trace_event(
            "HTTP_REQUEST",
            f"POST /skills/execute skill={req.skill.value} book={req.book_id} "
            f"msg_len={len(req.message)} "
            f"history_rounds={len(req.conversation_history or [])//2} "
            f"ai_config_present={has_ai_config} api_key_len={api_key_len} api_key_prefix={api_key_prefix}",
        )
        logger.info(
            f"收到 Skill 请求: skill={req.skill.value}, book={req.book_id}, "
            f"message_len={len(req.message)}, ai_config_present={has_ai_config}, "
            f"api_key_len={api_key_len}, api_key_prefix={api_key_prefix}"
        )
        if req.ai_config:
            safe_cfg = {
                k: (f"{str(v)[:8]}..." if k in ("api_key",) and v else v)
                for k, v in req.ai_config.items()
            }
            logger.debug(f"完整 ai_config: {safe_cfg}")
        return create_sse_response(
            skill=req.skill,
            book_id=req.book_id,
            user_message=req.message,
            conversation_history=req.conversation_history,
            ai_config=req.ai_config,
            conversation_summary=req.conversation_summary,
        )

    @app.post("/skills/cancel")
    async def cancel_skill():
        """取消当前任务（预留，后续实现任务管理）"""
        trace_event("HTTP_REQUEST", "POST /skills/cancel", logging.DEBUG)
        return {"status": "cancelled"}

    # ─── 记忆管理 API ───

    def _sanitize_memory(id, book_id, skill_type, memory_type, content, keywords, relevance_score, created_at, updated_at) -> dict:
        """防御 NaN/Infinity，确保响应体为合法 JSON"""
        score = relevance_score
        if isinstance(score, float) and (math.isnan(score) or math.isinf(score)):
            score = 1.0  # NaN/Inf 降级为默认值
        return {
            "id": id,
            "book_id": book_id,
            "skill_type": skill_type,
            "memory_type": memory_type,
            "content": content,
            "keywords": keywords,
            "relevance_score": score,
            "created_at": created_at,
            "updated_at": updated_at,
        }

    @app.get("/memory/list")
    async def list_memories(book_id: str, skill_type: str | None = None):
        """列出指定书籍的记忆

        GET /memory/list?book_id=xxx&skill_type=writing
        """
        from ..memory import MemoryStore
        try:
            store = MemoryStore()
            memories = store.get_memories(
                book_id=book_id,
                skill_type=skill_type,
                limit=200,
            )
            result = {
                "memories": [
                    _sanitize_memory(
                        id=m.id,
                        book_id=m.book_id,
                        skill_type=m.skill_type,
                        memory_type=m.memory_type.value,
                        content=m.content,
                        keywords=m.keywords,
                        relevance_score=m.relevance_score,
                        created_at=m.created_at,
                        updated_at=m.updated_at,
                    )
                    for m in memories
                ],
                "total": len(memories),
            }
            trace_event(
                "HTTP_RESPONSE",
                f"GET /memory/list → {len(memories)} 条记忆",
                logging.DEBUG,
            )
            return result
        except Exception as e:
            logger.error(f"获取记忆列表异常: {e}", exc_info=True)
            return {"memories": [], "total": 0, "error": str(e)}

    @app.put("/memory/{memory_id}")
    async def update_memory(memory_id: int, req: MemoryUpdateRequest):
        """更新指定记忆

        PUT /memory/123
        Body: { "content": "新内容", "keywords": "关键词", "memory_type": "preference" }
        """
        from ..memory import MemoryStore
        store = MemoryStore()
        mem_type = None
        if req.memory_type:
            try:
                mem_type = MemoryType(req.memory_type)
            except ValueError:
                return {"error": f"无效的记忆类型: {req.memory_type}"}, 400

        store.update_memory(
            memory_id=memory_id,
            content=req.content,
            keywords=req.keywords,
            memory_type=mem_type,
        )
        return {"status": "updated", "memory_id": memory_id}

    @app.delete("/memory/clear")
    async def clear_memories(book_id: str):
        """清空指定书籍的所有记忆

        DELETE /memory/clear?book_id=xxx
        注意：此路由必须在 /memory/{memory_id} 之前定义，
        否则 FastAPI 会将 "clear" 匹配为 memory_id 导致 int 解析失败
        """
        from ..memory import MemoryStore
        store = MemoryStore()
        count = store.clear_all_memories(book_id)
        return {"status": "cleared", "deleted_count": count}

    @app.delete("/memory/{memory_id}")
    async def delete_memory(memory_id: int):
        """删除指定记忆

        DELETE /memory/123
        """
        from ..memory import MemoryStore
        store = MemoryStore()
        store.delete_memory(memory_id)
        return {"status": "deleted", "memory_id": memory_id}
