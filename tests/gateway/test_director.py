"""Tests for M10 companion auto-pacing wiring (BUG D fix).

`docs/specs/M10-companions.md` §4 locks companion pacing to on-request (exploration) + auto on
initiative (combat). `gateway.director.run_director` is the auto half; `gateway.turn.run_turn`
calls it after every REAL (non-command) AI-KP turn. Before this fix, nothing in the turn path ever
called it, so a party's AI companions never acted on their own -- even with `.party auto` on and an
active initiative order. These tests pin:

- a real player turn auto-triggers a companion's turn when `.party auto` is on AND the room is in
  combat (an active initiative order) -- WITHOUT the KP ever calling `companion_act` itself;
- it does NOT trigger with auto off, or outside combat (no initiative order);
- a command turn never reaches the director at all;
- the structural anti-runaway: a companion's own turn (`ctx.platform == "companion"`) never
  re-triggers the director, even given `run_director` directly.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_companion import CompanionTools
from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.director import request_companion, run_director
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
from infra.store import Store


class FakeMember:
    """A recording hub member (mirrors `tests/agent/test_companion.py`'s)."""

    def __init__(self, id: str) -> None:
        self.id = id
        self.user_key = f"user:{id}"
        self.transport = "tui"
        self.name = id
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _ctx(chat_key: str, user_id: str = "nora", *, platform: str = "tui") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id=user_id, platform=platform, locale="en")


async def _add_companion(services, chat_key: str, name: str = "Ada") -> None:
    await CompanionTools(services).add_companion(_ctx(chat_key, user_id="kp"), name=name)


async def _set_party_auto(services, chat_key: str, on: bool) -> None:
    await services.store.set(user_key="", store_key=f"party_auto.{chat_key}", value="1" if on else "0")


async def _seed_initiative(services, chat_key: str, names: list[str]) -> None:
    entries = [{"name": name, "init": 20 - index} for index, name in enumerate(names)]
    await services.store.set(user_key="", store_key=f"initiative.{chat_key}", value=json.dumps(entries))


def _kp_narrates(text: str):
    """A responder for a normal player turn whose companion, if consulted, acts once."""

    def responder(messages, tools):
        if tools is None:  # the companion actor call (declares an action, no tools attached)
            return assistant_text(json.dumps({"action": "I ready my blade.", "dialogue": "On it."}))
        return assistant_text(text)

    return responder


def _services(responder) -> tuple:
    store = Store(":memory:")
    llm = FakeLLM(responder=responder) if responder is not None else FakeLLM(script=[])
    services = build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(8), store=store)
    return services, store


async def _room(services, hub: RoomHub, chat_key: str) -> tuple[CommandRouter, object, FakeMember]:
    router = CommandRouter(services, hub=hub)
    toolset = build_kp_toolset(services, hub=hub, command_router=router)
    watcher = FakeMember("watcher")
    await hub.subscribe(chat_key, watcher)
    watcher.events.clear()
    return router, toolset, watcher


async def test_player_turn_auto_triggers_a_companion_turn_when_auto_on_and_in_combat():
    chat_key = "combat-room"
    services, _store = _services(_kp_narrates("The hallway is quiet for now."))
    await _add_companion(services, chat_key, "Ada")
    await _set_party_auto(services, chat_key, True)
    await _seed_initiative(services, chat_key, ["Ada"])

    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key)

    await run_turn(hub, services, _ctx(chat_key), "I creep down the hallway", command_router=router, toolset=toolset)

    # The companion's own turn broadcast to the room -- the KP never called `companion_act` itself.
    companion_actions = [e for e in watcher.events if e.kind == "player_action" and e.name == "Ada"]
    assert companion_actions, "the party's companion must have auto-acted on the player's turn"
    kp_lines = [e for e in watcher.events if e.kind == "narrative" and e.speaker == "kp"]
    assert len(kp_lines) == 2  # the player's own KP reply + the companion's turn's KP resolution


async def test_no_auto_turn_when_party_auto_is_off():
    chat_key = "auto-off-room"
    services, _store = _services(_kp_narrates("The hallway is quiet for now."))
    await _add_companion(services, chat_key, "Ada")
    await _set_party_auto(services, chat_key, False)
    await _seed_initiative(services, chat_key, ["Ada"])

    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key)

    await run_turn(hub, services, _ctx(chat_key), "I creep down the hallway", command_router=router, toolset=toolset)

    assert [e.name for e in watcher.events if e.kind == "player_action"] == ["nora"]


async def test_no_auto_turn_outside_combat_even_with_auto_on():
    chat_key = "no-combat-room"
    services, _store = _services(_kp_narrates("The hallway is quiet for now."))
    await _add_companion(services, chat_key, "Ada")
    await _set_party_auto(services, chat_key, True)
    # No initiative order seeded -- not in combat.

    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key)

    await run_turn(hub, services, _ctx(chat_key), "I creep down the hallway", command_router=router, toolset=toolset)

    assert [e.name for e in watcher.events if e.kind == "player_action"] == ["nora"]


async def test_command_turn_never_reaches_the_director():
    chat_key = "command-room"
    services, _store = _services(_kp_narrates("unused"))
    await _add_companion(services, chat_key, "Ada")
    await _set_party_auto(services, chat_key, True)
    await _seed_initiative(services, chat_key, ["Ada"])

    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key)

    # A pure dice-roll command never reaches the AI-KP branch at all (and thus never the director) --
    # if it did, the companion's actor call (`tools is None`) would be consulted and its turn would
    # show up in the room's events.
    await run_turn(hub, services, _ctx(chat_key), ".r 1d20", command_router=router, toolset=toolset)

    assert not any(e.kind == "player_action" and e.name == "Ada" for e in watcher.events)


async def test_run_director_is_a_structural_noop_for_a_companions_own_turn():
    # Anti-runaway: even called directly with a companion-turn ctx, `run_director` must refuse to
    # run at all -- no store reads, no LLM calls (an empty FakeLLM script would raise if it tried).
    chat_key = "no-recurse-room"
    services, _store = _services(None)
    await _add_companion(services, chat_key, "Ada")
    await _set_party_auto(services, chat_key, True)
    await _seed_initiative(services, chat_key, ["Ada"])

    hub = RoomHub()
    router = CommandRouter(services, hub=hub)

    companion_ctx = _ctx(chat_key, user_id="companion:ada", platform="companion")
    result = await run_director(hub, services, companion_ctx, command_router=router)
    assert result == []


# --- Model-authored companion text must NEVER reach the command router / inline-roll parser ---
# (security cluster fix). A companion's action is LLM-generated; feeding it verbatim into the
# command router let it (a) recurse via ".party act <self>", (b) execute a level-0 command like
# ".bot off" with EVERYONE privilege from pure model output, and (c) short-circuit the whole KP
# turn via an inline "[[1d6]]". `run_companion_turn` now runs `run_turn` with `model_authored=True`,
# which skips `dispatch_reply` and treats the text as pure narration/action for the KP pipeline.


def _companion_declares(action: str, kp_reply: str):
    """A responder whose companion actor declares `action`, and whose KP resolves it to `kp_reply`.

    Counts every LLM call so a test can prove the turn is BOUNDED (no recursion cascade).
    """
    calls = {"n": 0}

    def responder(messages, tools):
        calls["n"] += 1
        if tools is None:  # the companion actor call (declares an action, no tools attached)
            return assistant_text(json.dumps({"action": action, "dialogue": ""}))
        return assistant_text(kp_reply)  # the KP resolving the action

    return responder, calls


async def test_companion_action_that_is_a_party_command_never_recurses_or_executes():
    # (a) A companion whose generated action reads ".party act <its own name>" must NOT re-enter
    # the director. Fed verbatim to the command router it recursed until RecursionError (an
    # instrumented run drove 165 real LLM calls); model-authored text now bypasses the router.
    chat_key = "recurse-room"
    responder, calls = _companion_declares(".party act Ada", "The Keeper describes Ada's move.")
    services, store = _services(responder)
    await _add_companion(services, chat_key, "Ada")

    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key)

    result = await request_companion(
        hub, services, "Ada", chat_key=chat_key, command_router=router, toolset=toolset
    )

    # BOUNDED: exactly one companion-actor call + one KP resolution -- no recursive cascade.
    assert calls["n"] == 2
    # The Keeper resolved the action as narration; no command executed.
    assert result is not None
    kp_lines = [e for e in watcher.events if e.kind == "narrative" and e.speaker == "kp"]
    assert len(kp_lines) == 1
    # The room attributes exactly one Ada action -- no second companion turn was spawned.
    ada_actions = [e for e in watcher.events if e.kind == "player_action" and e.name == "Ada"]
    assert len(ada_actions) == 1
    # The `.party` command binding/state was never touched.
    assert await store.get(user_key="", store_key=f"bot_enabled.{chat_key}") is None


async def test_companion_action_bot_off_does_not_mute_the_keeper():
    # (b) A companion action of ".bot off" must NOT flip `bot_enabled.{chat_key}` -- a level-0
    # command executing with EVERYONE privilege from pure model output -- and the room must still
    # get a KP-adjudicated turn (rather than the command reply branch swallowing it).
    chat_key = "botoff-room"
    responder, _calls = _companion_declares(".bot off", "The Keeper resolves the move.")
    services, store = _services(responder)
    await _add_companion(services, chat_key, "Ada")

    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key)

    result = await request_companion(
        hub, services, "Ada", chat_key=chat_key, command_router=router, toolset=toolset
    )

    # The KP mute flag was NOT flipped by the model-authored ".bot off".
    assert await store.get(user_key="", store_key=f"bot_enabled.{chat_key}") != "0"
    # And the room still got a KP-adjudicated turn.
    assert result is not None
    kp_lines = [e for e in watcher.events if e.kind == "narrative" and e.speaker == "kp"]
    assert len(kp_lines) == 1


async def test_companion_action_with_inline_roll_still_reaches_the_keeper(monkeypatch):
    # (c) An inline "[[1d6]]" in companion prose must NOT hit the `_render_inline_rolls` fallback
    # (which short-circuits the whole turn, leaving the Keeper unconsulted and the turn swallowed).
    # `run_kp_turn` MUST still be invoked.
    import gateway.turn as turn_mod

    kp_calls = {"n": 0}
    original_run_kp_turn = turn_mod.run_kp_turn

    async def spy(*args, **kwargs):
        kp_calls["n"] += 1
        return await original_run_kp_turn(*args, **kwargs)

    monkeypatch.setattr(turn_mod, "run_kp_turn", spy)

    chat_key = "inline-room"
    responder, _calls = _companion_declares(
        "I search the desk, rolling [[1d6]].", "The Keeper describes the search."
    )
    services, _store = _services(responder)
    await _add_companion(services, chat_key, "Ada")

    hub = RoomHub()
    router, toolset, watcher = await _room(services, hub, chat_key)

    result = await request_companion(
        hub, services, "Ada", chat_key=chat_key, command_router=router, toolset=toolset
    )

    # The Keeper WAS consulted -- the inline roll did not swallow the turn.
    assert kp_calls["n"] == 1
    assert result is not None, "the KP turn must not be swallowed by the inline-roll fallback"
    kp_lines = [e for e in watcher.events if e.kind == "narrative" and e.speaker == "kp"]
    assert len(kp_lines) == 1


async def test_run_director_noop_without_auto_or_combat():
    chat_key = "gate-room"
    services, _store = _services(None)
    await _add_companion(services, chat_key, "Ada")
    hub = RoomHub()
    router = CommandRouter(services, hub=hub)

    # Neither auto nor an initiative order is set.
    assert await run_director(hub, services, _ctx(chat_key), command_router=router) == []

    await _set_party_auto(services, chat_key, True)
    # Auto is on but the room is not in combat yet.
    assert await run_director(hub, services, _ctx(chat_key), command_router=router) == []
