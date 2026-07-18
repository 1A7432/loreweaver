"""Tests for the RoomHub — the transport-agnostic session bus (M6 Phase 1).

These exercise the hub in isolation with in-memory ``FakeMember``s (no sockets):
subscribe/unsubscribe/online bookkeeping, fan-out to every member, ``exclude``,
the drop-a-raising-member guarantee, and — the crux of the cross-platform
vision — that two members on *different* transports in one room both receive a
published event.
"""

from __future__ import annotations

from gateway.hub import Event, Member, RoomHub


class FakeMember:
    """An in-memory `gateway.hub.Member` that records what it was delivered.

    `fail` can be toggled to make `deliver` raise, to exercise the hub's
    drop-on-failure fan-out guarantee.
    """

    def __init__(self, id: str, *, transport: str = "tui", name: str = "", fail: bool = False) -> None:
        self.id = id
        self.user_key = f"user:{id}"
        self.transport = transport
        self.name = name or id
        self.fail = fail
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        if self.fail:
            raise RuntimeError("deliver boom")
        self.events.append(event)


def _delivered_kinds(member: FakeMember) -> list[str]:
    return [event.kind for event in member.events]


def test_fake_member_satisfies_the_member_protocol() -> None:
    # The Protocol is runtime_checkable, so this pins the structural contract
    # (id / user_key / transport / deliver) the hub relies on.
    assert isinstance(FakeMember("x"), Member)


def test_event_constructors_tag_kind_and_payload() -> None:
    assert Event.player_action("Nora", ".r 1d20").kind == "player_action"
    assert Event.dice("Nora", "check", expr="Spot", total=42).data["kind"] == "check"
    npc = Event.narrative("npc", "Hello.", name="Martha")
    assert (npc.kind, npc.speaker, npc.name) == ("narrative", "npc", "Martha")
    assert Event.state({"type": "state", "online": 0}).data["type"] == "state"
    presence = Event.presence([{"id": "a"}], 1)
    assert presence.data["online"] == 1
    assert Event.system("info", "hi").data["level"] == "info"
    assert Event.turn_status("busy", actor="Nora").data == {"status": "busy", "actor": "Nora"}


async def test_nested_ai_turns_publish_one_outer_busy_idle_pair() -> None:
    hub = RoomHub()
    watcher = FakeMember("watcher")
    await hub.subscribe("room", watcher)
    watcher.events.clear()

    await hub.begin_turn("room", "Nora")
    await hub.begin_turn("room", "Silas")
    await hub.end_turn("room")
    assert [(event.data["status"], event.data.get("actor")) for event in watcher.events] == [
        ("busy", "Nora")
    ]

    await hub.end_turn("room")
    assert [(event.data["status"], event.data.get("actor")) for event in watcher.events] == [
        ("busy", "Nora"),
        ("idle", None),
    ]


async def test_subscribe_unsubscribe_and_online_count() -> None:
    hub = RoomHub()
    alice, bob = FakeMember("a"), FakeMember("b")

    assert hub.online("room") == 0
    assert hub.members("room") == []

    await hub.subscribe("room", alice)
    assert hub.online("room") == 1
    assert alice in hub.members("room")
    # subscribing broadcasts the new roster to the room.
    assert "presence" in _delivered_kinds(alice)

    await hub.subscribe("room", bob)
    assert hub.online("room") == 2

    await hub.unsubscribe(alice)
    assert hub.online("room") == 1
    assert alice not in hub.members("room")
    assert bob in hub.members("room")

    await hub.unsubscribe(bob)
    assert hub.online("room") == 0
    assert hub.members("room") == []


async def test_publish_fans_out_to_every_member() -> None:
    hub = RoomHub()
    members = [FakeMember("a"), FakeMember("b"), FakeMember("c")]
    for member in members:
        await hub.subscribe("room", member)
    for member in members:
        member.events.clear()

    event = Event.narrative(speaker="kp", text="You step into the lamplit hall.")
    await hub.publish("room", event)

    for member in members:
        assert any(delivered is event for delivered in member.events)


async def test_publish_exclude_skips_that_member() -> None:
    hub = RoomHub()
    author, other = FakeMember("author"), FakeMember("other")
    await hub.subscribe("room", author)
    await hub.subscribe("room", other)
    author.events.clear()
    other.events.clear()

    event = Event.player_action("author", "look around")
    await hub.publish("room", event, exclude=author)

    assert all(delivered is not event for delivered in author.events)
    assert any(delivered is event for delivered in other.events)


async def test_publish_only_user_and_exclude_user_target_every_connection_of_one_human() -> None:
    """`only_user`/`exclude_user` address a `user_key` — including a second terminal
    of the same human — without the caller knowing individual members."""
    hub = RoomHub()
    keeper_a, keeper_b, player = FakeMember("kp"), FakeMember("kp"), FakeMember("p1")
    for member in (keeper_a, keeper_b, player):
        await hub.subscribe("room", member)
        member.events.clear()

    secret = Event.narrative(speaker="system", text="module progress ①")
    await hub.publish("room", secret, only_user="user:kp")
    assert any(delivered is secret for delivered in keeper_a.events)
    assert any(delivered is secret for delivered in keeper_b.events)
    assert all(delivered is not secret for delivered in player.events)

    notice = Event.narrative(speaker="system", text="the Keeper is preparing a module")
    await hub.publish("room", notice, exclude_user="user:kp")
    assert all(delivered is not notice for delivered in keeper_a.events)
    assert all(delivered is not notice for delivered in keeper_b.events)
    assert any(delivered is notice for delivered in player.events)


async def test_member_whose_deliver_raises_is_dropped_without_breaking_others() -> None:
    hub = RoomHub()
    good1, bad, good2 = FakeMember("good1"), FakeMember("bad"), FakeMember("good2")
    for member in (good1, bad, good2):
        await hub.subscribe("room", member)
    for member in (good1, bad, good2):
        member.events.clear()

    bad.fail = True
    event = Event.narrative(speaker="kp", text="A shot rings out across the dark hall.")
    await hub.publish("room", event)

    # The fan-out completed for the healthy members despite `bad` raising.
    assert any(delivered is event for delivered in good1.events)
    assert any(delivered is event for delivered in good2.events)
    # ...and the offender was dropped from the room.
    assert bad not in hub.members("room")
    assert hub.online("room") == 2

    # A subsequent publish never touches the dropped member again, even if it
    # would now "recover".
    bad.fail = False
    followup = Event.system("info", "the smoke slowly clears")
    await hub.publish("room", followup)
    assert all(delivered is not followup for delivered in bad.events)
    assert any(delivered is followup for delivered in good1.events)


async def test_personalized_event_build_failure_does_not_drop_the_connection() -> None:
    hub = RoomHub()
    good, broken = FakeMember("good"), FakeMember("broken")
    await hub.subscribe("room", good)
    await hub.subscribe("room", broken)
    good.events.clear()
    broken.events.clear()

    async def build(member: FakeMember) -> Event:
        if member is broken:
            raise ValueError("bad state")
        return Event.state({"member": member.id})

    await hub.publish_each("room", build)

    assert any(event.kind == "state" for event in good.events)
    assert broken in hub.members("room")


async def test_publish_does_not_delete_a_room_recreated_during_fanout() -> None:
    """Regression: ``publish`` captures the room's member set before awaiting each
    ``deliver``. If the room is emptied and re-created (a new member joins) during that
    await, the post-fan-out cleanup must reconcile against the *live* set, not pop the
    freshly-created one — otherwise the newcomer is silently dropped from all fan-out.
    """
    hub = RoomHub()
    newcomer = FakeMember("newcomer")

    class SwappingMember(FakeMember):
        async def deliver(self, event: Event) -> None:
            # Model a concurrent unsubscribe-to-empty + fresh subscribe landing while
            # this deliver is in flight (a real deliver awaits I/O here), then fail so
            # publish runs its drop/cleanup path against the now-detached original set.
            hub.rooms.pop("room", None)
            hub.rooms.setdefault("room", set()).add(newcomer)
            raise RuntimeError("deliver boom")

    hub.rooms["room"] = {SwappingMember("swapper")}

    await hub.publish("room", Event.system("info", "x"))

    # The re-created room (holding the newcomer) survived; it was not popped.
    assert newcomer in hub.members("room")
    assert hub.online("room") == 1


async def test_two_members_on_different_transports_both_receive_the_event() -> None:
    # The whole point of the hub: one logical session, heterogeneous membership.
    hub = RoomHub()
    terminal = FakeMember("term-1", transport="tui")
    discord = FakeMember("discord-1", transport="discord")
    await hub.subscribe("session", terminal)
    await hub.subscribe("session", discord)
    terminal.events.clear()
    discord.events.clear()

    event = Event.narrative(speaker="npc", name="Martha", text="The bell rang long after midnight.")
    await hub.publish("session", event)

    assert any(delivered is event for delivered in terminal.events)
    assert any(delivered is event for delivered in discord.events)
    assert {terminal.transport, discord.transport} == {"tui", "discord"}
