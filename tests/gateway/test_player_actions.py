"""Player-invokable module actions (protocol 2.6): `.act` lists and runs a room's
`defineAction(…, {player: true})` mechanics with no Keeper round, delivers the result like a
`.ra` result, reports it to the Keeper's next turn, and advertises the actions on `state`.
Skipped as a module without the `ejs` extra (hooks are inert then)."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.hook_actions import COMMAND_SEQ_KEY, PLAYER_ACTION_LOG_KEY  # noqa: E402
from agent.hook_runtime import ACTION_MANIFEST_KEY, HOOK_STATE_PREFIX, install_room_hooks  # noqa: E402
from agent.kp_tools import build_kp_toolset  # noqa: E402
from agent.loop import run_kp_turn  # noqa: E402
from agent.services import build_services  # noqa: E402
from agent.tools import Toolset  # noqa: E402
from agent.undo import capture, restore  # noqa: E402
from core.dice_engine import seed_dice  # noqa: E402
from core.modvars import build_spec, define_modvar, load_modvars  # noqa: E402
from gateway.commands.router import CommandRouter  # noqa: E402
from gateway.hub import RoomHub  # noqa: E402
from gateway.session import SessionSource  # noqa: E402
from gateway.turn import run_turn  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call  # noqa: E402
from net.state import build_room_state  # noqa: E402

ACTIONS = (
    "defineAction('forage', {description: 'Search the hedgerow for food', params: '{where?: string}',"
    " player: true, label: {en: 'Forage', zh: '采集'}, rolls: {find: '1d6'}}, (args, ev) => {"
    "  const pantry = (getstate('pantry') ?? 0) + ev.rolls.find.total;"
    "  setstate('pantry', pantry); setvar('food', pantry);"
    "  emitUI([{kind: 'stat', label: 'Pantry', value: pantry}]);"
    "  return ev.source + ' foraged ' + (args.where || args.text || 'nearby') + ': pantry ' + pantry; });"
    "defineAction('reveal_traitor', {description: 'Keeper-only: unmask the traitor'}, () => 'the steward');"
    "defineAction('seed', {description: 'seed', player: true}, (a, ev) => String(ev.seed));"
)


def _services(llm=None, **settings):
    return build_services(Settings(locale="en", **settings), llm=llm or FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _ctx(room: str, *, user_id: str = "p1", locale: str = "en", role: str = "player") -> AgentCtx:
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform="tui", locale=locale, extra={"role": role})


class _Recorder:
    def __init__(self, member_id: str = "m1"):
        self.id = member_id
        self.user_key = f"tui:{member_id}"
        self.transport = "test"
        self.events = []

    async def deliver(self, event):
        self.events.append(event)


async def _room(services, ctx, scripts=(ACTIONS,)):
    await install_room_hooks(services, ctx.chat_key, "test", list(scripts))


async def _act(services, ctx, text):
    return await CommandRouter(services).dispatch_reply(ctx, text)


async def test_act_lists_only_player_actions_privately():
    services = _services()
    ctx = _ctx("act-list")
    empty = await _act(services, ctx, ".act")
    assert empty.private and "no actions" in empty.text

    await _room(services, ctx)
    listing = await _act(services, ctx, ".act")
    assert listing.private and not listing.error
    assert "Forage (forage) — Search the hedgerow for food [{where?: string}]" in listing.text
    assert "reveal_traitor" not in listing.text and "traitor" not in listing.text
    zh = await _act(services, _ctx("act-list", locale="zh"), ".act")
    assert "采集" in zh.text


async def test_act_runs_an_action_with_json_or_text_args():
    seed_dice(3)
    services = _services()
    ctx = _ctx("act-run")
    await _room(services, ctx)

    by_json = await _act(services, ctx, '.act forage {"where": "the ditch"}')
    by_text = await _act(services, ctx, ".act forage behind the mill")
    bare = await _act(services, ctx, ".act forage")

    assert by_json.text.startswith("player foraged the ditch: pantry ")
    assert by_text.text.startswith("player foraged behind the mill: pantry ")
    assert bare.text.startswith("player foraged nearby: pantry ")
    assert not (by_json.error or by_json.private)  # table content, like a `.ra` result
    pantry = int(bare.text.rsplit(" ", 1)[-1])
    assert await services.store.state_get(ctx.chat_key, HOOK_STATE_PREFIX + "pantry") == str(pantry)
    dice = [event for event in by_json.events if event.kind == "dice"]
    assert dice and dice[0].data["kind"] == "subsystem" and dice[0].data["subsystem"] == "module_action:forage"
    assert by_json.ui_frames and by_json.ui_frames[0]["blocks"][0]["label"] == "Pantry"


async def test_unknown_and_keeper_only_actions_get_the_same_reply():
    services = _services()
    ctx = _ctx("act-unknown")
    await _room(services, ctx)

    unknown = await _act(services, ctx, ".act nope")
    keeper_only = await _act(services, ctx, ".act reveal_traitor")

    assert unknown.error and keeper_only.error
    assert unknown.text.replace("nope", "X") == keeper_only.text.replace("reveal_traitor", "X")
    assert "steward" not in keeper_only.text


async def test_a_failed_action_is_unicast_and_applies_nothing():
    services = _services()
    ctx = _ctx("act-fail")
    await _room(services, ctx, ["defineAction('jam', {description: 'j', player: true}, () => { setstate('x', 1); throw new Error('stuck'); });"])

    reply = await _act(services, ctx, ".act jam")

    assert reply.error and "stuck" in reply.text
    assert await services.store.state_list(ctx.chat_key, prefix=HOOK_STATE_PREFIX) == []
    assert await services.store.state_get(ctx.chat_key, PLAYER_ACTION_LOG_KEY) is None


async def test_variables_changed_fires_once_after_an_action_that_wrote_variables():
    services = _services()
    ctx = _ctx("act-varchanged")
    await define_modvar(services.documents, ctx.chat_key, build_spec("food", "number", minimum=0, maximum=100))
    await _room(
        services,
        ctx,
        [
            ACTIONS,
            "on('variables_changed', (e) => { setstate('seen', e.writes.map((w) => w.path)); narrate('[the larder creaks]'); });",
        ],
    )

    reply = await _act(services, ctx, ".act forage")

    assert reply.text.endswith("\n\n[the larder creaks]")
    assert json.loads(await services.store.state_get(ctx.chat_key, HOOK_STATE_PREFIX + "seen")) == ["food"]
    assert (await load_modvars(services.documents, ctx.chat_key))["values"]["food"] >= 1


async def test_the_tool_use_hook_is_not_consulted_for_act():
    services = _services()
    ctx = _ctx("act-no-veto")
    await _room(services, ctx, [ACTIONS, "on('tool_use', () => denyTool('never'));"])

    reply = await _act(services, ctx, ".act forage")

    assert not reply.error and "foraged" in reply.text


async def test_two_identical_calls_draw_different_seeds_and_undo_restores_the_counter():
    services = _services()
    ctx = _ctx("act-seeds")
    await _room(services, ctx)

    first = (await _act(services, ctx, ".act seed")).text
    await capture(services, ctx.chat_key, 1)
    second = (await _act(services, ctx, ".act seed")).text
    assert first != second
    assert await services.store.state_get(ctx.chat_key, COMMAND_SEQ_KEY) == "2"

    assert await restore(services, ctx.chat_key, 1)
    assert await services.store.state_get(ctx.chat_key, COMMAND_SEQ_KEY) == "1"
    assert (await _act(services, ctx, ".act seed")).text == second  # replays the same seed


async def test_the_keeper_learns_what_players_ran_on_its_next_turn():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("The Keeper goes on."))
    services = _services(llm)
    ctx = _ctx("act-keeper")
    await _room(services, ctx)
    reply = await _act(services, ctx, ".act forage by the river")

    await run_kp_turn(ctx, services, Toolset(), "what now?")
    first_prompt = json.dumps(llm.calls[-1][0], ensure_ascii=False)
    await run_kp_turn(ctx, services, Toolset(), "and now?")
    second_prompt = json.dumps(llm.calls[-1][0], ensure_ascii=False)

    assert "players ran these module actions" in first_prompt
    assert json.dumps(reply.text, ensure_ascii=False)[1:-1] in first_prompt
    assert "players ran these module actions" not in second_prompt  # read-and-clear


async def test_the_keeper_tool_sees_source_keeper():
    llm = FakeLLM(script=[assistant_tools(tool_call("module_action", action="forage", args={"where": "camp"})), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("act-keeper-source")
    await _room(services, ctx)

    await run_kp_turn(ctx, services, Toolset(), "forage")

    tool_messages = [message["content"] for message in llm.calls[1][0] if message.get("role") == "tool"]
    assert tool_messages[0].startswith("keeper foraged camp")


async def test_run_turn_broadcasts_the_result_like_a_check_and_refreshes_state():
    services = _services()
    ctx = _ctx("act-hub")
    await _room(services, ctx)
    hub = RoomHub()
    caller, other = _Recorder("m1"), _Recorder("m2")
    await hub.subscribe(ctx.chat_key, caller)
    await hub.subscribe(ctx.chat_key, other)

    await run_turn(
        hub, services, ctx, ".act forage", command_router=CommandRouter(services),
        toolset=build_kp_toolset(services), origin=caller,
    )

    kinds = [event.kind for event in other.events]
    assert "dice" in kinds and "ui" in kinds and kinds[-1] == "state"
    narrative = next(event for event in other.events if event.kind == "narrative" and event.speaker == "system")
    assert "foraged" in narrative.text and not narrative.private
    assert any(action["id"] == "forage" for action in next(e for e in other.events if e.kind == "state").data.get("actions", []))

    # A failure reaches its author alone.
    caller.events.clear()
    other.events.clear()
    await run_turn(
        hub, services, ctx, ".act nope", command_router=CommandRouter(services),
        toolset=build_kp_toolset(services), origin=caller,
    )
    assert not any(event.kind == "narrative" and event.speaker == "system" for event in other.events)
    assert any(event.kind == "narrative" and event.speaker == "system" for event in caller.events)


async def test_state_frames_list_player_actions_from_the_cached_manifest():
    services = _services()
    ctx = _ctx("act-state")
    assert "actions" not in await build_room_state(services, ctx)

    await _room(services, ctx)  # the install refreshes the manifest
    state = await build_room_state(services, ctx)
    assert state["actions"] == [
        {"id": "forage", "label": "Forage", "description": "Search the hedgerow for food", "params": "{where?: string}"},
        {"id": "seed", "label": "seed", "description": "seed"},
    ]
    zh = await build_room_state(services, _ctx("act-state", locale="zh"))
    assert zh["actions"][0]["label"] == "采集"
    assert "reveal_traitor" not in json.dumps(state)

    # The manifest is a cache: serving it builds no engine, and it follows the scripts.
    await install_room_hooks(services, ctx.chat_key, "test", ["on('turn_start', () => {});"])
    assert "actions" not in await build_room_state(services, ctx)
    assert (await services.store.state_get(ctx.chat_key, ACTION_MANIFEST_KEY) or "") == ""


async def test_no_actions_when_hooks_are_disabled():
    services = _services(enable_full_ejs=False)
    ctx = _ctx("act-disabled")
    await _room(services, ctx)

    assert "no actions" in (await _act(services, ctx, ".act")).text
    assert (await _act(services, ctx, ".act forage")).error
    assert "actions" not in await build_room_state(services, ctx)
