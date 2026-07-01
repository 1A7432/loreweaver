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

    def supports_proactive(self) -> bool:
        return True

    async def deliver(self, event: Event) -> None:
        if self.fail:
            raise RuntimeError("deliver boom")
        self.events.append(event)


def _delivered_kinds(member: FakeMember) -> list[str]:
    return [event.kind for event in member.events]


def test_fake_member_satisfies_the_member_protocol() -> None:
    # The Protocol is runtime_checkable, so this pins the structural contract
    # (id / user_key / transport / supports_proactive / deliver) the hub relies on.
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
