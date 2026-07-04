"""Tests for infra.llm.parse_usage/context_window_for: the best-effort,
provider-agnostic token/cache usage parser that backs the TUI's status-bar
context%/cache% meter (see gateway.turn._record_usage_stats and
net.state.build_room_state). Every raw shape is stubbed with
`types.SimpleNamespace`/dicts -- no network, no real SDK objects.
"""

from __future__ import annotations

from types import SimpleNamespace

from infra.llm import context_window_for, parse_usage

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


def test_parse_usage_anthropic_shape_no_caching():
    raw = SimpleNamespace(
        usage=SimpleNamespace(input_tokens=300, output_tokens=40, cache_read_input_tokens=0, cache_creation_input_tokens=0)
    )

    usage = parse_usage(raw)

    assert usage.prompt_tokens == 300
    assert usage.cache_hit_tokens == 0
    # No cache activity at all (read==creation==0, and this codebase never sends cache_control):
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
    assert context_window_for("deepseek-chat") == 65536
    assert context_window_for("gpt-4o-mini") == 128000
    assert context_window_for("gpt-4.1") == 128000
    assert context_window_for("o1-preview") == 128000
    assert context_window_for("o3-mini") == 128000
    assert context_window_for("gpt-5") == 256000
    assert context_window_for("claude-opus-4-5") == 200000
    assert context_window_for("gemini-2.5-pro") == 1000000


def test_context_window_for_is_case_insensitive():
    assert context_window_for("DeepSeek-Chat") == 65536
    assert context_window_for("Claude-3-Opus") == 200000


def test_context_window_for_unknown_model_defaults():
    assert context_window_for("some-custom-local-model") == 128000
    assert context_window_for("") == 128000
