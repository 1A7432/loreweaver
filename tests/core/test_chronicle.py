"""M18 oracle: the deterministic fold policy (`core.chronicle`).

Written FIRST (red). These pin the pure, offline half of the chronicle fold:

- the hysteresis levels (trigger 0.60 / floor 0.40 / emergency 0.85 by default);
- the no-future guard: entries inside the trailing lag window (last 4 turns by
  default) are NEVER fold candidates, and a fold input referencing turns beyond
  the watermark is rejected outright;
- batch selection: oldest-first, accumulating until the floor is projected to
  be reached (never one-entry-per-turn churn).
"""

from __future__ import annotations

from core.chronicle import (
    FoldCandidate,
    estimate_tokens,
    fold_decision,
    fold_watermark,
    select_fold_batch,
    validate_fold_input,
)

# -- token estimation ----------------------------------------------------------


def test_estimate_tokens_counts_cjk_per_char_and_latin_per_word_chunk() -> None:
    assert estimate_tokens("") == 0
    latin = "the party pressed onward through the fog"  # 40 latin chars + spaces
    assert 0 < estimate_tokens(latin) <= len(latin) // 3
    cjk = "顾晚棠拒绝了血契仪式"  # 10 CJK chars — roughly one token each
    assert estimate_tokens(cjk) >= 8, "CJK text must not be under-counted by a latin chars/4 rule"


# -- hysteresis decision --------------------------------------------------------


def test_fold_decision_levels_follow_the_configured_ratios() -> None:
    assert fold_decision(0.59, trigger=0.60, emergency=0.85) == "none"
    assert fold_decision(0.60, trigger=0.60, emergency=0.85) == "fold"
    assert fold_decision(0.84, trigger=0.60, emergency=0.85) == "fold"
    assert fold_decision(0.85, trigger=0.60, emergency=0.85) == "emergency"
    assert fold_decision(0.99, trigger=0.60, emergency=0.85) == "emergency"


# -- the lag window / watermark --------------------------------------------------


def test_fold_watermark_keeps_the_trailing_lag_window_raw() -> None:
    assert fold_watermark(current_turn=10, lag_turns=4) == 6
    assert fold_watermark(current_turn=3, lag_turns=4) == -1, "a young campaign folds nothing"


def _candidates(turns: list[int], tokens: int = 30) -> list[FoldCandidate]:
    return [FoldCandidate(id=f"c{turn:05d}", turn=turn, tokens=tokens) for turn in turns]


def test_select_fold_batch_never_touches_the_lag_window() -> None:
    candidates = _candidates(list(range(1, 11)))  # turns 1..10
    batch = select_fold_batch(candidates, watermark=6, needed_free_tokens=10_000, max_entries=100)
    assert batch, "entries at or before the watermark ARE foldable"
    assert max(entry.turn for entry in batch) <= 6, "the trailing 4 turns (7-10) stay raw"


def test_select_fold_batch_is_oldest_first_and_stops_at_the_floor_projection() -> None:
    candidates = _candidates([3, 1, 2, 4, 5], tokens=30)  # unsorted input
    batch = select_fold_batch(candidates, watermark=6, needed_free_tokens=100, max_entries=100)
    assert [entry.turn for entry in batch] == [1, 2, 3, 4], "30*3=90 < 100, so the 4th entry joins the batch"

    single = select_fold_batch(candidates, watermark=6, needed_free_tokens=30, max_entries=100)
    assert [entry.turn for entry in single] == [1], "a small deficit folds one entry, not a churn of them"


def test_select_fold_batch_caps_the_batch_size() -> None:
    candidates = _candidates(list(range(1, 31)), tokens=10)
    batch = select_fold_batch(candidates, watermark=100, needed_free_tokens=10_000, max_entries=12)
    assert len(batch) == 12, "one fold call consumes at most one batch — the loop iterates instead"


def test_select_fold_batch_empty_when_nothing_is_eligible() -> None:
    assert select_fold_batch(_candidates([7, 8, 9]), watermark=6, needed_free_tokens=100, max_entries=12) == []
    assert select_fold_batch([], watermark=6, needed_free_tokens=100, max_entries=12) == []


# -- the no-future guard (engine-side rejection) ---------------------------------


def test_validate_fold_input_rejects_turn_indices_beyond_the_watermark() -> None:
    batch = _candidates([4, 5, 7])
    violations = validate_fold_input(batch, watermark=6)
    assert violations and "c00007" in violations[0], "a fold consuming the future must be rejected"

    assert validate_fold_input(_candidates([4, 5, 6]), watermark=6) == []
    assert validate_fold_input([], watermark=6) == []
