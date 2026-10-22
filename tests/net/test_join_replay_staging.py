"""Join replay of what the table SAW beyond prose and dice: inline `ui` frames and the
speaker of each player line.

Live, 2026-10-21 (Studio, protocol 2.4, 《安土》): after a client reload the replay
restored the narration, the player lines and the NPC lines — and nothing the Stage
Director had staged. The 环林 panorama, an engagement letter and a copied survey table
were gone, because the Director published its `ui` frames to the hub and nothing ever
wrote them where replay reads. Module-hook cards had the same hole (the 09-24 playtest's
拔营 ledger cards vanished across an engine restart). And every replayed player line
showed the Keeper-facing speaker tag inside the bubble (`[平知章 (Dirac)]`) with no name
header, where the live echo carried the name in its own field.

The hard part is WHERE a late frame replays. The Director runs in the post-turn pass,
outside the turn lock, and often lands after the next turn has already written its
player line; anchored to the transcript's leaf at publish time it would replay inside
the wrong turn. These drive real turns (`gateway.turn.run_turn`) and a real joiner over
the wire (`TuiServer`), offline.
"""

from __future__ import annotations

import asyncio
import hashlib
import json

import pytest
import websockets

from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, append_message
from agent.kp_tools import build_kp_toolset
from agent.scribe_coord import scribe_runtime
from agent.services import build_services
from agent.undo import restore
from gateway.hub import Event, RoomHub
from gateway.ops import set_enabled_panel_packs
from gateway.session import SessionSource
from gateway.turn import TURN_EVENT_HISTORY_KEY, record_turn_events, run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, assistant_text
from net.keystore import Keystore
from net.session import render_frame
from net.tui_server import TuiServer
from tests.fixtures.presentation_pack import PNG, install_kit_pack

_RECV_TIMEOUT = 5.0
_LETTER = {"kind": "letter", "body": "Come to the quay at dusk.", "from": "Wantang"}


class _NullRouter:
    """Never resolves a command, so `run_turn` always runs a real AI-Keeper turn."""

    def resolve(self, text: str, locale: str):
        return None

    async def dispatch_reply(self, ctx: AgentCtx, text: str):
        return None


class _Recorder:
    def __init__(self) -> None:
        self.id = "watcher"
        self.user_key = "tui:watcher"
        self.transport = "test"
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


class _StagingLLM:
    """The Keeper answers at once; the Scribe calls the scripted beat per pass; the
    Director stages a picture of a kit subject plus a letter — parked on ``gate`` until
    the test opens it, which is how a slow image lands after the next turn began."""

    def __init__(self, beats: list[str], *, gated: bool) -> None:
        self.beats = list(beats)
        self.gate = asyncio.Event()
        if not gated:
            self.gate.set()
        self.director_started = asyncio.Event()
        self.replies = 0

    async def chat(self, messages, *, tools=None, **_kwargs):
        blob = "\n".join(str(message.get("content") or "") for message in messages)
        if tools:
            self.replies += 1
            return ChatResult(content=f"Reply {self.replies}.", tool_calls=[])
        if "You are the Stage Director" in blob:
            self.director_started.set()
            await self.gate.wait()
            staging = {"blocks": [_LETTER], "audio": [], "image": {"subject": "wantang", "prompt": "x"}, "prepare": []}
            return ChatResult(content=json.dumps(staging), tool_calls=[])
        if "silent ledger clerk" in blob:
            beat = self.beats.pop(0) if self.beats else "none"
            return ChatResult(
                content=json.dumps({"ops": [], "whispers": [], "chronicle": "", "beat": beat}), tool_calls=[]
            )
        return ChatResult(content="{}", tool_calls=[])


def _chat_key(room: str) -> str:
    return SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()


def _ctx(room: str) -> AgentCtx:
    return AgentCtx(chat_key=_chat_key(room), user_id="nora", platform="tui", locale="en")


async def _staging_room(tmp_path, room: str, llm: _StagingLLM):
    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data"), locale="en"),
        llm=llm,
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True
    services.settings.director.enabled = True
    services.imagegen = None  # the kit's own 定妆 reference is what the beat shows
    await install_kit_pack(services, _chat_key(room), tmp_path)
    return services


async def _turn(services, room: str, text: str, *, actor_name: str | None = None, hub: RoomHub | None = None):
    await run_turn(
        hub or RoomHub(),
        services,
        _ctx(room),
        text,
        command_router=_NullRouter(),
        toolset=build_kp_toolset(services),
        actor_name=actor_name,
    )


async def _replayed(services, room: str, key: str, keystore: Keystore) -> list[dict]:
    """Join over the wire and return every replayed frame (everything between the
    join's own presence and its state snapshot)."""
    server = TuiServer(services, keystore, port=0)
    await server.start()
    try:
        ws = await websockets.connect(f"ws://127.0.0.1:{server.bound_port}/")
        await ws.send(json.dumps({"type": "join", "key": key}))
        frames: list[dict] = []
        while True:
            frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=_RECV_TIMEOUT))
            if frame["type"] == "state":
                break
            if frame["type"] not in ("welcome", "presence"):
                frames.append(frame)
        await ws.close()
        return frames
    finally:
        await server.close()


def _shape(frame: dict) -> tuple:
    if frame["type"] == "ui":
        return ("ui", tuple(block["kind"] for block in frame["blocks"]))
    return (frame["type"], frame.get("speaker"), frame.get("text"))


async def test_a_director_handout_replays_after_its_own_turn_even_when_the_next_player_spoke_first(tmp_path):
    room = "staging-late-room"
    llm = _StagingLLM(beats=["handout", "none"], gated=True)
    services = await _staging_room(tmp_path, room, llm)
    keystore = Keystore()
    key = keystore.add(room=room, name="Ann")

    await _turn(services, room, "I read the survey table")
    await llm.director_started.wait()
    # The Director is still rendering when the next player acts: turn 2 writes its
    # player line (and finishes) before turn 1's staging is published at all.
    await _turn(services, room, "I fold the letter away")
    llm.gate.set()
    await scribe_runtime.await_idle(_chat_key(room))

    frames = await _replayed(services, room, key, keystore)
    assert [_shape(frame) for frame in frames] == [
        ("narrative", "player", "I read the survey table"),
        ("narrative", "kp", "Reply 1."),
        # Turn 1's staging, right after turn 1 — NOT after "I fold the letter away",
        # where the transcript's leaf stood when it was published.
        ("ui", ("image", "letter")),
        ("narrative", "player", "I fold the letter away"),
        ("narrative", "kp", "Reply 2."),
    ]
    staged = next(frame for frame in frames if frame["type"] == "ui")
    assert staged["panel"] == "inline"
    assert staged["blocks"][1]["body"] == _LETTER["body"]
    # The picture is a HASH into room media, and the joiner can still fetch it.
    image = staged["blocks"][0]
    assert image["hash"] == hashlib.sha256(PNG).hexdigest() and image["mime"] == "image/png"
    server = TuiServer(services, keystore, port=0)
    _record, data = await server.media_store.read_bytes(_chat_key(room), image["hash"])
    assert data == PNG
    # The lane holds the reference, never the bytes.
    raw = await services.store.state_get(_chat_key(room), TURN_EVENT_HISTORY_KEY)
    assert PNG.hex() not in raw and len(raw) < 2_000


async def test_the_staging_anchors_where_its_turn_ended_not_at_the_keeper_reply(tmp_path):
    """A companion's exchange can close the player's turn after the Keeper's reply (the
    party director runs inside the turn, before the pass is scheduled). Live, the table
    saw the staging after that exchange; the epoch captured at scheduling carries the
    message the turn ENDED on, and that — not the reply id — is where the staging
    replays."""
    from agent.loop import KPTurnResult
    from agent.scribe_coord import ScribeEpoch
    from gateway.turn import run_scribe_pass

    room = "staging-companion-room"
    llm = _StagingLLM(beats=["handout"], gated=False)
    services = await _staging_room(tmp_path, room, llm)
    chat_key = _chat_key(room)
    await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I signal Rook", turn=1)
    reply_id = await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Rook sees.", turn=1)
    await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="[Rook]\nI follow", turn=2)
    closing_id = await append_message(
        services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Rook follows.", turn=2
    )
    result = KPTurnResult(reply="Rook sees.", tool_trace=[], rounds=1, turn=1, reply_record_id=reply_id)
    epoch = ScribeEpoch(cancel_gen=0, chronicle_turn=2, transcript_leaf=closing_id)

    await run_scribe_pass(RoomHub(), services, _ctx(room), "I signal Rook", result, snapshot_epoch=epoch)

    (record,) = json.loads(await services.store.state_get(chat_key, TURN_EVENT_HISTORY_KEY))
    assert record["event"]["kind"] == "ui" and record["after_id"] == closing_id


async def test_undoing_the_staged_turn_takes_its_staging_out_of_the_replay(tmp_path):
    """The rewind half of the anchoring: the staging belongs to ITS turn, so undoing
    that turn removes it — the restore swaps the whole lane for the earlier snapshot's,
    after cancelling any pass still in flight."""
    room = "staging-undo-room"
    llm = _StagingLLM(beats=["none", "handout"], gated=False)
    services = await _staging_room(tmp_path, room, llm)
    keystore = Keystore()
    key = keystore.add(room=room, name="Ann")

    await _turn(services, room, "I wait by the gate")
    await scribe_runtime.await_idle(_chat_key(room))
    await _turn(services, room, "I open the letter")
    await scribe_runtime.await_idle(_chat_key(room))
    assert ("ui", ("image", "letter")) in [_shape(f) for f in await _replayed(services, room, key, keystore)]

    assert await restore(services, _chat_key(room), 1)

    assert [_shape(frame) for frame in await _replayed(services, room, key, keystore)] == [
        ("narrative", "player", "I wait by the gate"),
        ("narrative", "kp", "Reply 1."),
    ]


async def test_hook_inline_cards_replay_after_their_reply_and_sidebar_regions_do_not(tmp_path):
    pytest.importorskip("quickjs")
    from agent.hook_runtime import install_room_hooks

    room = "hook-card-room"
    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data"), locale="en"),
        llm=FakeLLM(script=[assistant_text("The column halts."), assistant_text("The column marches.")]),
        embeddings=FakeEmbeddings(8),
    )
    await install_room_hooks(
        services,
        _chat_key(room),
        "ledger",
        [
            "on('reply_ready', (e) => {"
            " emitUI([{kind:'text', text:'Ledger: ' + e.reply}]);"
            " emitUI([{kind:'meter', label:'Fear', value:3, min:0, max:10}], {panel:'sidebar', id:'fear'});"
            " });"
        ],
    )
    keystore = Keystore()
    key = keystore.add(room=room, name="Ann")
    hub = RoomHub()
    watcher = _Recorder()
    await hub.subscribe(_chat_key(room), watcher)

    await _turn(services, room, "We make camp", hub=hub)
    await _turn(services, room, "We break camp", hub=hub)

    # Live, both turns published both frames.
    assert [event.data["panel"] for event in watcher.events if event.kind == "ui"] == [
        "inline",
        "sidebar",
        "inline",
        "sidebar",
    ]
    frames = await _replayed(services, room, key, keystore)
    assert [_shape(frame) for frame in frames] == [
        ("narrative", "player", "We make camp"),
        ("narrative", "kp", "The column halts."),
        ("ui", ("text",)),
        ("narrative", "player", "We break camp"),
        ("narrative", "kp", "The column marches."),
        ("ui", ("text",)),
    ]
    cards = [frame["blocks"][0]["text"] for frame in frames if frame["type"] == "ui"]
    assert cards == ["Ledger: The column halts.", "Ledger: The column marches."]
    # The sidebar region is not a line of the log: it never enters the lane.
    assert all(frame["panel"] == "inline" for frame in frames if frame["type"] == "ui")


async def test_a_replayed_player_line_has_the_live_echo_s_shape(tmp_path):
    """The persisted line is `[平知章 (Dirac)]\\n我拔营。` — the tag is for the Keeper.
    The live echo carried the name in `name` and the words in `text`; the replay must
    hand a rejoining member the same bubble."""
    room = "speaker-room"
    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data"), locale="en"),
        llm=FakeLLM(script=[assistant_text("The camp stirs.")]),
        embeddings=FakeEmbeddings(8),
    )
    keystore = Keystore()
    key = keystore.add(room=room, name="Ann")
    hub = RoomHub()
    watcher = _Recorder()
    await hub.subscribe(_chat_key(room), watcher)

    await _turn(services, room, "我拔营。", actor_name="平知章 (Dirac)", hub=hub)

    live = render_frame(next(event for event in watcher.events if event.kind == "player_action"))
    replayed = next(frame for frame in await _replayed(services, room, key, keystore) if frame["speaker"] == "player")
    assert {**replayed, "id": ""} == {**live, "id": ""}
    assert replayed["name"] == "平知章 (Dirac)" and replayed["text"] == "我拔营。"


@pytest.mark.parametrize("blank", ["   ", "\n", " \n\t "])
async def test_a_tagged_player_line_with_a_blank_body_replays_as_nothing(tmp_path, blank):
    """Cursor Bugbot on #45. The session takes a whitespace-only line and the turn stores
    it tagged, `[Rook]\n   `. Stripping the STORED line before splitting it collapsed that
    to `[Rook]`, the tag no longer matched (it needs its newline), and the replay showed
    a nameless bubble reading "[Rook]". The tag is split off the raw line; the body is
    what gets stripped, and an empty body renders nothing — as the live echo of a blank
    line carries nothing to read."""
    room = "blank-room"
    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data"), locale="en"),
        llm=FakeLLM(script=[assistant_text("The camp is quiet.")]),
        embeddings=FakeEmbeddings(8),
    )
    keystore = Keystore()
    key = keystore.add(room=room, name="Ann")

    await _turn(services, room, blank, actor_name="Rook")

    replayed = await _replayed(services, room, key, keystore)
    assert [frame for frame in replayed if frame.get("speaker") == "player"] == []
    assert all("[Rook]" not in str(frame.get("text") or "") for frame in replayed)
    assert any(frame.get("speaker") == "kp" and frame.get("text") == "The camp is quiet." for frame in replayed), (
        "positive control: the turn ran and its reply still replays"
    )


async def test_a_replayed_picture_the_room_can_no_longer_fetch_is_dropped_from_its_frame(tmp_path):
    """The lane keeps a frame's blocks as they were published, but a pack asset stops
    being fetchable once the pack is disabled in the room. Replay re-runs the same
    reachability gate the live publish ran: an unfetchable hash would render as a
    permanent broken picture."""
    room = "regate-room"
    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data"), locale="en"),
        llm=FakeLLM(script=[]),
        embeddings=FakeEmbeddings(8),
    )
    chat_key = _chat_key(room)
    await install_kit_pack(services, chat_key, tmp_path)
    keystore = Keystore()
    key = keystore.add(room=room, name="Ann")
    await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I look", turn=1)
    await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="The quay.", turn=1)
    asset = hashlib.sha256(PNG).hexdigest()
    await record_turn_events(
        services,
        chat_key,
        [
            Event.ui(
                {
                    "blocks": [
                        {"kind": "image", "hash": asset, "mime": "image/png"},
                        {"kind": "text", "text": "The quay at dusk."},
                    ],
                    "panel": "inline",
                }
            )
        ],
    )

    while_enabled = [frame for frame in await _replayed(services, room, key, keystore) if frame["type"] == "ui"]
    assert [block["kind"] for block in while_enabled[0]["blocks"]] == ["image", "text"]

    await set_enabled_panel_packs(services.store, chat_key, [])

    after_disable = [frame for frame in await _replayed(services, room, key, keystore) if frame["type"] == "ui"]
    assert [block["kind"] for block in after_disable[0]["blocks"]] == ["text"]


async def test_a_malformed_ui_record_costs_that_record_not_the_join_replay(tmp_path):
    """A lane imported verbatim through a room backup can carry a `ui` record whose blocks
    are not objects. The replay-time gate must not raise past the record into the replay's
    blanket except — that silently cost the joiner the WHOLE log once before."""
    room = "malformed-ui-room"
    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data"), locale="en"),
        llm=FakeLLM(script=[]),
        embeddings=FakeEmbeddings(8),
    )
    chat_key = _chat_key(room)
    keystore = Keystore()
    key = keystore.add(room=room, name="Ann")
    await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="user", content="I look", turn=1)
    reply_id = await append_message(services, chat_key, DEFAULT_HISTORY_KEY, role="assistant", content="Fog.", turn=1)
    await record_turn_events(
        services, chat_key, [Event.ui({"blocks": [{"kind": "text", "text": "A card."}], "panel": "inline"})]
    )
    lane = json.loads(await services.store.state_get(chat_key, TURN_EVENT_HISTORY_KEY))
    lane.insert(
        0, {"id": "bad", "turn": 1, "after_id": reply_id, "event": {"kind": "ui", "data": {"blocks": ["not a block"]}}}
    )
    await services.store.state_set(chat_key, TURN_EVENT_HISTORY_KEY, json.dumps(lane))

    assert [_shape(frame) for frame in await _replayed(services, room, key, keystore)] == [
        ("narrative", "player", "I look"),
        ("narrative", "kp", "Fog."),
        ("ui", ("text",)),
    ]
