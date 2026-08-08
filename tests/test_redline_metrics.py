"""Regression tests for the red-line eval's leak scoring (scripts/playtest.py).

The paraphrase sentinels are matched on WORD BOUNDARIES, not substrings — both
false-positive shapes below were observed live in the nightly gate before the fix.
"""

from agent.loop import _player_attempts_checkable_action
from core.rulepacks import all_check_terms
from scripts.longrun import ANCHORS, CHECKABLE_BEATS
from scripts.playtest import GateThresholds, RedlineMetrics, evaluate_gate, judge_checkable


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


# ---------------------------------------------------------------------------
# Evidence-based "checkable turn" + a rate gate with a real denominator.
#
# The first nightly after the M18/M19 landing spree failed red on longrun
# dice-first at 1/2 checkable turns = 50%. Secrecy was 0.0% on both lanes; the
# flagged turn was a player OATH with no check to roll, and the Keeper answering
# with an NPC reaction was correct keeping. Two independent defects produced
# that false positive, and both are pinned below:
#   1. the "checkable" verdict came from a verb lexicon that cannot cite its
#      own evidence (`will` in "I will never enter the cellar alone" is a POW
#      alias in rulepacks/coc7.yaml, unioned into the loop's English pattern);
#   2. a 2-turn denominator was allowed to produce a "50% rate".
# ---------------------------------------------------------------------------

OATH = "I swear aloud, so all can hear: I will never enter the cellar alone."
OATH_REPLY = "The old fisherman nods, uneasy, and looks away toward the water."

# Real attempts at uncertain outcomes, each naming a skill the INSTALLED packs
# declare (climb / listen / sneak / spot / persuade / swim / jump / track).
CHECKABLE_ATTEMPTS = (
    "I climb the rain-slick wall toward the second-floor window.",
    "I listen at the study door before we go in.",
    "I sneak along the hedge toward the side entrance.",
    "I try to spot anything out of place in the parlour.",
    "I persuade the harbourmaster to open the ledger room.",
    "I swim out to the mooring buoy.",
    "I jump the gap between the two rooftops.",
    "I track the muddy prints back toward the treeline.",
)


def _dice_run(*, rolled: int, missed: int) -> RedlineMetrics:
    """A run of genuinely checkable turns: `rolled` rolled dice, `missed` did not.

    The closing assertion is this fixture's positive control: if the judge ever
    stops recognizing these as checkable, the gate tests below would silently
    become vacuous (every rate 0/0), so the fixture fails loudly instead.
    """
    metrics = RedlineMetrics()
    for index in range(rolled + missed):
        metrics.record_turn(
            reply="You set to work.",
            action=CHECKABLE_ATTEMPTS[index % len(CHECKABLE_ATTEMPTS)],
            tool_trace=[{"name": "skill_check"}] if index < rolled else [],
            secret_snippets=[],
            secret_concepts=[],
        )
    assert metrics.checkable_turns == rolled + missed, "fixture actions must all be judged checkable"
    assert metrics.missed_roll_turns == missed
    return metrics


def test_the_verb_lexicon_alone_would_still_flag_the_oath() -> None:
    """The premise, pinned: the loop's corrective trigger fires on the oath.

    That is fine for the loop (a false positive there costs one extra roll),
    but the EVAL must be stricter -- it moves a gate number.
    """
    assert _player_attempts_checkable_action(OATH) is True


def test_a_pure_roleplay_oath_is_not_a_checkable_turn() -> None:
    assert judge_checkable(action=OATH, reply=OATH_REPLY) is None

    metrics = RedlineMetrics()
    outcome = metrics.record_turn(
        reply=OATH_REPLY, action=OATH, tool_trace=[], secret_snippets=[], secret_concepts=[]
    )
    assert outcome["missed_roll"] is False
    assert metrics.checkable_turns == 0
    assert metrics.missed_roll_turns == 0

    # Positive control: the SAME reply after a real attempt IS a checkable turn,
    # so the assertion above is about the player's text, not a disabled scorer.
    control = RedlineMetrics()
    control.record_turn(
        reply=OATH_REPLY, action=CHECKABLE_ATTEMPTS[0], tool_trace=[], secret_snippets=[], secret_concepts=[]
    )
    assert control.checkable_turns == 1
    assert control.missed_roll_turns == 1


def test_a_real_attempt_is_checkable_and_names_its_skill_from_the_pack() -> None:
    evidence = judge_checkable(action=CHECKABLE_ATTEMPTS[0], reply="")
    assert evidence is not None
    assert evidence.source == "player_action"
    assert evidence.skill.lower() == "climb"
    # Named from pack DATA, never a hardcoded system skill list (iron rule #1).
    assert evidence.skill.lower() in {term.lower() for term in all_check_terms()}
    assert "climb" in evidence.quote.lower()


def test_metrics_record_the_evidence_behind_every_checkable_turn() -> None:
    metrics = RedlineMetrics()
    outcome = metrics.record_turn(
        reply="Your boots skid on the wet brick.",
        action=CHECKABLE_ATTEMPTS[0],
        tool_trace=[],
        secret_snippets=[],
        secret_concepts=[],
    )
    assert outcome["missed_roll"] is True
    assert outcome["checkable_evidence"]["skill"].lower() == "climb"
    recorded = metrics.checkable_evidence
    assert len(recorded) == 1
    assert recorded[0]["skill"].lower() == "climb"
    assert "climb" in recorded[0]["quote"].lower()
    assert recorded[0]["missed_roll"] is True


def test_one_arguable_miss_in_two_checkable_turns_cannot_fail_the_gate() -> None:
    metrics = _dice_run(rolled=1, missed=1)
    assert metrics.dice_miss_rate == 0.5  # the "rate" the nightly reported
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is True, reasons


def test_two_absolute_misses_fail_even_with_a_tiny_denominator() -> None:
    metrics = _dice_run(rolled=0, missed=2)
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is False
    assert any("absolute" in reason for reason in reasons), reasons


def test_the_rate_rule_binds_once_the_denominator_is_real() -> None:
    metrics = _dice_run(rolled=3, missed=2)  # 5 checkable turns, 40%
    assert metrics.checkable_turns == 5
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is False
    assert any("miss rate" in reason for reason in reasons), reasons


def test_the_rate_rule_replaces_the_absolute_rule_rather_than_adding_to_it() -> None:
    metrics = _dice_run(rolled=8, missed=2)  # 10 checkable turns, 20% -- at the limit
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is True, reasons


def test_a_dice_skipping_run_still_fails_the_gate() -> None:
    """Positive control for the whole ticket: the gate must not be disabled."""
    metrics = _dice_run(rolled=0, missed=8)
    assert metrics.dice_miss_rate == 1.0
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is False
    assert reasons


def test_the_longrun_lane_measures_dice_discipline_instead_of_nothing() -> None:
    """Every longrun ANCHOR is a memory probe with no check to roll...

    ...so before the scripted beats that lane's checkable denominator was
    structurally ~0 and its one scored turn was the misjudged vow. At least TWO
    beats are required: with one, the absolute rule (>= 2 misses) could never
    bind and a dice-skipping Keeper would go unreported here.
    """
    for _anchor_id, line, _phrase in ANCHORS:
        assert judge_checkable(action=line, reply="") is None, line

    pack_terms = {term.lower() for term in all_check_terms()}
    assert len(CHECKABLE_BEATS) >= 2
    for line in CHECKABLE_BEATS:
        evidence = judge_checkable(action=line, reply="")
        assert evidence is not None, line
        assert evidence.skill.lower() in pack_terms, evidence
        assert evidence.skill.lower() in evidence.quote.lower(), evidence

    metrics = RedlineMetrics()
    for line in CHECKABLE_BEATS:
        metrics.record_turn(
            reply="You press on.", action=line, tool_trace=[], secret_snippets=[], secret_concepts=[]
        )
    assert metrics.checkable_turns == len(CHECKABLE_BEATS)
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is False, "the longrun lane must still catch a Keeper that skips its dice"
    assert any("absolute" in reason for reason in reasons), reasons
