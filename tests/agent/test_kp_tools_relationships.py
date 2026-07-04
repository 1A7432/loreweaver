"""Tests for agent.kp_tools_relationships: the `adjust_relationship`/`set_relationship`/
`get_relationships` GATED tools (Layer B.2, `docs/plugins.md` "Layer B") over
`core.relationships.RelationshipManager`.

Covers: (a) `adjust_relationship` persists + returns a localized confirmation; (b)
`set_relationship` sets an exact (clamped) value; (c) `get_relationships` filters by entity and
reports an empty notice; (d) bad track/delta input is handled without raising; and (e) the Layer
B.2 gating contract -- absent from `Toolset.schemas()` by default, present once unlocked, and
refused by `Toolset.dispatch()` while locked -- mirroring `tests/agent/test_kp_tools_forge.py`'s
gating coverage.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_relationships import RelationshipTools
from agent.services import Services, build_services
from agent.tools import Toolset
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import t
from infra.llm import FakeLLM


def _build() -> tuple[Services, AgentCtx]:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key="chat-relationships", user_id="kp", locale="en")
    return services, ctx


# ---------------------------------------------------------------------------
# adjust_relationship
# ---------------------------------------------------------------------------


async def test_adjust_relationship_persists_and_returns_localized_done():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 15)

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t(
        "relationships.tools.adjust.done",
        subject="Alice",
        target="Bob",
        track=i18n.t("relationships.track.affection"),
        old=0,
        new=15,
        delta=15,
    )

    raw = await services.store.get(user_key="", store_key=f"relationships.{ctx.chat_key}")
    assert raw is not None
    assert '"affection": 15' in raw or '"affection":15' in raw


async def test_adjust_relationship_accumulates_across_calls():
    services, ctx = _build()
    tools = RelationshipTools(services)

    await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 15)
    result = await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", -5)

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t(
        "relationships.tools.adjust.done",
        subject="Alice",
        target="Bob",
        track=i18n.t("relationships.track.affection"),
        old=15,
        new=10,
        delta=-5,
    )


async def test_adjust_relationship_clamps_at_the_tracks_boundary():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.adjust_relationship(ctx, "Alice", "Bob", "desire", 500)

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t(
        "relationships.tools.adjust.done",
        subject="Alice",
        target="Bob",
        track=i18n.t("relationships.track.desire"),
        old=0,
        new=100,
        delta=500,
    )


async def test_adjust_relationship_bad_track_is_reported_without_raising():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.adjust_relationship(ctx, "Alice", "Bob", "nonexistent-track", 5)

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("relationships.tools.bad_track", allowed="affection, desire")


async def test_adjust_relationship_bad_delta_via_direct_call_is_reported_without_raising():
    services, ctx = _build()
    tools = RelationshipTools(services)

    # Bypassing Toolset's own int coercion (a direct python call, as a bad-delta unit test) --
    # the tool's own `coerce_int` guard must still catch this rather than raising.
    result = await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", "not-a-number")  # type: ignore[arg-type]

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("relationships.tools.bad_delta")


async def test_adjust_relationship_accepts_an_optional_reason():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 5, reason="a kind gesture")

    assert "Alice" in result and "Bob" in result


# ---------------------------------------------------------------------------
# set_relationship
# ---------------------------------------------------------------------------


async def test_set_relationship_stores_the_clamped_value():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.set_relationship(ctx, "Alice", "Bob", "affection", -500)

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t(
        "relationships.tools.set.done",
        subject="Alice",
        target="Bob",
        track=i18n.t("relationships.track.affection"),
        value=-100,
    )


async def test_set_relationship_bad_track_is_reported_without_raising():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.set_relationship(ctx, "Alice", "Bob", "nonexistent-track", 5)

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("relationships.tools.bad_track", allowed="affection, desire")


async def test_set_relationship_bad_value_via_direct_call_is_reported_without_raising():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.set_relationship(ctx, "Alice", "Bob", "affection", "not-a-number")  # type: ignore[arg-type]

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("relationships.tools.bad_delta")


# ---------------------------------------------------------------------------
# get_relationships
# ---------------------------------------------------------------------------


async def test_get_relationships_empty_reports_localized_empty_notice():
    services, ctx = _build()
    tools = RelationshipTools(services)

    result = await tools.get_relationships(ctx)

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("relationships.tools.get.empty")


async def test_get_relationships_returns_header_and_all_lines_when_entity_is_empty():
    services, ctx = _build()
    tools = RelationshipTools(services)
    await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 15)
    await tools.adjust_relationship(ctx, "Carol", "Dave", "desire", 20)

    result = await tools.get_relationships(ctx)

    i18n = services.i18n.with_locale("en")
    assert i18n.t("relationships.tools.get.header") in result
    assert "Alice" in result and "Bob" in result
    assert "Carol" in result and "Dave" in result


async def test_get_relationships_filters_by_entity_as_subject():
    services, ctx = _build()
    tools = RelationshipTools(services)
    await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 15)
    await tools.adjust_relationship(ctx, "Carol", "Dave", "desire", 20)

    result = await tools.get_relationships(ctx, entity="Alice")

    assert "Alice" in result and "Bob" in result
    assert "Carol" not in result and "Dave" not in result


async def test_get_relationships_filters_by_entity_as_target():
    services, ctx = _build()
    tools = RelationshipTools(services)
    await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 15)
    await tools.adjust_relationship(ctx, "Carol", "Dave", "desire", 20)

    result = await tools.get_relationships(ctx, entity="Dave")

    assert "Carol" in result and "Dave" in result
    assert "Alice" not in result and "Bob" not in result


async def test_get_relationships_entity_filter_is_case_insensitive():
    services, ctx = _build()
    tools = RelationshipTools(services)
    await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 15)

    result = await tools.get_relationships(ctx, entity="alice")

    assert "Alice" in result and "Bob" in result


async def test_get_relationships_entity_filter_with_no_match_reports_empty_notice():
    services, ctx = _build()
    tools = RelationshipTools(services)
    await tools.adjust_relationship(ctx, "Alice", "Bob", "affection", 15)

    result = await tools.get_relationships(ctx, entity="Zorblax")

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("relationships.tools.get.empty")


# ---------------------------------------------------------------------------
# Layer B.2 gating -- absent by default, present once unlocked, refused while locked.
# ---------------------------------------------------------------------------

_TOOL_NAMES = ("adjust_relationship", "set_relationship", "get_relationships")


def test_relationship_tools_are_gated_and_not_keeper_only():
    services, _ctx = _build()
    toolset = Toolset(RelationshipTools(services))

    for name in _TOOL_NAMES:
        assert toolset.is_gated(name) is True
        assert toolset.is_keeper_only(name) is False


def test_relationship_tools_hidden_from_schemas_by_default():
    services, _ctx = _build()
    toolset = build_kp_toolset(services)

    names = {schema["function"]["name"] for schema in toolset.schemas()}
    for name in _TOOL_NAMES:
        assert name not in names


def test_relationship_tools_hidden_when_a_different_tool_is_unlocked():
    services, _ctx = _build()
    toolset = build_kp_toolset(services)

    names = {schema["function"]["name"] for schema in toolset.schemas(unlocked={"some_other_tool"})}
    for name in _TOOL_NAMES:
        assert name not in names


def test_relationship_tools_present_once_unlocked():
    services, _ctx = _build()
    toolset = build_kp_toolset(services)

    names = {schema["function"]["name"] for schema in toolset.schemas(unlocked=set(_TOOL_NAMES))}
    for name in _TOOL_NAMES:
        assert name in names


async def test_dispatch_refuses_a_locked_relationship_tool_with_a_localized_message():
    services, ctx = _build()
    toolset = build_kp_toolset(services)

    result = await toolset.dispatch("adjust_relationship", ctx, {"subject": "Alice", "target": "Bob", "track": "affection", "delta": 5})

    assert result == t("agent.tools.tool_not_available", name="adjust_relationship")


async def test_dispatch_runs_a_relationship_tool_once_unlocked():
    services, ctx = _build()
    toolset = build_kp_toolset(services)

    result = await toolset.dispatch(
        "adjust_relationship",
        ctx,
        {"subject": "Alice", "target": "Bob", "track": "affection", "delta": 5},
        unlocked={"adjust_relationship"},
    )

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t(
        "relationships.tools.adjust.done",
        subject="Alice",
        target="Bob",
        track=i18n.t("relationships.track.affection"),
        old=0,
        new=5,
        delta=5,
    )
