"""Per-room turn serialization (audit finding F8).

`infra.store` locks each individual get/set, but nothing serialized a caller's
read->mutate->write of a shared per-`chat_key` JSON blob (party roster, KP
history, knowledge pool, worldbook index). Two turns interleaving on the SAME
room (two transports on one room in combined mode, or a multiplayer room) could
therefore lost-update those blobs.

The fix is a per-room `asyncio.Lock` on `gateway.hub.RoomHub`, acquired around a
WHOLE turn at each transport choke point (`net.tui_server.dispatch_input`,
`gateway.runner._answer_on_hub`). These tests pin:

* the lock registry is stable per key and distinct across keys;
* two turns on the SAME room serialize and neither write is lost;
* two turns on DIFFERENT rooms still overlap (are NOT serialized);
* a companion/director sub-turn re-entering `run_turn` inside a player turn
  does not self-deadlock on the room's own lock.
"""

from __future__ import annotations

import asyncio
import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_companion import CompanionTools
from agent.services import build_services
from gateway.commands import CommandReply, CommandRouter
from gateway.events import InboundMessage
from gateway.hub import Event, RoomHub
from gateway.runner import GatewayRunner
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
from net.keystore import Keystore, member_id_for_key
from net.tui_server import TuiServer, WsMember


def _services(responder=None):
    llm = FakeLLM(responder=responder) if responder is not None else FakeLLM(script=[])
    return build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(8))


class _FakeWs:
    """A stand-in socket whose `send` records frames (never touches the network)."""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, data: str) -> None:
        self.sent.append(data)


class _FakeMember:
    """A recording `gateway.hub.Member` (mirrors tests/gateway/test_hub's FakeMember)."""

    transport = "tui"

    def __init__(self, member_id: str) -> None:
        self.id = member_id
        self.user_key = f"user:{member_id}"
        self.name = member_id
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


class _FakeAdapter:
    """A minimal chat adapter that records `.send` (stands in for a real transport)."""

    platform = "discord"

    def __init__(self) -> None:
        self.sends: list[tuple] = []

    async def deliver_event(self, source, session_key, event, *, locale, media_store=None):
        self.sends.append((source, event, session_key))
        return None


def _ws_member(room_id: str, member_id: str, name: str = "P") -> WsMember:
    """A `WsMember` for `room_id` whose `session_key` matches what `dispatch_input`
    derives from `member.room` (so the lock key and the turn's `chat_key` agree)."""
    source = SessionSource(platform="tui", chat_type="group", chat_id=room_id, user_id=member_id, user_name=name)
    return WsMember(
        ws=_FakeWs(),
        id=member_id,
        user_key=source.user_key(),
        name=name,
        role="player",
        room=room_id,
        session_key=source.chat_key(),
        locale="en",
    )


def _authorize(keystore: Keystore, *members: WsMember) -> list[str]:
    """Bind directly-constructed test members through the real live-auth mapping."""
    keys: list[str] = []
    for member in members:
        key = keystore.add(room=member.room, name=member.name, role=member.role)
        keys.append(key)
        member.id = member_id_for_key(key)
        source = SessionSource(
            platform="tui",
            chat_type="group",
            chat_id=member.room,
            user_id=member.id,
            user_name=member.name,
        )
        member.user_key = source.user_key()
    return keys


class _RosterRmwRouter:
    """A command-router stand-in whose `dispatch` performs the party-roster
    read-modify-write (the exact `core.character_manager.sync_party_roster` shape)
    with a deliberate yield between the read and the write.

    Absent per-room serialization, two turns each read the same stale roster and the
    later write clobbers the earlier one (a lost update). `order` records enter/exit so
    a test can assert the two turns did not interleave. `resolve` -> None so the runner's
    `on_inbound` treats the text as a normal (non-`.room`) message and still reaches
    `run_turn`, where `dispatch` runs.
    """

    def __init__(self, store, order: list[tuple[str, str]]) -> None:
        self._store = store
        self.order = order

    def resolve(self, text: str, locale: str):
        return None

    async def dispatch_reply(self, ctx: AgentCtx, text: str) -> CommandReply:
        name = text.strip()
        key = f"party_roster.{ctx.chat_key}"
        self.order.append(("enter", name))
        raw = await self._store.get(user_key="", store_key=key)
        roster = json.loads(raw) if raw else {}
        for _ in range(5):
            await asyncio.sleep(0)  # let an unserialized peer turn read the same stale roster
        roster[name] = {"name": name}
        await self._store.set(user_key="", store_key=key, value=json.dumps(roster))
        self.order.append(("exit", name))
        return CommandReply(f"added {name}")


class _BarrierRouter:
    """`dispatch` signals its room's arrival, then waits for EVERY other tracked room to
    arrive too. If both dispatches return, the two turns were inside simultaneously — proof
    that different rooms are not serialized against each other."""

    def __init__(self, arrived: dict[str, asyncio.Event]) -> None:
        self._arrived = arrived

    def resolve(self, text: str, locale: str):
        return None

    async def dispatch_reply(self, ctx: AgentCtx, text: str) -> CommandReply:
        self._arrived[ctx.chat_key].set()
        for key, event in self._arrived.items():
            if key != ctx.chat_key:
                await asyncio.wait_for(event.wait(), timeout=3.0)
        return CommandReply("ok")


# ---------------------------------------------------------------------------
# (1) the registry: stable per key, distinct across keys
# ---------------------------------------------------------------------------


async def test_turn_lock_is_stable_per_key_and_distinct_across_keys() -> None:
    hub = RoomHub()
    lock_a = hub.turn_lock("room-a")
    assert hub.turn_lock("room-a") is lock_a  # same room -> the SAME lock (turns contend)
    assert hub.turn_lock("room-b") is not lock_a  # different room -> a distinct lock (no contention)
    assert isinstance(lock_a, asyncio.Lock)


# ---------------------------------------------------------------------------
# (2) same room -> serialized, no lost update (the F8 core guarantee), via the
#     real TUI choke point `TuiServer.dispatch_input`
# ---------------------------------------------------------------------------


async def test_same_room_turns_serialize_and_do_not_lose_an_update() -> None:
    hub = RoomHub()
    services = _services()
    order: list[tuple[str, str]] = []
    ann = _ws_member("shared-room", "conn-a", "Ann")
    bob = _ws_member("shared-room", "conn-b", "Bob")
    keystore = Keystore()
    _authorize(keystore, ann, bob)
    server = TuiServer(services, keystore, command_router=_RosterRmwRouter(services.store, order), hub=hub)
    assert ann.session_key == bob.session_key  # one room -> one turn lock

    await asyncio.gather(server.dispatch_input(ann, "Ann"), server.dispatch_input(bob, "Bob"))

    raw = await services.store.get(user_key="", store_key=f"party_roster.{ann.session_key}")
    roster = json.loads(raw)
    assert set(roster) == {"Ann", "Bob"}  # neither turn's write was lost

    # Serialized, not interleaved: each turn's enter is immediately followed by its OWN exit.
    assert [op for op, _ in order] == ["enter", "exit", "enter", "exit"]
    assert order[1] == ("exit", order[0][1])
    assert order[3] == ("exit", order[2][1])
    assert {order[0][1], order[2][1]} == {"Ann", "Bob"}


async def test_queued_turn_reauthorizes_after_acquiring_the_room_lock() -> None:
    hub = RoomHub()
    services = _services()
    order: list[tuple[str, str]] = []
    member = _ws_member("queued-room", "conn", "Keeper")
    member.role = "keeper"
    keystore = Keystore()
    [key] = _authorize(keystore, member)
    server = TuiServer(
        services,
        keystore,
        command_router=_RosterRmwRouter(services.store, order),
        hub=hub,
    )
    lock = hub.turn_lock(member.session_key)
    await lock.acquire()
    task = asyncio.create_task(server.dispatch_input(member, "must-not-run"))
    await asyncio.sleep(0)  # initial auth completed; request is queued on `lock`

    keystore.remove(key)
    lock.release()
    await task

    assert order == []
    frames = [json.loads(raw) for raw in member.ws.sent]
    assert frames[-1]["type"] == "error"
    assert frames[-1]["code"] == "forbidden"


async def test_read_only_admin_does_not_wait_for_the_config_lock() -> None:
    services = _services()
    member = _ws_member("queued-admin", "conn", "Keeper")
    member.role = "keeper"
    keystore = Keystore()
    _authorize(keystore, member)
    server = TuiServer(services, keystore)
    await services.config_lock.acquire()
    task = asyncio.create_task(
        server._on_frame(member, json.dumps({"type": "admin_get_config"}))
    )
    await asyncio.sleep(0)

    completed_without_config_lock = task.done()
    services.config_lock.release()
    await task

    frames = [json.loads(raw) for raw in member.ws.sent]
    assert completed_without_config_lock
    assert frames[-1]["type"] == "admin_config"


# ---------------------------------------------------------------------------
# (3) different rooms -> NOT serialized (they overlap)
# ---------------------------------------------------------------------------


async def test_turns_on_different_rooms_are_not_serialized() -> None:
    hub = RoomHub()
    services = _services()
    alice = _ws_member("room-a", "a1")
    bruno = _ws_member("room-b", "b1")
    assert alice.session_key != bruno.session_key

    arrived = {alice.session_key: asyncio.Event(), bruno.session_key: asyncio.Event()}
    keystore = Keystore()
    _authorize(keystore, alice, bruno)
    server = TuiServer(services, keystore, command_router=_BarrierRouter(arrived), hub=hub)

    # Each turn only returns once the OTHER room's turn has also entered. If different rooms
    # wrongly shared a lock, the second turn could never enter and this would deadlock; the
    # wait_for turns that deadlock into a fast failure. Completing proves they overlapped.
    await asyncio.wait_for(
        asyncio.gather(server.dispatch_input(alice, "x"), server.dispatch_input(bruno, "y")),
        timeout=5.0,
    )
    assert all(event.is_set() for event in arrived.values())


# ---------------------------------------------------------------------------
# (4) a companion/director sub-turn inside a player turn must NOT self-deadlock
# ---------------------------------------------------------------------------


async def test_companion_subturn_inside_a_player_turn_does_not_deadlock() -> None:
    hub = RoomHub()

    def responder(messages, tools):
        if tools is None:  # the companion actor declares an action
            return assistant_text(json.dumps({"action": "I bar the door", "dialogue": "Hold fast."}))
        return assistant_text("The door slams shut under Silas' shoulder.")  # the KP resolves it

    services = _services(responder)
    room_id = "companion-room"
    chat_key = SessionSource(platform="tui", chat_type="group", chat_id=room_id).chat_key()
    await CompanionTools(services).add_companion(
        AgentCtx(chat_key=chat_key, user_id="kp", locale="en"), name="Silas", persona="A steady gunslinger."
    )

    watcher = _FakeMember("watcher")
    await hub.subscribe(chat_key, watcher)

    keeper = _ws_member(room_id, "kp-conn", "Keeper")
    keystore = Keystore()
    _authorize(keystore, keeper)
    router = CommandRouter(services, hub=hub)  # hub-wired so `.party act` can drive the director
    server = TuiServer(services, keystore, command_router=router, hub=hub, toolset=build_kp_toolset(services))
    assert keeper.session_key == chat_key

    # `.party act Silas` runs INSIDE the player turn, which already holds turn_lock(room). It drives
    # the director -> run_companion_turn -> run_turn AS the companion, re-entering run_turn for the
    # SAME room. If that re-acquired the room lock it would deadlock; it must complete.
    await asyncio.wait_for(server.dispatch_input(keeper, ".party act Silas"), timeout=5.0)

    # The sub-turn actually executed within the locked player turn: the room saw Silas act.
    assert any(e.kind == "player_action" and e.name == "Silas" for e in watcher.events)


# ---------------------------------------------------------------------------
# (5) the OTHER choke point: `GatewayRunner._answer_on_hub` serializes too
# ---------------------------------------------------------------------------


async def test_runner_hub_path_serializes_same_session_no_lost_update() -> None:
    hub = RoomHub()
    services = _services()
    order: list[tuple[str, str]] = []
    router = _RosterRmwRouter(services.store, order)
    adapter = _FakeAdapter()
    runner = GatewayRunner(services, [adapter], command_router=router, hub=hub, keystore=Keystore())

    # One source (a single DM channel) sending two messages that race: both resolve to the same
    # session_key, so both turns take the SAME room lock and must serialize.
    source = SessionSource(platform="discord", chat_type="dm", chat_id="dm-1", user_id="u-1", user_name="Nora")
    session_key = source.chat_key()

    await asyncio.gather(
        runner.on_inbound(InboundMessage(source=source, text="Ann", at_bot=True)),
        runner.on_inbound(InboundMessage(source=source, text="Bob", at_bot=True)),
    )

    raw = await services.store.get(user_key="", store_key=f"party_roster.{session_key}")
    roster = json.loads(raw)
    assert set(roster) == {"Ann", "Bob"}  # neither turn's write was lost
    assert [op for op, _ in order] == ["enter", "exit", "enter", "exit"]  # serialized, not interleaved
