"""Agent Server 包导出入口

对外提供路由注册与 SSE 响应构造接口：
- register_routes: 将 API 路由注册到 FastAPI 应用
- create_sse_response: 构造 SSE 流式响应
"""

from .routes import (
    register_routes,  # pyright: ignore[reportUnknownVariableType]  # 类型由 routes 模块定义
)
from .sse import (
    create_sse_response,  # pyright: ignore[reportUnknownVariableType]  # 类型由 sse 模块定义
)

__all__ = ["create_sse_response", "register_routes"]
