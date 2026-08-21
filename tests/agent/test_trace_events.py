"""The tool probe's non-tool lane (`agent.tool_trace.trace_event`).

`TRPG_DEBUG__TOOL_TRACE` hangs off the loop's dispatch seam, so it sees exactly what
the model ASKED FOR. Two lanes decide things that never become a tool call — the
Scribe's per-turn verdict and the Stage Director's performance decision — and run 2
(2026-08-19) could not explain a session that produced zero images because neither
left a trace. These pin that both lanes now write one line each, into the same file,
under the same `tool` field a consumer already filters on, and that the whole thing
stays free when the probe is off.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.scribe import SCRIBE_TRACE_KIND, run_scribe
from agent.services import build_services
from agent.stage_director import DIRECTOR_TRACE_KIND, run_director
from agent.tool_trace import enable_tool_trace, trace_event
from core.modvars import define_modvar
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.imagegen import FakeImageGen
from infra.llm import FakeLLM, assistant_text
from tests.fixtures.presentation_pack import KIT, install_kit_pack

CHAT = "trace-room"


class _Hub:
    def __init__(self) -> None:
        self.events: list = []

    async def publish(self, chat_key, event):
        self.events.append(event)

    def members(self, chat_key):
        return []


def _read(path) -> list[dict]:
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    for entry in lines:
        if isinstance(entry.get("event"), str):
            entry["event"] = json.loads(entry["event"])
    return lines


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="kp", locale="zh")


# --- the helper itself -------------------------------------------------------


def test_trace_event_writes_nothing_while_the_probe_is_off(tmp_path):
    path = tmp_path / "never.jsonl"
    trace_event("director", {"beat": "handout"})
    assert not path.exists()


def test_trace_event_shares_the_tool_field_so_one_reader_serves_both(tmp_path):
    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        trace_event("director", {"beat": "handout", "blocks": 2}, chat_key=CHAT)
    finally:
        enable_tool_trace(None)

    [entry] = _read(path)
    assert entry["tool"] == "director"
    assert entry["room"] == CHAT
    assert entry["event"] == {"beat": "handout", "blocks": 2}


# --- the Scribe's verdict ----------------------------------------------------


async def test_the_scribe_records_its_verdict(tmp_path):
    payload = json.dumps(
        {
            "ops": [{"op": "adjust", "id": "信物", "delta": 1, "evidence": "信物已得其一"}],
            "whispers": ["天色似乎已晚"],
            "chronicle": "他们在石埠取得了第一枚信物。",
            "beat": "handout",
        },
        ensure_ascii=False,
    )
    services = build_services(
        Settings(),
        llm=FakeLLM(responder=lambda messages, tools: assistant_text(payload)),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True
    services.settings.chronicle.enabled = True  # the suite-wide conftest turns it off
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "信物", "kind": "number", "labels": {"zh": "信物"}, "default": 0, "minimum": 0, "maximum": 3},
    )

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        outcome = await run_scribe(
            services, _ctx(), "我把指环收进口袋", "你确实拿到了指环——信物已得其一。", ["roll_dice"], 4
        )
    finally:
        enable_tool_trace(None)

    assert outcome.beat == "handout"
    [entry] = [line for line in _read(path) if line["tool"] == SCRIBE_TRACE_KIND]
    assert entry["room"] == CHAT
    assert entry["event"] == {
        "beat": "handout",
        "ops": 1,
        "ops_seen": 1,
        "whispers": 1,
        "chronicle": True,
    }


async def test_a_dropped_op_and_a_skipped_chronicle_are_visible_in_the_verdict(tmp_path):
    """The point of the line: it explains a turn where nothing happened."""
    payload = json.dumps(
        {
            "ops": [{"op": "adjust", "id": "信物", "delta": 1, "evidence": "这句话回复里没有"}],
            "whispers": [],
            "chronicle": "",
            "beat": "none",
        },
        ensure_ascii=False,
    )
    services = build_services(
        Settings(),
        llm=FakeLLM(responder=lambda messages, tools: assistant_text(payload)),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "信物", "kind": "number", "labels": {"zh": "信物"}, "default": 0, "minimum": 0, "maximum": 3},
    )

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_scribe(services, _ctx(), "我伸手", "你什么也没摸到。", [], 4)
    finally:
        enable_tool_trace(None)

    [entry] = [line for line in _read(path) if line["tool"] == SCRIBE_TRACE_KIND]
    assert entry["event"] == {
        "beat": "",  # "none" is not a beat, so the Director is never cued
        "ops": 0,  # proposed but dropped: the evidence was not a verbatim quote
        "ops_seen": 1,
        "whispers": 0,
        "chronicle": False,
    }


async def test_scribe_disabled_is_distinguishable_from_the_scribe_dying(tmp_path):
    services = build_services(
        Settings(),
        llm=FakeLLM(responder=lambda messages, tools: assistant_text("{}")),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = False

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_scribe(services, _ctx(), "我伸手", "你什么也没摸到。", [], 4)
    finally:
        enable_tool_trace(None)

    [entry] = [line for line in _read(path) if line["tool"] == SCRIBE_TRACE_KIND]
    assert entry["event"] == {"outcome": "disabled"}


async def test_scribe_skips_an_empty_reply_and_says_so(tmp_path):
    services = build_services(
        Settings(),
        llm=FakeLLM(responder=lambda messages, tools: assistant_text("{}")),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_scribe(services, _ctx(), "我伸手", "   ", [], 4)
    finally:
        enable_tool_trace(None)

    [entry] = [line for line in _read(path) if line["tool"] == SCRIBE_TRACE_KIND]
    assert entry["event"] == {"outcome": "empty_reply"}


async def test_a_dead_scribe_llm_is_traced_as_llm_failed(tmp_path):
    def _boom(messages, tools):
        raise RuntimeError("scribe llm down")

    services = build_services(
        Settings(),
        llm=FakeLLM(responder=_boom),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        outcome = await run_scribe(services, _ctx(), "我伸手", "你什么也没摸到。", [], 4)
    finally:
        enable_tool_trace(None)

    assert outcome.changed is False
    [entry] = [line for line in _read(path) if line["tool"] == SCRIBE_TRACE_KIND]
    assert entry["event"] == {"outcome": "llm_failed"}


async def test_an_unparseable_scribe_reply_is_traced_as_parse_failed(tmp_path):
    services = build_services(
        Settings(),
        llm=FakeLLM(responder=lambda messages, tools: assistant_text("not json at all")),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.scribe.enabled = True

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        outcome = await run_scribe(services, _ctx(), "我伸手", "你什么也没摸到。", [], 4)
    finally:
        enable_tool_trace(None)

    assert outcome.changed is False
    [entry] = [line for line in _read(path) if line["tool"] == SCRIBE_TRACE_KIND]
    assert entry["event"] == {"outcome": "parse_failed"}


# --- the Director's decision -------------------------------------------------


async def _director_room(tmp_path, payload, *, imagegen: FakeImageGen | None = None):
    llm = FakeLLM(responder=lambda messages, tools: assistant_text(json.dumps(payload, ensure_ascii=False)))
    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))
    services.settings.director.enabled = True
    if imagegen is not None:
        services.imagegen = imagegen
    await install_kit_pack(services, CHAT, tmp_path, kit=KIT)
    return services, _Hub()


async def test_the_director_records_what_it_staged(tmp_path):
    services, hub = await _director_room(
        tmp_path,
        {
            "blocks": [{"kind": "title_card", "title": "第二幕 · 曝灯"}],
            "audio": [{"cue": "tide", "action": "play"}],
            "image": {"subject": "wantang", "prompt": "她站在灯下"},
            "prepare": ["the-quay"],
        },
        imagegen=FakeImageGen(),
    )

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=hub)
    finally:
        enable_tool_trace(None)

    [entry] = [line for line in _read(path) if line["tool"] == DIRECTOR_TRACE_KIND]
    event = entry["event"]
    assert event["beat"] == "handout"
    assert event["blocks"] == 2  # the title card plus the image block inserted in front
    assert event["cues"] == 1
    assert event["prepared"] == 1
    assert event["image"]["subject"] == "wantang"
    assert event["image"]["outcome"] == "generated"
    assert len(event["image"]["hash"]) == 64


async def test_a_beat_that_produced_no_picture_says_why(tmp_path):
    """Zero images across a whole session is the run-2 symptom; the reason is the fix."""
    services, hub = await _director_room(
        tmp_path,
        {"blocks": [], "audio": [], "image": {"subject": "the-quay", "prompt": "石埠"}, "prepare": []},
        imagegen=FakeImageGen(),
    )

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我看埠头", "石埠空着。", beat="scene_change", hub=hub)
    finally:
        enable_tool_trace(None)

    [entry] = [line for line in _read(path) if line["tool"] == DIRECTOR_TRACE_KIND]
    assert entry["event"]["image"] == {"subject": "the-quay", "outcome": "ref_missing"}
    assert entry["event"]["blocks"] == 0


async def test_a_room_with_no_presentation_kit_is_traced_as_such(tmp_path):
    settings = Settings()
    settings.data_dir = tmp_path / "data"
    services = build_services(
        settings,
        llm=FakeLLM(responder=lambda messages, tools: assistant_text("{}")),
        embeddings=FakeEmbeddings(64),
    )
    services.settings.director.enabled = True

    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_director(services, _ctx(), "我抬头", "她在灯下。", beat="handout", hub=_Hub())
    finally:
        enable_tool_trace(None)

    [entry] = [line for line in _read(path) if line["tool"] == DIRECTOR_TRACE_KIND]
    assert entry["event"] == {
        "beat": "handout",
        "blocks": 0,
        "cues": 0,
        "prepared": 0,
        "image": {"outcome": "kit_missing"},
    }


# --- the model-call rows ------------------------------------------------------


async def test_every_model_call_of_a_turn_leaves_a_row_named_by_its_lane(tmp_path):
    """One row per LOGICAL model call, in the same file, under `tool: "model_call"`: the
    Keeper's rounds numbered as the loop advances, and an NPC voiced from inside a round
    as its own lane — then back to the Keeper. This is the wiring the unit tests in
    tests/infra/test_model_call_trace.py cannot see: `enable_tool_trace` installs the
    sink, `RetryingLLM` (every production path) records through it."""
    from agent import npc as npc_records
    from agent.kp_tools_npc import NpcTools
    from agent.loop import run_kp_turn
    from agent.tools import Toolset
    from infra.llm import assistant_tools, tool_call
    from infra.llm_retry import RetryingLLM

    path = tmp_path / "probe.jsonl"
    try:
        llm = RetryingLLM(
            FakeLLM(
                script=[
                    assistant_tools(tool_call("speak_as_npc", npc="Ada", situation="asked the time")),
                    assistant_text('{"dialogue": "Past noon.", "mood": "dry"}'),
                    assistant_text("Ada answers."),
                ]
            )
        )
        services = build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(8))
        # AFTER build_services: it (re)configures the probe from settings, and the default
        # is off — the same lifecycle the sink follows.
        enable_tool_trace(path)
        await npc_records.create_npc(services.documents, CHAT, "Ada", persona="a clerk")
        ctx = AgentCtx(chat_key=CHAT, user_id="kp", locale="en")

        await run_kp_turn(ctx, services, Toolset(NpcTools(services)), "What time is it, Ada?")
    finally:
        enable_tool_trace(None)

    rows = [r for r in _read(path) if r.get("tool") == "model_call"]
    lanes = [(r["event"]["lane"], r["event"].get("round"), r.get("room")) for r in rows]
    assert lanes == [("keeper", 1, CHAT), ("npc", None, CHAT), ("keeper", 2, CHAT)], lanes
    assert rows[1]["event"]["npc"] == "ada"
    assert all("ms" in r["event"] and r["event"]["attempts"] == 1 for r in rows)
