"""Tests for agent.kp_tools_vars: the `define_variable`/`set_variable`/`adjust_variable`/
`remove_variable` tools over `core.modvars`'s document-persisted variable state.

Covers: (a) define persists a validated spec + default value and returns a localized
confirmation; (b) set/adjust validate + clamp against the spec; (c) model-friendly id
normalization ("Town Fear" resolves to town_fear); (d) bad kind/visibility/id/value input is
handled without raising; (e) the tools are ungated and present in the assembled KP toolset; and
(f) locale threading — a zh room gets zh tool text.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_vars import ModuleVarTools
from agent.services import Services, build_services
from core.modvars import load_modvars
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _build(locale: str = "en") -> tuple[Services, AgentCtx]:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key="chat-modvars", user_id="kp", locale=locale)
    return services, ctx


# ---------------------------------------------------------------------------
# define_variable
# ---------------------------------------------------------------------------


async def test_define_variable_persists_spec_and_default():
    services, ctx = _build()
    tools = ModuleVarTools(services)

    result = await tools.define_variable(
        ctx, "Town Fear", "number", label="Town Fear", minimum=0, maximum=10
    )

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t(
        "modvars.tools.define.done",
        label="Town Fear",
        id="town_fear",
        kind="number",
        visibility=i18n.t("modvars.visibility.player"),
        value=0,
    )
    stored = await load_modvars(services.documents, ctx.chat_key)
    assert stored["specs"]["town_fear"]["minimum"] == 0
    assert stored["values"]["town_fear"] == 0


async def test_define_variable_rejects_bad_kind_visibility_and_id():
    services, ctx = _build()
    tools = ModuleVarTools(services)
    i18n = services.i18n.with_locale("en")

    assert await tools.define_variable(ctx, "x", "float") == i18n.t(
        "modvars.tools.bad_kind", allowed="number, bool, text, enum"
    )
    assert await tools.define_variable(ctx, "x", "number", visibility="everyone") == i18n.t(
        "modvars.tools.bad_visibility", allowed="player, keeper"
    )
    assert await tools.define_variable(ctx, "!!!", "number") == i18n.t("modvars.tools.bad_id")


async def test_define_variable_enum_without_options_reports_failed():
    services, ctx = _build()
    tools = ModuleVarTools(services)

    result = await tools.define_variable(ctx, "mood", "enum")

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("modvars.tools.failed", error="enum kind needs a non-empty options list")


# ---------------------------------------------------------------------------
# set_variable / adjust_variable / remove_variable
# ---------------------------------------------------------------------------


async def test_set_variable_validates_and_reports_old_new():
    services, ctx = _build()
    tools = ModuleVarTools(services)
    await tools.define_variable(ctx, "mood", "enum", options=["calm", "tense"])

    result = await tools.set_variable(ctx, "mood", "TENSE")

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("modvars.tools.set.done", label="mood", id="mood", old="calm", new="tense")


async def test_set_variable_unknown_id_lists_known_variables():
    services, ctx = _build()
    tools = ModuleVarTools(services)
    i18n = services.i18n.with_locale("en")

    assert await tools.set_variable(ctx, "ghost", "1") == i18n.t("modvars.tools.none_defined")

    await tools.define_variable(ctx, "fear", "number")
    assert await tools.set_variable(ctx, "ghost", "1") == i18n.t(
        "modvars.tools.unknown_var", id="ghost", known="fear"
    )


async def test_adjust_variable_clamps_and_rejects_non_number_kinds():
    services, ctx = _build()
    tools = ModuleVarTools(services)
    await tools.define_variable(ctx, "fear", "number", minimum=0, maximum=10)
    await tools.define_variable(ctx, "note", "text")

    i18n = services.i18n.with_locale("en")
    assert await tools.adjust_variable(ctx, "fear", 99) == i18n.t(
        "modvars.tools.adjust.done", label="fear", id="fear", old=0, new=10, delta=99
    )
    result = await tools.adjust_variable(ctx, "note", 1)
    assert result == i18n.t(
        "modvars.tools.failed", error="variable 'note' is text, not number — use set instead"
    )


async def test_adjust_variable_resolves_model_friendly_ids():
    services, ctx = _build()
    tools = ModuleVarTools(services)
    await tools.define_variable(ctx, "town_fear", "number", minimum=0, maximum=10)

    i18n = services.i18n.with_locale("en")
    assert await tools.adjust_variable(ctx, "Town Fear", 3) == i18n.t(
        "modvars.tools.adjust.done", label="town_fear", id="town_fear", old=0, new=3, delta=3
    )


async def test_remove_variable_drops_it():
    services, ctx = _build()
    tools = ModuleVarTools(services)
    await tools.define_variable(ctx, "fear", "number")

    result = await tools.remove_variable(ctx, "fear")

    i18n = services.i18n.with_locale("en")
    assert result == i18n.t("modvars.tools.remove.done", label="fear", id="fear")
    assert await tools.set_variable(ctx, "fear", "1") == i18n.t("modvars.tools.none_defined")


# ---------------------------------------------------------------------------
# Toolset integration + locale threading
# ---------------------------------------------------------------------------


async def test_variable_tools_are_ungated_in_the_kp_toolset():
    services, _ = _build()
    toolset = build_kp_toolset(services)
    schema_names = {schema["function"]["name"] for schema in toolset.schemas()}
    assert {"define_variable", "set_variable", "adjust_variable", "remove_variable"} <= schema_names


async def test_zh_room_gets_zh_tool_text_and_zh_label():
    services, ctx = _build(locale="zh")
    tools = ModuleVarTools(services)

    result = await tools.define_variable(
        ctx, "town_fear", "number", label="小镇恐慌", minimum=0, maximum=10
    )

    i18n = services.i18n.with_locale("zh")
    assert result == i18n.t(
        "modvars.tools.define.done",
        label="小镇恐慌",
        id="town_fear",
        kind="number",
        visibility=i18n.t("modvars.visibility.player"),
        value=0,
    )
