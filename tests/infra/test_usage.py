"""Tests for infra.llm.parse_usage/context_window_for: the best-effort,
provider-agnostic token/cache usage parser that backs the TUI's status-bar
context%/cache% meter (see gateway.turn._record_usage_stats and
net.state.build_room_state). Every raw shape is stubbed with
`types.SimpleNamespace`/dicts -- no network, no real SDK objects.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from infra.llm import Usage, context_window_for, parse_usage
from infra.store import Store
from infra.usage_stats import record_usage_stats

# ---------------------------------------------------------------------------
# parse_usage -- no usage-like object present
# ---------------------------------------------------------------------------


def test_parse_usage_none_raw_returns_none():
    assert parse_usage(None) is None


def test_parse_usage_no_usage_attribute_returns_none():
    assert parse_usage(SimpleNamespace(choices=[])) is None


def test_parse_usage_all_zero_prompt_and_completion_returns_none():
    raw = SimpleNamespace(usage=SimpleNamespace(prompt_tokens=0, completion_tokens=0, total_tokens=0))
    assert parse_usage(raw) is None


# ---------------------------------------------------------------------------
# parse_usage -- OpenAI shape (plain + prompt_tokens_details.cached_tokens)
# ---------------------------------------------------------------------------


def test_parse_usage_openai_plain_shape():
    raw = SimpleNamespace(usage=SimpleNamespace(prompt_tokens=100, completion_tokens=20, total_tokens=120))

    usage = parse_usage(raw)

    assert usage is not None
    assert (usage.prompt_tokens, usage.completion_tokens, usage.total_tokens) == (100, 20, 120)
    assert (usage.cache_hit_tokens, usage.cache_miss_tokens) == (0, 0)


def test_parse_usage_openai_cached_tokens_details():
    details = SimpleNamespace(cached_tokens=40)
    raw = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=100, completion_tokens=20, total_tokens=120, prompt_tokens_details=details)
    )

    usage = parse_usage(raw)

    assert usage.cache_hit_tokens == 40
    # No explicit miss field -- derived as prompt - hit.
    assert usage.cache_miss_tokens == 60


def test_parse_usage_openai_total_derived_when_absent():
    raw = SimpleNamespace(usage=SimpleNamespace(prompt_tokens=50, completion_tokens=10, total_tokens=0))

    usage = parse_usage(raw)

    assert usage.total_tokens == 60


def test_parse_usage_openai_dict_shape():
    raw = {"usage": {"prompt_tokens": 30, "completion_tokens": 5, "total_tokens": 35}}

    usage = parse_usage(raw)

    assert usage is not None
    assert (usage.prompt_tokens, usage.completion_tokens, usage.total_tokens) == (30, 5, 35)


def test_parse_usage_coerces_non_numeric_fields_to_zero():
    raw = SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens="not-a-number", total_tokens=None))

    usage = parse_usage(raw)

    assert usage.completion_tokens == 0
    assert usage.total_tokens == 10  # derived, since total was absent/invalid


# ---------------------------------------------------------------------------
# parse_usage -- DeepSeek shape (explicit hit/miss, incl. via model_extra)
# ---------------------------------------------------------------------------


def test_parse_usage_deepseek_attribute_shape():
    raw = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=200,
            completion_tokens=50,
            total_tokens=250,
            prompt_cache_hit_tokens=150,
            prompt_cache_miss_tokens=50,
        )
    )

    usage = parse_usage(raw)

    assert usage.cache_hit_tokens == 150
    assert usage.cache_miss_tokens == 50  # explicit, not derived


def test_parse_usage_deepseek_model_extra_dict_shape():
    """The openai SDK may stash DeepSeek's extra fields on `usage.model_extra`
    (a dict) instead of as direct attributes, depending on SDK version."""
    raw = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=200,
            completion_tokens=50,
            total_tokens=250,
            model_extra={"prompt_cache_hit_tokens": 120, "prompt_cache_miss_tokens": 80},
        )
    )

    usage = parse_usage(raw)

    assert usage.cache_hit_tokens == 120
    assert usage.cache_miss_tokens == 80


def test_parse_usage_deepseek_attribute_wins_over_model_extra():
    raw = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=200,
            completion_tokens=50,
            total_tokens=250,
            prompt_cache_hit_tokens=150,
            model_extra={"prompt_cache_hit_tokens": 999},
        )
    )

    usage = parse_usage(raw)

    assert usage.cache_hit_tokens == 150


# ---------------------------------------------------------------------------
# parse_usage -- Anthropic shape
# ---------------------------------------------------------------------------


def test_parse_usage_anthropic_shape_prompt_includes_cache_fields():
    raw = SimpleNamespace(
        usage=SimpleNamespace(
            input_tokens=1000,
            output_tokens=200,
            cache_read_input_tokens=500,
            cache_creation_input_tokens=100,
        )
    )

    usage = parse_usage(raw)

    assert usage is not None
    # prompt_tokens = input + cache_read + cache_creation
    assert usage.prompt_tokens == 1600
    assert usage.completion_tokens == 200
    assert usage.cache_hit_tokens == 500
    assert usage.total_tokens == 1800


def test_anthropic_cache_reads_still_count_toward_the_context_meter():
    """REGRESSION GUARD (M20 A). Anthropic's `input_tokens` EXCLUDES cached tokens, so
    `prompt_tokens` must add `cache_read` + `cache_creation` back in.

    This is not cosmetic accounting. `prompt_tokens` is what `infra.usage_stats` persists
    as the room's meter, and what `agent.chronicle`'s fold trigger reads to decide whether
    the context is full. Drop the cache fields and the meter would SHRINK as caching got
    better — a well-cached long campaign would report a tiny context, never fold, and
    silently run the window off the end. The failure is invisible until the provider
    rejects the request.

    Same two turns, same real context, different cache luck: the meter must not move.
    """
    cold = parse_usage(
        SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=12_000, output_tokens=300, cache_read_input_tokens=0, cache_creation_input_tokens=8_000
            )
        )
    )
    warm = parse_usage(
        SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=4_000, output_tokens=300, cache_read_input_tokens=16_000, cache_creation_input_tokens=0
            )
        )
    )

    assert cold is not None and warm is not None
    assert cold.prompt_tokens == warm.prompt_tokens == 20_000, (
        "the fold trigger reads prompt_tokens; if a cache hit makes it smaller, long "
        "campaigns stop folding and blow the context window"
    )
    assert warm.cache_hit_tokens == 16_000


def test_parse_usage_anthropic_shape_no_caching():
    raw = SimpleNamespace(
        usage=SimpleNamespace(input_tokens=300, output_tokens=40, cache_read_input_tokens=0, cache_creation_input_tokens=0)
    )

    usage = parse_usage(raw)

    assert usage.prompt_tokens == 300
    assert usage.cache_hit_tokens == 0
    # No cache activity at all (read==creation==0 — a cold call, before the M20 A
    # breakpoints every KP turn now sends have written a cache):
    # miss stays 0 too, so hit+miss==0 -> the HUD renders "—" (not-applicable), NOT a misleading
    # permanent "0%". (Were miss derived to `prompt`, the rate would read a fake 0% every turn.)
    assert usage.cache_miss_tokens == 0


# ---------------------------------------------------------------------------
# parse_usage -- Gemini shape
# ---------------------------------------------------------------------------


def test_parse_usage_gemini_shape():
    raw = SimpleNamespace(
        usage_metadata=SimpleNamespace(prompt_token_count=400, candidates_token_count=80, cached_content_token_count=100)
    )

    usage = parse_usage(raw)

    assert usage is not None
    assert usage.prompt_tokens == 400
    assert usage.completion_tokens == 80
    assert usage.cache_hit_tokens == 100
    assert usage.total_tokens == 480
    # Derived: miss = prompt - hit.
    assert usage.cache_miss_tokens == 300


def test_parse_usage_gemini_zero_usage_returns_none():
    raw = SimpleNamespace(usage_metadata=SimpleNamespace(prompt_token_count=0, candidates_token_count=0))

    assert parse_usage(raw) is None


# ---------------------------------------------------------------------------
# context_window_for
# ---------------------------------------------------------------------------


def test_context_window_for_known_models():
    """Each figure is the vendor's own published maximum (checked 2026-08-11).

    This is not a cosmetic table: M18 made it the denominator of the chronicle fold, so
    an under-reported window makes a room summarise and trim its raw history early.
    """
    assert context_window_for("deepseek-v4-pro") == 1_000_000
    assert context_window_for("deepseek-v4-flash") == 1_000_000
    assert context_window_for("kimi-k3") == 1_000_000
    assert context_window_for("gpt-5.6-sol") == 1_050_000
    assert context_window_for("gpt-4o-mini") == 128_000
    assert context_window_for("o3-mini") == 128_000
    assert context_window_for("claude-opus-5") == 1_000_000
    assert context_window_for("gemini-2.5-pro") == 1_000_000


def test_a_family_needle_never_swallows_a_sibling_with_a_different_window():
    """The reason matching is longest-needle-first rather than tuple order.

    Three vendors ship sibling models whose names share a prefix but whose windows do
    not, so a shorter needle placed earlier would quietly answer for the longer one.
    """
    assert context_window_for("kimi-k2.7-code") == 256_000, "k2.x is 256K; only k3 is 1M"
    assert context_window_for("grok-4.5") == 500_000, "4.5 is 500K while 4.3/4.20 are 1M"
    assert context_window_for("grok-4.3") == 1_000_000
    assert context_window_for("claude-haiku-4-5") == 200_000, "Haiku stayed at 200K"


def test_line_order_in_the_table_is_not_load_bearing():
    """The guard behind the guard: reordering the table must not change any answer."""
    import infra.llm as llm_module

    original = llm_module._CONTEXT_WINDOWS
    probes = ("kimi-k2.7-code", "kimi-k3", "grok-4.5", "claude-haiku-4-5", "claude-opus-5")
    expected = {probe: context_window_for(probe) for probe in probes}
    try:
        llm_module._CONTEXT_WINDOWS = tuple(reversed(original))
        assert {probe: context_window_for(probe) for probe in probes} == expected
    finally:
        llm_module._CONTEXT_WINDOWS = original


def test_context_window_for_is_case_insensitive():
    assert context_window_for("DeepSeek-V4-Pro") == 1_000_000
    assert context_window_for("Claude-Opus-5") == 1_000_000


def test_context_window_for_unknown_model_defaults():
    """Unverified names fall to the conservative default rather than a flattering guess.

    Guessing high would let a prompt outgrow the real window and kill the turn on a
    provider error; guessing low only folds sooner than needed. The operator knob is the
    fix for anything the table cannot name.
    """
    assert context_window_for("some-custom-local-model") == 128_000
    assert context_window_for("") == 128_000


def test_the_operator_override_outranks_the_table():
    """No lookup table survives a vendor's release schedule — the operator gets the last word."""
    assert context_window_for("deepseek-v4-pro", 250_000) == 250_000
    assert context_window_for("some-custom-local-model", 2_000_000) == 2_000_000
    assert context_window_for("deepseek-v4-pro", 0) == 1_000_000, "0 means auto-detect"


# ---------------------------------------------------------------------------
# record_usage_stats -- measured vs estimated
# ---------------------------------------------------------------------------


async def test_no_usage_object_at_all_still_writes_nothing():
    """"Nothing to record" and "nobody measured it" are different states.

    A caller with no usage object made no measurable call (or could not parse one);
    only a caller that HAS a number — measured or estimated — has something to say.
    """
    store = Store()

    await record_usage_stats(store, "room", None, model="deepseek-chat")
    await record_usage_stats(store, "room", Usage(), model="deepseek-chat")

    assert await store.state_get("room", "usage_stats") is None


async def test_an_estimated_reading_is_stored_labelled_and_kept_out_of_the_totals():
    store = Store()

    await record_usage_stats(
        store, "room", Usage(prompt_tokens=4_000, total_tokens=4_000, estimated=True), model="deepseek-chat"
    )

    stats = json.loads(await store.state_get("room", "usage_stats"))
    assert stats["last"]["prompt"] == 4_000 and stats["last"]["estimated"] is True
    assert stats["session"]["turns"] == 0 and stats["session"]["prompt"] == 0
