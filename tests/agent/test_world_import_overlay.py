"""M26 §10.13-§10.15 — what `.import … world` reports, adopts and leaves open.

The unreachable COUNT (and nothing more than a count), the pack-declared overlay applied
from the pack home only, and the setup choices a native lorecard declares.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent.context import AgentCtx, LocalFs
from agent.kp_tools_charcard import CharcardTools
from agent.services import build_services
from core.lore_overlay import load_overlay
from core.mvu_compat import mvu_exposed_prefixes
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from tests.fixtures.overlay_card import OVERLAY_FILE, UNREACHABLE_COUNT, card_book

CARD = {
    "name": "残堇",
    "personality": "",
    "description": "The estate itself.",
    "character_book": card_book(),
}

TIDY_CARD = {
    "name": "Tidy",
    "description": "Nothing switched off.",
    "character_book": {"entries": [{"comment": "开场", "content": "天亮了。", "keys": ["开场"]}]},
}

LORECARD = {
    "format": "loreweaver.card",
    "format_version": 1,
    "name": "试作模组",
    "description": "A native bundle.",
    "variables": [
        {
            "id": "难度",
            "kind": "enum",
            "options": ["轻松", "标准", "残酷"],
            "labels": {"en": "Difficulty", "zh": "难度"},
            "setup": True,
        },
        {"id": "恐惧", "kind": "number", "minimum": 0, "maximum": 10},
    ],
}


def _services(tmp_path):
    return build_services(
        Settings(data_dir=str(tmp_path / "data")), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(16)
    )


def _keeper_ctx(tmp_path, chat_key: str) -> AgentCtx:
    return AgentCtx(
        chat_key=chat_key,
        user_id="k1",
        platform="cli",
        locale="en",
        fs=LocalFs(str(tmp_path), extra_bases=(str(tmp_path / "data"),)),
    )


def _loose_card(tmp_path, payload: dict, name: str = "world.json") -> str:
    path = tmp_path / name
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return str(path)


def _packed_card(data_dir: Path, payload: dict, *, overlay: str | None) -> str:
    """A card inside an installed pack home, optionally with an `overlay:` declared."""
    home = data_dir / "packs" / "canjin@1.0.0"
    (home / "cards").mkdir(parents=True)
    (home / "cards" / "world.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    entry = "  cards: [cards/world.json]"
    if overlay is not None:
        (home / "cards" / "world.overlay.yaml").write_text(overlay, encoding="utf-8")
        entry = "  cards:\n    - path: cards/world.json\n      overlay: cards/world.overlay.yaml"
    (home / "pack.yaml").write_text(
        "manifest: 2\nid: canjin\nname: Canjin\nversion: \"1.0.0\"\ncontents:\n" + entry + "\n",
        encoding="utf-8",
    )
    return str(home / "cards" / "world.json")


# ---------------------------------------------------------------------------
# §10.13 — the unreachable receipt line
# ---------------------------------------------------------------------------


async def test_the_receipt_counts_unreachable_entries_and_points_at_the_commands(tmp_path):
    services = _services(tmp_path)
    card_path = _loose_card(tmp_path, CARD)

    reply = await CharcardTools(services).import_world_card(_keeper_ctx(tmp_path, "room-a"), file_path=card_path)

    assert f"{UNREACHABLE_COUNT} entr" in reply
    assert ".lore list disabled" in reply and ".lore enable" in reply
    # A count and a hint — never a grouping, never a suggested pick.
    assert "难度·残酷" not in reply and "路线" not in reply


async def test_a_card_with_nothing_unreachable_says_nothing(tmp_path):
    services = _services(tmp_path)
    card_path = _loose_card(tmp_path, TIDY_CARD, name="tidy.json")

    reply = await CharcardTools(services).import_world_card(_keeper_ctx(tmp_path, "room-b"), file_path=card_path)

    assert "disabled with no keywords" not in reply
    assert ".lore list disabled" not in reply


async def test_a_player_import_never_sees_the_line_or_an_overlay(tmp_path):
    services = _services(tmp_path)
    card_path = _loose_card(tmp_path, CARD)
    ctx = _keeper_ctx(tmp_path, "room-c")

    reply = await CharcardTools(services).import_character(ctx, file_path=card_path, as_="pc")

    assert ".lore list disabled" not in reply
    assert (await load_overlay(services.documents, "room-c")).is_empty


# ---------------------------------------------------------------------------
# §10.14 — the pack-declared overlay
# ---------------------------------------------------------------------------


async def test_a_pack_declared_overlay_is_applied_at_world_import(tmp_path):
    services = _services(tmp_path)
    card_path = _packed_card(tmp_path / "data", CARD, overlay=OVERLAY_FILE)

    reply = await CharcardTools(services).import_world_card(_keeper_ctx(tmp_path, "room-d"), file_path=card_path)

    assert "Pack overlay applied" in reply
    overlay = await load_overlay(services.documents, "room-d")
    assert overlay.entries["难度·残酷"].condition == '配置.难度 == "残酷"'
    assert overlay.entries["难度·残酷"].enabled is True
    assert overlay.entries["回复模板"].enabled is False
    assert [item.path for item in overlay.setup] == ["配置.难度", "配置.路线"]
    # `expose:` is handed to the MVU document's own exposure list, not copied.
    assert await mvu_exposed_prefixes(services.documents, "room-d") == ["配置"]
    assert "Setup still open (2)" in reply


async def test_the_same_card_outside_a_pack_gets_no_overlay(tmp_path):
    services = _services(tmp_path)
    card_path = _loose_card(tmp_path, CARD)

    reply = await CharcardTools(services).import_world_card(_keeper_ctx(tmp_path, "room-e"), file_path=card_path)

    assert "Pack overlay applied" not in reply
    assert (await load_overlay(services.documents, "room-e")).is_empty


async def test_an_overlay_naming_a_missing_title_is_reported_not_refused(tmp_path):
    services = _services(tmp_path)
    card_path = _packed_card(
        tmp_path / "data",
        CARD,
        overlay="format: loreweaver.lore-overlay/1\nentries:\n  没有这条: {enabled: true}\n",
    )

    reply = await CharcardTools(services).import_world_card(_keeper_ctx(tmp_path, "room-f"), file_path=card_path)

    assert "1 title(s) this card no longer has" in reply
    assert (await load_overlay(services.documents, "room-f")).entries["没有这条"].enabled is True


async def test_a_broken_overlay_never_fails_the_world_import(tmp_path):
    """The lore has already landed; the module still runs on the author's defaults."""
    services = _services(tmp_path)
    card_path = _packed_card(tmp_path / "data", CARD, overlay="format: nonsense\n")

    reply = await CharcardTools(services).import_world_card(_keeper_ctx(tmp_path, "room-g"), file_path=card_path)

    assert "Pack overlay applied" not in reply
    assert await services.worldbook.list("room-g")  # the lore is there


async def test_a_reimport_keeps_the_overlay_and_reports_it(tmp_path):
    services = _services(tmp_path)
    card_path = _packed_card(tmp_path / "data", CARD, overlay=OVERLAY_FILE)
    ctx = _keeper_ctx(tmp_path, "room-h")
    tools = CharcardTools(services)
    await tools.import_world_card(ctx, file_path=card_path)
    from core.lore_overlay import mark_setup_done

    await mark_setup_done(services.documents, "room-h", "配置.难度")

    receipt = await tools.import_world_card(ctx, file_path=card_path)

    overlay = await load_overlay(services.documents, "room-h")
    assert overlay.entries["难度·残酷"].condition == '配置.难度 == "残酷"'
    # A choice the table already made is not re-opened by a re-import.
    assert [item.path for item in overlay.pending()] == ["配置.路线"]
    assert "Your existing switches were kept" in receipt


async def test_the_reimport_report_does_not_depend_on_the_card_being_pack_wrapped(tmp_path):
    """§5.1's matched/stale promise is owed to a keeper importing a bare attachment too —
    it used to be skipped entirely for any card with no pack overlay beside it."""
    from gateway.commands import CommandRouter

    services = _services(tmp_path)
    card_path = _loose_card(tmp_path, CARD)
    ctx = _keeper_ctx(tmp_path, "room-j")
    tools = CharcardTools(services)
    await tools.import_world_card(ctx, file_path=card_path)
    # Switches typed at the table, by hand — no pack anywhere in this story.
    router = CommandRouter(services)
    await router.dispatch(ctx, ".lore enable 难度·残酷")
    await router.dispatch(ctx, ".lore enable 一条不再存在的条目")  # refused: not in the room
    from core.lore_overlay import load_overlay as _load, save_overlay, set_entry

    await save_overlay(
        services.documents, "room-j", set_entry(await _load(services.documents, "room-j"), "旧标题", enabled=True)
    )

    receipt = await tools.import_world_card(ctx, file_path=card_path)

    assert "Your existing switches were kept" in receipt
    assert "1 title(s) no longer present" in receipt and "旧标题" in receipt
    assert (await load_overlay(services.documents, "room-j")).entries["难度·残酷"].enabled is True


async def test_a_first_import_into_a_clean_room_reports_no_kept_switches(tmp_path):
    services = _services(tmp_path)
    card_path = _loose_card(tmp_path, CARD)

    receipt = await CharcardTools(services).import_world_card(
        _keeper_ctx(tmp_path, "room-k"), file_path=card_path
    )

    assert "Your existing switches were kept" not in receipt


async def test_the_world_import_names_the_exposed_prefixes(tmp_path):
    services = _services(tmp_path)
    card_path = _packed_card(tmp_path / "data", CARD, overlay=OVERLAY_FILE)

    receipt = await CharcardTools(services).import_world_card(
        _keeper_ctx(tmp_path, "room-l"), file_path=card_path
    )

    assert "publishes 1 variable prefix(es) to the players' panel: 配置" in receipt


async def test_the_unknown_title_oracle_is_the_rooms_entries_not_the_cards_raw_list(tmp_path):
    """The raw list still holds `[InitVar]` and the oversized block; an overlay naming one
    of those must read as unknown on this door exactly as it does on `.lore overlay`."""
    services = _services(tmp_path)
    card_path = _packed_card(
        tmp_path / "data",
        CARD,
        overlay=(
            "format: loreweaver.lore-overlay/1\nentries:\n"
            "  '[InitVar]开局变量': {enabled: true}\n"
            "  '[mvu_update]变量输出格式': {enabled: true}\n"
        ),
    )

    receipt = await CharcardTools(services).import_world_card(
        _keeper_ctx(tmp_path, "room-m"), file_path=card_path
    )

    assert "2 title(s) this card no longer has" in receipt


# ---------------------------------------------------------------------------
# §10.15 — a native lorecard's own setup variables
# ---------------------------------------------------------------------------


async def test_a_native_setup_variable_lands_as_a_pending_choice(tmp_path):
    services = _services(tmp_path)
    card_path = _loose_card(tmp_path, LORECARD, name="module.lorecard.json")
    ctx = _keeper_ctx(tmp_path, "room-i")

    reply = await CharcardTools(services).import_world_card(ctx, file_path=card_path)

    assert "Setup still open (1)" in reply and "Difficulty" in reply
    overlay = await load_overlay(services.documents, "room-i")
    assert [(item.path, item.options) for item in overlay.pending()] == [
        ("难度", ("轻松", "标准", "残酷"))
    ]

    from agent.prompt_builder import build_system_prompt

    prompt = await build_system_prompt(ctx, services)
    assert "Difficulty (轻松|标准|残酷)" in prompt

    # A typed setup variable closes through the ordinary `.var set` the admin types.
    from gateway.commands import CommandRouter

    assert await CommandRouter(services).dispatch(ctx, ".var set 难度 残酷") is not None
    assert (await load_overlay(services.documents, "room-i")).pending() == ()
    assert "Difficulty (轻松|标准|残酷)" not in await build_system_prompt(ctx, services)
