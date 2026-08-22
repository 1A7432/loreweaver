"""ORACLE for the per-room Scribe coordinator (order, undo, snapshot, recycle).

The post-turn Scribe used to be a bare ``asyncio.create_task``. Same-room
passes could finish out of LLM order; the next prompt could ``pop_whispers``
before the previous write; ``.undo`` / reset / import / delete could restore
a room a still-running pass then wrote back; and ``run_kp_turn`` photographed
the boundary *before* the pass, so its writes sat in no rewind snapshot.

This file pins the four acceptances the coordinator exists for. Everything
is offline: a scriptable LLM plus an ``asyncio.Event`` gate, no network.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from agent.chronicle import CHRONICLE_DOC_TYPE, chronicle_turn
from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.scribe_coord import refresh_latest_snapshot, scribe_runtime
from agent.services import build_services
from agent.undo import available_turns, capture, restore
from core.documents import KEEPER_VIEWER, MODVARS_ID
from core.modvars import define_modvar
from gateway.hub import RoomHub
from gateway.turn import run_scribe_pass, run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, assistant_text
from net.keystore import Keystore
from net.room_backup import chat_key_for_room, delete_room_data, reset_room_state


class _NullRouter:
    def resolve(self, text: str, locale: str):
        return None

    async def dispatch_reply(self, ctx: AgentCtx, text: str):
        return None


class _GatedLLM:
    """KP replies instantly; the Scribe lane parks on ``gate`` until the test opens it."""

    def __init__(self, *, whisper: str, chronicle: str, evidence: str, hold_first: bool = True):
        self.whisper = whisper
        self.chronicle = chronicle
        self.evidence = evidence
        self.hold_first = hold_first
        self.gate = asyncio.Event()
        self.scribe_started = asyncio.Event()
        self.scribe_starts: list[int] = []
        self.scribe_finishes: list[int] = []
        self.kp_prompts: list[list[dict]] = []
        self._scribe_n = 0

    async def chat(self, messages, *, tools=None, **_kwargs):
        blob = "\n".join(str(message.get("content") or "") for message in messages)
        if tools:
            self.kp_prompts.append(messages)
            return ChatResult(content=f"The lantern lights — {self.evidence}", tool_calls=[])
        if "silent ledger clerk" not in blob:
            # A chronicle fold (or any other no-tools lane) is not the Scribe.
            return ChatResult(content="{}", tool_calls=[])
        self._scribe_n += 1
        n = self._scribe_n
        self.scribe_starts.append(n)
        self.scribe_started.set()
        if self.hold_first and n == 1:
            await self.gate.wait()
        self.scribe_finishes.append(n)
        return ChatResult(
            content=json.dumps(
                {
                    "ops": [{"op": "set", "id": "tokens", "value": n, "evidence": self.evidence}],
                    "whispers": [f"{self.whisper}-{n}"],
                    "chronicle": f"{self.chronicle} {n}",
                    "beat": "none",
                }
            ),
            tool_calls=[],
        )


def _services(llm, tmp_path):
    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data"), locale="en"),
        llm=llm,
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True
    services.settings.chronicle.enabled = True
    services.settings.chronicle.auto_record = True
    return services


def _ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="nora", platform="tui", locale="en")


async def _with_tracker(services, chat_key: str) -> None:
    await define_modvar(
        services.documents,
        chat_key,
        {
            "id": "tokens",
            "kind": "number",
            "labels": {"en": "Tokens", "zh": "信物"},
            "default": 0,
            "minimum": 0,
            "maximum": 9,
        },
    )


async def _tracker_value(services, chat_key: str):
    view = await services.documents.get_view(chat_key, "modvars", MODVARS_ID, KEEPER_VIEWER)
    return (view or {}).get("values", {}).get("tokens")


def _prompt_blob(messages: list[dict]) -> str:
    return "\n".join(str(message.get("content") or "") for message in messages)


@pytest.fixture(autouse=True)
async def _isolate_coordinator():
    await scribe_runtime.reset_for_tests()
    yield
    await scribe_runtime.reset_for_tests()


async def test_two_consecutive_player_turns_run_scribes_in_order_and_n_whisper_reaches_n_plus_one(tmp_path):
    """Turn N's whisper is in turn N+1's prompt; Scribe 2 cannot start before Scribe 1 ends."""
    evidence = "the lantern lights"
    llm = _GatedLLM(whisper="clock drifted", chronicle="They lit the lantern.", evidence=evidence)
    services = _services(llm, tmp_path)
    chat_key = "scribe-order-room"
    await _with_tracker(services, chat_key)
    hub = RoomHub()
    lock = hub.turn_lock(chat_key)
    ctx = _ctx(chat_key)
    toolset = build_kp_toolset(services)

    async with lock:
        await run_turn(hub, services, ctx, "I strike the match", command_router=_NullRouter(), toolset=toolset)

    await llm.scribe_started.wait()
    assert llm.scribe_starts == [1]
    assert llm.scribe_finishes == []
    assert len(llm.kp_prompts) == 1

    async def _turn_two() -> None:
        async with lock:
            await run_turn(hub, services, ctx, "I step inside", command_router=_NullRouter(), toolset=toolset)

    second = asyncio.create_task(_turn_two())
    for _ in range(100):
        if lock.locked() and not second.done() and len(llm.kp_prompts) == 1:
            break
        await asyncio.sleep(0)
    else:
        raise AssertionError("second turn never parked on the previous Scribe")

    llm.gate.set()
    await second
    await scribe_runtime.await_idle(chat_key)

    assert llm.scribe_starts == [1, 2]
    assert llm.scribe_finishes == [1, 2]
    assert len(llm.kp_prompts) == 2
    assert "clock drifted-1" in _prompt_blob(llm.kp_prompts[1])
    assert "clock drifted-2" not in _prompt_blob(llm.kp_prompts[1])


async def test_undo_during_a_slow_scribe_does_not_write_abandoned_trackers_or_chronicle(tmp_path):
    evidence = "the lantern lights"
    llm = _GatedLLM(whisper="note", chronicle="They lit the lantern.", evidence=evidence)
    services = _services(llm, tmp_path)
    chat_key = "scribe-undo-room"
    await _with_tracker(services, chat_key)
    hub = RoomHub()
    ctx = _ctx(chat_key)

    await run_turn(
        hub, services, ctx, "I strike the match", command_router=_NullRouter(), toolset=build_kp_toolset(services)
    )
    await llm.scribe_started.wait()
    assert await chronicle_turn(services.store, chat_key) == 1
    assert await _tracker_value(services, chat_key) == 0
    assert await services.documents.list(chat_key, CHRONICLE_DOC_TYPE) == []

    assert await restore(services, chat_key, 1)

    llm.gate.set()
    await scribe_runtime.await_idle(chat_key)

    assert await _tracker_value(services, chat_key) == 0
    assert await services.documents.list(chat_key, CHRONICLE_DOC_TYPE) == []
    assert llm.scribe_finishes == [], "a cancelled pass must not complete its write-back"


async def test_completed_scribe_refreshes_the_latest_snapshot_with_its_writes(tmp_path):
    evidence = "the lantern lights"
    llm = _GatedLLM(whisper="note", chronicle="They lit the lantern.", evidence=evidence, hold_first=False)
    services = _services(llm, tmp_path)
    chat_key = "scribe-snap-room"
    await _with_tracker(services, chat_key)
    hub = RoomHub()

    await run_turn(
        hub,
        services,
        _ctx(chat_key),
        "I strike the match",
        command_router=_NullRouter(),
        toolset=build_kp_toolset(services),
    )
    await scribe_runtime.await_idle(chat_key)

    turn = await chronicle_turn(services.store, chat_key)
    assert turn == 1
    assert await _tracker_value(services, chat_key) == 1
    docs = await services.documents.list(chat_key, CHRONICLE_DOC_TYPE)
    assert len(docs) == 1

    # The snapshot taken inside run_kp_turn was pre-Scribe. The coordinator must
    # have overwritten the latest boundary so a rewind keeps the ledger.
    assert await restore(services, chat_key, turn)
    assert await _tracker_value(services, chat_key) == 1
    assert len(await services.documents.list(chat_key, CHRONICLE_DOC_TYPE)) == 1


async def test_snapshot_refresh_uses_the_current_counter_and_does_not_overwrite_an_earlier_boundary(tmp_path):
    """Companion sub-turns advance the counter; refreshing result.turn would fold
    later writes into the player's earlier snapshot."""
    services = _services(FakeLLM(responder=lambda messages, tools: assistant_text("ok")), tmp_path)
    chat_key = "scribe-snap-index"
    await services.store.state_set(chat_key, "scene", "before-companion")
    await capture(services, chat_key, 1)
    await services.store.state_set(chat_key, "scene", "after-companion")
    await services.store.state_set(chat_key, "chronicle_turn", "2")
    await capture(services, chat_key, 2)

    await services.store.state_set(chat_key, "scene", "after-scribe")
    await refresh_latest_snapshot(services, chat_key)

    raw_one = json.loads(await services.store.snapshot_get(chat_key, 1) or "{}")
    raw_two = json.loads(await services.store.snapshot_get(chat_key, 2) or "{}")
    state_one = {row["key"]: row["value"] for row in raw_one.get("room_state") or []}
    state_two = {row["key"]: row["value"] for row in raw_two.get("room_state") or []}
    assert state_one.get("scene") == "before-companion"
    assert state_two.get("scene") == "after-scribe"


async def test_delete_and_full_reset_drop_coordinator_memory(tmp_path):
    chat_key = chat_key_for_room("arkham")
    hold = asyncio.Event()

    async def _blocked() -> None:
        await hold.wait()

    scribe_runtime.schedule(chat_key, _blocked)
    assert scribe_runtime.tracked(chat_key)

    services = _services(FakeLLM(responder=lambda messages, tools: assistant_text("ok")), tmp_path)
    keystore = Keystore()
    keystore.add(room="arkham", name="Keeper", role="keeper")

    await delete_room_data(services, keystore, "arkham")
    hold.set()
    await asyncio.sleep(0)
    assert not scribe_runtime.tracked(chat_key)

    hold = asyncio.Event()

    async def _blocked_again() -> None:
        await hold.wait()

    other = chat_key_for_room("dunwich")
    scribe_runtime.schedule(other, _blocked_again)
    assert scribe_runtime.tracked(other)
    await reset_room_state(services, other, scope="all")
    hold.set()
    await asyncio.sleep(0)
    assert not scribe_runtime.tracked(other)


async def test_story_reset_cancels_but_keeps_the_slot_until_idle_dispose(tmp_path):
    """A story reset must abort the pass (no write-back) without requiring a delete."""
    evidence = "the lantern lights"
    llm = _GatedLLM(whisper="note", chronicle="They lit the lantern.", evidence=evidence)
    services = _services(llm, tmp_path)
    chat_key = "scribe-story-reset"
    await _with_tracker(services, chat_key)
    hub = RoomHub()

    await run_turn(
        hub,
        services,
        _ctx(chat_key),
        "I strike the match",
        command_router=_NullRouter(),
        toolset=build_kp_toolset(services),
    )
    await llm.scribe_started.wait()
    assert scribe_runtime.tracked(chat_key)

    await reset_room_state(services, chat_key, scope="story")
    llm.gate.set()
    await scribe_runtime.await_idle(chat_key)

    assert await _tracker_value(services, chat_key) in (None, 0)
    assert await services.documents.list(chat_key, CHRONICLE_DOC_TYPE) == []
    assert await available_turns(services, chat_key) == []


async def test_snapshot_refresh_is_skipped_once_the_next_external_turn_has_begun():
    chat_key = "scribe-refresh-guard"
    epoch = scribe_runtime.capture_epoch(chat_key)
    await scribe_runtime.take_external_turn(chat_key)
    assert scribe_runtime.may_refresh_snapshot(chat_key, epoch) is False
    assert scribe_runtime.may_refresh_snapshot(chat_key, None) is True


async def test_cancelled_scribe_pass_does_not_swallow_cancellation_as_a_logged_success(tmp_path):
    """``except Exception`` must not turn a cancel into 'the pass failed quietly'."""
    evidence = "the lantern lights"
    llm = _GatedLLM(whisper="note", chronicle="They lit the lantern.", evidence=evidence)
    services = _services(llm, tmp_path)
    chat_key = "scribe-cancel-raise"
    await _with_tracker(services, chat_key)
    ctx = _ctx(chat_key)
    from agent.loop import KPTurnResult

    result = KPTurnResult(reply=f"The lantern lights — {evidence}", tool_trace=[], rounds=1, turn=1)
    task = asyncio.create_task(run_scribe_pass(None, services, ctx, "go", result))
    await llm.scribe_started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await _tracker_value(services, chat_key) == 0
    assert llm.scribe_finishes == []
