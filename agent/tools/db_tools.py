"""LangChain Tools：通过 HTTP 回调 Rust Core 获取数据库数据

Python Agent 不直接访问 SQLite，而是通过 Rust 侧暴露的 HTTP 回调接口
来读取书籍、章节、世界观卡片等数据。

优化特性：
- ToolCache：请求级 LRU 缓存，避免重复调用 Rust 后端
- 分页读取：read_chapter_chunk 支持大章节分段读取
- 摘要优先：read_chapter_summary 仅返回摘要，节省 Token
- 结果截断：search_world_cards 限制返回数量和内容长度
- 选择性加载：SKILL_TOOLS_MAP 按技能类型定制工具集

调试：
- 设置环境变量 AGENT_TRACE_LEVEL=DEBUG 查看所有工具调用详情
"""

import json
import logging
import time
import asyncio
from collections import OrderedDict
from typing import Optional

import httpx
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from ..config import config, SkillType
from ..tracer import trace, log_call, get_request_id, trace_event

logger = logging.getLogger(__name__)

# ─── 数据模型 ───


class ChapterData(BaseModel):
    id: str
    title: str
    content: str
    summary: Optional[str] = None
    volume_name: Optional[str] = None


class WorldCardData(BaseModel):
    id: str
    name: str
    category: str
    content: str
    tags: list[str] = Field(default_factory=list)


class BookContext(BaseModel):
    book_id: str
    book_name: str
    chapters: list[ChapterData] = Field(default_factory=list)
    world_cards: list[WorldCardData] = Field(default_factory=list)


# ─── HTTP 客户端 ───

_client: httpx.AsyncClient | None = None

# Bridge 重试配置
_BRIDGE_MAX_RETRIES = 3
_BRIDGE_RETRY_BACKOFF_BASE = 0.5  # 初始退避秒数


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=config.rust_callback_url,
            timeout=httpx.Timeout(30.0),
        )
    return _client


async def _reset_client():
    """重置 HTTP 客户端（在 Bridge 连接失败后重建连接池）"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _is_bridge_connection_error(error: Exception) -> bool:
    """判断是否为 Bridge Server 连接错误（而非云 API 错误）"""
    msg = str(error).lower()
    return any(kw in msg for kw in [
        "connection refused",
        "all connection attempts failed",
        "connection reset",
        "connect call failed",
        "cannot assign requested address",
        "connection aborted",
        "broken pipe",
        "eof occurred",
        "no route to host",
    ])


@trace(log_result=False)  # 不打印返回值（JSON 太大），只记录参数和耗时
async def _call_rust(endpoint: str, params: dict) -> dict:
    """通用 Rust 回调，含重试和 Bridge 专用错误诊断

    重试逻辑：
    - Bridge 连接错误（Connection Refused 等）→ 最多重试 3 次，指数退避
    - Bridge 业务错误（404、500 等）→ 不重试，直接报错
    - 其他网络错误 → 重试 1 次
    """
    rid = get_request_id()
    last_error: Exception | None = None

    for attempt in range(1, _BRIDGE_MAX_RETRIES + 1):
        try:
            resp = await _get_client().post(
                f"/agent/{endpoint}", json=params
            )
            resp.raise_for_status()
            result = resp.json()
            # Bridge Server 返回 {"data": {...}} 或 {"data": null, "error": "..."}
            if not result.get("data") and result.get("error"):
                raise httpx.HTTPError(f"Bridge 回调错误: {result['error']}")
            data = result.get("data", result)
            # 简要记录返回数据规模
            trace_event(
                "HTTP",
                f"POST /agent/{endpoint} → 200, size={len(json.dumps(data, ensure_ascii=False))} chars",
                level=logging.DEBUG,
            )
            return data

        except httpx.HTTPError as e:
            last_error = e

            # 尝试从 Bridge 响应体中提取详细错误信息
            bridge_error_detail: str | None = None
            if hasattr(e, "response") and e.response is not None:
                try:
                    body = e.response.json()
                    bridge_error_detail = body.get("error")
                except Exception:
                    pass

            if _is_bridge_connection_error(e):
                # Bridge 未就绪 → 重试
                if attempt < _BRIDGE_MAX_RETRIES:
                    backoff = _BRIDGE_RETRY_BACKOFF_BASE * (2 ** (attempt - 1))
                    trace_event(
                        "BRIDGE_RETRY",
                        f"Bridge 连接失败 (第 {attempt}/{_BRIDGE_MAX_RETRIES} 次): {e}，"
                        f"{backoff:.1f}s 后重试...",
                        logging.WARNING,
                    )
                    await _reset_client()
                    await asyncio.sleep(backoff)
                    continue
                else:
                    # 所有重试耗尽
                    trace_event(
                        "BRIDGE_FATAL",
                        f"Bridge Server ({config.rust_callback_url}) 连接失败，"
                        f"已重试 {_BRIDGE_MAX_RETRIES} 次: {e}",
                        logging.ERROR,
                    )
                    raise RuntimeError(
                        f"无法连接到本地数据桥接服务 ({config.rust_callback_url})，"
                        f"已重试 {_BRIDGE_MAX_RETRIES} 次。\n"
                        f"请检查应用是否正常启动，Bridge Server 是否监听端口。\n"
                        f"原始错误: {e}"
                    ) from e
            else:
                # Bridge 业务错误（如 404、500）→ 不重试，输出详细错误
                detail = bridge_error_detail or str(e)
                trace_event(
                    "HTTP_ERROR",
                    f"POST /agent/{endpoint} → {detail}",
                    level=logging.ERROR,
                )
                raise RuntimeError(
                    f"数据桥接服务返回错误 ({endpoint}): {detail}"
                ) from e

        except Exception as e:
            last_error = e
            # 非 HTTP 错误（如序列化失败）→ 重试 1 次
            if attempt < 2:
                trace_event(
                    "BRIDGE_RETRY",
                    f"Bridge 调用异常 (第 {attempt} 次): {type(e).__name__}: {e}",
                    logging.WARNING,
                )
                await asyncio.sleep(0.5)
                continue
            raise

    # 不应到达此处
    raise RuntimeError(
        f"Bridge 调用失败: {last_error}"
    ) from last_error


# ─── 请求级 LRU 缓存 ───

class ToolCache:
    """请求级工具结果缓存

    在单次 Agent 执行中缓存工具调用结果，避免同一数据被多次请求。
    使用 LRU 淘汰策略，最大缓存 32 条。
    """

    def __init__(self, max_size: int = 32, ttl_seconds: float = 300.0):
        self._cache: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self._max_size = max_size
        self._ttl = ttl_seconds

    def _make_key(self, endpoint: str, params: dict) -> str:
        """生成缓存键"""
        stable_params = {k: v for k, v in params.items()
                         if k not in ("timestamp", "request_id")}
        return f"{endpoint}:{json.dumps(stable_params, sort_keys=True, ensure_ascii=False)}"

    def get(self, endpoint: str, params: dict) -> Optional[str]:
        key = self._make_key(endpoint, params)
        if key in self._cache:
            ts, result = self._cache[key]
            if time.time() - ts < self._ttl:
                self._cache.move_to_end(key)
                trace_event("CACHE_HIT", f"{endpoint} → 命中缓存", logging.DEBUG)
                return result
            else:
                del self._cache[key]
        return None

    def set(self, endpoint: str, params: dict, result: str):
        key = self._make_key(endpoint, params)
        if key in self._cache:
            self._cache.move_to_end(key)
        self._cache[key] = (time.time(), result)
        trace_event("CACHE_SET", f"{endpoint} → 已缓存 (共{len(self._cache)}条)", logging.DEBUG)
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

    def clear(self):
        count = len(self._cache)
        self._cache.clear()
        if count > 0:
            trace_event("CACHE_CLEAR", f"清除 {count} 条缓存", logging.DEBUG)


def create_cache() -> ToolCache:
    return ToolCache()


# ─── Tools ───


@tool
@trace(log_args=True, log_result=True, max_result_len=200)
async def read_chapter(book_id: str, chapter_id: str) -> str:
    """读取指定章节的完整内容（含标题和摘要）

    注意：如果章节内容很长（超过 3000 字），建议先使用
    read_chapter_summary 查看摘要，再用 read_chapter_chunk 分页读取。

    Args:
        book_id: 书籍 ID
        chapter_id: 章节 ID

    Returns:
        章节内容文本，格式为 Markdown
    """
    data = await _call_rust("read_chapter", {
        "book_id": book_id,
        "chapter_id": chapter_id,
    })
    chapter = ChapterData(**data)
    parts = [f"# {chapter.title}"]
    if chapter.volume_name:
        parts.append(f"所属卷：{chapter.volume_name}")
    if chapter.summary:
        parts.append(f"\n> 摘要：{chapter.summary}")
    parts.append(f"\n{chapter.content}")
    result = "\n".join(parts)
    trace_event("TOOL", f"read_chapter → {chapter.title} ({len(chapter.content)} chars)")
    return result


@tool
@trace(log_args=True, log_result=True, max_result_len=200)
async def read_chapter_summary(book_id: str, chapter_id: str) -> str:
    """读取指定章节的摘要信息（不含正文），节省 Token

    在需要了解章节内容但不需逐字分析时优先使用此工具。

    Args:
        book_id: 书籍 ID
        chapter_id: 章节 ID

    Returns:
        章节摘要文本
    """
    data = await _call_rust("read_chapter", {
        "book_id": book_id,
        "chapter_id": chapter_id,
    })
    chapter = ChapterData(**data)
    parts = [f"## {chapter.title}"]
    if chapter.volume_name:
        parts.append(f"所属卷：{chapter.volume_name}")
    if chapter.summary:
        parts.append(f"\n摘要：{chapter.summary}")
    else:
        preview = chapter.content[:500]
        parts.append(f"\n内容预览（前500字）：{preview}...")
    result = "\n".join(parts)
    trace_event("TOOL", f"read_chapter_summary → {chapter.title}")
    return result


@tool
@trace(log_args=True, log_result=True, max_result_len=200)
async def read_chapter_chunk(
    book_id: str,
    chapter_id: str,
    chunk_index: int = 0,
    chunk_size: int = 2000,
) -> str:
    """分页读取章节内容，适用于大章节分段分析

    每次只读取指定的一段内容，大幅减少单次 Token 消耗。

    Args:
        book_id: 书籍 ID
        chapter_id: 章节 ID
        chunk_index: 分段索引，从 0 开始
        chunk_size: 每段字符数，默认 2000

    Returns:
        指定段落的文本内容，含分段位置信息
    """
    data = await _call_rust("read_chapter", {
        "book_id": book_id,
        "chapter_id": chapter_id,
    })
    chapter = ChapterData(**data)
    content = chapter.content
    total_chunks = (len(content) + chunk_size - 1) // chunk_size

    if chunk_index < 0 or chunk_index >= total_chunks:
        return json.dumps({
            "error": f"chunk_index 超出范围",
            "total_chunks": total_chunks,
            "valid_range": f"0 ~ {total_chunks - 1}",
        }, ensure_ascii=False)

    start = chunk_index * chunk_size
    end = min(start + chunk_size, len(content))
    chunk_text = content[start:end]

    parts = [
        f"# {chapter.title} (第 {chunk_index + 1}/{total_chunks} 段)",
        f"字符范围: {start + 1} ~ {end} / {len(content)}",
    ]
    if chapter.summary:
        parts.insert(0, f"> 全文摘要：{chapter.summary}")
    parts.append(f"\n{chunk_text}")

    if chunk_index < total_chunks - 1:
        parts.append(
            f"\n---\n💡 还有 {total_chunks - chunk_index - 1} 段未读取，"
            f"可使用 chunk_index={chunk_index + 1} 继续读取"
        )

    result = "\n".join(parts)
    trace_event("TOOL", f"read_chapter_chunk → {chapter.title} chunk={chunk_index + 1}/{total_chunks}")
    return result


@tool
@trace(log_args=True, log_result=True, max_result_len=200)
async def list_book_chapters(book_id: str) -> str:
    """列出指定书籍的所有章节（标题+摘要，不含正文）

    Args:
        book_id: 书籍 ID

    Returns:
        章节列表，JSON 格式
    """
    data = await _call_rust("list_chapters", {"book_id": book_id})
    chapters = [ChapterData(**c) for c in data.get("chapters", [])]
    result = json.dumps(
        [{"id": c.id, "title": c.title, "summary": c.summary, "volume": c.volume_name}
         for c in chapters],
        ensure_ascii=False,
        indent=2,
    )
    trace_event("TOOL", f"list_book_chapters → {len(chapters)} 章")
    return result


@tool
@trace(log_args=True, log_result=True, max_result_len=200)
async def search_world_cards(book_id: str, query: str) -> str:
    """搜索世界观卡片（角色、地点、设定等）

    为节省 Token，最多返回 5 条结果，每条内容截断 300 字。
    如需更多详情，请缩小搜索范围或指定更精确的关键词。

    Args:
        book_id: 书籍 ID
        query: 搜索关键词

    Returns:
        匹配的世界观卡片列表（最多 5 条）
    """
    data = await _call_rust("search_world_cards", {
        "book_id": book_id,
        "query": query,
    })
    cards = [WorldCardData(**c) for c in data.get("cards", [])]

    MAX_RESULTS = 5
    CONTENT_TRUNCATE = 300

    truncated = []
    for c in cards[:MAX_RESULTS]:
        content = c.content
        if len(content) > CONTENT_TRUNCATE:
            content = content[:CONTENT_TRUNCATE] + "..."
        truncated.append({
            "id": c.id,
            "name": c.name,
            "category": c.category,
            "content": content,
            "tags": c.tags,
        })

    result_obj = {
        "total": len(cards),
        "shown": len(truncated),
        "cards": truncated,
    }
    if len(cards) > MAX_RESULTS:
        result_obj["hint"] = (
            f"还有 {len(cards) - MAX_RESULTS} 条结果未显示，"
            f"请使用更精确的关键词缩小范围"
        )

    trace_event("TOOL", f"search_world_cards(query='{query}') → {len(cards)} total, showing {len(truncated)}")
    return json.dumps(result_obj, ensure_ascii=False, indent=2)


@tool
@trace(log_args=True, log_result=True, max_result_len=200)
async def get_book_context(book_id: str) -> str:
    """获取整本书的创作上下文（最近章节摘要+世界观概览）

    Args:
        book_id: 书籍 ID

    Returns:
        书籍上下文概览
    """
    data = await _call_rust("book_context", {"book_id": book_id})
    ctx = BookContext(**data)

    parts = [f"# 《{ctx.book_name}》创作上下文\n"]

    if ctx.chapters:
        parts.append("## 最近章节")
        for ch in ctx.chapters[-5:]:
            parts.append(f"- {ch.title}: {ch.summary or '(无摘要)'}")

    if ctx.world_cards:
        parts.append("\n## 世界观设定")
        for wc in ctx.world_cards:
            wc_content = wc.content[:200]
            if len(wc.content) > 200:
                wc_content += "..."
            parts.append(f"- [{wc.category}] {wc.name}: {wc_content}")

    trace_event("TOOL", f"get_book_context → 《{ctx.book_name}》 {len(ctx.chapters)}章, {len(ctx.world_cards)}世界观")
    return "\n".join(parts)


# ─── Tool 集合 ───

DB_TOOLS = [
    read_chapter,
    read_chapter_summary,
    read_chapter_chunk,
    list_book_chapters,
    search_world_cards,
    get_book_context,
]

SKILL_TOOLS_MAP: dict[SkillType, list] = {
    SkillType.WRITING: [
        read_chapter_summary,
        read_chapter_chunk,
        list_book_chapters,
        search_world_cards,
        get_book_context,
    ],
    SkillType.ANALYSIS: [
        read_chapter,
        read_chapter_chunk,
        list_book_chapters,
        search_world_cards,
        get_book_context,
    ],
    SkillType.RESEARCH: [
        read_chapter_summary,
        list_book_chapters,
        search_world_cards,
        get_book_context,
    ],
    SkillType.POLISH: [
        read_chapter,
        read_chapter_chunk,
        get_book_context,
    ],
}
