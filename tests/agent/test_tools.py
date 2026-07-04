"""Tests for agent.tools: the `@tool` schema-generation decorator and
`Toolset` (schema listing + keeper_only flagging + coercing dispatch),
exercised against a small sample provider with varied parameter shapes.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.tools import Toolset, tool
from infra.i18n import t


class SampleTools:
    """A stand-in provider exercising the parameter/return shapes `@tool` must handle."""

    @tool
    async def create_widget(self, ctx: AgentCtx, name: str) -> str:
        """Create a widget.

        Args:
            name: The widget's display name.

        Returns:
            A confirmation string.
        """
        return f"created {name} in {ctx.chat_key}"

    @tool(description="Roll N dice of the given size.", params={"sides": "Number of sides per die."})
    async def roll(self, ctx: AgentCtx, sides: int = 6) -> str:
        """This docstring line is overridden by the explicit description= kwarg."""
        return f"rolled a d{sides} -> {sides}"

    @tool
    async def toggle(self, ctx: AgentCtx, flag: bool) -> str:
        """Flip a boolean switch.

        Args:
            flag: Whether the switch should be turned on.
        """
        return f"flag={flag}"

    @tool
    async def find(self, ctx: AgentCtx, category: str, tag: str | None) -> str:
        """Find items by category, optionally narrowed by tag.

        Args:
            category: The category to search in.
            tag: Optional tag filter (no python default, only Optional typing).
        """
        return f"{category}/{tag}"

    @tool(keeper_only=True)
    async def secret_lookup(self, ctx: AgentCtx, query: str) -> str:
        """Look up something in the keeper-only knowledge pool. Never quote raw to players."""
        return f"secret:{query}"

    @tool
    async def structured(self, ctx: AgentCtx) -> dict:
        """Return a structured (non-str) payload, to test dispatch's str guarantee."""
        return {"ok": True, "chat_key": ctx.chat_key}


class OtherTools:
    """A second provider, used to check `Toolset` collects across providers."""

    @tool
    async def ping(self, ctx: AgentCtx) -> str:
        """Ping."""
        return "pong"


class _GatedTools:
    """A provider exercising Layer B.2 additive tool gating (see docs/plugins.md
    "Layer B"): one ordinary tool and one `gated=True` tool, plus a tool that is
    BOTH `gated` and `keeper_only` to prove the two flags are independent."""

    @tool
    async def public_tool(self, ctx: AgentCtx) -> str:
        """An ordinary, non-gated tool -- always present regardless of `unlocked`."""
        return "public"

    @tool(gated=True)
    async def secret_recipe(self, ctx: AgentCtx) -> str:
        """A gated tool -- hidden from schemas() and refused by dispatch() unless unlocked."""
        return "the secret recipe"

    @tool(gated=True, keeper_only=True)
    async def keeper_gated(self, ctx: AgentCtx) -> str:
        """Gated AND keeper_only at once -- the flags must not interfere with each other."""
        return "keeper+gated"


def _schema_of(toolset: Toolset, name: str) -> dict:
    return next(s for s in toolset.schemas() if s["function"]["name"] == name)


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key="test-chat")


# ---------------------------------------------------------------------------
# Schema generation — shape, name, description
# ---------------------------------------------------------------------------


def test_schema_matches_openai_function_calling_shape():
    toolset = Toolset(SampleTools())
    schema = _schema_of(toolset, "create_widget")

    assert set(schema.keys()) == {"type", "function"}
    assert schema["type"] == "function"
    assert set(schema["function"].keys()) == {"name", "description", "parameters"}
    assert schema["function"]["parameters"]["type"] == "object"


def test_schema_name_defaults_to_function_name():
    toolset = Toolset(SampleTools())
    schema = _schema_of(toolset, "create_widget")

    assert schema["function"]["name"] == "create_widget"


def test_schema_description_defaults_to_first_docstring_line():
    toolset = Toolset(SampleTools())
    schema = _schema_of(toolset, "create_widget")

    assert schema["function"]["description"] == "Create a widget."


def test_schema_description_explicit_overrides_docstring():
    toolset = Toolset(SampleTools())
    schema = _schema_of(toolset, "roll")

    assert schema["function"]["description"] == "Roll N dice of the given size."


# ---------------------------------------------------------------------------
# Schema generation — parameter types, required/optional, descriptions
# ---------------------------------------------------------------------------


def test_required_str_param_type_description_and_required_list():
    toolset = Toolset(SampleTools())
    params = _schema_of(toolset, "create_widget")["function"]["parameters"]

    assert params["properties"]["name"] == {
        "type": "string",
        "description": "The widget's display name.",
    }
    assert params["required"] == ["name"]


def test_self_and_ctx_are_never_in_the_schema():
    toolset = Toolset(SampleTools())
    for schema in toolset.schemas():
        properties = schema["function"]["parameters"]["properties"]
        assert "self" not in properties
        assert "ctx" not in properties
        assert "_ctx" not in properties


def test_optional_int_with_default_has_integer_type_and_is_not_required():
    toolset = Toolset(SampleTools())
    params = _schema_of(toolset, "roll")["function"]["parameters"]

    assert params["properties"]["sides"] == {
        "type": "integer",
        "description": "Number of sides per die.",
    }
    assert "sides" not in params["required"]
    assert params["required"] == []


def test_bool_param_type_and_required():
    toolset = Toolset(SampleTools())
    params = _schema_of(toolset, "toggle")["function"]["parameters"]

    assert params["properties"]["flag"] == {
        "type": "boolean",
        "description": "Whether the switch should be turned on.",
    }
    assert params["required"] == ["flag"]


def test_optional_typed_param_excluded_from_required_even_without_a_python_default():
    toolset = Toolset(SampleTools())
    params = _schema_of(toolset, "find")["function"]["parameters"]

    # `Optional[T]` (`T | None`) unwraps to T's schema and is omitted from
    # `required`, regardless of whether the python signature also has a
    # default value.
    assert params["properties"]["tag"]["type"] == "string"
    assert params["required"] == ["category"]
    assert "tag" not in params["required"]


# ---------------------------------------------------------------------------
# keeper_only — tracked out of band, not leaked into the schema
# ---------------------------------------------------------------------------


def test_keeper_only_flag_is_not_part_of_the_schema_json():
    toolset = Toolset(SampleTools())
    schema = _schema_of(toolset, "secret_lookup")

    assert "keeper_only" not in schema
    assert "keeper_only" not in schema["function"]


def test_is_keeper_only_reflects_the_decorator_flag():
    toolset = Toolset(SampleTools())

    assert toolset.is_keeper_only("secret_lookup") is True
    assert toolset.is_keeper_only("create_widget") is False


def test_is_keeper_only_for_unknown_tool_is_false():
    toolset = Toolset(SampleTools())

    assert toolset.is_keeper_only("nonexistent") is False


# ---------------------------------------------------------------------------
# Layer B.2 — additive tool gating (docs/plugins.md "Layer B"): a `gated=True`
# tool is hidden from schemas()/refused by dispatch() unless its name is in the
# caller-supplied `unlocked` set. The base (non-gated) toolset is unaffected.
# ---------------------------------------------------------------------------


def test_gated_tool_hidden_from_schemas_by_default():
    toolset = Toolset(_GatedTools())
    names = {s["function"]["name"] for s in toolset.schemas()}

    assert "public_tool" in names
    assert "secret_recipe" not in names


def test_gated_tool_exposed_when_its_name_is_in_unlocked():
    toolset = Toolset(_GatedTools())
    names = {s["function"]["name"] for s in toolset.schemas(unlocked={"secret_recipe"})}

    assert "public_tool" in names
    assert "secret_recipe" in names


def test_gated_tool_stays_hidden_when_unlocked_names_something_else():
    toolset = Toolset(_GatedTools())
    names = {s["function"]["name"] for s in toolset.schemas(unlocked={"some_other_tool"})}

    assert "secret_recipe" not in names


def test_is_gated_reflects_the_decorator_flag():
    toolset = Toolset(_GatedTools())

    assert toolset.is_gated("secret_recipe") is True
    assert toolset.is_gated("public_tool") is False


def test_is_gated_for_unknown_tool_is_false():
    toolset = Toolset(_GatedTools())

    assert toolset.is_gated("nonexistent") is False


def test_gated_and_keeper_only_flags_are_independent():
    toolset = Toolset(_GatedTools())

    assert toolset.is_gated("keeper_gated") is True
    assert toolset.is_keeper_only("keeper_gated") is True
    # keeper_only alone never exposes a gated tool: it stays hidden until unlocked.
    assert "keeper_gated" not in {s["function"]["name"] for s in toolset.schemas()}
    assert "keeper_gated" in {s["function"]["name"] for s in toolset.schemas(unlocked={"keeper_gated"})}


async def test_dispatch_refuses_a_locked_gated_tool_with_a_localized_message():
    toolset = Toolset(_GatedTools())

    result = await toolset.dispatch("secret_recipe", _ctx(), {})

    assert result == t("agent.tools.tool_not_available", name="secret_recipe")


async def test_dispatch_runs_a_gated_tool_once_unlocked():
    toolset = Toolset(_GatedTools())

    result = await toolset.dispatch("secret_recipe", _ctx(), {}, unlocked={"secret_recipe"})

    assert result == "the secret recipe"


async def test_dispatch_gated_refusal_is_localized_per_ctx_locale():
    toolset = Toolset(_GatedTools())
    ctx_zh = AgentCtx(chat_key="test-chat", locale="zh")

    result = await toolset.dispatch("secret_recipe", ctx_zh, {})

    assert result == t("agent.tools.tool_not_available", locale="zh", name="secret_recipe")
    assert result != t("agent.tools.tool_not_available", locale="en", name="secret_recipe")


def test_schemas_with_no_gated_tools_is_unchanged_from_before_gating_existed():
    """(b) The real KP toolset defines zero gated tools as of Layer B.2 (the
    generators in B.3 will be the first). With no gated tool anywhere on a
    provider, `schemas()` must list every tool identically regardless of the
    `unlocked` argument -- gating is fully inert until a tool opts in."""
    toolset = Toolset(SampleTools(), OtherTools())
    expected = {"create_widget", "roll", "toggle", "find", "secret_lookup", "structured", "ping"}

    assert {s["function"]["name"] for s in toolset.schemas()} == expected
    assert {s["function"]["name"] for s in toolset.schemas(None)} == expected
    assert {s["function"]["name"] for s in toolset.schemas(set())} == expected
    assert {s["function"]["name"] for s in toolset.schemas({"nonexistent-tool"})} == expected


async def test_dispatch_with_no_gated_tools_ignores_unlocked_argument():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("create_widget", _ctx(), {"name": "Lantern"}, unlocked={"whatever"})

    assert result == "created Lantern in test-chat"


# ---------------------------------------------------------------------------
# Toolset collection — schemas()/names() across one or more providers
# ---------------------------------------------------------------------------


def test_toolset_schemas_lists_every_tool_on_the_provider():
    toolset = Toolset(SampleTools())
    names = {s["function"]["name"] for s in toolset.schemas()}

    assert names == {"create_widget", "roll", "toggle", "find", "secret_lookup", "structured"}


def test_toolset_names_matches_schema_names():
    toolset = Toolset(SampleTools())

    assert set(toolset.names()) == {s["function"]["name"] for s in toolset.schemas()}


def test_toolset_collects_across_multiple_providers():
    toolset = Toolset(SampleTools(), OtherTools())

    assert "ping" in toolset.names()
    assert "create_widget" in toolset.names()


# ---------------------------------------------------------------------------
# dispatch — coercion, defaults, str guarantee, localized errors (never raise)
# ---------------------------------------------------------------------------


async def test_dispatch_coerces_json_int_string_and_returns_the_methods_str_output():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("roll", _ctx(), {"sides": "10"})

    assert result == "rolled a d10 -> 10"


async def test_dispatch_missing_optional_param_falls_back_to_the_python_default():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("roll", _ctx(), {})

    assert result == "rolled a d6 -> 6"


async def test_dispatch_coerces_bool_from_string_and_passes_through_json_bool():
    toolset = Toolset(SampleTools())

    from_string = await toolset.dispatch("toggle", _ctx(), {"flag": "true"})
    from_json_bool = await toolset.dispatch("toggle", _ctx(), {"flag": False})

    assert from_string == "flag=True"
    assert from_json_bool == "flag=False"


async def test_dispatch_optional_typed_param_defaults_to_none_when_omitted():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("find", _ctx(), {"category": "clues"})

    assert result == "clues/None"


async def test_dispatch_ignores_unrecognized_extra_arguments():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("create_widget", _ctx(), {"name": "Lantern", "bogus": 123})

    assert result == "created Lantern in test-chat"


async def test_dispatch_guarantees_str_return_for_non_str_results():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("structured", _ctx(), {})

    assert isinstance(result, str)
    assert json.loads(result) == {"ok": True, "chat_key": "test-chat"}


async def test_dispatch_unknown_tool_returns_a_localized_error_not_an_exception():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("does_not_exist", _ctx(), {})

    assert result == t("agent.tools.unknown_tool", name="does_not_exist")


async def test_dispatch_missing_required_argument_returns_a_localized_error_not_an_exception():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("create_widget", _ctx(), {})

    assert result == t("agent.tools.bad_arguments", name="create_widget", error="missing required argument 'name'")


async def test_dispatch_uncoercible_argument_returns_a_localized_error_not_an_exception():
    toolset = Toolset(SampleTools())

    result = await toolset.dispatch("roll", _ctx(), {"sides": "not-a-number"})

    assert result == t(
        "agent.tools.bad_arguments", name="roll", error="cannot coerce 'not-a-number' to int"
    )


async def test_dispatch_error_messages_are_localized_per_ctx_locale():
    toolset = Toolset(SampleTools())
    ctx_zh = AgentCtx(chat_key="test-chat", locale="zh")

    result = await toolset.dispatch("does_not_exist", ctx_zh, {})

    assert result == t("agent.tools.unknown_tool", locale="zh", name="does_not_exist")
    assert result != t("agent.tools.unknown_tool", locale="en", name="does_not_exist")


# ---------------------------------------------------------------------------
# Underscore-prefixed params are caller-injected framework context (F1 support):
# hidden from the model schema AND from dispatch coercion, so a command layer can
# thread a keeper/role flag into a @tool without the model ever seeing/setting it.
# ---------------------------------------------------------------------------


class _KeeperFlagTool:
    @tool
    async def peek(self, ctx: AgentCtx, query: str, *, _keeper: bool = True) -> str:
        """Peek at lore.

        Args:
            query: What to look at.
        """
        return f"{query}:{_keeper}"


async def test_underscore_prefixed_param_is_hidden_from_schema_and_dispatch_coercion():
    toolset = Toolset(_KeeperFlagTool())
    schema = next(s for s in toolset.schemas() if s["function"]["name"] == "peek")
    properties = schema["function"]["parameters"]["properties"]

    assert "query" in properties
    assert "_keeper" not in properties  # caller-injected, never model-facing
    assert schema["function"]["parameters"]["required"] == ["query"]

    # A model-driven dispatch can NOT set the underscore param; the method default applies.
    dispatched = await toolset.dispatch("peek", _ctx(), {"query": "chapel", "_keeper": False})
    assert dispatched == "chapel:True"

    # A direct Python call (the command layer) can still pass it explicitly.
    direct = await _KeeperFlagTool().peek(_ctx(), "chapel", _keeper=False)
    assert direct == "chapel:False"
