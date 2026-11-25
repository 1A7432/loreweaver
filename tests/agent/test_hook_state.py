"""The hook-private state store (`getstate` / `setstate`) through the real turn loop and the
room lifecycle: it persists across turns from every dispatch site, it is invisible to
everything that is not a hook (Keeper prompt, wire frames, `variables_changed`, the turn's
`hook_writes`), its caps hold room-wide, and it rides undo / export / import and dies at the
reset scope its facet declares. Skipped as a module without the `ejs` extra (hooks inert)."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.hook_runtime import (  # noqa: E402
    HOOK_STATE_PREFIX,
    apply_hook_state_writes,
    install_room_hooks,
    load_hook_state,
    load_room_hook_engine,
)
from agent.loop import run_kp_turn  # noqa: E402
from agent.services import build_services  # noqa: E402
from agent.tools import Toolset, tool  # noqa: E402
from agent.undo import restore  # noqa: E402
from core.hooks import MAX_STATE_VALUE_BYTES, HookOutcome  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call  # noqa: E402
from net.keystore import Keystore  # noqa: E402
from net.room_backup import chat_key_for_room, export_room, import_room, reset_room_state  # noqa: E402
from net.room_lifecycle import room_registry  # noqa: E402
from net.state import build_room_state  # noqa: E402

SENTINEL = "ZQX-HOOK-STATE-SENTINEL-7731"


def _services(llm=None, *, data_dir: str | None = None):
    settings = Settings(locale="en", data_dir=data_dir) if data_dir else Settings(locale="en")
    return build_services(settings, llm=llm or FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _ctx(chat_key: str, **kwargs) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale="en", **kwargs)


async def _stored(services, chat_key: str) -> dict[str, str]:
    rows = await services.store.state_list(chat_key, prefix=HOOK_STATE_PREFIX)
    return {str(row["key"])[len(HOOK_STATE_PREFIX):]: str(row["value"]) for row in rows}


class _DiceProvider:
    @tool
    async def skill_check(self, ctx: AgentCtx, skill_name: str) -> str:
        """Roll a skill check."""
        return f"{skill_name}: rolled 42 vs 65 -> hard success"


# The count is narrated at reply_ready, after every phase of the turn has had its say.
COUNTER_HOOK = (
    "on('turn_start', () => setstate('turns', (getstate('turns') ?? 0) + 1));"
    "on('reply_ready', () => narrate('turn#' + getstate('turns')));"
)


async def test_state_round_trips_across_turns_one_row_per_key():
    services = _services(FakeLLM(responder=lambda messages, tools: assistant_text("ok")))
    ctx = _ctx("hook-state-roundtrip")
    await install_room_hooks(services, ctx.chat_key, "test", [COUNTER_HOOK])

    first = await run_kp_turn(ctx, services, Toolset(), "one")
    second = await run_kp_turn(ctx, services, Toolset(), "two")
    third = await run_kp_turn(ctx, services, Toolset(), "three")

    assert "turn#1" in first.reply and "turn#2" in second.reply and "turn#3" in third.reply
    assert await _stored(services, ctx.chat_key) == {"turns": "3"}
    assert await services.store.state_get(ctx.chat_key, "hook_state:turns") == "3"


async def test_every_turn_phase_persists_its_state_writes():
    from agent.kp_tools_knowledge import NoteTools

    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call("skill_check", skill_name="Spot Hidden"),
                tool_call("set_stat", path="trail.seen", value="true"),
            ),
            assistant_tools(tool_call("game_clock", action="set", value="D1 09:00")),
            assistant_tools(tool_call("game_clock", action="advance", value="+1天")),
            assistant_text("done"),
        ]
    )
    from agent.kp_tools_vars import MvuStatTools

    services = _services(llm)
    ctx = _ctx("hook-state-phases")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => setstate('p.turn_start', 1));"
            "on('dice_rolled', () => setstate('p.dice_rolled', 1));"
            "on('clock_advanced', () => setstate('p.clock_advanced', 1));"
            "on('reply_ready', () => setstate('p.reply_ready', 1));"
            "on('variables_changed', () => setstate('p.variables_changed', 1));"
        ],
    )

    await run_kp_turn(
        ctx, services, Toolset(_DiceProvider(), NoteTools(services), MvuStatTools(services)), "search, then rest"
    )

    assert set(await _stored(services, ctx.chat_key)) == {
        "p.turn_start",
        "p.dice_rolled",
        "p.clock_advanced",
        "p.reply_ready",
        "p.variables_changed",
    }


async def test_a_state_only_write_is_not_a_variable_write():
    """No `variables_changed`, nothing in `hook_writes` (so the Scribe's hook-owned rule never
    sees it), and nothing in the variable space."""
    from core.modvars import load_modvars
    from core.mvu_compat import load_mvu

    services = _services(FakeLLM(script=[assistant_text("quiet")]))
    ctx = _ctx("hook-state-not-a-var")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => setstate('fear', 9));"
            "on('variables_changed', (e) => narrate('changed:' + e.writes.length));"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "go")

    assert "changed:" not in result.reply
    assert result.hook_writes == []
    assert "fear" not in (await load_modvars(services.documents, ctx.chat_key))["values"]
    assert "fear" not in (await load_mvu(services.documents, ctx.chat_key))
    assert await _stored(services, ctx.chat_key) == {"fear": "9"}


async def test_state_never_reaches_the_keeper_prompt():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("ok"))
    services = _services(llm)
    ctx = _ctx("hook-state-prompt")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            f"on('turn_start', () => {{ setstate('secret', {{note: '{SENTINEL}'}}); }});"
            "on('reply_ready', () => narrate('has-secret:' + (getstate('secret') !== undefined)));"
        ],
    )

    await run_kp_turn(ctx, services, Toolset(), "one")
    second = await run_kp_turn(ctx, services, Toolset(), "two")

    assert SENTINEL in json.dumps(await _stored(services, ctx.chat_key))  # it IS stored...
    assert "has-secret:true" in second.reply  # ...and the hooks read it back...
    sent = json.dumps([messages for messages, _tools in llm.calls], ensure_ascii=False)
    assert SENTINEL not in sent  # ...but no Keeper prompt of either turn ever carried it


async def test_state_never_reaches_a_wire_frame():
    services = _services(FakeLLM(script=[assistant_text("ok")]))
    chat_key = "hook-state-wire"
    ctx = _ctx(chat_key)
    await install_room_hooks(
        services, chat_key, "test", [f"on('turn_start', () => setstate('secret', '{SENTINEL}'));"]
    )

    result = await run_kp_turn(ctx, services, Toolset(), "go")

    assert SENTINEL in json.dumps(await _stored(services, chat_key))
    assert SENTINEL not in json.dumps(
        [result.reply, result.ui_frames, result.panel_events, result.hook_writes], ensure_ascii=False
    )
    player = AgentCtx(chat_key=chat_key, user_id="p1", platform="tui", locale="en", extra={"role": "player"})
    keeper = AgentCtx(chat_key=chat_key, user_id="kp", platform="cli", locale="en")
    for viewer in (player, keeper):
        assert SENTINEL not in json.dumps(await build_room_state(services, viewer), ensure_ascii=False)


async def test_a_refused_write_is_not_stored_and_later_handlers_stop_seeing_it():
    services = _services(FakeLLM(script=[assistant_text("ok")]))
    ctx = _ctx("hook-state-refused")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => {"
            f" setstate('huge', 'x'.repeat({MAX_STATE_VALUE_BYTES}));"  # + quotes: over the cap
            " setstate('bad key', 1); setstate('fine', 1);"
            " setstate('saw_huge', getstate('huge') !== undefined); });"
            "on('reply_ready', () => narrate('same-dispatch:' + getstate('saw_huge')"
            " + ' later:' + (getstate('huge') !== undefined)"
            " + '/' + (getstate('bad key') !== undefined) + '/' + getstate('fine')));"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "go")

    assert "same-dispatch:true" in result.reply  # the dispatch that wrote it still sees it
    assert "later:false/false/1" in result.reply  # re-synced to what the engine persisted
    assert await _stored(services, ctx.chat_key) == {"fine": "1", "saw_huge": "true"}


async def test_caps_hold_across_the_dispatches_of_a_turn():
    from core.hooks import MAX_STATE_KEYS

    services = _services(FakeLLM(script=[assistant_text("ok")]))
    ctx = _ctx("hook-state-room-cap")
    half = MAX_STATE_KEYS // 2
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            f"on('turn_start', () => {{ for (let i = 0; i < {half}; i++) setstate('a' + i, i); }});"
            f"on('reply_ready', () => {{ for (let i = 0; i < {half + 3}; i++) setstate('b' + i, i); }});"
        ],
    )

    await run_kp_turn(ctx, services, Toolset(), "go")

    stored = await _stored(services, ctx.chat_key)
    assert len(stored) == MAX_STATE_KEYS
    assert {f"b{i}" for i in range(half, half + 3)}.isdisjoint(stored)


async def test_a_corrupt_row_degrades_to_absent_and_can_be_overwritten():
    services = _services(FakeLLM(script=[assistant_text("ok")]))
    ctx = _ctx("hook-state-corrupt")
    await services.store.state_set(ctx.chat_key, "hook_state:ledger", "{not json")
    await services.store.state_set(ctx.chat_key, "hook_state:bad key", "1")  # a key setstate never writes
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => { setstate('seen', String(getstate('ledger'))); setstate('ledger', {n: 1}); });"
            "on('reply_ready', () => narrate('seen:' + getstate('seen')));"
        ],
    )

    assert await load_hook_state(services, ctx.chat_key) == {}
    result = await run_kp_turn(ctx, services, Toolset(), "go")

    assert "seen:undefined" in result.reply
    assert (await _stored(services, ctx.chat_key))["ledger"] == '{"n":1}'


async def test_tool_use_state_writes_are_not_persisted():
    llm = FakeLLM(
        script=[assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")), assistant_text("done")]
    )
    services = _services(llm)
    ctx = _ctx("hook-state-tool-use")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('tool_use', () => setstate('seen_tool', true));"
            "on('reply_ready', () => narrate('view:' + String(getstate('seen_tool'))));"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(_DiceProvider()), "search")

    assert "view:undefined" in result.reply
    assert await _stored(services, ctx.chat_key) == {}


async def test_every_engine_the_room_builds_gets_the_snapshot_through_one_loader():
    """The Scribe's tool_use veto path builds its engine with `load_room_hook_engine` too, so
    its handlers read the same state the turn's handlers do."""
    services = _services()
    ctx = _ctx("hook-state-loader")
    await install_room_hooks(services, ctx.chat_key, "test", ["on('tool_use', () => {});"])
    await apply_hook_state_writes(
        services, ctx.chat_key, None, HookOutcome(state_writes=[("column", {"state": "marching"})])
    )

    engine = await load_room_hook_engine(services, ctx)

    assert engine is not None
    assert engine.committed_state == {"column": {"state": "marching"}}


async def test_apply_never_raises_on_a_store_failure(monkeypatch):
    services = _services()
    chat_key = "hook-state-store-down"

    async def _boom(*args, **kwargs):
        raise RuntimeError("store down")

    monkeypatch.setattr(services.store, "state_list", _boom)

    applied = await apply_hook_state_writes(services, chat_key, None, HookOutcome(state_writes=[("k", 1)]))

    assert applied == []
    assert await load_hook_state(services, chat_key) == {}


# ---------------------------------------------------------------------------
# Lifecycle: the facet, undo, export/import
# ---------------------------------------------------------------------------


def test_the_facet_claims_the_prefix_at_the_scope_that_kills_the_variable_space():
    registry = room_registry()
    by_name = {facet.name: facet for facet in registry.facets}
    facet = by_name["hook_state"]
    assert facet.state_prefixes == frozenset({HOOK_STATE_PREFIX})
    assert facet.reset_scope == by_name["modvars"].reset_scope == by_name["mvu_tree"].reset_scope
    assert registry.claims_state_key(HOOK_STATE_PREFIX + "anything")


async def test_reset_keeps_state_below_the_facet_scope_and_kills_it_at_all(tmp_path):
    services = _services(data_dir=str(tmp_path))
    chat_key = chat_key_for_room("hook-reset")
    await apply_hook_state_writes(services, chat_key, None, HookOutcome(state_writes=[("ledger", 475)]))

    for scope in ("story", "chars"):
        await reset_room_state(services, chat_key, scope=scope)
        assert await _stored(services, chat_key) == {"ledger": "475"}, f"`.reset {scope}` must keep it"

    await reset_room_state(services, chat_key, scope="all")
    assert await _stored(services, chat_key) == {}


async def test_an_undo_restores_the_state_of_that_turn():
    services = _services(FakeLLM(responder=lambda messages, tools: assistant_text("ok")))
    ctx = _ctx("hook-state-undo")
    await install_room_hooks(services, ctx.chat_key, "test", [COUNTER_HOOK])

    for word in ("one", "two", "three"):
        await run_kp_turn(ctx, services, Toolset(), word)
    assert await _stored(services, ctx.chat_key) == {"turns": "3"}

    assert await restore(services, ctx.chat_key, 1)

    assert await _stored(services, ctx.chat_key) == {"turns": "1"}
    replay = await run_kp_turn(ctx, services, Toolset(), "two again")
    assert "turn#2" in replay.reply


async def test_export_and_import_carry_the_state(tmp_path):
    services = _services(data_dir=str(tmp_path))
    keystore = Keystore()
    keystore.add(room="hook-export", name="Keeper", role="keeper")
    chat_key = chat_key_for_room("hook-export")
    await apply_hook_state_writes(services, chat_key, None, HookOutcome(state_writes=[("ledger", {"n": 1})]))

    exported = await export_room(services, keystore, "hook-export", "hook-state.json")
    await apply_hook_state_writes(
        services, chat_key, None, HookOutcome(state_writes=[("ledger", None), ("later", 2)])
    )
    await import_room(services, keystore, exported["path"], expected_room="hook-export")

    assert await _stored(services, chat_key) == {"ledger": '{"n":1}'}
