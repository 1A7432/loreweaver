"""Fixture-grounded smoke coverage for the unified live behavior harness."""

from pathlib import Path

import pytest

from scripts.playtest import (
    BehaviorMetrics,
    BehaviorThresholds,
    Recorder,
    _build_behavior_services,
    _contains_eval_sentinel,
    _fixture_turns,
    evaluate_behavior_gate,
    load_behavior_fixture,
    run_behavior_suite,
)

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests/fixtures/behavioral_eval_scenarios.json"


def test_behavior_fixture_has_fixed_ground_truth_denominators() -> None:
    fixture = load_behavior_fixture(FIXTURE)
    turns = _fixture_turns(fixture)

    assert len(turns) == 40
    assert sum(turn.get("expect_roll") is False for turn in turns) == 18
    assert sum(turn.get("expect_roll") is True for turn in turns) == 20
    assert sum("actor_expectation" in turn for turn in turns) == 20
    assert sum("state_expectation" in turn for turn in turns) == 4
    assert sum("initiative_expectation" in turn for turn in turns) == 2


def test_behavior_sentinels_use_token_boundaries_for_latin_text() -> None:
    assert _contains_eval_sentinel("Recovered the brass key from the dock locker.", "brass key")
    assert not _contains_eval_sentinel("A brass keyboard sits nearby.", "brass key")
    assert _contains_eval_sentinel("从码头储物柜取得黄铜钥匙。", "黄铜钥匙")


def test_behavior_clock_claim_accepts_equivalent_locale_renderings() -> None:
    sentinel = "1926-03-15 09:30"
    assert _contains_eval_sentinel("Time: 1926-03-15, 09:30", sentinel)
    assert _contains_eval_sentinel("At 09:30 on March 15, 1926, the door opens.", sentinel)
    assert _contains_eval_sentinel("时间：1926年3月15日 09:30", sentinel)
    assert not _contains_eval_sentinel("Time remains 1926-03-15 09:00.", sentinel)


def test_behavior_gate_fails_closed_on_empty_or_bad_metrics() -> None:
    passed, reasons = evaluate_behavior_gate(BehaviorMetrics(), BehaviorThresholds())
    assert not passed
    assert any("no no-roll cases" in reason for reason in reasons)

    bad = BehaviorMetrics(
        turns=5,
        no_roll_cases=1,
        over_roll_false_positives=1,
        roll_required_cases=1,
        dice_first_misses=1,
        state_cases=1,
        state_divergences=1,
        actor_cases=1,
        event_groups=1,
        recorded_event_groups=0,
    )
    passed, reasons = evaluate_behavior_gate(bad, BehaviorThresholds(max_state_divergence_rate=0.0))
    assert not passed
    assert any("over-roll" in reason for reason in reasons)
    assert any("dice-first" in reason for reason in reasons)
    assert any("state divergence" in reason for reason in reasons)
    assert any("actor compliance" in reason for reason in reasons)
    assert any("event recording" in reason for reason in reasons)


@pytest.mark.asyncio
async def test_behavior_fake_llm_smoke_runs_real_turn_and_tool_pipeline(tmp_path: Path) -> None:
    fixture = load_behavior_fixture(FIXTURE)
    services, temporary, meter = await _build_behavior_services(
        mode="smoke",
        fixture=fixture,
        credentials_db="",
        provider="chatgpt",
        model="gpt-5.6-sol",
        reasoning_effort="medium",
    )
    recorder = Recorder(tmp_path / "smoke.jsonl", append=False)
    try:
        metrics, records = await run_behavior_suite(services, fixture, recorder)
    finally:
        recorder.close()
        services.store.close()
        if temporary is not None:
            temporary.cleanup()

    passed, reasons = evaluate_behavior_gate(metrics, BehaviorThresholds(max_state_divergence_rate=0.0))
    assert passed, reasons
    assert len(records) == 40
    assert metrics.actor_compliant == metrics.actor_cases == 20
    assert metrics.state_divergences == 0
    assert metrics.recorded_event_groups == metrics.event_groups == 2
    assert metrics.duplicated_event_groups == 0
    assert len(metrics.initiative_suppression_observations or []) == 2
    legitimate = next(
        item for item in metrics.initiative_suppression_observations or [] if item["legitimate_multi_advance"]
    )
    assert legitimate["suppressed_calls"] == 1
    # The meter sees tool follow-ups and recap/correction calls too, not only one
    # headline usage object per turn.
    assert meter.usage.calls > metrics.turns
    assert meter.usage.total_tokens > 0
