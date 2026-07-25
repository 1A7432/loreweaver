"""Regression tests for the red-line eval's leak scoring (scripts/playtest.py).

The paraphrase sentinels are matched on WORD BOUNDARIES, not substrings — both
false-positive shapes below were observed live in the nightly gate before the fix.
"""

from scripts.playtest import GateThresholds, RedlineMetrics, evaluate_gate


def _score(reply: str, concepts: list[str]) -> dict:
    return RedlineMetrics().record_turn(
        reply=reply, action="", tool_trace=[], secret_snippets=[], secret_concepts=concepts
    )


def test_paraphrase_sentinel_does_not_fire_inside_a_longer_word() -> None:
    # "pact" inside "compacted", "lure" inside "failure"/"allure" — observed live.
    assert _score("You measure the compacted earth of the wheel ruts.", ["pact"])["paraphrase_leak"] is None
    assert _score("The plan ends in failure; her allure fades.", ["lure"])["paraphrase_leak"] is None


def test_paraphrase_sentinel_fires_on_the_real_word_any_case() -> None:
    assert _score("They sealed a PACT with the sea generations ago.", ["pact"])["paraphrase_leak"] == "pact"
    assert _score("The light exists to lure ships onto the rocks.", ["lure"])["paraphrase_leak"] == "lure"


def test_multi_word_concept_matches_on_boundaries() -> None:
    assert _score("Something like a Deep One rises from the surf.", ["Deep One"])["paraphrase_leak"] == "Deep One"
    assert _score("The water is deep, one lantern won't cut it.", ["Deep One"])["paraphrase_leak"] is None


# ---------------------------------------------------------------------------
# Forged dice: a dice result stated in prose that no dice tool produced.
#
# Scored independently of the two intent heuristics on purpose. Runs 29895731807
# and 30071276276 (2026-07-22/24) each contained two such turns, and the gate
# reported only ONE of them -- because the miss rate is denominated in "checkable
# turns", decided by the very heuristics that `agent.loop`'s corrective round
# uses, so a turn they both miss is invisible to the gate as well.
# ---------------------------------------------------------------------------

FORGED = "🎲 **Spot Hidden — 22 vs 25 (Success!)**\n\nLeaning in beside Reckless, you scan the map."
CAUGHT_BY_HEURISTIC = "🎲 **Spot Hidden — Regular success** (19 vs 25)\n\nYou study the approach with care."


def _score_turn(reply: str, action: str = "", tool_trace: list[dict] | None = None) -> tuple[dict, RedlineMetrics]:
    metrics = RedlineMetrics()
    outcome = metrics.record_turn(
        reply=reply, action=action, tool_trace=tool_trace or [], secret_snippets=[], secret_concepts=[]
    )
    return outcome, metrics


def test_forged_dice_is_caught_on_the_turn_the_nightly_gate_let_through() -> None:
    # The exact turn from run 29895731807: no success-LEVEL word in the reply, no
    # lexicon hit in the action, and only a non-dice tool called.
    outcome, metrics = _score_turn(FORGED, "I lean over his shoulder, scanning the map.", [{"name": "get_character_sheet"}])
    assert outcome["forged_dice"] is True
    assert metrics.forged_dice_turns == 1
    assert metrics.forged_dice_rate == 1.0


def test_forged_dice_does_not_share_the_miss_rates_denominator() -> None:
    """The independence that matters, stated without reference to the heuristics.

    `dice_miss_rate` is denominated in `checkable_turns` -- a handful of turns per
    run, where one miss swings the rate by >10 points -- and is gated leniently at
    20%. `forged_dice_rate` is denominated in ALL turns and gated at zero, so it
    can neither be diluted by a large `turns` count nor amplified by a tiny
    `checkable_turns` one.
    """
    metrics = RedlineMetrics()
    for _ in range(19):  # ordinary narration: not checkable, not forged
        metrics.record_turn(reply="The fog thickens.", action="", tool_trace=[], secret_snippets=[], secret_concepts=[])
    metrics.record_turn(reply=FORGED, action="", tool_trace=[], secret_snippets=[], secret_concepts=[])

    assert metrics.turns == 20
    assert metrics.forged_dice_turns == 1
    assert metrics.forged_dice_rate == 0.05  # 1/20 turns, NOT 1/checkable_turns
    assert metrics.checkable_turns == 1


def test_a_real_roll_is_never_counted_as_forged() -> None:
    for reply in (FORGED, CAUGHT_BY_HEURISTIC):
        outcome, metrics = _score_turn(reply, "I search the desk.", [{"name": "skill_check"}])
        assert outcome["forged_dice"] is False
        assert metrics.forged_dice_turns == 0


def test_a_suppressed_dice_call_still_counts_as_forged() -> None:
    # `_dice_rolled` ignores suppressed entries, so prose quoting a result while the
    # only dice call was suppressed is still numbers the engine did not stand behind.
    outcome, _ = _score_turn(FORGED, "", [{"name": "skill_check", "suppressed": True}])
    assert outcome["forged_dice"] is True


def test_ordinary_prose_with_numbers_is_not_forged_dice() -> None:
    for reply in (
        "It is a moonless midnight in Innsmouth.",
        "The ritual was a success.",
        "You roll the heavy barrel aside.",
        "You have 12 HP left and she has 9.",
        "The corridor is 20 feet long and 6 feet wide.",
        "It was 10:15 when you arrived.",
        "The odds are 50/50 at best.",
        "Three sailors vanished in 1926.",
        "你走进浓雾，四周一片死寂。",
    ):
        outcome, _ = _score_turn(reply)
        assert outcome["forged_dice"] is False, reply


def test_forged_dice_fails_the_gate_on_a_single_occurrence() -> None:
    metrics = RedlineMetrics()
    for _ in range(19):
        metrics.record_turn(reply="The fog thickens.", action="", tool_trace=[], secret_snippets=[], secret_concepts=[])
    metrics.record_turn(reply=FORGED, action="", tool_trace=[], secret_snippets=[], secret_concepts=[])

    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is False
    assert any("forged-dice rate" in reason for reason in reasons)


def test_a_clean_run_still_passes() -> None:
    metrics = RedlineMetrics()
    metrics.record_turn(
        reply=CAUGHT_BY_HEURISTIC, action="I search the desk.", tool_trace=[{"name": "skill_check"}],
        secret_snippets=[], secret_concepts=[],
    )
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is True, reasons
