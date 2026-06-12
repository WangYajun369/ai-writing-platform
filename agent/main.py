"""MirageInk Agent Server 入口

启动方式：
    # 方式 1：直接运行（默认开启所有调试日志）
    python -m agent.main

    # 方式 2：通过 uvicorn 启动
    uvicorn agent.main:app --host 127.0.0.1 --port 9877

    # 方式 3：只显示关键日志
    AGENT_TRACE_LEVEL=INFO python -m agent.main

    # 方式 4：仅显示异常
    AGENT_TRACE_LEVEL=WARN python -m agent.main

由 Rust Core 通过子进程管理生命周期。

调试埋点：
    启动后默认开启所有调试日志（AGENT_TRACE_LEVEL=DEBUG），
    自动记录所有函数调用的传参、返参和耗时。
    可通过环境变量 AGENT_TRACE_LEVEL 控制日志级别：
        DEBUG  — 所有调用详情（默认）
        INFO   — 仅关键调用
        WARN   — 仅异常
"""

import logging
import sys
import signal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import config
from .server import register_routes

# ─── 日志配置 ───
# 注意：uvicorn 启动时会重新配置 root logger，可能覆盖 basicConfig。
# 解决方案：tracer logger 使用独立的 handler + propagate=False，
# 并在 uvicorn 启动后重新确认日志级别。
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)-5s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)

# 强制导入 tracer 模块，确保日志初始化在 uvicorn 之前完成
from .tracer import get_tracer_logger, _init_tracer_logger  # noqa: E402
_init_tracer_logger()

# ─── FastAPI 应用 ───
app = FastAPI(
    title="MirageInk Agent Server",
    description="智写时光 AI 写作助手 — Agent Skills 服务",
    version="0.1.0",
)

# CORS：允许 Rust Core 本地回调
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
register_routes(app)

# ─── 优雅关闭 ───
_shutdown_requested = False


def _signal_handler(signum, frame):
    global _shutdown_requested
    logger.info(f"收到信号 {signum}，正在优雅关闭...")
    _shutdown_requested = True


signal.signal(signal.SIGTERM, _signal_handler)
signal.signal(signal.SIGINT, _signal_handler)


@app.on_event("shutdown")
async def on_shutdown():
    logger.info("Agent Server 已关闭")


# ─── 直接运行入口 ───
if __name__ == "__main__":
    import uvicorn

    tracer = get_tracer_logger()
    tracer_level = logging.getLevelName(tracer.level)

    logger.info(f"启动 Agent Server: http://{config.host}:{config.port}")
    logger.info(f"本地模型: {config.local_model_name} @ {config.ollama_base_url}")
    logger.info(f"云端模型: {config.cloud_model_name} @ {config.cloud_api_base}")
    logger.info(f"Trace 级别: {tracer_level}（所有函数调用传参/返参/耗时已开启）")
    if tracer_level == "DEBUG":
        logger.info("调试模式：可通过 AGENT_TRACE_LEVEL=INFO 仅显示关键日志")

    uvicorn.run(
        "agent.main:app",
        host=config.host,
        port=config.port,
        log_level="debug",       # uvicorn 自身也用 debug 级别
        reload=False,
    )
