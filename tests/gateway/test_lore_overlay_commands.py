"""M26 §10.9-§10.12: the `.lore` switches and `.var`'s tree fall-through, as typed.

Keeper-only on every switch, both dialects, and — the point of the whole feature — the
stored lore document is never rewritten by any of them.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx, LocalFs
from agent.services import build_services
from core.documents import DocumentStore
from core.lore_overlay import OVERLAY_DOC_ID, OVERLAY_DOC_TYPE, SetupItem, load_overlay
from core.modvars import build_spec, define_modvar
from core.mvu_compat import load_mvu, mvu_init_from_initvar
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from tests.fixtures.overlay_card import OVERLAY_FILE, card_book

KEEPER_ROOM = "cli:dm:overlay"
PLAYER_ROOM = "tui:group:overlay"


def _services(tmp_path, locale: str = "en"):
    settings = Settings(locale=locale, data_dir=str(tmp_path))
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _keeper(chat_key: str = KEEPER_ROOM, locale: str = "en", fs=None) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="kp", locale=locale, fs=fs)


def _player(chat_key: str = PLAYER_ROOM, locale: str = "en") -> AgentCtx:
    return AgentCtx(
        chat_key=chat_key, user_id="p1", locale=locale, platform="tui", extra={"role": "player"}
    )


async def _room(tmp_path, *, chat_key: str = KEEPER_ROOM, locale: str = "en"):
    services = _services(tmp_path, locale)
    router = CommandRouter(services)
    await services.worldbook.import_entries(chat_key, card_book(), source="card", is_keeper=True)
    await mvu_init_from_initvar(services.documents, chat_key, {"配置": {"难度": "标准", "路线": "主线"}})
    return services, router


# ---------------------------------------------------------------------------
# §10.9 — state transitions, both dialects, and the keeper gate
# ---------------------------------------------------------------------------


async def test_enable_disable_and_restore_walk_the_overlay(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()

    on = await router.dispatch(ctx, ".lore enable 难度·残酷")
    assert on is not None and "难度·残酷" in on
    assert (await load_overlay(services.documents, KEEPER_ROOM)).entries["难度·残酷"].enabled is True

    await router.dispatch(ctx, ".lore disable 难度·残酷")
    assert (await load_overlay(services.documents, KEEPER_ROOM)).entries["难度·残酷"].enabled is False

    restored = await router.dispatch(ctx, ".lore restore 难度·残酷")
    assert restored is not None
    assert (await load_overlay(services.documents, KEEPER_ROOM)).entries == {}


async def test_bind_and_unbind(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()

    bound = await router.dispatch(ctx, '.lore bind 难度·残酷 配置.难度 == "残酷"')
    assert bound is not None
    entry = (await load_overlay(services.documents, KEEPER_ROOM)).entries["难度·残酷"]
    assert entry.condition == '配置.难度 == "残酷"'
    assert entry.enabled is True  # a binding implies the switch — otherwise it is an inert trap

    await router.dispatch(ctx, ".lore unbind 难度·残酷")
    entry = (await load_overlay(services.documents, KEEPER_ROOM)).entries["难度·残酷"]
    assert entry.condition == "" and entry.enabled is True


async def _with_spaced_title(services, chat_key: str = KEEPER_ROOM) -> None:
    await services.worldbook.import_entries(
        chat_key,
        {"entries": [{"comment": "the deep water", "content": "cold", "enabled": False, "keys": []}]},
        source="second",
        is_keeper=True,
    )


async def test_bind_accepts_a_pipe_for_a_title_with_spaces(tmp_path):
    services, router = await _room(tmp_path)
    await _with_spaced_title(services)

    reply = await router.dispatch(_keeper(), '.lore bind the deep water | 配置.难度 == "残酷"')

    assert reply is not None
    overlay = await load_overlay(services.documents, KEEPER_ROOM)
    assert overlay.entries["the deep water"].condition == '配置.难度 == "残酷"'


async def test_every_non_bind_switch_takes_the_whole_rest_as_the_title(tmp_path):
    """`.lore enable the deep water` went looking for an entry called "the"."""
    services, router = await _room(tmp_path)
    await _with_spaced_title(services)
    ctx = _keeper()

    for command, check in (
        (".lore enable the deep water", lambda o: o.entries["the deep water"].enabled is True),
        (".lore disable the deep water", lambda o: o.entries["the deep water"].enabled is False),
        (".lore unbind the deep water", lambda o: o.entries["the deep water"].condition == ""),
    ):
        reply = await router.dispatch(ctx, command)
        assert reply is not None and "No lore entry" not in reply, command
        assert check(await load_overlay(services.documents, KEEPER_ROOM)), command

    shown = await router.dispatch(ctx, ".lore show the deep water")
    assert shown is not None and "the deep water" in shown and "No lore entry" not in shown

    restored = await router.dispatch(ctx, ".lore restore the deep water")
    assert restored is not None
    assert "the deep water" not in (await load_overlay(services.documents, KEEPER_ROOM)).entries


async def test_bind_never_splits_on_a_bare_pipe_so_an_or_expression_survives(tmp_path):
    """`配置.难度 == "残酷" || 配置.难度 == "困难"` is one condition, not a title and a tail."""
    services, router = await _room(tmp_path)
    expression = '配置.难度 == "残酷" || 配置.难度 == "困难"'

    positional = await router.dispatch(_keeper(), f".lore bind 难度·残酷 {expression}")

    assert positional is not None
    assert (await load_overlay(services.documents, KEEPER_ROOM)).entries["难度·残酷"].condition == expression

    await _with_spaced_title(services)
    piped = await router.dispatch(_keeper(), f".lore bind the deep water | {expression}")

    assert piped is not None
    overlay = await load_overlay(services.documents, KEEPER_ROOM)
    assert overlay.entries["the deep water"].condition == expression
    # And it actually fires on either value.
    from core.varspace import build_resolver

    for value in ("残酷", "困难"):
        resolve = build_resolver({}, {"配置": {"难度": value}})
        chosen = [e.title for e in await services.worldbook.match(KEEPER_ROOM, "", role="keeper", resolve=resolve)]
        assert "难度·残酷" in chosen, value


async def test_restore_star_drops_every_override(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()
    await router.dispatch(ctx, ".lore enable 难度·残酷")
    await router.dispatch(ctx, ".lore enable 路线·判官线")

    await router.dispatch(ctx, ".lore restore *")

    assert (await load_overlay(services.documents, KEEPER_ROOM)).entries == {}


async def test_the_chinese_dialect_reaches_the_same_switches(tmp_path):
    services, router = await _room(tmp_path, locale="zh")
    ctx = _keeper(locale="zh")

    reply = await router.dispatch(ctx, ".设定 启用 难度·残酷")

    assert reply is not None and "难度·残酷" in reply
    assert (await load_overlay(services.documents, KEEPER_ROOM)).entries["难度·残酷"].enabled is True
    await router.dispatch(ctx, ".设定 还原 难度·残酷")
    assert (await load_overlay(services.documents, KEEPER_ROOM)).entries == {}


async def test_every_switch_is_denied_to_a_player(tmp_path):
    services, router = await _room(tmp_path, chat_key=PLAYER_ROOM)
    denied = services.i18n.with_locale("en").t("worldbook.commands.lore.denied")

    for command in (
        ".lore enable 难度·残酷",
        ".lore disable 难度·残酷",
        '.lore bind 难度·残酷 配置.难度 == "残酷"',
        ".lore unbind 难度·残酷",
        ".lore restore *",
        ".lore show 难度·残酷",
        ".lore overlay whatever.yaml",
    ):
        assert await router.dispatch(_player(), command) == denied
    assert (await load_overlay(services.documents, PLAYER_ROOM)).is_empty


async def test_a_players_lore_list_is_unchanged_by_an_overlay(tmp_path):
    services, router = await _room(tmp_path, chat_key=PLAYER_ROOM)
    before = await router.dispatch(_player(), ".lore list")

    keeper_ctx = AgentCtx(
        chat_key=PLAYER_ROOM, user_id="kp", locale="en", platform="tui", extra={"role": "keeper"}
    )
    await router.dispatch(keeper_ctx, ".lore enable 难度·残酷")
    await router.dispatch(keeper_ctx, '.lore bind 路线·判官线 配置.路线 == "判官线"')

    assert await router.dispatch(_player(), ".lore list") == before


async def test_the_keeper_listing_carries_markers_and_a_disabled_filter(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()
    await router.dispatch(ctx, '.lore bind 难度·残酷 配置.难度 == "残酷"')

    listing = await router.dispatch(ctx, ".lore list")
    assert listing is not None
    assert "[when: 配置.难度 == \"残酷\"]" in listing
    assert "*" in listing and "[always-on]" in listing

    off_only = await router.dispatch(ctx, ".lore list disabled")
    assert off_only is not None
    assert "难度·轻松" in off_only  # still off
    assert "难度·残酷" not in off_only  # switched on by the binding
    assert "通用规则" not in off_only  # never was off


async def test_an_unknown_title_is_refused_and_writes_nothing(tmp_path):
    services, router = await _room(tmp_path)

    reply = await router.dispatch(_keeper(), ".lore enable 不存在的条目")

    assert reply is not None and "不存在的条目" in reply
    assert (await load_overlay(services.documents, KEEPER_ROOM)).is_empty


# ---------------------------------------------------------------------------
# §10.10 — a bad expression, and a binding on a path the tree does not have
# ---------------------------------------------------------------------------


async def test_an_unparsable_expression_is_refused_and_the_overlay_is_unchanged(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()
    await router.dispatch(ctx, ".lore enable 难度·残酷")

    reply = await router.dispatch(ctx, ".lore bind 难度·残酷 1 ~ 2")

    assert reply is not None
    overlay = await load_overlay(services.documents, KEEPER_ROOM)
    assert overlay.entries["难度·残酷"].condition == ""  # the earlier enable is intact


async def test_a_binding_on_a_missing_path_is_accepted_flagged_and_never_fires(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()

    await router.dispatch(ctx, '.lore bind 难度·残酷 配置.不存在 == "残酷"')
    shown = await router.dispatch(ctx, ".lore show 难度·残酷")

    assert shown is not None and "配置.不存在" in shown
    from core.modvars import load_modvars
    from core.varspace import build_resolver

    resolve = build_resolver(
        (await load_modvars(services.documents, KEEPER_ROOM))["values"],
        await load_mvu(services.documents, KEEPER_ROOM),
    )
    chosen = await services.worldbook.match(KEEPER_ROOM, "", role="keeper", resolve=resolve)
    assert "难度·残酷" not in [entry.title for entry in chosen]


async def test_show_prints_the_file_state_beside_the_effective_one(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()

    plain = await router.dispatch(ctx, ".lore show 难度·残酷")
    assert plain is not None and "no override" in plain

    await router.dispatch(ctx, ".lore enable 难度·残酷")
    overridden = await router.dispatch(ctx, ".lore show 难度·残酷")
    assert overridden is not None
    assert "as imported: enabled=No" in overridden
    assert "this room: enabled=Yes" in overridden


# ---------------------------------------------------------------------------
# §10.4 again, at the command layer: faithful import survives every switch
# ---------------------------------------------------------------------------


async def test_no_switch_ever_rewrites_the_stored_entry(tmp_path):
    services, router = await _room(tmp_path)
    ctx = _keeper()
    documents = DocumentStore(services.store)
    before = json.dumps(
        [doc.data for doc in await documents.list(KEEPER_ROOM, "lore")], ensure_ascii=False, sort_keys=True
    )

    await router.dispatch(ctx, ".lore enable 难度·残酷")
    await router.dispatch(ctx, '.lore bind 路线·判官线 配置.路线 == "判官线"')
    await router.dispatch(ctx, ".lore disable 通用规则")

    after = json.dumps(
        [doc.data for doc in await documents.list(KEEPER_ROOM, "lore")], ensure_ascii=False, sort_keys=True
    )
    assert after == before
    assert await documents.get(KEEPER_ROOM, OVERLAY_DOC_TYPE, OVERLAY_DOC_ID) is not None


# ---------------------------------------------------------------------------
# §10.12 — the budget receipt reaches the admin who typed the switch
# ---------------------------------------------------------------------------


async def test_enabling_an_oversized_entry_says_it_never_injects(tmp_path):
    services, router = await _room(tmp_path)
    from core.worldbook import KEEPER_TURN_BUDGET_CHARS, LoreEntry

    await services.worldbook.add(
        KEEPER_ROOM,
        LoreEntry.from_dict(
            {
                "id": "",
                "title": "巨块",
                "content": "·" * (KEEPER_TURN_BUDGET_CHARS + 10),
                "enabled": False,
                "constant": True,
            }
        ),
    )

    reply = await router.dispatch(_keeper(), ".lore enable 巨块")

    assert reply is not None and "NEVER inject" in reply


async def test_the_receipt_names_what_ranked_above_a_crowded_out_entry(tmp_path):
    services = _services(tmp_path)
    router = CommandRouter(services)
    await services.worldbook.import_entries(
        KEEPER_ROOM, card_book(route_chars=11_500), source="card", is_keeper=True
    )
    ctx = _keeper()
    await router.dispatch(ctx, ".lore enable 路线·判官线")

    reply = await router.dispatch(ctx, ".lore enable 难度·残酷")

    assert reply is not None
    assert "does NOT make this turn's cut" in reply and "路线·判官线" in reply


async def test_the_receipt_dry_run_leaves_the_timers_alone(tmp_path):
    services, router = await _room(tmp_path)
    before = await services.store.state_get(KEEPER_ROOM, "worldbook_timers")

    await router.dispatch(_keeper(), ".lore enable 难度·残酷")

    assert await services.store.state_get(KEEPER_ROOM, "worldbook_timers") == before


# ---------------------------------------------------------------------------
# §10.14 (hand-applied half) — `.lore overlay <file>`
# ---------------------------------------------------------------------------


async def test_lore_overlay_applies_a_file_by_hand(tmp_path):
    services, router = await _room(tmp_path)
    overlay_path = tmp_path / "overlay.yaml"
    overlay_path.write_text(OVERLAY_FILE, encoding="utf-8")

    reply = await router.dispatch(_keeper(fs=LocalFs(str(tmp_path))), f".lore overlay {overlay_path}")

    assert reply is not None and "Overlay applied" in reply
    overlay = await load_overlay(services.documents, KEEPER_ROOM)
    assert overlay.entries["难度·残酷"].condition == '配置.难度 == "残酷"'
    assert [item.path for item in overlay.setup] == ["配置.难度", "配置.路线"]
    from core.mvu_compat import mvu_exposed_prefixes

    assert await mvu_exposed_prefixes(services.documents, KEEPER_ROOM) == ["配置"]


async def test_a_broken_overlay_file_is_refused(tmp_path):
    services, router = await _room(tmp_path)
    overlay_path = tmp_path / "bad.yaml"
    overlay_path.write_text("format: not.a.known.format\nentries: {}\n", encoding="utf-8")

    reply = await router.dispatch(_keeper(fs=LocalFs(str(tmp_path))), f".lore overlay {overlay_path}")

    assert reply is not None and "Could not apply" in reply
    assert (await load_overlay(services.documents, KEEPER_ROOM)).is_empty


# ---------------------------------------------------------------------------
# §10.11 — `.var` writes the tree, and setup items close
# ---------------------------------------------------------------------------


async def test_var_set_writes_an_existing_tree_leaf(tmp_path):
    services, router = await _room(tmp_path)

    reply = await router.dispatch(_keeper(), ".var set 配置.难度 残酷")

    assert reply is not None and "标准" in reply and "残酷" in reply
    assert (await load_mvu(services.documents, KEEPER_ROOM))["配置"]["难度"] == "残酷"


async def test_var_set_refuses_a_path_the_tree_does_not_have(tmp_path):
    services, router = await _room(tmp_path)

    reply = await router.dispatch(_keeper(), ".var set 配置.不存在 x")

    assert reply is not None and "配置.难度" in reply  # the nearest paths, as a hint
    assert "不存在" not in json.dumps(await load_mvu(services.documents, KEEPER_ROOM), ensure_ascii=False)


async def test_var_set_still_takes_the_modvar_path_first(tmp_path):
    services, router = await _room(tmp_path)
    await define_modvar(
        services.documents,
        KEEPER_ROOM,
        build_spec("town_fear", "number", labels={"en": "Town fear"}, minimum=0, maximum=10),
    )

    reply = await router.dispatch(_keeper(), ".var set town_fear 4")

    assert reply is not None and "Town fear" in reply


async def test_var_add_nudges_a_numeric_leaf(tmp_path):
    services, router = await _room(tmp_path)
    await mvu_init_from_initvar(services.documents, KEEPER_ROOM, {"配置": {"恐惧": 2}})

    reply = await router.dispatch(_keeper(), ".var add 配置.恐惧 3")

    assert reply is not None and "5" in reply
    assert (await load_mvu(services.documents, KEEPER_ROOM))["配置"]["恐惧"] == 5


async def test_a_setup_item_closes_on_var_set_and_on_set_stat(tmp_path):
    from agent.kp_tools_vars import MvuStatTools
    from core.lore_overlay import EMPTY_OVERLAY, save_overlay, set_setup_items

    services, router = await _room(tmp_path)
    await save_overlay(
        services.documents,
        KEEPER_ROOM,
        set_setup_items(
            EMPTY_OVERLAY,
            [SetupItem(path="配置.难度", options=("轻松", "残酷")), SetupItem(path="配置.路线")],
        ),
    )
    ctx = _keeper()

    pending = await router.dispatch(ctx, ".var setup")
    assert pending is not None and "2 still open" in pending

    await router.dispatch(ctx, ".var set 配置.难度 残酷")
    assert [item.path for item in (await load_overlay(services.documents, KEEPER_ROOM)).pending()] == ["配置.路线"]

    await MvuStatTools(services).set_stat(ctx, path="配置.路线", value="判官线")
    assert (await load_overlay(services.documents, KEEPER_ROOM)).pending() == ()

    done = await router.dispatch(ctx, ".var setup")
    assert done is not None and "0 still open" in done


async def test_var_list_leads_with_the_open_setup_choices(tmp_path):
    from core.lore_overlay import EMPTY_OVERLAY, save_overlay, set_setup_items

    services, router = await _room(tmp_path)
    await save_overlay(
        services.documents,
        KEEPER_ROOM,
        set_setup_items(EMPTY_OVERLAY, [SetupItem(path="配置.难度", labels={"en": "Difficulty"})]),
    )

    listing = await router.dispatch(_keeper(), ".var list")

    assert listing is not None and listing.splitlines()[0].startswith("Setup still open: Difficulty")


async def test_var_setup_says_so_when_a_module_declares_none(tmp_path):
    services, router = await _room(tmp_path)

    reply = await router.dispatch(_keeper(), ".var setup")

    assert reply is not None and "no \"set before play\" choices" in reply


# ---------------------------------------------------------------------------
# The three distinct refusals: unknown path / branch / illegal write
# ---------------------------------------------------------------------------


async def test_writing_a_branch_is_refused_by_name_and_the_tree_survives(tmp_path):
    services, router = await _room(tmp_path)
    before = json.dumps(await load_mvu(services.documents, KEEPER_ROOM), ensure_ascii=False, sort_keys=True)

    reply = await router.dispatch(_keeper(), ".var set 配置 残酷")

    assert reply is not None
    assert "is a branch" in reply and "难度" in reply  # names it as a branch, lists the children
    assert "neither a defined tracker" not in reply  # NOT the unknown-target sentence
    after = json.dumps(await load_mvu(services.documents, KEEPER_ROOM), ensure_ascii=False, sort_keys=True)
    assert after == before


async def test_a_structure_typed_as_a_value_is_refused_and_the_leaf_survives(tmp_path):
    """The spec's "the admin changes VALUES, never the tree's shape" has a value side too:
    `.var set 配置.难度 {"a":1}` used to turn the leaf into a mapping."""
    services, router = await _room(tmp_path)
    before = json.dumps(await load_mvu(services.documents, KEEPER_ROOM), ensure_ascii=False, sort_keys=True)

    reply = await router.dispatch(_keeper(), '.var set 配置.难度 {"a": 1}')

    assert reply is not None
    assert "takes a value" in reply and "配置.难度" in reply
    assert "Could not write" not in reply and "is a branch" not in reply
    after = json.dumps(await load_mvu(services.documents, KEEPER_ROOM), ensure_ascii=False, sort_keys=True)
    assert after == before


async def test_a_refused_write_on_an_existing_leaf_says_why_not_that_it_is_unknown(tmp_path):
    """`.var add 配置.难度 3` on a STRING leaf used to print "neither a tracker nor a leaf"
    and then list 配置.难度 as the nearest path."""
    services, router = await _room(tmp_path)

    reply = await router.dispatch(_keeper(), ".var add 配置.难度 3")

    assert reply is not None
    assert "Could not write" in reply and "配置.难度" in reply
    assert "neither a defined tracker" not in reply
    assert "Nearest card paths" not in reply


async def test_an_unknown_path_still_gets_the_nearest_names(tmp_path):
    services, router = await _room(tmp_path)

    reply = await router.dispatch(_keeper(), ".var set 配置.不存在 x")

    assert reply is not None
    assert "neither a defined tracker" in reply and "配置.难度" in reply


# ---------------------------------------------------------------------------
# `.lore overlay` names the prefixes it publishes to players
# ---------------------------------------------------------------------------


async def test_the_overlay_receipt_names_the_exposed_prefixes(tmp_path):
    services, router = await _room(tmp_path)
    overlay_path = tmp_path / "overlay.yaml"
    overlay_path.write_text(OVERLAY_FILE, encoding="utf-8")

    reply = await router.dispatch(_keeper(fs=LocalFs(str(tmp_path))), f".lore overlay {overlay_path}")

    assert reply is not None
    assert "publishes 1 variable prefix(es) to the players' panel: 配置" in reply


async def test_an_overlay_file_that_asks_for_star_exposure_is_refused(tmp_path):
    services, router = await _room(tmp_path)
    overlay_path = tmp_path / "greedy.yaml"
    overlay_path.write_text("format: loreweaver.lore-overlay/1\nexpose: ['*']\n", encoding="utf-8")

    reply = await router.dispatch(_keeper(fs=LocalFs(str(tmp_path))), f".lore overlay {overlay_path}")

    assert reply is not None and "Could not apply" in reply
    from core.mvu_compat import mvu_exposed_prefixes

    assert await mvu_exposed_prefixes(services.documents, KEEPER_ROOM) == []


# ---------------------------------------------------------------------------
# Spec §5.7, end to end: import a pack-wrapped card, choose, play
# ---------------------------------------------------------------------------


async def test_the_whole_flow_from_world_import_to_the_entry_that_injects(tmp_path):
    """The walkthrough in the spec, through the real doors: keeper world-imports a
    pack-wrapped card, the pack's overlay binds the difficulty family, the keeper types
    `.var set`, and from the next turn exactly the matching sibling injects."""
    from agent.kp_tools_charcard import CharcardTools
    from core.modvars import load_modvars
    from core.varspace import build_resolver

    services = _services(tmp_path)
    router = CommandRouter(services)
    home = tmp_path / "packs" / "canjin@1.0.0"  # `_services` sets data_dir=tmp_path
    (home / "cards").mkdir(parents=True)
    (home / "cards" / "world.json").write_text(
        json.dumps({"name": "残堇", "description": "the estate", "character_book": card_book()}, ensure_ascii=False),
        encoding="utf-8",
    )
    (home / "cards" / "world.overlay.yaml").write_text(OVERLAY_FILE, encoding="utf-8")
    (home / "pack.yaml").write_text(
        "manifest: 2\nid: canjin\nname: Canjin\nversion: \"1.0.0\"\ncontents:\n"
        "  cards:\n    - path: cards/world.json\n      overlay: cards/world.overlay.yaml\n",
        encoding="utf-8",
    )
    ctx = _keeper(fs=LocalFs(str(tmp_path)))

    receipt = await CharcardTools(services).import_world_card(ctx, file_path=str(home / "cards" / "world.json"))

    assert "Pack overlay applied" in receipt
    assert "Setup still open (2)" in receipt
    assert "配置" in receipt  # the exposed prefix, by name
    # The [InitVar] tree really landed — every later step depends on it.
    assert (await load_mvu(services.documents, KEEPER_ROOM))["配置"]["难度"] == "标准"

    async def _injected() -> list[str]:
        resolve = build_resolver(
            (await load_modvars(services.documents, KEEPER_ROOM))["values"],
            await load_mvu(services.documents, KEEPER_ROOM),
        )
        entries = await services.worldbook.match(KEEPER_ROOM, "", role="keeper", resolve=resolve)
        return [entry.title for entry in entries if entry.title.startswith("难度·")]

    assert await _injected() == ["难度·标准"]  # the card's own default, via the binding

    assert await router.dispatch(ctx, ".var set 配置.难度 残酷") is not None

    assert await _injected() == ["难度·残酷"]  # exactly the chosen sibling, the others closed
    setup = await router.dispatch(ctx, ".var setup")
    assert setup is not None and "[x]" in setup and "1 still open" in setup
