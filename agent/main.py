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
import logging.config
import signal
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import config
from .server import register_routes

logger = logging.getLogger(__name__)


# ─── 日志配置 ───
# 统一日志策略，解决三个问题：
# 1. 时序错乱：tracer 之前写 stderr、uvicorn access log 写 stdout，
#    双流缓冲不同步导致日志顺序重排。现在将 uvicorn 家族 logger 与
#    root 统一输出到 stdout（与 tracer 同一流），并使用 FlushStreamHandler
#    每次写入后强制 flush，保证同一流内的日志顺序与写入顺序一致。
# 2. 调试控制台标红：stderr 在调试控制台会被统一渲染为 ERROR，
#    因此正常日志全部走 stdout，仅让未捕获异常默认落到 stderr。
# 3. 心跳噪声：uvicorn.access 挂 ExcludeHealthFilter，过滤 /health 轮询日志。
# 4. 日志级别：uvicorn 自身使用 info 级别，避免 debug 堆栈刷屏。
class ExcludeHealthFilter(logging.Filter):
    """过滤 uvicorn access log 中的 /health 心跳请求（看门狗每 10 秒轮询一次）"""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != "uvicorn.access":
            return True
        args = record.args
        # uvicorn.access 格式: '%s - "%s %s HTTP/%s" %d'
        # → args = (client_addr, method, path, http_version, status_code)
        if isinstance(args, tuple) and len(args) > 2:
            return not str(args[2]).startswith("/health")
        return True


LOG_CONFIG: dict[str, Any] = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "format": "%(asctime)s [%(levelname)-5s] %(name)s: %(message)s",
            "datefmt": "%H:%M:%S",
        },
    },
    "filters": {
        "no_health": {"()": ExcludeHealthFilter},
    },
    "handlers": {
        "console": {
            # 复用 tracer 的 FlushStreamHandler，保证 uvicorn 与 tracer 同流且即时 flush
            "class": "agent.tracer.FlushStreamHandler",
            "formatter": "default",
        },
    },
    "loggers": {
        # uvicorn 家族统一输出到 stdout，与 tracer 同流，保证日志顺序一致
        "uvicorn": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"handlers": ["console"], "level": "INFO", "propagate": False},
        # access log 默认 INFO；挂 no_health filter 消除心跳噪声
        "uvicorn.access": {
            "handlers": ["console"],
            "level": "INFO",
            "propagate": False,
            "filters": ["no_health"],
        },
    },
    "root": {"handlers": ["console"], "level": "INFO"},
}


def _setup_logging() -> None:
    """应用统一日志配置（模块导入时执行，先于 uvicorn 接管）"""
    logging.config.dictConfig(LOG_CONFIG)


# 强制导入 tracer 模块，确保 tracer logger 初始化在 uvicorn 之前完成；
# tracer 保持独立 handler（stdout + [TRACE] 格式，见 tracer.py）
from .tracer import get_tracer_logger

# 应用统一日志配置（覆盖 uvicorn 默认的 stdout access log）
_setup_logging()

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
        log_config=LOG_CONFIG,   # 复用统一日志配置（stderr + 心跳过滤）
        log_level="info",        # uvicorn 自身用 info 级别，避免 debug 堆栈刷屏
        reload=False,
    )
