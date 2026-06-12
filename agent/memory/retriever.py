"""记忆检索器：基于关键词匹配的智能记忆检索

在用户发起请求时，从记忆库中检索相关记忆，
注入 System Prompt 以减少重复说明。

调试：
- AGENT_TRACE_LEVEL=DEBUG 查看检索评分详情
"""

import logging
from typing import Optional

from ..config import SkillType
from ..tracer import trace, trace_event
from .store import Memory, MemoryStore, MemoryType

logger = logging.getLogger(__name__)

# 记忆注入的最大 Token 估算上限（中文约 1.5 字符/Token）
DEFAULT_MAX_TOKENS = 600


class MemoryRetriever:
    """记忆检索器

    策略：
    1. 按 (book_id, skill_type) 精确匹配
    2. 用户消息关键词与记忆 keywords 交集打分
    3. 记忆类型加权（preference > decision > lesson）
    4. 相关性分 × 时间衰减 = 最终排序
    5. 限制返回 Token 数
    """

    TYPE_WEIGHT: dict[MemoryType, float] = {
        MemoryType.PREFERENCE: 1.2,
        MemoryType.DECISION: 1.0,
        MemoryType.LESSON: 0.8,
    }

    def __init__(self, store: MemoryStore | None = None):
        self._store = store or MemoryStore()

    @trace(log_args=True, log_result=True, max_result_len=300)
    def retrieve(
        self,
        book_id: str,
        skill_type: SkillType | str,
        user_message: str,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        top_k: int = 10,
    ) -> list[Memory]:
        """检索相关记忆"""
        skill_str = skill_type.value if isinstance(skill_type, SkillType) else skill_type

        candidates = self._store.get_memories(
            book_id=book_id,
            skill_type=skill_str,
            limit=50,
        )

        if not candidates:
            candidates = self._store.get_memories(
                book_id=book_id,
                limit=30,
            )

        if not candidates:
            trace_event("MEMORY_RETRIEVE", "无候选记忆")
            return []

        user_keywords = set(MemoryStore._extract_keywords(user_message, max_words=10))
        trace_event(
            "MEMORY_RETRIEVE",
            f"候选={len(candidates)} 用户关键词={user_keywords}",
            logging.DEBUG,
        )

        scored: list[tuple[float, Memory]] = []

        for mem in candidates:
            score = self._score_memory(mem, user_keywords)
            if score > 0:
                scored.append((score, mem))

        scored.sort(key=lambda x: x[0], reverse=True)

        # 记录 Top 3 评分
        for i, (score, mem) in enumerate(scored[:3]):
            trace_event(
                "MEMORY_SCORE",
                f"#{i+1} score={score:.3f} type={mem.memory_type.value} "
                f"keywords='{mem.keywords}'",
                logging.DEBUG,
            )

        result: list[Memory] = []
        estimated_tokens = 0

        for score, mem in scored[:top_k]:
            mem_tokens = len(mem.content) // 2
            if estimated_tokens + mem_tokens > max_tokens:
                continue
            result.append(mem)
            estimated_tokens += mem_tokens

        trace_event(
            "MEMORY_RETRIEVE_DONE",
            f"返回 {len(result)}/{len(scored)} 条 (估算 {estimated_tokens} tokens)",
        )

        return result

    def _score_memory(self, memory: Memory, user_keywords: set[str]) -> float:
        """计算单条记忆的相关性分"""
        score = memory.relevance_score

        mem_keywords = set(
            kw.strip() for kw in memory.keywords.split(",") if kw.strip()
        )
        if user_keywords and mem_keywords:
            overlap = len(user_keywords & mem_keywords)
            if overlap > 0:
                score *= 1.0 + 0.3 * overlap

        score *= self.TYPE_WEIGHT.get(memory.memory_type, 1.0)

        return score

    @trace(log_args=True, log_result=True, max_result_len=300)
    def get_memory_prompt(
        self,
        book_id: str,
        skill_type: SkillType | str,
        user_message: str,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> str:
        """生成可注入 System Prompt 的记忆文本"""
        memories = self.retrieve(
            book_id=book_id,
            skill_type=skill_type,
            user_message=user_message,
            max_tokens=max_tokens,
        )

        if not memories:
            return ""

        lines = ["\n## 历史记忆（来自之前的对话）\n"]
        for mem in memories:
            lines.append(f"- {mem.to_prompt_text()}")
        lines.append("")

        result = "\n".join(lines)
        trace_event(
            "MEMORY_PROMPT",
            f"生成记忆 Prompt ({len(result)} chars, ~{len(result)//2} tokens)",
        )
        return result
