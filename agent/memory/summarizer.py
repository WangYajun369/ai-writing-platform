"""对话历史压缩器

当对话轮次超过阈值时，使用本地模型（Ollama）压缩历史对话为摘要，
大幅减少上下文 Token 消耗。

调试：
- AGENT_TRACE_LEVEL=DEBUG 查看压缩详情和压缩前后的对比
"""

import logging
from typing import Optional

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

from ..config import config
from ..tracer import trace, trace_event

logger = logging.getLogger(__name__)

COMPRESS_THRESHOLD = 6
KEEP_RECENT = 4

SUMMARIZE_SYSTEM = """你是一个对话压缩助手。请将以下小说创作对话压缩为简洁摘要。

## 压缩规则
1. 只保留关键信息：用户偏好、重要决策、已确认的设定
2. 忽略闲聊、问候、简单确认
3. 用中文输出，不超过 500 字
4. 使用以下格式：

### 关键决策
- 决策1
- 决策2

### 用户偏好
- 偏好1

### 讨论要点
- 要点1
- 要点2

### 已确认设定
- 设定1"""


class HistorySummarizer:
    """对话历史压缩器

    使用本地 Ollama 模型进行压缩，不消耗云端 API 额度。
    """

    _model = None

    @classmethod
    def _get_model(cls):
        """延迟加载本地压缩模型"""
        if cls._model is None:
            from langchain_ollama import ChatOllama
            cls._model = ChatOllama(
                model=config.local_model_name,
                base_url=config.ollama_base_url,
                temperature=0.3,
                num_predict=1024,
            )
            trace_event(
                "COMPRESS_MODEL",
                f"已加载 {config.local_model_name} @ {config.ollama_base_url}",
                logging.DEBUG,
            )
        return cls._model

    @classmethod
    @trace(log_args=True, log_result=True, max_result_len=200)
    async def summarize(
        cls,
        messages: list[BaseMessage],
    ) -> Optional[str]:
        """压缩消息列表为摘要"""
        conv_msgs = [m for m in messages if not isinstance(m, SystemMessage)]

        turns = len([m for m in conv_msgs if isinstance(m, HumanMessage)])
        if turns <= COMPRESS_THRESHOLD:
            trace_event(
                "COMPRESS_SKIP",
                f"轮次 {turns} ≤ 阈值 {COMPRESS_THRESHOLD}，跳过压缩",
                logging.DEBUG,
            )
            return None

        recent_start = max(0, len(conv_msgs) - KEEP_RECENT * 2)
        to_summarize = conv_msgs[:recent_start]

        if not to_summarize:
            return None

        total_chars = sum(len(m.content) if hasattr(m, 'content') else 0
                         for m in to_summarize)
        trace_event(
            "COMPRESS_START",
            f"压缩 {len(to_summarize)} 条消息 (总 {total_chars} chars, {turns} 轮)",
        )

        summarize_text = "\n\n".join(
            f"[{'用户' if isinstance(m, HumanMessage) else '助手'}]: {m.content[:500]}"
            for m in to_summarize
        )

        try:
            model = cls._get_model()
            response = await model.ainvoke([
                SystemMessage(content=SUMMARIZE_SYSTEM),
                HumanMessage(content=f"请压缩以下对话：\n\n{summarize_text}"),
            ])
            summary = response.content if hasattr(response, "content") else str(response)
            trace_event(
                "COMPRESS_DONE",
                f"压缩完成: {total_chars} chars → {len(summary)} chars "
                f"(压缩比 {len(summary)/max(total_chars,1)*100:.1f}%)",
            )
            return summary.strip()
        except Exception as e:
            trace_event(
                "COMPRESS_ERROR",
                f"压缩失败: {e}，将使用原始历史",
                logging.WARNING,
            )
            return None

    @classmethod
    @trace(log_args=True, log_result=True, max_result_len=200)
    def compress_messages(
        cls,
        messages: list[BaseMessage],
        summary: Optional[str],
    ) -> list[BaseMessage]:
        """用摘要替换压缩部分的消息"""
        if summary is None:
            return messages

        sys_msgs = [m for m in messages if isinstance(m, SystemMessage)]
        conv_msgs = [m for m in messages if not isinstance(m, SystemMessage)]

        recent = conv_msgs[-KEEP_RECENT * 2:]

        compressed = list(sys_msgs)

        summary_msg = HumanMessage(
            content=f"[对话历史摘要]\n{summary}\n\n"
                    f"以上是之前对话的摘要。请基于此摘要和接下来的对话继续工作。"
        )
        compressed.append(summary_msg)
        compressed.extend(recent)

        trace_event(
            "COMPRESS_MSGS",
            f"消息压缩: {len(messages)} → {len(compressed)} 条 "
            f"(节省 {len(messages) - len(compressed)} 条)",
        )
        return compressed
