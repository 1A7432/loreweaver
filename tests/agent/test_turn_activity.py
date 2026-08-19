"""Coarse turn-progress reporting (protocol 2.3.1's optional `turn_status.activity`).

A long turn used to look identical to a hung one: one `busy` frame at the start and
nothing until the narration landed. `agent.loop` now reports which COARSE kind of work
each tool round opened with, and the gateway publishes that as a refreshed `busy` frame.

What these pin:
  * the name -> bucket mapping, including that anything unrecognized is bookkeeping;
  * the loop calls the sink once per tool round, with the round number, and with the
    bucket of the round's FIRST call;
  * nothing but the bucket leaves the loop — no tool name, no arguments;
  * a turn with no sink installed still runs (the sink is optional by construction).
"""

from __future__ import annotations

import pytest

from agent.context import AgentCtx
from agent.loop import run_kp_turn, tool_activity
from agent.services import build_services
from agent.tools import Toolset, tool
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call


class _ActivityProvider:
    """One tool per bucket, named the way the real toolset names them."""

    @tool
    async def query_lore(self, ctx: AgentCtx, query: str = "") -> str:
        """Look something up in the world lore."""
        return "the lighthouse keeper drowned in 1921"

    @tool
    async def roll_dice(self, ctx: AgentCtx, expression: str = "1d100") -> str:
        """Roll dice."""
        return f"{expression}: 42"

    @tool
    async def speak_as_npc(self, ctx: AgentCtx, npc: str = "Ida") -> str:
        """Have an NPC speak."""
        return f"{npc} says nothing."

    @tool
    async def kp_note(self, ctx: AgentCtx, text: str = "") -> str:
        """Write a keeper note."""
        return "noted"


def _services(llm: FakeLLM):
    return build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("query_lore", "reading"),
        ("module_brief", "reading"),
        ("get_module_summary", "reading"),
        ("list_npcs", "reading"),
        ("search_documents", "reading"),
        ("roll_dice", "dice"),
        ("skill_check", "dice"),
        ("sanity_check", "dice"),
        ("opposed_check", "dice"),
        ("speak_as_npc", "cast"),
        ("companion_act", "cast"),
        ("kp_note", "bookkeeping"),
        ("game_clock", "bookkeeping"),
        ("unlock_for_player", "bookkeeping"),
        ("", "bookkeeping"),
        ("something_nobody_has_written_yet", "bookkeeping"),
    ],
)
def test_every_tool_name_maps_to_one_of_the_four_buckets(name: str, expected: str) -> None:
    assert tool_activity(name) == expected


async def test_the_loop_reports_one_bucket_and_round_per_tool_round() -> None:
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("query_lore", query="lighthouse")),
            assistant_tools(tool_call("roll_dice", expression="1d100")),
            assistant_tools(tool_call("kp_note", text="the keeper drowned")),
            assistant_text("The lamp gutters and the sea answers."),
        ]
    )
    services = _services(llm)
    seen: list[tuple[str, int]] = []

    async def sink(activity: str, round_index: int) -> None:
        seen.append((activity, round_index))

    ctx = AgentCtx(chat_key="chat-activity", user_id="u1", locale="en")
    ctx.activity_sink = sink

    await run_kp_turn(ctx, services, Toolset(_ActivityProvider()), "What does the lore say?")

    assert seen == [("reading", 1), ("dice", 2), ("bookkeeping", 3)]


async def test_a_round_takes_the_bucket_of_its_first_call_and_leaks_nothing_else() -> None:
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call("speak_as_npc", npc="Ida"),
                tool_call("kp_note", text="THE BUTLER POISONED THE WINE"),
            ),
            assistant_text("Ida turns away."),
        ]
    )
    services = _services(llm)
    seen: list[tuple[str, int]] = []

    async def sink(activity: str, round_index: int) -> None:
        seen.append((activity, round_index))

    ctx = AgentCtx(chat_key="chat-activity-first", user_id="u1", locale="en")
    ctx.activity_sink = sink

    await run_kp_turn(ctx, services, Toolset(_ActivityProvider()), "Talk to Ida.")

    assert seen == [("cast", 1)]
    # Only the four closed bucket words ever reach the sink — never a name or an argument.
    assert all(activity in {"reading", "dice", "cast", "bookkeeping"} for activity, _ in seen)


async def test_a_turn_without_a_sink_still_runs() -> None:
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("query_lore", query="lighthouse")),
            assistant_text("Nothing stirs."),
        ]
    )
    ctx = AgentCtx(chat_key="chat-no-sink", user_id="u1", locale="en")
    assert ctx.activity_sink is None

    result = await run_kp_turn(ctx, _services(llm), Toolset(_ActivityProvider()), "Look it up.")

    assert result.reply == "Nothing stirs."


async def test_a_failing_sink_never_takes_the_turn_down() -> None:
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("query_lore", query="lighthouse")),
            assistant_text("Nothing stirs."),
        ]
    )

    async def sink(activity: str, round_index: int) -> None:
        raise RuntimeError("the client hung up")

    ctx = AgentCtx(chat_key="chat-bad-sink", user_id="u1", locale="en")
    ctx.activity_sink = sink

    result = await run_kp_turn(ctx, _services(llm), Toolset(_ActivityProvider()), "Look it up.")

    assert result.reply == "Nothing stirs."
