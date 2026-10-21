"""Reply streaming: in-progress text reaches `on_reply_delta` as epoch/seq slices,
machinery blocks can NEVER stream (fail-closed hold-back), tool-round drafts are
discarded, and the final reply stays authoritative."""

from __future__ import annotations

import asyncio

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.loop import _ReplyStreamGate, run_kp_turn
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, assistant_text, assistant_tools, tool_call


async def _collecting_emitter(frames: list[dict]):
    async def emit(frame: dict) -> None:
        frames.append(frame)

    return emit


async def test_gate_streams_safe_text_and_never_releases_machinery():
    frames: list[dict] = []
    gate = _ReplyStreamGate(await _collecting_emitter(frames))

    gate.begin_round()
    gate.feed("雨声落在窗台上。老周抬起头。\n")
    gate.feed("「你来了。」<De")  # a suspicious opener split across deltas
    gate.feed("ep>\n<use><name>mcp__kp_note</name><args>{\"secret\": \"它不能说谎\"}</args></use>\n</Deep>")
    gate.feed("他把抹布放下。")
    gate.finish_round(discard=False)
    await gate.drain()

    streamed = "".join(frame["text"] for frame in frames)
    assert "雨声落在窗台上" in streamed and "他把抹布放下。" in streamed
    assert "<Deep" not in streamed and "mcp__" not in streamed and "不能说谎" not in streamed
    assert [frame["seq"] for frame in frames] == sorted(frame["seq"] for frame in frames)
    assert all(frame["epoch"] == 1 for frame in frames)


async def test_gate_holds_an_unclosed_suspicious_tail_at_round_end():
    frames: list[dict] = []
    gate = _ReplyStreamGate(await _collecting_emitter(frames))
    gate.begin_round()
    gate.feed("正文安全部分。<UpdateVariable>_.set('真凶'")  # never closes
    gate.finish_round(discard=False)
    await gate.drain()

    streamed = "".join(frame["text"] for frame in frames)
    assert streamed == "正文安全部分。"


async def test_max_rounds_finalizer_streams_its_reply(tmp_path):
    """The finalizer produces the player-visible reply on every tool-heavy turn, so it
    must stream through the gate like an ordinary final round — those are exactly the
    turns a player otherwise watches arrive minutes later as one block."""
    final_text = "线索汇拢：刮痕来自船底，而钟声在涨潮时最响。今晚的港口不会安静。"
    script = [
        *[assistant_tools(tool_call("roll_dice", expression="1d100")) for _ in range(12)],
        assistant_text(final_text),  # consumed by the finalizer, not a loop round
    ]
    services = build_services(Settings(locale="zh"), llm=FakeLLM(script=script), embeddings=FakeEmbeddings(16))
    ctx = AgentCtx(chat_key="finalizer-stream-room", user_id="p1", locale="zh")
    frames: list[dict] = []

    async def emit(frame: dict) -> None:
        frames.append(frame)

    result = await run_kp_turn(ctx, services, build_kp_toolset(services), "我调查港口。", on_reply_delta=emit)

    assert result.reply == final_text
    assert frames, "the finalizer reply must stream deltas"
    final_epoch = max(frame["epoch"] for frame in frames)
    reconstructed = "".join(frame["text"] for frame in frames if frame["epoch"] == final_epoch)
    assert reconstructed == final_text


async def test_run_kp_turn_streams_final_round_and_discards_tool_round_draft(tmp_path):
    script = [
        assistant_tools(tool_call("roll_dice", expression="1d100")),
        assistant_text("侦查的结果映入眼帘：墙上有一道新鲜的刮痕，一直延伸到踢脚线之下。"),
    ]
    services = build_services(Settings(locale="zh"), llm=FakeLLM(script=script), embeddings=FakeEmbeddings(16))
    ctx = AgentCtx(chat_key="stream-room", user_id="p1", locale="zh")
    frames: list[dict] = []

    async def emit(frame: dict) -> None:
        frames.append(frame)

    result = await run_kp_turn(ctx, services, build_kp_toolset(services), "我检查墙面。", on_reply_delta=emit)

    assert "刮痕" in result.reply
    final_epoch = max(frame["epoch"] for frame in frames)
    reconstructed = "".join(frame["text"] for frame in frames if frame["epoch"] == final_epoch)
    assert reconstructed == result.reply  # the streamed draft equals the final authoritative text
    # The tool round produced no streamed draft text (no content in that round).
    assert all(frame["epoch"] == final_epoch for frame in frames)


async def test_gate_publishes_one_slice_at_a_time_in_order():
    """A slice goes out only after the previous one has.

    The receiver keeps draft state across its own awaits (`gateway.turn` closes the
    previous round's draft before it opens the next). With every slice its own free
    task, two slices of one round were in flight at once and each opened a bubble of
    its own — the orphan drafts a 2026-10-21 playtest showed above a finished reply."""
    frames: list[dict] = []
    in_flight = 0
    peak = 0

    async def emit(frame: dict) -> None:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        frames.append(frame)
        in_flight -= 1

    gate = _ReplyStreamGate(emit)
    gate.begin_round()
    for line in ("第一行。\n", "第二行。\n", "第三行。\n"):
        gate.feed(line)
    gate.finish_round(discard=False)
    await gate.drain()

    assert peak == 1
    assert [frame["seq"] for frame in frames] == [0, 1, 2]


async def test_a_tool_round_s_slices_are_out_before_its_tools_publish():
    """A public tool event closes the open draft; a slice of the same round still in
    flight behind it would reopen a bubble that nothing ever closes."""
    script = [
        ChatResult(
            content="档案库里很静，只有翻页的声音。\n裴照把簿子推过来。\n",
            tool_calls=[tool_call("roll_dice", expression="1d100")],
        ),
        assistant_text("你看见那一行被人划掉了。"),
    ]
    services = build_services(Settings(locale="zh"), llm=FakeLLM(script=script), embeddings=FakeEmbeddings(16))
    ctx = AgentCtx(chat_key="stream-order-room", user_id="p1", locale="zh")
    timeline: list[str] = []

    async def emit(frame: dict) -> None:
        await asyncio.sleep(0.01)
        timeline.append(f"delta:{frame['epoch']}")

    async def on_tool_event(entry: dict) -> None:
        timeline.append(f"tool:{entry['name']}")

    await run_kp_turn(
        ctx,
        services,
        build_kp_toolset(services),
        "我翻看簿子。",
        on_reply_delta=emit,
        on_tool_event=on_tool_event,
    )

    tool_at = timeline.index("tool:roll_dice")
    assert "delta:1" in timeline
    assert all(event != "delta:1" for event in timeline[tool_at:])
