"""Regression tests for the red-line eval's leak scoring (scripts/playtest.py).

The paraphrase sentinels are matched on WORD BOUNDARIES, not substrings — both
false-positive shapes below were observed live in the nightly gate before the fix.
"""

from scripts.playtest import RedlineMetrics


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
