"""模型路由：根据任务复杂度自动选择本地/云端模型

- POLISH → 本地 Ollama（快速、免费）
- WRITING/ANALYSIS/RESEARCH → 云端 API（强推理）

DeepSeek API 参数说明（参考官方文档）：
- thinking: { type: "enabled"/"disabled" } — 思考模式开关，默认 enabled
- reasoning_effort: "high"/"max" — 思考强度，普通请求默认 high，Agent 类自动设为 max
- temperature/top_p/presence_penalty/frequency_penalty — 思考模式下不生效（DeepSeek 限制）
- KV Cache：DeepSeek 自动启用，无需配置；通过 usage.prompt_cache_hit_tokens 查看命中

调试：
- AGENT_TRACE_LEVEL=DEBUG 查看模型选择过程
"""

import logging
from typing import AsyncIterator

from ..config import config, SkillType, TASK_COMPLEXITY_MAP, ModelTier
from ..tracer import trace, trace_event

logger = logging.getLogger(__name__)

# ─── 模型实例（延迟初始化） ───

_local_model = None
# 云端模型改为按请求动态创建（不同用户可能有不同 API Key）
# 保留缓存：key = (endpoint, model, api_key_hash) → model 实例
_cloud_model_cache: dict[tuple, object] = {}


@trace(log_args=False, log_result=True)
def _get_local_model():
    """获取本地 Ollama 模型"""
    global _local_model
    if _local_model is None:
        from langchain_ollama import ChatOllama
        _local_model = ChatOllama(
            model=config.local_model_name,
            base_url=config.ollama_base_url,
            temperature=0.7,
            num_predict=4096,
        )
        trace_event(
            "MODEL_INIT",
            f"本地模型已加载: {config.local_model_name} @ {config.ollama_base_url}",
        )
    return _local_model


def _hash_api_key(api_key: str) -> str:
    """对 API Key 做简单哈希，避免明文存储"""
    import hashlib
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def _is_deepseek_endpoint(endpoint: str) -> bool:
    """判断是否为 DeepSeek API 端点"""
    return "deepseek" in endpoint.lower()


def _build_deepseek_model_kwargs(
    model_name: str,
    endpoint: str,
    api_key: str,
    temperature: float,
    max_tokens: int,
    thinking_enabled: bool = True,
    reasoning_effort: str = "high",
) -> dict:
    """构建 ChatOpenAI 初始化参数，遵循 DeepSeek 官方推荐配置。

    参考：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

    DeepSeek 思考模式注意事项：
    - thinking 参数需通过 default_headers 或 extra_body 注入
    - reasoning_effort: 普通请求默认 high，Agent 工具调用场景自动设为 max
    - 思考模式下 temperature/top_p/presence_penalty/frequency_penalty 不生效
    - KV Cache 自动启用，无需显式配置
    """
    kwargs = {
        "model": model_name,
        "base_url": endpoint,
        "api_key": api_key,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    if _is_deepseek_endpoint(endpoint) and thinking_enabled:
        # DeepSeek 思考模式：通过 model_kwargs 传递 thinking 和 reasoning_effort
        # langchain-openai 会将 model_kwargs 中的参数注入到每次 API 请求
        kwargs["model_kwargs"] = {
            "thinking": {"type": "enabled"},
            "reasoning_effort": reasoning_effort,
        }
        trace_event(
            "MODEL_DEEPSEEK_THINKING",
            f"启用 DeepSeek 思考模式: reasoning_effort={reasoning_effort}",
            logging.DEBUG,
        )

    return kwargs


def _get_ai_config_value(ai_config: dict, *keys, default=None):
    """兼容 camelCase（前端）和 snake_case（Python）两种格式读取配置值"""
    for key in keys:
        if key in ai_config and ai_config[key] is not None:
            return ai_config[key]
    return default


@trace(log_args=False, log_result=True)
def _get_or_create_cloud_model(ai_config: dict | None = None):
    """获取或创建云端模型实例

    优先使用请求传入的 ai_config，否则回退到全局配置。
    按 (endpoint, model, api_key_hash, thinking_enabled, reasoning_effort) 缓存模型实例。

    重要：dict.get() 仅在 key 不存在时返回默认值；若 key 存在但值为 None/""，
    不会触发 fallback。因此对 api_key 做显式空值处理。
    """
    if ai_config:
        # 兼容 camelCase（前端）和 snake_case（Python）两种格式
        endpoint = _get_ai_config_value(ai_config, "endpoint") or config.cloud_api_base
        model_name = _get_ai_config_value(ai_config, "model") or config.cloud_model_name
        # 显式空值检查：None / "" 均视为未提供，回退到全局配置
        raw_api_key = _get_ai_config_value(ai_config, "api_key", "apiKey")
        api_key = raw_api_key if (raw_api_key is not None and raw_api_key != "") else config.cloud_api_key
        temperature = _get_ai_config_value(ai_config, "temperature", default=0.7)
        max_tokens = _get_ai_config_value(ai_config, "max_tokens", "maxTokens", default=8192)
        thinking_enabled = _get_ai_config_value(ai_config, "thinking_enabled", "thinkingEnabled", default=True)
        # reasoning_effort: Agent 工具调用场景默认 "max"（参考 DeepSeek 文档）
        reasoning_effort = _get_ai_config_value(ai_config, "reasoning_effort", "reasoningEffort", default="max")
        logger.debug(
            f"使用请求 ai_config: endpoint={endpoint}, model={model_name}, "
            f"api_key_len={len(api_key) if api_key else 0}, "
            f"thinking_enabled={thinking_enabled}, reasoning_effort={reasoning_effort}"
        )
    else:
        endpoint = config.cloud_api_base
        model_name = config.cloud_model_name
        api_key = config.cloud_api_key
        temperature = 0.7
        max_tokens = 8192
        thinking_enabled = True
        reasoning_effort = "max"
        logger.debug(
            f"使用全局 config: endpoint={endpoint}, model={model_name}, "
            f"api_key_len={len(api_key) if api_key else 0}"
        )
        if not api_key:
            raise ValueError(
                "未配置云端 API Key。请在设置页面中配置 AI 模型的 API Key，"
                "并确保已选中作品后发送消息"
            )

    # 统一的 api_key 有效性检查（在构造 ChatOpenAI 之前）
    if not api_key or not api_key.strip():
        provider_hint = ""
        if _is_deepseek_endpoint(endpoint):
            provider_hint = "（当前使用 DeepSeek，可在 https://platform.deepseek.com 获取）"
        elif "bigmodel" in endpoint.lower():
            provider_hint = "（当前使用智谱 AI，可在 https://open.bigmodel.cn 获取）"
        raise ValueError(
            f"未配置云端 API Key。请在设置页面中配置 AI 模型的 API Key{provider_hint}"
        )

    # 去除 api_key 首尾空白（防止复制粘贴时带入空格）
    api_key = api_key.strip()

    # 缓存 key 包含 thinking 参数（因为影响 API 行为）
    cache_key = (
        endpoint,
        model_name,
        _hash_api_key(api_key),
        thinking_enabled,
        reasoning_effort,
    )

    if cache_key not in _cloud_model_cache:
        try:
            # 兜底：设置 OPENAI_API_KEY 环境变量，确保 openai SDK 内部能找到凭证
            # 必须在导入 langchain_openai 之前设置，避免 openai SDK 在导入时缓存空凭证
            import os
            os.environ["OPENAI_API_KEY"] = api_key

            # 必须在设置环境变量之后导入，确保 openai SDK 能读到正确的凭证
            from langchain_openai import ChatOpenAI

            # 根据端点类型构建不同的模型参数
            if _is_deepseek_endpoint(endpoint):
                # DeepSeek 思考模式：deepseek-chat 模型默认启用思考模式
                # 注意：thinking 参数不是 OpenAI SDK 标准参数，不能直接传递
                # 如需禁用思考模式，使用 deepseek-v3 或其他非推理模型
                model = ChatOpenAI(
                    model=model_name,
                    base_url=endpoint,
                    api_key=api_key,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                _cloud_model_cache[cache_key] = model
            else:
                _cloud_model_cache[cache_key] = ChatOpenAI(
                    model=model_name,
                    base_url=endpoint,
                    api_key=api_key,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )

            trace_event(
                "MODEL_INIT",
                f"云端模型已创建: {model_name} @ {endpoint} "
                f"(thinking={thinking_enabled}, effort={reasoning_effort})",
            )
        except Exception as e:
            trace_event(
                "MODEL_INIT_ERROR",
                f"创建云端模型失败: {type(e).__name__}: {e}",
                logging.ERROR,
            )
            raise ValueError(
                f"创建 AI 模型失败（{model_name} @ {endpoint}）: {e}"
            ) from e

    return _cloud_model_cache[cache_key]


@trace(log_args=True, log_result=True, max_result_len=100)
def get_model_for_skill(skill: SkillType, ai_config: dict | None = None):
    """根据 Skill 类型返回对应层级的模型

    Args:
        skill: 技能类型
        ai_config: 请求传入的 AI 配置，优先级高于全局配置
    """
    tier = TASK_COMPLEXITY_MAP.get(skill, ModelTier.CLOUD)

    if tier == ModelTier.LOCAL:
        model = _get_local_model()
        trace_event(
            "MODEL_SELECT",
            f"Skill={skill.value} → LOCAL ({config.local_model_name})",
        )
    else:
        model = _get_or_create_cloud_model(ai_config)
        model_name = ai_config.get("model", config.cloud_model_name) if ai_config else config.cloud_model_name
        trace_event(
            "MODEL_SELECT",
            f"Skill={skill.value} → CLOUD ({model_name})",
        )

    return model


@trace(log_args=False, log_result=False, log_time=False)
async def stream_model(model, messages) -> AsyncIterator[str]:
    """流式调用模型，逐 token 产出"""
    trace_event(
        "MODEL_STREAM_START",
        f"模型={model.model_name if hasattr(model, 'model_name') else 'unknown'} "
        f"消息数={len(messages)}",
        logging.DEBUG,
    )

    token_count = 0
    try:
        async for chunk in model.astream(messages):
            if hasattr(chunk, "content") and chunk.content:
                token_count += 1
                if isinstance(chunk.content, str):
                    yield chunk.content
        trace_event(
            "MODEL_STREAM_DONE",
            f"流式完成，输出 {token_count} tokens",
            logging.DEBUG,
        )
    except Exception as e:
        trace_event(
            "MODEL_STREAM_ERROR",
            f"流式异常: {e}",
            logging.ERROR,
        )
        raise
