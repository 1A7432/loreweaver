"""ORACLE for M20 C: the two dice checks, and the Stop-form runner that acts on them.

The thing this replaces was 21 compiled regexes guessing whether a player's sentence had
attempted something checkable, plus two hand-written corrective phases. What is left is
only what can be decided without reading the fiction — and this file is where the honesty
about that lives:

- **contradiction is exact.** Dice ran; the prose states numbers; compare. There is a
  right answer and the test asserts it, CJK numerals included.
- **forgery is not exact, and the tolerance band is written down below** rather than
  quietly hoped away. Ordinary prose has numbers in it. The band is the price of asking a
  question with no intent-guessing in it, and it is far narrower than the lexicon it
  replaced — but a test suite that only listed the wins would be lying about the shape.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.loop import run_kp_turn
from agent.services import build_services
from agent.tools import Toolset, tool
from agent.turn_checks import (
    MAX_ROUNDS_PER_CHECK,
    MAX_ROUNDS_PER_TURN,
    TurnState,
    dice_rolled,
    reply_states_a_roll,
    rolled_values,
    scene_title_lines,
    stated_roll_numbers,
    turn_checks_for,
)
from core.rulepacks import RulePack
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, assistant_text, assistant_tools, tool_call


class _DiceProvider:
    """One dice tool that publishes a structured payload, exactly as the real ones do."""

    @tool
    async def skill_check(self, ctx: AgentCtx, skill_name: str) -> str:
        """Roll a skill check."""
        ctx.emit_dice({"kind": "check", "expr": skill_name, "rolls": [42], "total": 42, "target": 65})
        return f"{skill_name}: rolled 42 vs 65 -> hard success"


class _SilentProvider:
    """A non-dice tool, for turns that must not count as rolled."""

    @tool
    async def lookup_time(self, ctx: AgentCtx) -> str:
        """Look up the current in-game time."""
        return "1926-03-15 14:00"


class _StateProvider:
    """The HUD bookkeeping tools the stale-scene check asks for."""

    @tool
    async def kp_note(self, ctx: AgentCtx, action: str, category: str = "", content: str = "") -> str:
        """Set or add a KP note (current_scene / current_focus / world_changes)."""
        return f"note {action} {category}: {content}"

    @tool
    async def game_clock(self, ctx: AgentCtx, action: str, value: str = "") -> str:
        """Show, set, or advance the in-game clock."""
        return f"clock {action} {value}"


_TITLE_REPLY = "🌉 Tokyo Port · Pier 5 | 10:15 pm\nThe sea wind mixes diesel and rust as the cranes sweep overhead."


def _services(llm):
    return build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(64))


def _ctx(chat: str = "checks-room") -> AgentCtx:
    return AgentCtx(chat_key=chat, user_id="u1", locale="en")


def _rolled_trace(total: int = 42, target: int = 65) -> list[dict]:
    return [
        {
            "name": "skill_check",
            "arguments": {},
            "result": "ok",
            "dice_payloads": [{"kind": "check", "rolls": [total], "total": total, "target": target}],
        }
    ]


# ---------------------------------------------------------------------------
# C1 — what the prose claims, and what the dice really did
# ---------------------------------------------------------------------------


def test_the_shapes_a_stated_roll_takes():
    """Every one of these is what the engine's own dice frames render, so a reply
    containing one either came from a tool call or was invented."""
    for stated in (
        "Spot Hidden — 22 vs 25 (Success!)",
        "You rolled 47 versus 65.",
        "侦查 22 对 25，勉强过了。",
        "1d100 = 47, under your 65.",
        "2d6+1 -> 9 damage.",
        "🎲 Intimidate — Fumble.",
        "掷出三十七，堪堪压过对方。",
    ):
        assert reply_states_a_roll(stated), stated


def test_ordinary_prose_with_numbers_in_it_is_not_a_roll():
    for plain in (
        "The corridor stretches on, silent and cold.",
        "Three men wait by the pier; the fourth is already gone.",
        "It is 10:15 pm and the tide is turning.",
        "The odds are 50/50 at best.",
        "You succeed in prying the crate open.",
        "他把 1926 年的账本推到你面前。",
        "你成功撬开了箱子。",
    ):
        assert not reply_states_a_roll(plain), plain


def test_the_forgery_tolerance_band_is_written_down_not_hidden():
    """THE HONEST PART. Forgery is SHAPE detection — there is no true value to compare
    against, because no dice ran. These are prose that trips it anyway.

    They are accepted, not fixed. Narrowing the shapes until these pass would reopen the
    hole the shapes exist to close (a real forged roll written as `22 vs 25`), and the
    consequence of a false positive here is bounded and cheap: one extra re-ask that the
    model answers by removing a number from its prose. A false NEGATIVE is a table shown
    numbers the engine never produced.
    """
    accepted_false_positives = (
        "The vote was 12 vs 5 — the council refuses.",  # a tally written like a roll
        "Reinforcements: 40 versus 6. The alley will not hold.",  # a head-count, not a check
        "🎲 The gaming table's felt is worn where hands rest — success favours the house.",
    )
    for text in accepted_false_positives:
        assert reply_states_a_roll(text), (
            "the tolerance band moved. That is allowed — but update this list and say why, "
            "rather than letting the band drift silently."
        )

    # And the band's edges, so a future widening is visible too: an intervening noun
    # breaks the pair, and a die emoji far from any result word is just decoration.
    assert not reply_states_a_roll("Their 40 rifles versus your 6 revolvers.")
    assert not reply_states_a_roll("🎲 " + "The dice cup sits untouched on the felt. " * 3)


def test_contradiction_is_exact_against_what_the_turn_really_rolled():
    trace = _rolled_trace(total=47, target=65)

    contradicts = TurnState(reply="Spot Hidden — 22 vs 25. You find nothing.", tool_trace=trace)
    agrees = TurnState(reply="Spot Hidden — 47 vs 65. You spot the latch.", tool_trace=trace)

    check = {c.condition: c for c in turn_checks_for(None)}["dice_contradicts"]
    assert check.holds(contradicts)
    assert not check.holds(agrees), "the real numbers are not a contradiction, even though prose should omit them"


def test_contradiction_normalizes_cjk_numerals():
    trace = _rolled_trace(total=37, target=60)

    assert stated_roll_numbers("你掷出三十七。") == {37}
    check = {c.condition: c for c in turn_checks_for(None)}["dice_contradicts"]
    assert not check.holds(TurnState(reply="你掷出三十七，压过了目标。", tool_trace=trace))
    assert check.holds(TurnState(reply="你掷出八十八，压过了目标。", tool_trace=trace))


def test_only_roll_shaped_numbers_are_compared():
    """A street number, a year, or a body count in the same reply as a real roll must not
    read as a contradicted die."""
    trace = _rolled_trace(total=42, target=65)
    reply = "42 vs 65 — you hold your nerve. Three men wait outside number 17, and it is 1926."

    assert stated_roll_numbers(reply) == {42, 65}
    assert not {c.condition: c for c in turn_checks_for(None)}["dice_contradicts"].holds(
        TurnState(reply=reply, tool_trace=trace)
    )


def test_forgery_and_contradiction_are_split_by_whether_dice_ran():
    """The two never fire on the same turn: one asks a question with a true value to
    compare against, the other has none. That is the whole reason they are separate."""
    forged_state = TurnState(reply="22 vs 25 — you fail.", tool_trace=[{"name": "lookup_time"}])
    contradicting_state = TurnState(reply="22 vs 25 — you fail.", tool_trace=_rolled_trace())
    checks = {c.condition: c for c in turn_checks_for(None)}

    assert checks["dice_forged"].holds(forged_state) and not checks["dice_contradicts"].holds(forged_state)
    assert checks["dice_contradicts"].holds(contradicting_state) and not checks["dice_forged"].holds(
        contradicting_state
    )


def test_rolled_values_reads_the_same_payloads_the_players_see():
    assert rolled_values(_rolled_trace(total=42, target=65)) == {42, 65}
    assert rolled_values([{"name": "skill_check"}]) == set(), "a roll with no published payload claims nothing"


def test_dice_rolled_keys_off_deterministic_dice_tools_only():
    assert dice_rolled([{"name": "skill_check"}])
    assert dice_rolled([{"name": "lookup_time"}, {"name": "sanity_check"}])
    assert dice_rolled([{"name": "spend_luck"}])
    assert not dice_rolled([{"name": "skill_check", "suppressed": True}])
    assert not dice_rolled([{"name": "lookup_time"}, {"name": "get_module_summary"}])
    assert not dice_rolled([])


def test_scene_title_detector_hits_and_misses():
    assert scene_title_lines("🌉 東京港·大井埠頭五号泊位 | 晚 10:15")
    assert scene_title_lines("码头仓库区 ｜ 深夜")
    assert scene_title_lines("## 東京港 | 凌晨 2:00\n正文继续。")
    assert scene_title_lines(_TITLE_REPLY)

    assert not scene_title_lines("你们在晚上10:15到达了码头,海风很冷,吊机在夜空里摆动。")
    assert not scene_title_lines("东京港 | 五号泊位")
    assert not scene_title_lines("东京港 | 深夜," + "很" * 140 + "冷")
    assert not scene_title_lines("The corridor stretches on, silent and cold.")


# ---------------------------------------------------------------------------
# C2 — the runner
# ---------------------------------------------------------------------------


async def test_a_forged_roll_is_refused_rolled_for_real_and_renarrated():
    """THE M20 C acceptance criterion. The turn does not end while the reply claims
    numbers the engine never produced; the model rolls, then narrates the real result."""
    llm = FakeLLM(
        script=[
            assistant_text("Spot Hidden — 22 vs 25. You find nothing."),
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("Your eye catches the loose panel behind the crates."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I search the storeroom.")

    assert dice_rolled(result.tool_trace), "the gate must have produced a real roll"
    assert result.reply == "Your eye catches the loose panel behind the crates."
    assert not reply_states_a_roll(result.reply)


async def test_the_gate_never_touches_tools_or_tool_choice():
    """Pure Stop form, and the reason is cache economics, not squeamishness: the checks run
    when the prefix is largest, and changing `tools` invalidates every cache layer beneath
    it while changing `tool_choice` invalidates the message layer."""
    llm = FakeLLM(
        script=[
            assistant_text("22 vs 25 — you fail."),
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("Nothing but dust."),
        ]
    )
    services = _services(llm)

    await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I look around.")

    assert llm.tool_choices == ["auto", "auto", "auto"], "no forced round anywhere"
    offered = [{schema["function"]["name"] for schema in tools or []} for _, tools in llm.calls]
    assert offered[0] == offered[1] == offered[2], "the tool list must be byte-identical across the gate"


async def test_the_gate_re_verifies_instead_of_asking_once():
    """"I will not let this turn end" only differs from "please roll" because the
    condition is re-run on the NEW reply. Here the model keeps forging; the gate keeps
    refusing until its cap, and the last word it managed to get is what ships."""
    llm = FakeLLM(
        script=[
            assistant_text("22 vs 25 — you fail."),
            assistant_text("Fine: 31 vs 25 — you still fail."),
            assistant_text("The lock does not give."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I pick the lock.")

    assert len(llm.calls) == 3, "one main round plus two re-asks, each re-verified"
    assert result.reply == "The lock does not give."


async def test_the_gate_is_bounded_and_keeps_the_best_reply_it_got():
    """The ceiling is real: a model that will not stop forging still ends its turn."""
    forever = "22 vs 25 — you fail."
    llm = FakeLLM(responder=lambda messages, tools: ChatResult(content=forever, tool_calls=[]))
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I try again.")

    assert result.reply == forever
    assert len(llm.calls) <= 1 + MAX_ROUNDS_PER_TURN


async def test_a_tool_round_inside_the_gate_is_not_the_end_of_it():
    """After the model rolls, the condition is technically clear — but the OLD reply still
    carries the invented numbers. Breaking there would ship them."""
    llm = FakeLLM(
        script=[
            assistant_text("Spot Hidden — 99 vs 25. You fail badly."),
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("You find the loose panel after all."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I search.")

    assert result.reply == "You find the loose panel after all."


async def test_a_clean_reply_runs_no_checks_at_all():
    llm = FakeLLM(script=[assistant_text("The rain keeps on, and the street stays empty.")])
    services = _services(llm)

    await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I wait under the awning.")

    assert len(llm.calls) == 1


async def test_a_turn_that_rolled_and_kept_numbers_out_of_prose_runs_no_checks():
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("skill_check", skill_name="Spot Hidden")),
            assistant_text("Your eye catches the loose panel behind the crates."),
        ]
    )
    services = _services(llm)

    await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I search the storeroom.")

    assert len(llm.calls) == 2


async def test_a_provider_error_inside_the_gate_keeps_the_reply():
    class _FailsAfterFirst(FakeLLM):
        async def chat(self, messages, **kwargs):
            if self.calls:
                self.calls.append((messages, kwargs.get("tools")))
                raise RuntimeError("gateway timeout")
            return await super().chat(messages, **kwargs)

    llm = _FailsAfterFirst(script=[assistant_text("22 vs 25 — you fail.")])
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(_DiceProvider()), "I search.")

    assert result.reply == "22 vs 25 — you fail.", "best-effort: a broken gate never eats the turn"


async def test_a_scene_heading_without_bookkeeping_is_refused_until_the_tools_run():
    llm = FakeLLM(
        script=[
            assistant_text(_TITLE_REPLY),
            assistant_tools(
                tool_call("kp_note", action="set", category="current_scene", content="Pier 5"),
                tool_call("game_clock", action="set", value="22:15"),
            ),
            assistant_text(_TITLE_REPLY + "\nThe HUD now agrees with the fiction."),
        ]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(_StateProvider()), "We head to the pier.")

    assert [entry["name"] for entry in result.tool_trace] == ["kp_note", "game_clock"]
    assert "HUD now agrees" in result.reply


async def test_a_scene_heading_with_bookkeeping_already_done_is_left_alone():
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call("kp_note", action="set", category="current_scene", content="Pier 5"),
                tool_call("game_clock", action="set", value="22:15"),
            ),
            assistant_text(_TITLE_REPLY),
        ]
    )
    services = _services(llm)

    await run_kp_turn(_ctx(), services, Toolset(_StateProvider()), "We head to the pier.")

    assert len(llm.calls) == 2


async def test_the_gate_reads_a_prefix_the_main_loop_already_paid_for():
    """The check conversation drops this turn's tool chatter and keeps the cached head and
    history, so a re-ask is a cache READ rather than a recompute of the largest prefix in
    the turn."""
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("lookup_time")),
            assistant_text("22 vs 25 — you fail."),
            assistant_text("The lock holds."),
        ]
    )
    services = _services(llm)

    await run_kp_turn(_ctx(), services, Toolset(_SilentProvider(), _DiceProvider()), "I pick the lock.")

    gate_messages = llm.calls[-1][0]
    assert not any(message.get("role") == "tool" for message in gate_messages), "tool chatter is dropped"
    assert gate_messages[0] == llm.calls[0][0][0], "the stable head is the same object the main loop sent"


# ---------------------------------------------------------------------------
# The table is data, and the engine owns its ceiling
# ---------------------------------------------------------------------------


def _pack_with(rows) -> RulePack:
    return RulePack(
        system="test",
        defaults={},
        alias={},
        st_show={},
        set_keys=[],
        creation_constraints={},
        alias_to_canonical={},
        derived_formulas={},
        turn_checks=tuple(rows),
    )


def test_a_pack_may_reword_reorder_and_shorten_the_table():
    table = turn_checks_for(
        _pack_with(
            [
                {"when": "stale_scene_hud", "max_rounds": 1},
                {"when": "dice_forged", "instruction": {"en": "Roll it. Now."}, "max_rounds": 2},
            ]
        )
    )

    assert [check.condition for check in table] == ["stale_scene_hud", "dice_forged"]
    assert table[0].max_rounds == 1
    assert table[1].instruction(None, "en") == "Roll it. Now."


def test_the_engine_clamps_whatever_the_pack_asked_for():
    """Otherwise one content pack could blow the per-turn model-call budget."""
    table = turn_checks_for(_pack_with([{"when": "dice_forged", "max_rounds": 99}]))

    assert table[0].max_rounds == MAX_ROUNDS_PER_CHECK


def test_a_pack_may_drop_a_check_but_not_invent_a_condition():
    """Conditions are code — structural predicates over the real tool trace. A pack
    chooses among them; a row naming one this engine does not have is skipped, the way an
    unknown subsystem tool is, rather than crashing the room."""
    table = turn_checks_for(
        _pack_with(
            [
                {"when": "dice_forged", "enabled": False},
                {"when": "vibe_check"},
                {"when": "dice_contradicts"},
            ]
        )
    )

    assert [check.condition for check in table] == ["dice_contradicts"]


def test_a_pack_without_a_table_gets_the_engine_default():
    assert [check.condition for check in turn_checks_for(None)] == [
        "dice_forged",
        "dice_contradicts",
        "stale_scene_hud",
    ]
