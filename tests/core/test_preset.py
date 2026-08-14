"""Tests for core.preset — the SillyTavern completion-preset (预设) parser/normalizer:
the dual enable matrix, the 8 marker anchors, sampler extraction, macro counting, and the
segment fold the prompt builder consumes.

Fixtures are synthetic but modeled on the real distribution shape these files have (a
250-prompt pool, ~2/3 disabled, a stale 100000 order group ahead of the live 100001 one,
markers that wrongly carry content, dense variable macros). No third-party preset is
committed."""

from __future__ import annotations

import json

import pytest

from core.preset import (
    MARKER_SLOTS,
    MAX_PRESET_BYTES,
    MAX_PROMPT_CONTENT_CHARS,
    MAX_PROMPTS,
    MAX_STYLE_CHARS,
    PresetPrompt,
    effective_prompts,
    macro_report,
    parse_st_preset,
    resolve_order_group,
    style_segments,
)

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


def _preset_dict() -> dict:
    return {
        "temperature": 1.3,
        "top_p": 0.95,
        "top_k": 40,
        "top_a": 0.12,
        "min_p": 0.05,
        "frequency_penalty": 0.4,
        "presence_penalty": 0.6,
        "repetition_penalty": 1.07,
        "seed": -1,
        "n": 1,
        "openai_max_tokens": 8192,
        "openai_max_context": 128000,
        # ST-only junk keys: carried as names, never stored.
        "wi_format": "{0}",
        "impersonation_prompt": "impersonation text",
        "names_behavior": 0,
        "prompts": [
            {
                "identifier": "main",
                "name": "Main",
                "role": "system",
                "system_prompt": True,
                "content": "Core rules. {{getvar::mood}} Speak as {{char}}.",
                "enabled": True,
                "marker": False,
                "injection_position": 0,
                "injection_depth": 4,
                "forbid_overrides": False,
            },
            {"identifier": "charDescription", "name": "Char Description", "marker": True, "content": ""},
            # A marker that (wrongly) carries content — must never leak as prompt text.
            {"identifier": "worldInfoBefore", "name": "World Info", "marker": True, "content": "SHOULD NOT LEAK"},
            # A marker outside the 8 standard slots.
            {"identifier": "customAnchor", "name": "Weird marker", "marker": True, "content": ""},
            # Matrix disagreement, direction A: pool says off, order says on.
            {"identifier": "prompt-off", "content": "PROMPT LAYER OFF {{setvar::x::1}}", "enabled": False},
            # Matrix disagreement, direction B: pool says on, order says off.
            {"identifier": "order-off", "content": "ORDER LAYER OFF", "enabled": True},
            # Numeric identifier — stringified on both sides of the matrix.
            {"identifier": 12345, "name": "Numbered", "content": "Numbered entry."},
            # Every optional field missing: ST defaults apply.
            {"identifier": "sparse", "content": "Sparse survives. {{getvar::day}}"},
            {
                "identifier": "depth-one",
                "name": "User nudge",
                "role": "user",
                "content": "Continue. {{random::a,b,c}}",
                "injection_position": 1,
                "injection_depth": 1,
                "injection_order": 100,
            },
            # In the pool, never referenced by the order list.
            {"identifier": "pool-only", "content": "NEVER IN ORDER {{noop}}"},
            # Entry-level junk: no identifier, and not an object at all.
            {"name": "broken", "content": "MALFORMED"},
            "not-an-object",
            # Duplicate identifier: the first `main` wins.
            {"identifier": "main", "content": "DUPLICATE MAIN"},
        ],
        "prompt_order": [
            # Stale legacy group — 100001 must win over it.
            {"character_id": 100000, "order": [{"identifier": "main", "enabled": False}]},
            {
                "character_id": 100001,
                "order": [
                    {"identifier": "main", "enabled": True},
                    {"identifier": "worldInfoBefore", "enabled": True},
                    {"identifier": "charDescription", "enabled": True},
                    {"identifier": "prompt-off", "enabled": True},
                    {"identifier": "order-off", "enabled": False},
                    {"identifier": 12345, "enabled": True},
                    {"identifier": "customAnchor", "enabled": True},
                    {"identifier": "sparse", "enabled": True},
                    {"identifier": "depth-one", "enabled": True},
                    {"identifier": "ghost", "enabled": True},
                ],
            },
        ],
        "extensions": {"regex_scripts": [{"scriptName": "smooth"}, {"scriptName": "trim"}], "tavern_helper": {"v": 3}},
    }


def _parsed(**overrides):
    data = _preset_dict()
    data.update(overrides)
    return parse_st_preset(json.dumps(data), "duo")


def _warned(preset, needle: str) -> bool:
    return any(needle in warning for warning in preset.warnings)


def _by_id(preset) -> dict[str, PresetPrompt]:
    return {prompt.identifier: prompt for prompt in preset.prompts}


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def test_parses_pool_with_defaults_and_injection_fields():
    preset = _parsed()
    assert preset.name == "duo"
    pool = _by_id(preset)
    # 13 raw entries − 2 unusable − 1 duplicate.
    assert len(preset.prompts) == 10
    assert "12345" in pool  # numeric identifier stringified

    sparse = pool["sparse"]
    assert (sparse.role, sparse.enabled, sparse.marker) == ("system", True, False)
    assert (sparse.injection_position, sparse.injection_depth, sparse.injection_order) == (0, 4, None)

    nudge = pool["depth-one"]
    assert (nudge.role, nudge.injection_position, nudge.injection_depth, nudge.injection_order) == ("user", 1, 1, 100)
    assert pool["main"].system_prompt is True
    assert pool["main"].content.startswith("Core rules.")  # the duplicate never overwrote it
    assert _warned(preset, "duplicate identifier 'main'")


def test_markers_are_anchors_with_resolved_slots():
    preset = _parsed()
    pool = _by_id(preset)
    assert pool["charDescription"].slot == "charDescription"
    assert pool["worldInfoBefore"].marker is True
    assert pool["worldInfoBefore"].content == ""  # forced empty on import
    assert _warned(preset, "carried content")
    # A marker outside the 8 is kept, unfillable, and warned about.
    assert pool["customAnchor"].marker is True
    assert pool["customAnchor"].slot is None
    assert _warned(preset, "'customAnchor' is not one of the 8 standard slots")
    # A non-marker entry never claims a slot.
    assert pool["main"].slot is None


def test_entry_level_junk_is_skipped_with_warnings():
    preset = _parsed()
    assert "MALFORMED" not in json.dumps([p.content for p in preset.prompts])
    assert _warned(preset, "has no usable identifier")
    assert _warned(preset, "is not an object")


def test_role_and_content_caps_degrade_with_warnings():
    preset = parse_st_preset(
        json.dumps(
            {
                "prompts": [
                    {"identifier": "a", "role": "narrator", "content": "x", "injection_order": "junk"},
                    {"identifier": "b", "content": "y" * (MAX_PROMPT_CONTENT_CHARS + 500), "injection_depth": -3},
                ],
                "prompt_order": [{"character_id": 100001, "order": [{"identifier": "a"}, {"identifier": "b"}]}],
            }
        ),
        "caps",
    )
    pool = _by_id(preset)
    assert pool["a"].role == "system"
    assert _warned(preset, "unknown role")
    assert len(pool["b"].content) == MAX_PROMPT_CONTENT_CHARS
    assert _warned(preset, "content cap")
    # Unusable numerics fall back rather than coercing to a misleading 0.
    assert pool["a"].injection_order is None
    assert pool["b"].injection_depth == 4
    # A missing `enabled` means enabled, on both matrix layers.
    assert [p.identifier for p in effective_prompts(preset)] == ["a", "b"]


def test_sampling_normalizes_names_and_keeps_unknown_top_level():
    preset = _parsed()
    assert preset.sampling == {
        "temperature": 1.3,
        "top_p": 0.95,
        "top_k": 40,
        "top_a": 0.12,
        "min_p": 0.05,
        "frequency_penalty": 0.4,
        "presence_penalty": 0.6,
        "repetition_penalty": 1.07,
        "seed": -1,
        "n": 1,
        "max_tokens": 8192,
        "max_context": 128000,
    }
    assert preset.unknown_top_level == ("wi_format", "impersonation_prompt", "names_behavior")


def test_unusable_sampling_value_is_warned_and_left_unmapped():
    preset = _parsed(temperature="hot", top_p=True)
    assert "temperature" not in preset.sampling
    assert "top_p" not in preset.sampling
    assert "temperature" in preset.unknown_top_level
    assert _warned(preset, "'temperature' is not a finite number")
    assert _warned(preset, "'top_p' is not a finite number")


def test_extensions_reduce_to_presence_flags():
    preset = _parsed()
    assert (preset.has_regex_scripts, preset.has_tavern_helper) == (True, True)
    assert "extensions" not in preset.unknown_top_level
    assert _warned(preset, "2 SillyTavern regex script(s)")
    assert _warned(preset, "TavernHelper")

    bare = _parsed(extensions={"regex_scripts": []})
    assert (bare.has_regex_scripts, bare.has_tavern_helper) == (False, False)

    broken = _parsed(extensions="nope")
    assert (broken.has_regex_scripts, broken.has_tavern_helper) == (False, False)
    assert "extensions" in broken.unknown_top_level
    assert _warned(broken, "extensions is not an object")


# ---------------------------------------------------------------------------
# The dual enable matrix
# ---------------------------------------------------------------------------


def test_effective_prompts_need_both_layers_and_follow_the_order_list():
    preset = _parsed()
    assert [p.identifier for p in effective_prompts(preset)] == [
        "main",
        "worldInfoBefore",
        "charDescription",
        "12345",
        "customAnchor",
        "sparse",
        "depth-one",
    ]
    live = {p.identifier for p in effective_prompts(preset)}
    assert "prompt-off" not in live  # pool layer said off
    assert "order-off" not in live  # order layer said off
    assert "pool-only" not in live  # never referenced by the order list
    assert _warned(preset, "prompt_order references 'ghost'")


def test_order_group_resolution_prefers_the_live_pseudo_character():
    preset = _parsed()
    assert resolve_order_group(preset).character_id == 100001
    # The stale group is still exposed and addressable — and it disables `main`.
    assert resolve_order_group(preset, 100000).character_id == 100000
    assert effective_prompts(preset, 100000) == ()
    # An unknown character falls back to the global list, exactly as ST does.
    assert resolve_order_group(preset, 4242).character_id == 100001
    assert len(preset.order) == 2


def test_order_group_falls_back_to_the_first_group_without_pseudo_characters():
    preset = parse_st_preset(
        json.dumps(
            {
                "prompts": [{"identifier": "a", "content": "A"}, {"identifier": "b", "content": "B"}],
                "prompt_order": [
                    {"character_id": 7, "order": [{"identifier": "a", "enabled": True}]},
                    {"character_id": 8, "order": [{"identifier": "b", "enabled": True}]},
                ],
            }
        ),
        "plain",
    )
    assert resolve_order_group(preset).character_id == 7
    assert [p.identifier for p in effective_prompts(preset)] == ["a"]
    assert [p.identifier for p in effective_prompts(preset, 8)] == ["b"]


def test_a_pool_without_any_order_list_is_inert():
    preset = parse_st_preset(json.dumps({"prompts": [{"identifier": "a", "content": "A"}]}), "orderless")
    assert resolve_order_group(preset) is None
    assert effective_prompts(preset) == ()
    assert style_segments(preset) == ()
    assert _warned(preset, "no prompt_order")


def test_duplicate_order_refs_resolve_first_ref_wins():
    preset = parse_st_preset(
        json.dumps(
            {
                "prompts": [{"identifier": "a", "content": "A"}],
                "prompt_order": [
                    {
                        "character_id": 100001,
                        "order": [{"identifier": "a", "enabled": False}, {"identifier": "a", "enabled": True}],
                    }
                ],
            }
        ),
        "dupes",
    )
    assert effective_prompts(preset) == ()


# ---------------------------------------------------------------------------
# Macros
# ---------------------------------------------------------------------------


def test_macro_report_counts_effective_content_only():
    preset = _parsed()
    report = macro_report(preset)
    assert report == {"getvar": 2, "char": 1, "random": 1}
    # Ordered by count desc, then name — a stable display order.
    assert list(report) == ["getvar", "char", "random"]
    # Disabled and unordered prompts contribute nothing.
    assert "setvar" not in report
    assert "noop" not in report


def test_macro_report_handles_colon_and_comment_forms():
    preset = parse_st_preset(
        json.dumps(
            {
                "prompts": [{"identifier": "a", "content": "{{roll:1d6}} {{random:a,b}} {{// note}} {{USER}} {{}}"}],
                "prompt_order": [{"character_id": 100001, "order": [{"identifier": "a", "enabled": True}]}],
            }
        ),
        "macros",
    )
    assert macro_report(preset) == {"//": 1, "random": 1, "roll": 1, "user": 1}


# ---------------------------------------------------------------------------
# Folding
# ---------------------------------------------------------------------------


def test_style_segments_collapse_text_and_emit_marker_boundaries():
    preset = _parsed()
    segments = style_segments(preset)
    assert segments == (
        (None, "Core rules. {{getvar::mood}} Speak as {{char}}."),
        ("worldInfoBefore", ""),
        ("charDescription", ""),
        # `customAnchor` is unfillable, so it is dropped rather than splitting the run.
        (None, "Numbered entry.\n\nSparse survives. {{getvar::day}}\n\nContinue. {{random::a,b,c}}"),
    )
    joined = "\n\n".join(text for _, text in segments)
    assert "SHOULD NOT LEAK" not in joined
    assert "PROMPT LAYER OFF" not in joined
    assert "ORDER LAYER OFF" not in joined
    assert "NEVER IN ORDER" not in joined
    assert "DUPLICATE MAIN" not in joined
    # Macros ride along verbatim — the fold expands nothing.
    assert "{{getvar::mood}}" in joined


def test_style_segments_truncate_at_a_prompt_boundary_and_warn():
    chunk = 10_000
    preset = parse_st_preset(
        json.dumps(
            {
                "prompts": [
                    {"identifier": "p1", "content": "a" * chunk},
                    {"identifier": "p2", "content": "b" * chunk},
                    {"identifier": "p3", "content": "c" * chunk},
                    {"identifier": "p4", "content": "d" * chunk},
                    {"identifier": "chatHistory", "marker": True, "content": ""},
                ],
                "prompt_order": [
                    {
                        "character_id": 100001,
                        "order": [{"identifier": name} for name in ("p1", "p2", "p3", "p4", "chatHistory")],
                    }
                ],
            }
        ),
        "big",
    )
    segments = style_segments(preset)
    # Three whole prompts fit (30_000 chars + two "\n\n" joins); the fourth is dropped whole.
    assert segments == (
        (None, "\n\n".join(("a" * chunk, "b" * chunk, "c" * chunk))),
        ("chatHistory", ""),
    )
    assert len(segments[0][1]) <= MAX_STYLE_CHARS
    assert "d" not in segments[0][1]
    assert _warned(preset, f"{MAX_STYLE_CHARS}-char cap")


def test_style_segments_skip_blank_prompts():
    preset = parse_st_preset(
        json.dumps(
            {
                "prompts": [
                    {"identifier": "a", "content": "A"},
                    {"identifier": "blank", "content": "   \n  "},
                    {"identifier": "b", "content": "B"},
                ],
                "prompt_order": [
                    {"character_id": 100001, "order": [{"identifier": i} for i in ("a", "blank", "b")]}
                ],
            }
        ),
        "blanks",
    )
    assert style_segments(preset) == ((None, "A\n\nB"),)


# ---------------------------------------------------------------------------
# Structural failures + caps
# ---------------------------------------------------------------------------


def test_marker_slots_are_the_eight_standard_anchors():
    assert MARKER_SLOTS == (
        "personaDescription",
        "charDescription",
        "charPersonality",
        "scenario",
        "worldInfoBefore",
        "worldInfoAfter",
        "dialogueExamples",
        "chatHistory",
    )
    assert (MAX_PRESET_BYTES, MAX_PROMPTS, MAX_PROMPT_CONTENT_CHARS, MAX_STYLE_CHARS) == (
        2 * 1024 * 1024,
        512,
        64_000,
        32_000,
    )


@pytest.mark.parametrize(
    ("text", "needle"),
    [
        ("not json{", "not valid JSON"),
        ("[1, 2]", "must be a JSON object"),
        ('"a string"', "must be a JSON object"),
        ('{"temperature": 0.5}', "prompts"),
        ('{"prompts": {}}', "prompts"),
        ('{"prompts": []}', "prompts"),
    ],
)
def test_structural_garbage_raises_with_an_actionable_message(text, needle):
    with pytest.raises(ValueError, match=needle):
        parse_st_preset(text, "bad")


def test_oversized_documents_raise():
    padded = json.dumps({"prompts": [{"identifier": "a", "content": "x"}], "pad": "y" * MAX_PRESET_BYTES})
    with pytest.raises(ValueError, match="byte cap"):
        parse_st_preset(padded, "huge")

    crowded = json.dumps(
        {"prompts": [{"identifier": f"p{i}", "content": "x"} for i in range(MAX_PROMPTS + 1)]}
    )
    with pytest.raises(ValueError, match="prompts"):
        parse_st_preset(crowded, "crowded")


def test_a_full_size_pool_imports_and_folds():
    """The real-world shape: every marker slot plus ~250 prompts, roughly 2/3 disabled by
    one layer or the other."""
    prompts: list[dict] = [{"identifier": slot, "marker": True, "content": ""} for slot in MARKER_SLOTS]
    order: list[dict] = [{"identifier": slot, "enabled": True} for slot in MARKER_SLOTS]
    for index in range(242):
        prompts.append(
            {
                "identifier": f"uuid-{index}",
                "content": f"Segment {index}. {{{{getvar::v{index % 7}}}}}",
                "enabled": index % 3 != 1,
            }
        )
        order.append({"identifier": f"uuid-{index}", "enabled": index % 3 != 2})
    preset = parse_st_preset(
        json.dumps({"temperature": 0.9, "prompts": prompts, "prompt_order": [{"character_id": 100001, "order": order}]}),
        "big",
    )
    assert len(preset.prompts) == 250
    # 8 markers + the 81 plain prompts both layers agree on (index ≡ 0 mod 3).
    assert len(effective_prompts(preset)) == 89
    assert macro_report(preset) == {"getvar": 81}
    # Eight marker boundaries, and text runs collapsed between them.
    assert [slot for slot, _ in style_segments(preset) if slot is not None] == list(MARKER_SLOTS)


# ---------------------------------------------------------------------------
# style_bands — the four-band marker→section contract (v1)
# ---------------------------------------------------------------------------


def _banded_preset() -> dict:
    prompts = [
        {"identifier": "opener", "content": "HEAD STYLE.", "enabled": True},
        {"identifier": "charDescription", "content": "", "marker": True},
        {"identifier": "framing", "content": "PRE LORE FRAMING.", "enabled": True},
        {"identifier": "worldInfoBefore", "content": "", "marker": True},
        {"identifier": "worldInfoAfter", "content": "", "marker": True},
        {"identifier": "afterworld", "content": "POST LORE NOTE.", "enabled": True},
        {"identifier": "chatHistory", "content": "", "marker": True},
        {"identifier": "jail", "content": "POST HISTORY COMMAND.", "enabled": True},
    ]
    order = [{"identifier": p["identifier"], "enabled": True} for p in prompts]
    return {"prompts": prompts, "prompt_order": [{"character_id": 100001, "order": order}]}


def test_style_bands_split_at_the_three_honest_anchors():
    from core.preset import style_bands

    bands = style_bands(parse_st_preset(json.dumps(_banded_preset()), "banded"))
    assert bands["head"] == "HEAD STYLE."
    assert bands["pre_lore"] == "PRE LORE FRAMING."
    assert bands["post_lore"] == "POST LORE NOTE."
    assert bands["post_history"] == "POST HISTORY COMMAND."


def test_style_bands_walk_is_monotonic_on_odd_marker_orders():
    from core.preset import style_bands

    raw = _banded_preset()
    # An author who puts worldInfoBefore AFTER chatHistory cannot pull text backwards:
    # the walk only moves forward, so late text stays post_history.
    raw["prompt_order"][0]["order"].append({"identifier": "worldInfoBefore", "enabled": True})
    raw["prompts"].append({"identifier": "tail", "content": "STILL LATE.", "enabled": True})
    raw["prompt_order"][0]["order"].append({"identifier": "tail", "enabled": True})
    bands = style_bands(parse_st_preset(json.dumps(raw), "odd"))
    assert "STILL LATE." in bands["post_history"]


def test_style_bands_without_markers_match_the_v0_single_fold():
    from core.preset import style_bands

    raw = {
        "prompts": [
            {"identifier": "a", "content": "One.", "enabled": True},
            {"identifier": "b", "content": "Two.", "enabled": True},
        ],
        "prompt_order": [
            {"character_id": 100001, "order": [{"identifier": "a", "enabled": True}, {"identifier": "b", "enabled": True}]}
        ],
    }
    bands = style_bands(parse_st_preset(json.dumps(raw), "plain"))
    assert bands["head"] == "One.\n\nTwo."
    assert bands["pre_lore"] == "" and bands["post_lore"] == "" and bands["post_history"] == ""
