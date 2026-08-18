"""Tests for net.state's `variables` snapshot field: player-visible module variables
(`core.modvars`) surfaced by `build_room_state` as `state["variables"]` (or omitted entirely
when the room has none).

RED LINE (iron rule #3, information isolation): a `visibility="keeper"` variable must NEVER
appear ANYWHERE in the state payload — not its id, not its label, not its value. That filter
lives in the `modvars` document's PLAYER projection (`core.documents`, structural, by
construction), and these tests are the tripwire that keeps it that way.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import build_services
from core.modvars import build_spec, define_modvar, set_modvar
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.state import build_room_state


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _room_ctx(room: str, *, user_id: str = "seed", locale: str = "en") -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform="tui", locale=locale)


async def test_build_room_state_omits_variables_when_none_defined():
    services = _services()
    ctx = _room_ctx("vars-empty-room")

    state = await build_room_state(services, ctx)

    assert "variables" not in state
    # v1.9: no roster → no `pregens` field either (omitted, never an empty list).
    assert "pregens" not in state


async def test_build_room_state_lists_the_rule_systems_and_how_to_create_in_them():
    """v2.3: what a client needs to offer character creation WITHOUT knowing a system.

    Studio's character screen was read-only and the TUI's was not — because the TUI
    hard-codes CoC's and D&D's attribute tables, point-buy budgets and command words,
    which is precisely the per-system knowledge M16 deleted from the engine. A client
    that reads this list offers a pack's own system without a client release.
    """
    services = _services()
    ctx = _room_ctx("systems-room")

    state = await build_room_state(services, ctx)

    by_id = {entry["id"]: entry for entry in state["systems"]}
    assert {"coc7", "dnd5e"} <= set(by_id)
    # The word to SEND, read off the pack's own `commands:` declaration.
    assert by_id["coc7"]["make_char"] == "coc"
    assert by_id["dnd5e"]["make_char"] == "dnd"
    # Nothing but the id and the word: a rule system's contents are not room state.
    assert set(by_id["coc7"]) <= {"id", "make_char"}


async def test_an_extends_pack_advertises_its_OWN_creation_word_never_its_base_s(tmp_path):
    """A module's rulepack patch (`extends: coc7`) inherits the base's whole `commands:`
    table, base words first — and dispatch routes an inherited word to the BASE pack.
    Advertising `.coc` on the patch's row would hand a player a plain CoC7 sheet with
    none of the module's own attributes. So the word on the wire is one that routes back
    to this very pack; a patch that declares none has no `make_char` at all, rather
    than the base's — the client then offers describe/import for it, not roll.
    """
    from core import rulepacks as rulepacks_module

    (tmp_path / "coc7-patch.yaml").write_text(
        "extends: coc7\nnames: [coc7-patch]\ndefaults:\n  根值: 0\ncommands:\n  patch: {action: make_char}\n",
        encoding="utf-8",
    )
    (tmp_path / "coc7-wordless.yaml").write_text(
        "extends: coc7\nnames: [coc7-wordless]\ndefaults:\n  根值: 0\n",
        encoding="utf-8",
    )
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    rulepacks_module.reload_rulepacks()
    try:
        state = await build_room_state(_services(), _room_ctx("extends-room"))
        by_id = {entry["id"]: entry for entry in state["systems"]}
        assert by_id["coc7"]["make_char"] == "coc"
        # The patch's own word — the only one that creates a sheet IN the patch.
        assert by_id["coc7-patch"]["make_char"] == "patch"
        assert rulepacks_module.pack_declaring_command("patch", "make_char").system == "coc7-patch"
        # Inherited words route to the base, so a wordless patch carries none.
        assert "make_char" not in by_id["coc7-wordless"]
    finally:
        rulepacks_module._USER_RULEPACK_DIR = None
        rulepacks_module.reload_rulepacks()


async def test_build_room_state_surfaces_pregen_roster_to_every_viewer():
    from core.character_manager import CharacterSheet
    from core.pregen_roster import pregen_add, pregen_claim

    services = _services()
    ctx = _room_ctx("pregen-room")
    await pregen_add(
        services.documents, ctx.chat_key, CharacterSheet(name="Mira Vane", system="CoC"), source="module"
    )
    await pregen_add(
        services.documents, ctx.chat_key, CharacterSheet(name="老陈", system="CoC"), source="module"
    )
    await pregen_claim(services.documents, ctx.chat_key, "Mira Vane", "player-1", services.characters)

    state = await build_room_state(services, ctx)

    assert state["pregens"] == [
        {"name": "Mira Vane", "claimed_by": "player-1"},
        {"name": "老陈", "claimed_by": ""},
    ]


async def test_build_room_state_surfaces_player_visible_variables_in_definition_order():
    services = _services()
    ctx = _room_ctx("vars-room")
    await define_modvar(
        services.documents,
        ctx.chat_key,
        build_spec("town_fear", "number", labels={"en": "Town Fear"}, minimum=0, maximum=10),
    )
    await define_modvar(services.documents, ctx.chat_key, build_spec("mood", "enum", options=["calm", "tense"]))
    await set_modvar(services.documents, ctx.chat_key, "town_fear", 7)

    state = await build_room_state(services, ctx)

    assert state["variables"] == [
        {"id": "town_fear", "label": "Town Fear", "kind": "number", "value": 7, "min": 0, "max": 10},
        {"id": "mood", "label": "mood", "kind": "enum", "value": "calm"},
    ]


async def test_red_line_keeper_only_variables_never_appear_anywhere_in_the_state_payload():
    """Iron rule #3: the keeper-only variable's id, label, and value must be absent from the
    ENTIRE serialized state frame — not just from `state["variables"]`."""
    services = _services()
    ctx = _room_ctx("vars-secret-room")
    await define_modvar(services.documents, ctx.chat_key, build_spec("fear", "number", minimum=0, maximum=10))
    await define_modvar(
        services.documents,
        ctx.chat_key,
        build_spec(
            "true_culprit",
            "text",
            labels={"en": "True Culprit"},
            visibility="keeper",
            default="Dr. Corvus Marsh",
        ),
    )

    state = await build_room_state(services, ctx)

    wire = json.dumps(state, ensure_ascii=False)
    assert "true_culprit" not in wire
    assert "True Culprit" not in wire
    assert "Corvus" not in wire
    assert [entry["id"] for entry in state["variables"]] == ["fear"]


async def test_variables_labels_follow_the_callers_locale():
    services = _services()
    ctx_zh = _room_ctx("vars-locale-room", locale="zh")
    await define_modvar(
        services.documents,
        ctx_zh.chat_key,
        build_spec("town_fear", "number", labels={"en": "Town Fear", "zh": "小镇恐慌"}, minimum=0, maximum=10),
    )

    state_zh = await build_room_state(services, ctx_zh)
    state_en = await build_room_state(services, _room_ctx("vars-locale-room", locale="en"))

    assert state_zh["variables"][0]["label"] == "小镇恐慌"
    assert state_en["variables"][0]["label"] == "Town Fear"


async def test_mvu_leaves_are_hidden_from_players_until_exposed():
    """RED LINE: an imported tree is opaque module state — with no exposure list, a player
    frame carries NO mvu.* entries at all (heavy cards keep hidden plot flags in the tree)."""
    services = _services()
    ctx = _room_ctx("vars-mvu-hidden-room")
    from core.mvu_compat import mvu_init_from_initvar

    await define_modvar(services.documents, ctx.chat_key, build_spec("fear", "number", minimum=0, maximum=10))
    await mvu_init_from_initvar(
        services.documents, ctx.chat_key, {"理": {"好感度": [33, "affinity"]}, "真凶": ["管家", "hidden twist"]}
    )

    state = await build_room_state(services, ctx)

    assert [entry["id"] for entry in state["variables"]] == ["fear"]
    assert "真凶" not in json.dumps(state, ensure_ascii=False)


async def test_exposed_mvu_leaves_ride_the_variables_list_with_prefixed_ids():
    services = _services()
    ctx = _room_ctx("vars-mvu-room")
    from core.mvu_compat import mvu_expose, mvu_init_from_initvar

    await define_modvar(services.documents, ctx.chat_key, build_spec("fear", "number", minimum=0, maximum=10))
    await mvu_init_from_initvar(
        services.documents,
        ctx.chat_key,
        {"理": {"好感度": [33, "affinity"], "档案": {"备注": ["長い", "note"]}}, "真凶": ["管家", "twist"]},
    )
    await mvu_expose(services.documents, ctx.chat_key, "理")  # keeper puts the 理 subtree on the panel

    state = await build_room_state(services, ctx)

    ids = [entry["id"] for entry in state["variables"]]
    assert ids[0] == "fear"  # native trackers first
    assert "mvu.理.好感度" in ids
    assert "mvu.真凶" not in ids  # unexposed sibling stays off every player frame
    mvu_entry = next(entry for entry in state["variables"] if entry["id"] == "mvu.理.好感度")
    assert mvu_entry == {"id": "mvu.理.好感度", "label": "理.好感度", "kind": "number", "value": 33}


async def test_keeper_viewer_sees_unexposed_leaves_flagged_hidden():
    """A keeper connection (authenticated role in ctx.extra, or the local `cli` operator)
    still watches the whole tree — unexposed leaves arrive flagged `hidden: true`."""
    services = _services()
    player_ctx = _room_ctx("vars-mvu-keeper-room")
    keeper_ctx = AgentCtx(
        chat_key=player_ctx.chat_key,
        user_id="kp",
        platform="tui",
        locale="en",
        extra={"role": "keeper"},
    )
    from core.mvu_compat import mvu_expose, mvu_init_from_initvar

    await mvu_init_from_initvar(
        services.documents, ctx_key := player_ctx.chat_key, {"理": {"好感度": [33, "a"]}, "真凶": ["管家", "t"]}
    )
    await mvu_expose(services.documents, ctx_key, "理")

    keeper_state = await build_room_state(services, keeper_ctx)
    entries = {entry["id"]: entry for entry in keeper_state["variables"]}
    assert entries["mvu.理.好感度"].get("hidden") is None  # exposed → plain entry
    assert entries["mvu.真凶"]["hidden"] is True

    cli_ctx = AgentCtx(chat_key=ctx_key, user_id="op", platform="cli", locale="en")
    cli_state = await build_room_state(services, cli_ctx)
    assert "mvu.真凶" in {entry["id"] for entry in cli_state["variables"]}
