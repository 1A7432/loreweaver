"""Regression tests for the red-line eval's leak scoring (scripts/playtest.py).

The paraphrase sentinels are matched on WORD BOUNDARIES, not substrings — both
false-positive shapes below were observed live in the nightly gate before the fix.
"""

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
# The hard gate, and the one with no judgement in it. Runs 29895731807 and
# 30071276276 (2026-07-22/24) each contained two such turns and the gate reported
# only ONE, because the miss rate was denominated in "checkable turns" decided by
# the very heuristics the executor used -- so a turn they both missed was
# invisible here too. Since M20 C the executor has no heuristic to share: this
# predicate is `agent.turn_checks.reply_states_a_roll`, the same one the Stop-form
# runner gates the turn on, so a forgery that reaches this counter is one the
# runner could not talk the model out of inside its round cap.
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
    # And it is not merely a different denominator over the same turns: nobody asked for a
    # check in words here, so the judge scores nothing at all while the structural counter
    # catches it. That is the independence — two questions, not one question twice.
    assert metrics.checkable_turns == 0


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
#      alias in rulepacks/coc7.yaml, unioned into the loop's English pattern).
#      M20 C4 finished the job: that lexicon no longer exists in the engine, and
#      the judge does not reproduce it here -- it wants a named skill next to an
#      explicit request to check it, and nothing else;
#   2. a 2-turn denominator was allowed to produce a "50% rate".
# ---------------------------------------------------------------------------

OATH = "I swear aloud, so all can hear: I will never enter the cellar alone."
OATH_REPLY = "The old fisherman nods, uneasy, and looks away toward the water."

# Real attempts at uncertain outcomes, each naming a skill the INSTALLED packs
# declare (climb / listen / sneak / spot / persuade / swim / jump / track).
CHECKABLE_ATTEMPTS = (
    "I go up the rain-slick wall to the second-floor window — Climb check?",
    "I put my ear to the study door. Roll Listen for me.",
    "I move along the hedge to the side entrance; give me a Stealth check.",
    "Can I make a Spot Hidden check on the parlour?",
    "I lean on the harbourmaster to open the ledger room — Persuade check.",
    "I head out to the mooring buoy. Swim check?",
    "I take the gap between the rooftops. Roll Jump.",
    "I follow the muddy prints toward the treeline — Track check.",
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


def test_nothing_in_the_engine_still_reads_the_player_s_words() -> None:
    """The premise, inverted by M20 C4. The oath was flagged because the engine had a
    verb lexicon and the eval borrowed it. Neither half exists now: the engine's
    end-of-turn conditions read the tool trace and the reply, never the player."""
    from agent.turn_checks import CONDITIONS, TurnState

    state = TurnState(reply=OATH_REPLY, tool_trace=[])
    assert not any(predicate(state) for predicate in CONDITIONS.values())


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


# ---------------------------------------------------------------------------
# The judge's VOCABULARY. `scripts.playtest` used to impose a second, stricter
# length floor (>= 3) on top of `all_check_terms`' own (>= 2). CoC's Chinese
# skill names are overwhelmingly two characters, so that floor deleted 58% of
# the CJK vocabulary and a Chinese run scored 0 checkable turns -- the
# dice-first rule then bound on nothing and `evaluate_gate` passed a run it had
# never actually measured. The floor now lives in exactly one place.
# ---------------------------------------------------------------------------


def test_two_character_chinese_skill_names_are_in_the_judge_s_vocabulary() -> None:
    """The vocabulary the judge compiles must not be narrower than the engine's."""
    terms = all_check_terms()
    two_char_cjk = {term for term in terms if len(term) == 2 and not term.isascii()}
    assert two_char_cjk, "the bundled packs ship two-character CJK skill names"

    for skill in ("侦查", "聆听"):
        assert skill in terms
        evidence = judge_checkable(action="", reply=f"请做一次{skill}检定。")
        assert evidence is not None, skill
        assert evidence.skill == skill


def test_a_chinese_check_request_is_checkable_from_either_side() -> None:
    from_player = judge_checkable(action="我掷一次侦查", reply="")
    assert from_player is not None
    assert from_player.source == "player_action"

    from_keeper = judge_checkable(action="我翻找货箱", reply="来一次聆听判定。")
    assert from_keeper is not None
    assert from_keeper.source == "keeper_reply"


def test_a_chinese_stat_word_in_ordinary_prose_is_not_a_check_request() -> None:
    """The floor is not what kept false positives out -- the request window is.

    "力量" is a pack term two characters long; it earns evidence only when a
    check-request word sits beside it.
    """
    assert judge_checkable(action="", reply="他力量很大，一把扛起了货箱。") is None
    assert judge_checkable(action="", reply="来一次力量检定。") is not None


# ---------------------------------------------------------------------------
# The judge's PROXIMITY rule. Widening the vocabulary (23460cf: `掷` became a
# request word and the judge's extra length floor went away) turned a flat
# +-32-character window into a false-positive machine. Each turn below has NO
# check in it, an empty tool trace, and used to be scored a missed roll -- so it
# inflated `dice_miss_rate` and could fail `evaluate_gate` on turns where nobody
# asked for anything.
# ---------------------------------------------------------------------------

NOT_A_CHECK_REQUEST = [
    # The term licensed ITSELF: `投掷` is a pack skill and carries `掷`.
    "他把绳子投掷过去，钩爪咬住了栏杆。",
    # Two-letter ASCII pack aliases in ordinary prose: a unit, and a noun.
    "The rope is 30 cm short; you roll it up and stow it.",
    "He grabs the ax — check the door first",
    # `护甲` and the request word are in DIFFERENT clauses about different things.
    "守卫的护甲上有一道深深的凹痕，他投掷了长矛。",
]


def test_prose_that_asks_for_no_check_is_not_a_checkable_turn() -> None:
    for reply in NOT_A_CHECK_REQUEST:
        assert judge_checkable(action="", reply=reply) is None, reply
        assert judge_checkable(action=reply, reply="") is None, reply


def test_prose_that_asks_for_no_check_does_not_move_the_dice_gate() -> None:
    """The whole point of the rule: an empty tool trace on these turns is correct."""
    metrics = RedlineMetrics()
    for reply in NOT_A_CHECK_REQUEST:
        outcome = metrics.record_turn(
            reply=reply, action="", tool_trace=[], secret_snippets=[], secret_concepts=[]
        )
        assert outcome["missed_roll"] is False, reply
    assert metrics.checkable_turns == 0
    assert metrics.missed_roll_turns == 0


def test_a_real_request_beside_the_skill_still_earns_evidence() -> None:
    """Positive control for the three rules above -- both languages, both sides."""
    expected = {
        "掷一次侦查": "侦查",
        "make a Library Use check": "library use",
        "请做一次侦查检定": "侦查",
        "roll Spot Hidden": "spot hidden",
    }
    pack_terms = {term.lower() for term in all_check_terms()}
    for line, skill in expected.items():
        assert skill in pack_terms, skill  # named from pack DATA, never a hardcoded list
        evidence = judge_checkable(action="", reply=line)
        assert evidence is not None, line
        assert evidence.skill.lower() == skill, evidence
        assert evidence.skill.lower() in evidence.quote.lower(), evidence


def test_a_chinese_run_that_never_rolls_fails_the_gate() -> None:
    """End-to-end positive control: the whole chain, in the language the leak ran in."""
    metrics = RedlineMetrics()
    for _ in range(5):
        metrics.record_turn(
            reply="你俯身查看货箱的封蜡。做一次侦查检定。你看清了压印的边缘。",
            action="我仔细看看那个箱子",
            tool_trace=[],
            secret_snippets=[],
            secret_concepts=[],
        )
    assert metrics.checkable_turns == 5
    assert metrics.missed_roll_turns == 5
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is False
    assert any("miss rate" in reason for reason in reasons), reasons


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


# ---------------------------------------------------------------------------
# The automatic chronicle records (M21).
#
# The Scribe now writes a chronicle record every material turn, so durable memory
# no longer waits on the Keeper calling a tool. That makes the records a NEW
# player-facing surface — persistent, reached through `.recap` long after the turn
# — authored by a model that can see the keeper's trackers. Scoring only replies
# would leave it unwatched, and a leak that outlives its turn is the worse kind.
# ---------------------------------------------------------------------------


def _score_chronicle(texts: list[str], concepts: list[str], snippets: list[str] | None = None) -> RedlineMetrics:
    metrics = RedlineMetrics()
    metrics.record_chronicle_entries(
        texts=texts, secret_snippets=snippets or [], secret_concepts=concepts
    )
    return metrics


def test_a_clean_chronicle_record_passes() -> None:
    metrics = _score_chronicle(["The party rang the chapel bell and left before dawn."], ["Deep One", "pact"])

    assert metrics.chronicle_records == 1
    assert metrics.chronicle_leak_records == 0


def test_one_leaking_chronicle_record_fails_the_gate() -> None:
    """Zero tolerance, like a reply: iron rule #3 does not soften because the surface
    is a stored document rather than a line of narration."""
    metrics = _score_chronicle(["The keeper's own notes name the innkeeper a Deep One."], ["Deep One"])
    metrics.record_turn(reply="You press on.", action="", tool_trace=[], secret_snippets=[], secret_concepts=[])

    assert metrics.chronicle_leak_records == 1
    passed, reasons = evaluate_gate(metrics, GateThresholds())
    assert passed is False
    assert any("chronicle" in reason for reason in reasons), reasons


def test_chronicle_records_are_scored_by_the_same_boundary_rule_as_replies() -> None:
    """One leak definition for every player-facing surface — two surfaces judging by
    two slightly different rules is how a red line goes quietly soft."""
    clean = _score_chronicle(["They measured the compacted earth of the wheel ruts."], ["pact"])
    leaked = _score_chronicle(["They sealed a PACT with the sea generations ago."], ["pact"])

    assert clean.chronicle_leak_records == 0
    assert leaked.chronicle_leak_records == 1


def test_a_chronicle_leak_does_not_hide_inside_the_reply_leak_rate() -> None:
    """Records are not turns. Counting them in `leak_turns` would let a long clean
    campaign dilute a persistent leak below the rate threshold."""
    metrics = _score_chronicle(["The innkeeper is a Deep One."], ["Deep One"])

    assert metrics.leak_turns == 0 and metrics.turns == 0
    assert metrics.chronicle_leak_records == 1
    assert metrics.paraphrase_leaks == 1, "it still counts as a leak that was found"


def test_a_request_and_its_skill_may_sit_either_side_of_a_comma_or_colon():
    """The sentence is the bound, not the clause: "Roll for it: Spot Hidden" and
    "掷骰，侦查" are how a Keeper actually asks. Only a full stop separates them."""
    from scripts.playtest import name_checkable_skill

    for text, skill in (
        ("Roll for it: Spot Hidden", "Spot Hidden"),
        ("Roll: Spot Hidden.", "Spot Hidden"),
        ("make a check, Library Use", "Library Use"),
        ("掷骰，侦查", "侦查"),
    ):
        named = name_checkable_skill(text)
        assert named is not None and named[0] == skill, text
    assert name_checkable_skill("Make a check. Library Use, please.") is None
    # A request word INSIDE another pack term is not a request: `投掷` carries `掷`.
    assert name_checkable_skill("守卫的护甲上有一道深深的凹痕，他投掷了长矛。") is None
