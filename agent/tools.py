"""`@tool` decorator + `Toolset` — AI-KP function-calling schema generation and dispatch.

Marking an async provider method with `@tool` attaches an OpenAI
function-calling schema (built lazily from the method's type hints and
docstring) without altering its behavior. `Toolset` collects every
`@tool`-decorated method across one or more provider objects and dispatches
named tool calls to them, coercing JSON-ish arguments (e.g. the int-like
strings some models emit) to the method's declared parameter types.

Standalone by design: stdlib + typing only, plus `agent.context.AgentCtx`
(same layer) and `infra.i18n` for the two user/model-visible error strings
`dispatch()` can return (unknown tool name, bad/missing arguments) — it
never raises those into the calling loop.
"""

from __future__ import annotations

import inspect
import json
import re
import types
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Union, get_args, get_origin, get_type_hints

from agent.context import AgentCtx
from infra.i18n import t

# `self` is bound automatically; `ctx`/`_ctx` is injected positionally by
# `Toolset.dispatch`. Neither belongs in the schema or the coerced kwargs.
_SKIPPED_PARAMS = {"self", "ctx", "_ctx"}

_JSON_TYPE_MAP: dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
}

_ARGS_HEADER_RE = re.compile(r"^\s*Args:\s*$")
_ARG_LINE_RE = re.compile(r"^(?P<indent>\s+)(?P<name>\**\w+)\s*(?:\([^)]*\))?:\s*(?P<desc>.*)$")


class ToolArgumentError(Exception):
    """Raised when an incoming argument can't be coerced to its declared type.

    Caught internally by `Toolset.dispatch`, which turns it into a localized
    error string; this never escapes to the caller.
    """


@dataclass
class ToolMeta:
    """Metadata `@tool` attaches to the decorated function as `__tool_meta__`."""

    fn: Callable[..., Any]
    name: str
    description: str
    keeper_only: bool
    param_descriptions: dict[str, str]
    _schema: dict[str, Any] | None = field(default=None, init=False, repr=False, compare=False)

    def schema(self) -> dict[str, Any]:
        """Build the OpenAI function-calling schema on first use, then cache it."""
        if self._schema is None:
            self._schema = _build_schema(self.fn, self.name, self.description, self.param_descriptions)
        return self._schema


def tool(
    fn: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
    keeper_only: bool = False,
    params: dict[str, str] | None = None,
):
    """Mark an async method as an AI-KP tool. Schema is generated from type hints + docstring.

    Usable bare (`@tool`) or parameterized (`@tool(keeper_only=True, params={...})`).
    `params` optionally maps `param_name -> human description`; `keeper_only`
    flags red-line tools that must never be quoted directly to players.
    Attaches the metadata to the function as `__tool_meta__`; the function's
    behavior is otherwise unchanged.
    """

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        func.__tool_meta__ = ToolMeta(
            fn=func,
            name=name or func.__name__,
            description=description or _first_doc_line(func.__doc__),
            keeper_only=keeper_only,
            param_descriptions=dict(params or {}),
        )
        return func

    return decorator(fn) if fn is not None else decorator


@dataclass
class _ToolEntry:
    meta: ToolMeta
    bound: Callable[..., Any]


def _is_tool_method(member: Any) -> bool:
    return callable(member) and hasattr(member, "__tool_meta__")


class Toolset:
    """Collects every `@tool`-decorated method across one or more provider objects."""

    def __init__(self, *providers: Any) -> None:
        self._entries: dict[str, _ToolEntry] = {}
        for provider in providers:
            for _, bound_method in inspect.getmembers(provider, predicate=_is_tool_method):
                meta: ToolMeta = bound_method.__tool_meta__
                self._entries[meta.name] = _ToolEntry(meta=meta, bound=bound_method)

    def schemas(self) -> list[dict[str, Any]]:
        """OpenAI function-calling schema list, one entry per collected tool."""
        return [entry.meta.schema() for entry in self._entries.values()]

    def names(self) -> list[str]:
        return list(self._entries.keys())

    def is_keeper_only(self, name: str) -> bool:
        entry = self._entries.get(name)
        return entry.meta.keeper_only if entry is not None else False

    async def dispatch(self, name: str, ctx: AgentCtx, arguments: dict[str, Any]) -> str:
        """Look up `name`, coerce `arguments` to its parameter types, call it, and
        guarantee a `str` result.

        Never raises into the caller: an unknown tool name or bad/missing
        arguments both come back as a localized error string instead.
        """
        entry = self._entries.get(name)
        if entry is None:
            return t("agent.tools.unknown_tool", locale=ctx.locale, name=name)

        try:
            coerced = _coerce_arguments(entry.meta.fn, arguments or {})
            result = await entry.bound(ctx, **coerced)
        except ToolArgumentError as exc:
            return t("agent.tools.bad_arguments", locale=ctx.locale, name=name, error=str(exc))
        except TypeError as exc:
            return t("agent.tools.bad_arguments", locale=ctx.locale, name=name, error=str(exc))

        return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Schema generation
# ---------------------------------------------------------------------------


def _build_schema(
    fn: Callable[..., Any],
    name: str,
    description: str,
    param_descriptions: dict[str, str],
) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": _build_parameters_schema(fn, param_descriptions),
        },
    }


def _build_parameters_schema(fn: Callable[..., Any], param_descriptions: dict[str, str]) -> dict[str, Any]:
    signature = inspect.signature(fn)
    hints = _resolve_type_hints(fn)
    descriptions = _parse_docstring_args(fn.__doc__)
    descriptions.update(param_descriptions)  # explicit params= wins over the docstring

    properties: dict[str, Any] = {}
    required: list[str] = []
    for param_name, param in signature.parameters.items():
        if _skip_param(param_name, param):
            continue

        annotation = hints.get(param_name, param.annotation)
        prop_schema = _schema_for_type(annotation)
        description = descriptions.get(param_name)
        if description:
            prop_schema["description"] = description
        properties[param_name] = prop_schema

        has_default = param.default is not inspect.Parameter.empty
        if not has_default and not _is_optional(annotation):
            required.append(param_name)

    return {"type": "object", "properties": properties, "required": required}


def _skip_param(param_name: str, param: inspect.Parameter) -> bool:
    return param_name in _SKIPPED_PARAMS or param.kind in (
        inspect.Parameter.VAR_POSITIONAL,
        inspect.Parameter.VAR_KEYWORD,
    )


def _resolve_type_hints(fn: Callable[..., Any]) -> dict[str, Any]:
    try:
        return get_type_hints(fn)
    except NameError:
        # A forward reference that isn't resolvable yet (e.g. a not-quite-
        # importable annotation). Degrade to per-parameter `inspect`
        # annotations rather than failing the whole schema build.
        return {}


def _schema_for_type(annotation: Any) -> dict[str, Any]:
    """Map a resolved type annotation to a JSON Schema fragment.

    `Optional[T]`/`T | None` unwraps to `T`'s schema (optionality itself is
    reflected via the `required` list, not here). Everything not explicitly
    covered (`dict`, `Any`, unannotated, other classes) becomes a generic object.
    """
    if annotation is inspect.Parameter.empty or annotation is Any:
        return {"type": "object"}

    if _is_union(annotation):
        non_none = [arg for arg in get_args(annotation) if arg is not type(None)]
        return _schema_for_type(non_none[0]) if len(non_none) == 1 else {"type": "object"}

    if annotation in _JSON_TYPE_MAP:
        return {"type": _JSON_TYPE_MAP[annotation]}

    origin = get_origin(annotation)
    if origin in (list, set, tuple, frozenset):
        args = get_args(annotation)
        item_schema = _schema_for_type(args[0]) if args else {"type": "object"}
        return {"type": "array", "items": item_schema}

    return {"type": "object"}


def _is_union(annotation: Any) -> bool:
    return get_origin(annotation) in (Union, types.UnionType)


def _is_optional(annotation: Any) -> bool:
    return _is_union(annotation) and type(None) in get_args(annotation)


def _first_doc_line(doc: str | None) -> str:
    if not doc:
        return ""
    for line in doc.strip().splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def _parse_docstring_args(doc: str | None) -> dict[str, str]:
    """Parse a Google-style `Args:` block into `{param_name: description}`."""
    if not doc:
        return {}

    descriptions: dict[str, str] = {}
    in_args = False
    args_indent: int | None = None
    for line in doc.splitlines():
        if _ARGS_HEADER_RE.match(line):
            in_args = True
            args_indent = None
            continue
        if not in_args or not line.strip():
            continue

        indent = len(line) - len(line.lstrip())
        if args_indent is None:
            args_indent = indent
        elif indent < args_indent:
            break  # dedented past the Args block (e.g. into a Returns: section)

        match = _ARG_LINE_RE.match(line)
        if match and indent == args_indent:
            descriptions[match.group("name").lstrip("*")] = match.group("desc").strip()

    return descriptions


# ---------------------------------------------------------------------------
# Argument coercion
# ---------------------------------------------------------------------------


def _coerce_arguments(fn: Callable[..., Any], arguments: dict[str, Any]) -> dict[str, Any]:
    signature = inspect.signature(fn)
    hints = _resolve_type_hints(fn)

    coerced: dict[str, Any] = {}
    for param_name, param in signature.parameters.items():
        if _skip_param(param_name, param):
            continue

        annotation = hints.get(param_name, param.annotation)
        if param_name not in arguments:
            if param.default is not inspect.Parameter.empty:
                continue  # the method's own default applies
            if _is_optional(annotation):
                coerced[param_name] = None  # Optional[T] with no explicit default -> None
                continue
            raise ToolArgumentError(f"missing required argument {param_name!r}")

        coerced[param_name] = _coerce_value(arguments[param_name], annotation)

    return coerced


def _coerce_value(value: Any, annotation: Any) -> Any:
    if value is None:
        return None

    if _is_union(annotation):
        non_none = [arg for arg in get_args(annotation) if arg is not type(None)]
        return _coerce_value(value, non_none[0]) if len(non_none) == 1 else value

    if annotation is str:
        return value if isinstance(value, str) else str(value)
    if annotation is bool:
        return _coerce_bool(value)
    if annotation is int:
        return _coerce_int(value)
    if annotation is float:
        return _coerce_float(value)

    origin = get_origin(annotation)
    if origin in (list, set, tuple, frozenset):
        if not isinstance(value, (list, tuple, set)):
            raise ToolArgumentError(f"expected a list, got {value!r}")
        args = get_args(annotation)
        item_type = args[0] if args else Any
        coerced_items = [_coerce_value(item, item_type) for item in value]
        return coerced_items if origin is list else origin(coerced_items)

    return value  # dict/Any/unannotated -> passthrough as-is


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        if lowered in {"false", "0", "no", "n", "off"}:
            return False
    raise ToolArgumentError(f"cannot coerce {value!r} to bool")


def _coerce_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError as exc:
            raise ToolArgumentError(f"cannot coerce {value!r} to int") from exc
    raise ToolArgumentError(f"cannot coerce {value!r} to int")


def _coerce_float(value: Any) -> float:
    if isinstance(value, bool):
        raise ToolArgumentError(f"cannot coerce {value!r} to float")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError as exc:
            raise ToolArgumentError(f"cannot coerce {value!r} to float") from exc
    raise ToolArgumentError(f"cannot coerce {value!r} to float")
