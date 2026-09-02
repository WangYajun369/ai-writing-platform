"""模型路由导出入口

对外提供模型选择与流式调用接口：
- get_model_for_skill: 根据 Skill 类型选择本地/云端模型
- stream_model: 流式调用模型，逐 token 产出
"""

from .router import (
    get_model_for_skill,
    stream_model,
)

__all__ = ["get_model_for_skill", "stream_model"]
