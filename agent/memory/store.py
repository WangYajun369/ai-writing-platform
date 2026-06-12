"""记忆体存储层：SQLite 持久化 Agent 记忆

支持三种记忆类型：
- preference: 用户偏好（风格、语气、格式偏好）
- decision: 决策记录（曾做过什么选择、原因）
- lesson: 经验教训（什么有效、什么无效）

调试：
- 设置 AGENT_TRACE_LEVEL=DEBUG 查看所有记忆体操作日志
"""

import json
import logging
import os
import sqlite3
import threading
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional

from ..config import config
from ..tracer import trace, log_call, trace_event

logger = logging.getLogger(__name__)


class MemoryType(str, Enum):
    PREFERENCE = "preference"   # 用户偏好
    DECISION = "decision"       # 决策记录
    LESSON = "lesson"           # 经验教训


@dataclass
class Memory:
    """单条记忆"""
    id: int
    book_id: str
    skill_type: str
    memory_type: MemoryType
    content: str
    keywords: str                  # 逗号分隔的关键词，用于检索
    relevance_score: float = 0.0   # 初始相关性分，随时间衰减
    created_at: str = ""
    updated_at: str = ""

    def to_prompt_text(self) -> str:
        """转为注入 Prompt 的文本"""
        type_label = {
            MemoryType.PREFERENCE: "偏好",
            MemoryType.DECISION: "历史决策",
            MemoryType.LESSON: "经验",
        }.get(self.memory_type, "记忆")
        return f"[{type_label}] {self.content}"


class MemoryStore:
    """SQLite 记忆存储

    使用 WAL 模式 + 线程锁保证并发安全。
    """

    _instance: Optional["MemoryStore"] = None
    _lock = threading.Lock()

    def __new__(cls, db_path: str | None = None):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self, db_path: str | None = None):
        if self._initialized:
            return
        self._db_path = db_path or getattr(
            config, "memory_db_path", "data/agent_memory.db"
        )
        # 确保父目录存在（SQLite 不会自动创建目录）
        _parent = os.path.dirname(self._db_path)
        if _parent and not os.path.exists(_parent):
            os.makedirs(_parent, exist_ok=True)
            trace_event("MEMORY_DIR_CREATE", f"创建目录: {_parent}", logging.DEBUG)
        self._conn: sqlite3.Connection | None = None
        self._init_db()
        self._initialized = True
        trace_event("MEMORY_INIT", f"db={self._db_path}", logging.DEBUG)

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(
                self._db_path, check_same_thread=False
            )
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.row_factory = sqlite3.Row
        return self._conn

    def _init_db(self):
        conn = self._get_conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_id TEXT NOT NULL,
                skill_type TEXT NOT NULL,
                memory_type TEXT NOT NULL,
                content TEXT NOT NULL,
                keywords TEXT NOT NULL DEFAULT '',
                relevance_score REAL NOT NULL DEFAULT 1.0,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_memories_book_skill
            ON memories(book_id, skill_type)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_memories_type
            ON memories(memory_type)
        """)
        conn.commit()
        trace_event("MEMORY_DB", "表结构已就绪", logging.DEBUG)

    # ─── CRUD ───

    @trace(log_args=True, log_result=True)
    def save_memory(
        self,
        book_id: str,
        skill_type: str,
        memory_type: MemoryType,
        content: str,
        keywords: str = "",
    ) -> int:
        """保存一条记忆，返回 ID"""
        conn = self._get_conn()
        cursor = conn.execute(
            """INSERT INTO memories (book_id, skill_type, memory_type, content, keywords)
               VALUES (?, ?, ?, ?, ?)""",
            (book_id, skill_type, memory_type.value, content.strip(), keywords.strip()),
        )
        conn.commit()
        mem_id = cursor.lastrowid
        trace_event(
            "MEMORY_SAVE",
            f"id={mem_id} type={memory_type.value} keywords='{keywords[:50]}' "
            f"content_len={len(content)}",
        )
        return mem_id

    @trace(log_args=True, log_result=True, max_result_len=200)
    def get_memories(
        self,
        book_id: str,
        skill_type: str | None = None,
        memory_type: MemoryType | None = None,
        limit: int = 20,
    ) -> list[Memory]:
        """查询记忆"""
        conn = self._get_conn()
        conditions = ["book_id = ?"]
        params: list = [book_id]

        if skill_type:
            conditions.append("skill_type = ?")
            params.append(skill_type)
        if memory_type:
            conditions.append("memory_type = ?")
            params.append(memory_type.value)

        where = " AND ".join(conditions)
        rows = conn.execute(
            f"""SELECT * FROM memories
               WHERE {where}
               ORDER BY relevance_score DESC, updated_at DESC
               LIMIT ?""",
            params + [limit],
        ).fetchall()

        results = [Memory(
            id=row["id"],
            book_id=row["book_id"],
            skill_type=row["skill_type"],
            memory_type=MemoryType(row["memory_type"]),
            content=row["content"],
            keywords=row["keywords"],
            relevance_score=row["relevance_score"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        ) for row in rows]

        trace_event(
            "MEMORY_GET",
            f"book={book_id} skill={skill_type or '*'} "
            f"type={memory_type.value if memory_type else '*'} → {len(results)} 条",
        )
        return results

    @trace(log_args=True, log_result=False)
    def update_relevance(self, memory_id: int, new_score: float):
        """更新记忆的相关性分数"""
        conn = self._get_conn()
        conn.execute(
            """UPDATE memories
               SET relevance_score = ?, updated_at = datetime('now', 'localtime')
               WHERE id = ?""",
            (max(0.0, min(1.0, new_score)), memory_id),
        )
        conn.commit()
        trace_event("MEMORY_RELEVANCE", f"id={memory_id} score={new_score:.3f}", logging.DEBUG)

    @trace(log_args=True, log_result=False)
    def decay_relevance(self, book_id: str, skill_type: str, decay_rate: float = 0.95):
        """衰减指定 book+skill 下所有记忆的相关性分"""
        conn = self._get_conn()
        cursor = conn.execute(
            """UPDATE memories
               SET relevance_score = relevance_score * ?,
                   updated_at = datetime('now', 'localtime')
               WHERE book_id = ? AND skill_type = ?""",
            (decay_rate, book_id, skill_type),
        )
        conn.commit()
        trace_event(
            "MEMORY_DECAY",
            f"book={book_id} skill={skill_type} rate={decay_rate} "
            f"affected={cursor.rowcount} 条",
        )

    @trace(log_args=True, log_result=False)
    def update_memory(
        self,
        memory_id: int,
        content: str | None = None,
        keywords: str | None = None,
        memory_type: MemoryType | None = None,
    ):
        """更新一条记忆的内容/关键词/类型"""
        conn = self._get_conn()
        fields = []
        params: list = []

        if content is not None:
            fields.append("content = ?")
            params.append(content.strip())
        if keywords is not None:
            fields.append("keywords = ?")
            params.append(keywords.strip())
        if memory_type is not None:
            fields.append("memory_type = ?")
            params.append(memory_type.value)

        if not fields:
            return

        fields.append("updated_at = datetime('now', 'localtime')")
        params.append(memory_id)

        conn.execute(
            f"UPDATE memories SET {', '.join(fields)} WHERE id = ?",
            params,
        )
        conn.commit()
        trace_event("MEMORY_UPDATE", f"id={memory_id} fields={list(zip(fields, params[:-1]))}", logging.DEBUG)

    @trace(log_args=True, log_result=False)
    def delete_memory(self, memory_id: int):
        conn = self._get_conn()
        conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        conn.commit()
        trace_event("MEMORY_DELETE", f"id={memory_id}", logging.DEBUG)

    @trace(log_args=True, log_result=False)
    def clear_all_memories(self, book_id: str):
        """清空指定书籍的所有记忆"""
        conn = self._get_conn()
        cursor = conn.execute("DELETE FROM memories WHERE book_id = ?", (book_id,))
        conn.commit()
        count = cursor.rowcount
        trace_event("MEMORY_CLEAR_ALL", f"book={book_id} deleted={count}条", logging.DEBUG)
        return count

    @trace(log_args=True, log_result=True)
    def get_memory_count(self, book_id: str | None = None) -> int:
        conn = self._get_conn()
        if book_id:
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM memories WHERE book_id = ?",
                (book_id,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM memories"
            ).fetchone()
        return row["cnt"] if row else 0

    # ─── 智能提取 ───

    async def extract_and_save(
        self,
        book_id: str,
        skill_type: str,
        user_message: str,
        assistant_response: str,
    ):
        """从对话中智能提取记忆并保存

        基于规则提取（不消耗额外 LLM 调用）：
        - 用户消息含"喜欢"/"偏好"/"习惯" → preference
        - 用户消息含"决定"/"选择"/"采用" → decision
        - 助手回复含"建议"/"注意"/"教训" → lesson
        """
        trace_event(
            "MEMORY_EXTRACT_START",
            f"book={book_id} skill={skill_type} "
            f"user_msg_len={len(user_message)} assistant_msg_len={len(assistant_response)}",
        )
        saved_count = 0

        # 提取偏好
        preference_keywords = ["喜欢", "偏好", "习惯", "风格", "语气", "总是", "一直"]
        if any(kw in user_message for kw in preference_keywords):
            keywords = self._extract_keywords(user_message, max_words=5)
            self.save_memory(
                book_id=book_id,
                skill_type=skill_type,
                memory_type=MemoryType.PREFERENCE,
                content=user_message[:300],
                keywords=",".join(keywords),
            )
            saved_count += 1

        # 提取决策
        decision_keywords = ["决定", "选择", "采用", "就用这个", "按这个来", "确认"]
        if any(kw in user_message for kw in decision_keywords):
            keywords = self._extract_keywords(user_message, max_words=5)
            self.save_memory(
                book_id=book_id,
                skill_type=skill_type,
                memory_type=MemoryType.DECISION,
                content=user_message[:300],
                keywords=",".join(keywords),
            )
            saved_count += 1

        # 提取经验（助手侧）
        lesson_keywords = ["建议", "注意", "教训", "避免", "推荐", "最好"]
        if any(kw in assistant_response for kw in lesson_keywords):
            sentences = assistant_response.replace("\n", " ").split("。")
            relevant = [
                s.strip() for s in sentences
                if any(kw in s for kw in lesson_keywords)
            ][:3]
            if relevant:
                content = "。".join(relevant) + "。"
                keywords = self._extract_keywords(content, max_words=5)
                self.save_memory(
                    book_id=book_id,
                    skill_type=skill_type,
                    memory_type=MemoryType.LESSON,
                    content=content[:300],
                    keywords=",".join(keywords),
                )
                saved_count += 1

        if saved_count > 0:
            trace_event(
                "MEMORY_EXTRACT_DONE",
                f"从对话中提取了 {saved_count} 条记忆",
            )
        else:
            trace_event(
                "MEMORY_EXTRACT_SKIP",
                "未匹配到可提取的记忆",
                logging.DEBUG,
            )

    @staticmethod
    def _extract_keywords(text: str, max_words: int = 5) -> list[str]:
        """简单关键词提取：取长度 >= 2 的高频词"""
        import re
        from collections import Counter

        words = re.findall(r"[\u4e00-\u9fff\w]{2,}", text)
        stop_words = {
            "这个", "那个", "什么", "怎么", "可以", "是否", "需要",
            "已经", "还是", "但是", "然后", "一个", "一下", "一些",
            "不过", "只是", "因为", "所以", "如果", "虽然", "the", "is", "a", "an",
        }
        filtered = [w for w in words if w.lower() not in stop_words]
        counter = Counter(filtered)
        return [word for word, _ in counter.most_common(max_words)]
