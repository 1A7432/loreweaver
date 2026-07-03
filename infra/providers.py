"""Multi-provider LLM construction and provider-specific adapters."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from infra.config import LLMSettings, Settings
from infra.llm import ChatResult, LLMClient, OpenAILLM, ToolCall
from infra.runtime_config import OVERRIDE_FIELDS, apply_overrides

PRESETS: dict[str, str] = {
    "openai": "",
    "deepseek": "https://api.deepseek.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
    "together": "https://api.together.xyz/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "moonshot": "https://api.moonshot.cn/v1",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
    "xai": "https://api.x.ai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "ollama": "http://localhost:11434/v1",
    "lmstudio": "http://localhost:1234/v1",
    "vllm": "http://localhost:8000/v1",
}

# ChatGPT web subscriptions are not API credentials. These provider names are
# only for user-operated OpenAI-compatible proxy gateways that expose a base_url.
CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES: tuple[str, ...] = ("chatgpt", "gpt-subscription")
CHATGPT_SUBSCRIPTION_PROXY_PROVIDERS: frozenset[str] = frozenset(CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES)

_GEMINI_SCHEMA_ALLOWED_KEYS = {
    "type",
    "format",
    "title",
    "description",
    "nullable",
    "enum",
    "maxItems",
    "minItems",
    "properties",
    "required",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength",
    "pattern",
    "example",
    "anyOf",
    "propertyOrdering",
    "default",
    "items",
    "minimum",
    "maximum",
}


def build_llm(settings: Settings) -> LLMClient:
    """Build an LLM client from application settings."""

    llm_settings = settings.llm
    provider = (llm_settings.provider or "openai").lower()
    if provider in {"anthropic", "claude"}:
        return AnthropicLLM(llm_settings)
    if provider in {"gemini", "google"}:
        return GeminiLLM(llm_settings)
    if provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDERS and not llm_settings.base_url:
        raise ValueError("chatgpt_subscription_proxy_requires_base_url")

    base_url = llm_settings.base_url or PRESETS.get(provider, "")
    if base_url == llm_settings.base_url:
        return OpenAILLM(llm_settings)
    return OpenAILLM(llm_settings.model_copy(update={"base_url": base_url}))


# Providers reached through a native (non-OpenAI) SDK. Aliases included so
# `is_known_provider` accepts what `build_llm` accepts; `NATIVE_PROVIDER_NAMES`
# is the curated set shown to users by `.model list`.
NATIVE_PROVIDERS: frozenset[str] = frozenset({"anthropic", "claude", "gemini", "google"})
NATIVE_PROVIDER_NAMES: tuple[str, ...] = ("anthropic", "gemini")


def is_known_provider(name: str) -> bool:
    """True if `name` is a recognized provider key (`build_llm` can build it)."""
    provider = (name or "").lower()
    return provider in PRESETS or provider in CHATGPT_SUBSCRIPTION_PROXY_PROVIDERS or provider in NATIVE_PROVIDERS


def mask_secret(value: str) -> str:
    """Mask an API key for display: first/last 4 chars, or all-stars if short."""
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def describe_settings(llm: LLMSettings) -> dict[str, str]:
    """A display-safe snapshot of the effective LLM config (api_key masked)."""
    provider = (llm.provider or "openai").lower()
    return {
        "provider": llm.provider or "openai",
        "chat_model": llm.chat_model,
        "base_url": llm.base_url or PRESETS.get(provider, ""),
        "analysis_model": llm.analysis_model,
        "npc_model": llm.npc_model,
        "api_key": mask_secret(llm.api_key),
    }


class MutableLLM:
    """An `LLMClient` whose backing provider/model can be swapped at runtime.

    Wraps an inner client built via `build_llm`. `reconfigure()` rebuilds the
    inner client AND copies the new llm fields into the shared `Settings` IN
    PLACE, so every consumer observes the switch without rebuilding `Services`:
    the agent loop uses the inner client's default model, while module init and
    the NPC/companion actors read `services.settings.llm.*` at call time.
    """

    def __init__(self, settings: Settings, *, builder: Callable[[Settings], LLMClient] = build_llm) -> None:
        self._builder = builder
        self._settings = settings  # shared/effective settings (mutated in place)
        self._base = settings.model_copy(deep=True)  # pristine baseline for reset
        self._inner: LLMClient = builder(settings)

    @property
    def inner(self) -> LLMClient:
        return self._inner

    @property
    def settings(self) -> Settings:
        return self._settings

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        return await self._inner.chat(
            messages,
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            model=model,
        )

    def reconfigure(self, settings: Settings) -> None:
        """Rebuild the inner client from `settings`, mutating the shared Settings'
        llm fields in place so all LLM consumers observe the change."""
        for field in OVERRIDE_FIELDS:
            setattr(self._settings.llm, field, getattr(settings.llm, field))
        self._inner = self._builder(self._settings)

    def apply(self, overrides: dict) -> None:
        """Recompute effective settings from the pristine baseline + `overrides`
        and reconfigure (empty `overrides` reverts to the env/`Settings` baseline)."""
        self.reconfigure(apply_overrides(self._base, overrides))

    def describe(self) -> dict[str, str]:
        """Display-safe snapshot of the current effective config (api_key masked)."""
        return describe_settings(self._settings.llm)


class AnthropicLLM:
    """Anthropic Messages API adapter for the repo's LLMClient protocol."""

    def __init__(self, settings: LLMSettings, client: Any | None = None) -> None:
        self._settings = settings
        if client is not None:
            self._client = client
            return
        try:
            import anthropic
        except ImportError as exc:
            raise ValueError("缺少 anthropic SDK；请安装 loreweaver[anthropic] 或 anthropic。") from exc
        self._client = anthropic.AsyncAnthropic(
            api_key=settings.api_key or None,
            base_url=settings.base_url or None,
        )

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        system, anthropic_messages = to_anthropic_messages(messages)
        kwargs: dict[str, Any] = {
            "model": model or self._settings.chat_model,
            "max_tokens": 4096,
            "messages": anthropic_messages,
        }
        if system:
            kwargs["system"] = system
        anthropic_tools = to_anthropic_tools(tools)
        if anthropic_tools:
            kwargs["tools"] = anthropic_tools
        if tool_choice is not None:
            kwargs["tool_choice"] = _to_anthropic_tool_choice(tool_choice)
        effective_temperature = self._settings.temperature if temperature is None else temperature
        if effective_temperature is not None:
            kwargs["temperature"] = effective_temperature

        response = await self._client.messages.create(**kwargs)
        return from_anthropic_response(response)


class GeminiLLM:
    """Google Gemini adapter for the repo's LLMClient protocol."""

    def __init__(self, settings: LLMSettings, client: Any | None = None) -> None:
        self._settings = settings
        if client is not None:
            self._client = client
            return
        try:
            from google import genai
        except ImportError as exc:
            raise ValueError("缺少 google-genai SDK；请安装 loreweaver[gemini] 或 google-genai。") from exc
        self._client = genai.Client(api_key=settings.api_key or None)

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        del tool_choice  # Gemini SDK handles tool selection through tool config; keep best-effort parity.
        system, contents = to_gemini_contents(messages)
        config = to_gemini_config(
            tools=tools,
            system=system,
            temperature=self._settings.temperature if temperature is None else temperature,
        )
        response = await self._client.aio.models.generate_content(
            model=model or self._settings.chat_model,
            contents=contents,
            config=config,
        )
        return from_gemini_response(response)


def to_anthropic_messages(messages: list[dict]) -> tuple[str | None, list[dict[str, Any]]]:
    """Translate OpenAI-style messages to Anthropic Messages API turns."""

    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system" and not out:
            text = _content_to_text(message.get("content"))
            if text:
                system_parts.append(text)
            continue
        if role == "assistant":
            blocks = _anthropic_text_blocks(message.get("content"))
            for call in message.get("tool_calls") or []:
                function = _get_value(call, "function", {})
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": _get_value(call, "id", ""),
                        "name": _get_value(function, "name", ""),
                        "input": _ensure_dict(_get_value(function, "arguments", {})),
                    }
                )
            out.append({"role": "assistant", "content": blocks or ""})
            continue
        if role == "tool":
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.get("tool_call_id") or message.get("id") or "",
                            "content": _content_to_text(message.get("content")),
                        }
                    ],
                }
            )
            continue
        out.append({"role": "user", "content": _content_to_text(message.get("content"))})
    return ("\n\n".join(system_parts) if system_parts else None), out


def to_anthropic_tools(tools: list[dict] | None) -> list[dict[str, Any]]:
    """Translate OpenAI function tools to Anthropic tool declarations."""

    out: list[dict[str, Any]] = []
    for tool in tools or []:
        function = tool.get("function", tool)
        name = function.get("name")
        if not name:
            continue
        out.append(
            {
                "name": name,
                "description": function.get("description", ""),
                "input_schema": function.get("parameters") or {"type": "object", "properties": {}},
            }
        )
    return out


def from_anthropic_response(response: Any) -> ChatResult:
    text_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    for block in _iter_response_blocks(response):
        block_type = _get_value(block, "type")
        if block_type == "text":
            text = _get_value(block, "text", "")
            if text:
                text_parts.append(text)
        elif block_type == "tool_use":
            tool_calls.append(
                ToolCall(
                    id=_get_value(block, "id", ""),
                    name=_get_value(block, "name", ""),
                    arguments=_ensure_dict(_get_value(block, "input", {})),
                )
            )
    return ChatResult(content="".join(text_parts) or None, tool_calls=tool_calls, raw=response)


def sanitize_gemini_schema(schema: Any) -> dict[str, Any]:
    """Return a Gemini-compatible copy of an OpenAI-style JSON schema."""

    if not isinstance(schema, dict):
        return {}
    cleaned: dict[str, Any] = {}
    for key, value in schema.items():
        if key not in _GEMINI_SCHEMA_ALLOWED_KEYS:
            continue
        if key == "properties":
            if isinstance(value, dict):
                cleaned[key] = {
                    prop_name: sanitize_gemini_schema(prop_schema)
                    for prop_name, prop_schema in value.items()
                    if isinstance(prop_name, str)
                }
            continue
        if key == "items":
            cleaned[key] = sanitize_gemini_schema(value)
            continue
        if key == "anyOf":
            if isinstance(value, list):
                cleaned[key] = [sanitize_gemini_schema(item) for item in value if isinstance(item, dict)]
            continue
        cleaned[key] = value

    enum_value = cleaned.get("enum")
    type_value = cleaned.get("type")
    if isinstance(enum_value, list) and type_value in {"integer", "number", "boolean"}:
        if any(not isinstance(item, str) for item in enum_value):
            cleaned.pop("enum", None)
    return cleaned


def sanitize_gemini_tool_parameters(parameters: Any) -> dict[str, Any]:
    cleaned = sanitize_gemini_schema(parameters)
    return cleaned or {"type": "object", "properties": {}}


def to_gemini_tools(tools: list[dict] | None) -> list[Any]:
    """Translate OpenAI function tools to Gemini Tool declarations."""

    if not tools:
        return []
    try:
        from google.genai import types
    except ImportError as exc:
        raise ValueError("缺少 google-genai SDK；请安装 loreweaver[gemini] 或 google-genai。") from exc

    declarations = []
    for tool in tools:
        function = tool.get("function", tool)
        name = function.get("name")
        if not name:
            continue
        declarations.append(
            types.FunctionDeclaration(
                name=name,
                description=function.get("description", ""),
                parametersJsonSchema=sanitize_gemini_tool_parameters(function.get("parameters")),
            )
        )
    return [types.Tool(functionDeclarations=declarations)] if declarations else []


def to_gemini_contents(messages: list[dict]) -> tuple[str | None, list[Any]]:
    """Translate OpenAI-style messages to Gemini contents."""

    try:
        from google.genai import types
    except ImportError as exc:
        raise ValueError("缺少 google-genai SDK；请安装 loreweaver[gemini] 或 google-genai。") from exc

    system_parts: list[str] = []
    contents: list[Any] = []
    for message in messages:
        role = message.get("role")
        if role == "system" and not contents:
            text = _content_to_text(message.get("content"))
            if text:
                system_parts.append(text)
            continue
        if role == "assistant":
            parts = _gemini_text_parts(message.get("content"))
            for call in message.get("tool_calls") or []:
                function = _get_value(call, "function", {})
                parts.append(
                    types.Part(
                        functionCall=types.FunctionCall(
                            id=_get_value(call, "id", None),
                            name=_get_value(function, "name", ""),
                            args=_ensure_dict(_get_value(function, "arguments", {})),
                        )
                    )
                )
            contents.append(types.Content(role="model", parts=parts))
            continue
        if role == "tool":
            name = message.get("name") or message.get("tool_name") or "tool"
            contents.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            functionResponse=types.FunctionResponse(
                                id=message.get("tool_call_id") or message.get("id") or None,
                                name=name,
                                response={"result": _content_to_text(message.get("content"))},
                            )
                        )
                    ],
                )
            )
            continue
        contents.append(types.Content(role="user", parts=_gemini_text_parts(message.get("content"))))
    return ("\n\n".join(system_parts) if system_parts else None), contents


def to_gemini_config(
    *,
    tools: list[dict] | None,
    system: str | None,
    temperature: float | None,
) -> Any:
    try:
        from google.genai import types
    except ImportError as exc:
        raise ValueError("缺少 google-genai SDK；请安装 loreweaver[gemini] 或 google-genai。") from exc
    kwargs: dict[str, Any] = {}
    gemini_tools = to_gemini_tools(tools)
    if gemini_tools:
        kwargs["tools"] = gemini_tools
    if system:
        kwargs["systemInstruction"] = system
    if temperature is not None:
        kwargs["temperature"] = temperature
    return types.GenerateContentConfig(**kwargs)


def from_gemini_response(response: Any) -> ChatResult:
    text_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    for part in _iter_gemini_parts(response):
        text = _get_value(part, "text", "")
        if text:
            text_parts.append(text)
        function_call = _get_value(part, "functionCall") or _get_value(part, "function_call")
        if function_call:
            tool_calls.append(
                ToolCall(
                    id=_get_value(function_call, "id", "") or "",
                    name=_get_value(function_call, "name", ""),
                    arguments=_ensure_dict(_get_value(function_call, "args", {})),
                )
            )
    if not text_parts:
        text = _get_value(response, "text", "")
        if text:
            text_parts.append(text)
    return ChatResult(content="".join(text_parts) or None, tool_calls=tool_calls, raw=response)


def _to_anthropic_tool_choice(tool_choice: str | dict) -> Any:
    if isinstance(tool_choice, str):
        if tool_choice in {"auto", "any", "none"}:
            return {"type": tool_choice}
        return {"type": "tool", "name": tool_choice}
    return tool_choice


def _anthropic_text_blocks(content: Any) -> list[dict[str, str]]:
    text = _content_to_text(content)
    return [{"type": "text", "text": text}] if text else []


def _gemini_text_parts(content: Any) -> list[Any]:
    from google.genai import types

    text = _content_to_text(content)
    return [types.Part(text=text)] if text else []


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(str(item.get("text", "")))
                elif "text" in item:
                    parts.append(str(item["text"]))
                else:
                    parts.append(str(item))
            else:
                parts.append(str(item))
        return "".join(parts)
    return str(content)


def _ensure_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        import json

        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _get_value(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _iter_response_blocks(response: Any) -> Iterable[Any]:
    content = _get_value(response, "content", [])
    return content or []


def _iter_gemini_parts(response: Any) -> Iterable[Any]:
    candidates = _get_value(response, "candidates", None)
    if candidates:
        for candidate in candidates:
            content = _get_value(candidate, "content", None)
            yield from (_get_value(content, "parts", []) or [])
        return
    content = _get_value(response, "content", None)
    if content:
        yield from (_get_value(content, "parts", []) or [])
        return
    yield from (_get_value(response, "parts", []) or [])
