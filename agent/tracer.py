"""Agent 统一埋点/调试日志模块

提供装饰器和工具函数，自动记录函数调用时的传参和返参，
支持分级日志和性能计时，方便开发调试。

使用方式：
    from .tracer import trace, Traced

    @trace                          # 装饰器方式
    def my_func(a, b):
        return a + b

    class MyService(Traced):        # 继承方式（自动追踪所有方法）
        def do_something(self, x):
            return x * 2

环境变量控制：
    AGENT_TRACE_LEVEL=DEBUG  # 记录所有调用（默认）
    AGENT_TRACE_LEVEL=INFO   # 仅记录关键调用
    AGENT_TRACE_LEVEL=WARN   # 仅记录异常
"""

import functools
import inspect
import json
import logging
import os
import sys
import time
from typing import Any, Callable, TypeVar, ParamSpec, Optional, Union

P = ParamSpec("P")
R = TypeVar("R")

# ─── 日志配置 ───

# 独立的 tracer logger，前缀 [TRACE] 便于 grep 过滤
_tracer_logger: logging.Logger | None = None


def _init_tracer_logger() -> logging.Logger:
    """初始化 tracer logger（模块导入时自动调用）"""
    global _tracer_logger
    if _tracer_logger is not None:
        return _tracer_logger

    _tracer_logger = logging.getLogger("agent.tracer")
    # 不传播到 root logger，避免被 uvicorn 配置覆盖
    _tracer_logger.propagate = False

    # 始终确保有 handler（stderr 输出）
    if not _tracer_logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(
            "%(asctime)s [TRACE] %(message)s", datefmt="%H:%M:%S"
        ))
        _tracer_logger.addHandler(handler)

    # 从环境变量读取日志级别，默认 DEBUG（启动后默认打开所有日志）
    level_name = os.getenv("AGENT_TRACE_LEVEL", "DEBUG").upper()
    _tracer_logger.setLevel(getattr(logging, level_name, logging.DEBUG))

    return _tracer_logger


def get_tracer_logger() -> logging.Logger:
    """获取 tracer 专用 logger"""
    if _tracer_logger is None:
        _init_tracer_logger()
    return _tracer_logger


# ─── 模块导入时自动初始化 ───
# 确保 tracer logger 在首次被 import 时就已配置好，
# 避免 uvicorn 重新配置 root logger 时影响 tracer 输出
_init_tracer_logger()


# ─── 数据序列化 ───

def _serialize(obj: Any, max_len: int = 500) -> str:
    """安全序列化对象为字符串

    Args:
        obj: 任意对象
        max_len: 最大输出长度，超出截断
    """
    if obj is None:
        return "None"

    try:
        if isinstance(obj, (str, int, float, bool)):
            s = str(obj)
        elif isinstance(obj, (list, tuple)):
            items = [_serialize(item, 100) for item in obj[:10]]
            suffix = f", ...({len(obj) - 10} more)" if len(obj) > 10 else ""
            s = f"[{', '.join(items)}{suffix}]"
        elif isinstance(obj, dict):
            items = []
            for k, v in list(obj.items())[:10]:
                items.append(f"{k}={_serialize(v, 80)}")
            suffix = f", ...({len(obj) - 10} more)" if len(obj) > 10 else ""
            s = f"{{{', '.join(items)}{suffix}}}"
        elif hasattr(obj, "__class__"):
            class_name = obj.__class__.__name__
            # 常见类型特殊处理
            if hasattr(obj, "content"):
                s = f"{class_name}(content={_serialize(getattr(obj, 'content', ''), 200)})"
            elif hasattr(obj, "role"):
                s = f"{class_name}(role={getattr(obj, 'role', '?')}, content_len={len(getattr(obj, 'content', '') or '')})"
            else:
                s = f"<{class_name}>"
        else:
            s = str(obj)
    except Exception:
        s = "<serialize_error>"

    if len(s) > max_len:
        s = s[:max_len] + f"...(truncated, total {len(s)} chars)"
    return s


def _format_kwargs(
    func: Callable,
    args: tuple,
    kwargs: dict,
    skip_self: bool = True,
) -> str:
    """格式化函数调用参数"""
    try:
        sig = inspect.signature(func)
        bound = sig.bind(*args, **kwargs)
        bound.apply_defaults()

        params = dict(bound.arguments)

        # 跳过 self/cls
        if skip_self and params:
            first_key = list(params.keys())[0]
            if first_key in ("self", "cls"):
                params.pop(first_key)

        # 对敏感参数脱敏
        sensitive = {"api_key", "password", "token", "secret"}
        for key in list(params.keys()):
            if key.lower() in sensitive:
                params[key] = "***"

        parts = []
        for k, v in params.items():
            parts.append(f"{k}={_serialize(v, 200)}")
        return ", ".join(parts)
    except Exception:
        # 降级：简单拼接
        args_str = ", ".join(_serialize(a, 150) for a in args[1:] if skip_self)
        kw_str = ", ".join(f"{k}={_serialize(v, 150)}" for k, v in kwargs.items())
        return ", ".join(filter(None, [args_str, kw_str]))


# ─── 装饰器 ───

def trace(
    log_args: bool = True,
    log_result: bool = True,
    log_time: bool = True,
    max_result_len: int = 300,
    level: int = logging.DEBUG,
) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """函数调用追踪装饰器

    自动记录：函数名、传参、返回值、耗时。

    Args:
        log_args: 是否记录参数
        log_result: 是否记录返回值
        log_time: 是否记录耗时
        max_result_len: 返回值最大记录长度
        level: 日志级别（默认 DEBUG，可在调用处改为 INFO）

    Usage:
        @trace
        def foo(x): ...

        @trace(level=logging.INFO, max_result_len=100)
        async def bar(x): ...
    """
    def decorator(func: Callable[P, R]) -> Callable[P, R]:
        module_name = func.__module__.split(".")[-1] if func.__module__ else ""
        full_name = f"{module_name}.{func.__qualname__}"

        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
                tracer = get_tracer_logger()
                start = time.perf_counter()

                if log_args:
                    args_str = _format_kwargs(func, args, kwargs)
                    tracer.log(level, f"▶ {full_name}({args_str})")

                try:
                    result = await func(*args, **kwargs)
                    elapsed = (time.perf_counter() - start) * 1000

                    if log_result:
                        result_str = _serialize(result, max_result_len)
                        time_str = f" [{elapsed:.1f}ms]" if log_time else ""
                        tracer.log(level, f"◀ {full_name} → {result_str}{time_str}")
                    elif log_time:
                        tracer.log(level, f"◀ {full_name} ✓ [{elapsed:.1f}ms]")

                    return result
                except Exception as e:
                    elapsed = (time.perf_counter() - start) * 1000
                    tracer.error(
                        f"✕ {full_name} 异常 [{elapsed:.1f}ms]: "
                        f"{type(e).__name__}: {e}"
                    )
                    raise

            return async_wrapper
        else:
            @functools.wraps(func)
            def sync_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
                tracer = get_tracer_logger()
                start = time.perf_counter()

                if log_args:
                    args_str = _format_kwargs(func, args, kwargs)
                    tracer.log(level, f"▶ {full_name}({args_str})")

                try:
                    result = func(*args, **kwargs)
                    elapsed = (time.perf_counter() - start) * 1000

                    if log_result:
                        result_str = _serialize(result, max_result_len)
                        time_str = f" [{elapsed:.1f}ms]" if log_time else ""
                        tracer.log(level, f"◀ {full_name} → {result_str}{time_str}")
                    elif log_time:
                        tracer.log(level, f"◀ {full_name} ✓ [{elapsed:.1f}ms]")

                    return result
                except Exception as e:
                    elapsed = (time.perf_counter() - start) * 1000
                    tracer.error(
                        f"✕ {full_name} 异常 [{elapsed:.1f}ms]: "
                        f"{type(e).__name__}: {e}"
                    )
                    raise

            return sync_wrapper

    # 支持 @trace 无括号用法
    if callable(log_args):
        func, log_args = log_args, True
        return decorator(func)

    return decorator


# ─── 类级别埋点基类 ───

class Traced:
    """埋点基类：自动为所有 public 方法添加追踪

    使用方式：
        class MyService(Traced):
            def do_work(self, data):
                return process(data)

    注意：只追踪不以 _ 开头的方法。
    """

    _trace_exclude_: set[str] = set()  # 子类可覆盖，排除特定方法

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)

        exclude = getattr(cls, "_trace_exclude_", set())

        for name, method in list(cls.__dict__.items()):
            if name.startswith("_"):
                continue
            if name in exclude:
                continue
            if not callable(method):
                continue

            # 自动包裹
            wrapped = trace(log_args=True, log_result=True, log_time=True)(method)
            setattr(cls, name, wrapped)


# ─── 手动埋点辅助 ───

def log_call(
    func_name: str,
    args: dict | None = None,
    result: Any = None,
    elapsed_ms: float | None = None,
    error: Exception | None = None,
) -> None:
    """手动埋点日志

    Args:
        func_name: 函数名
        args: 参数字典
        result: 返回值（可选）
        elapsed_ms: 耗时毫秒（可选）
        error: 异常对象（可选）
    """
    tracer = get_tracer_logger()

    if args:
        args_str = ", ".join(f"{k}={_serialize(v, 150)}" for k, v in args.items())
        tracer.debug(f"▶ {func_name}({args_str})")

    if error:
        time_str = f" [{elapsed_ms:.1f}ms]" if elapsed_ms else ""
        tracer.error(
            f"✕ {func_name} 异常{time_str}: {type(error).__name__}: {error}"
        )
    elif result is not None:
        result_str = _serialize(result, 300)
        time_str = f" [{elapsed_ms:.1f}ms]" if elapsed_ms else ""
        tracer.debug(f"◀ {func_name} → {result_str}{time_str}")


# ─── 请求级上下文 ───

import uuid
from contextvars import ContextVar

# 请求追踪 ID，可在整个请求链路中传递
_request_id: ContextVar[str] = ContextVar("trace_request_id", default="")
_request_start: ContextVar[float] = ContextVar("trace_request_start", default=0.0)


def start_request(skill: str = "", book_id: str = "") -> str:
    """开始一个请求追踪，返回 request_id"""
    rid = uuid.uuid4().hex[:8]
    _request_id.set(rid)
    _request_start.set(time.perf_counter())
    tracer = get_tracer_logger()
    tracer.info(
        f"╔══ REQUEST START [{rid}] skill={skill} book={book_id} ══╗"
    )
    return rid


def end_request():
    """结束请求追踪"""
    rid = _request_id.get()
    start = _request_start.get()
    if start > 0:
        elapsed = (time.perf_counter() - start) * 1000
        tracer = get_tracer_logger()
        tracer.info(
            f"╚══ REQUEST END [{rid}] total={elapsed:.0f}ms ══╝"
        )


def get_request_id() -> str:
    return _request_id.get()


def trace_event(event: str, detail: str = "", level: int = logging.DEBUG):
    """记录请求链路中的事件"""
    rid = get_request_id()
    prefix = f"[{rid}] " if rid else ""
    tracer = get_tracer_logger()
    tracer.log(level, f"{prefix}● {event}{' — ' + detail if detail else ''}")
