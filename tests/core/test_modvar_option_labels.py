"""Protocol 2.5: an enum variable's options can carry display names (`option_labels`).

The VALUE stays the raw option id everywhere — conditions, hooks, `.var set` and the
Keeper speak ids — and the wire entry gains `value_label`, the name of the CURRENT option,
resolved by the same fallback as the variable's own `label` (exact language → en → any).
On the card side the field is tolerant, like `labels`: junk is dropped with a warning and
the variable is kept.
"""

from __future__ import annotations

import json

import pytest

from core.lorecard import LORECARD_FORMAT, parse_lorecard_bytes
from core.modvars import (
    MAX_LABEL_LEN,
    apply_define,
    apply_set,
    build_spec,
    empty_state,
    normalize_spec,
    normalize_state,
    option_label_for,
    wire_entries,
)

COLUMN_LABELS = {
    "zh": {"waiting": "未成形", "marching": "在道上"},
    "en": {"waiting": "Not yet formed", "marching": "On the road", "done": "Done"},
}


def _column_spec(**overrides):
    kwargs = {
        "labels": {"en": "Column", "zh": "纵队"},
        "options": ["waiting", "forming", "marching", "done"],
        "option_labels": COLUMN_LABELS,
    }
    kwargs.update(overrides)
    return build_spec("column_state", "enum", **kwargs)


def _wire(spec, value, locale):
    state = apply_define(empty_state(), spec)
    state, _old, _new = apply_set(state, spec["id"], value)
    return wire_entries(state, locale)[0]


# --- spec building -----------------------------------------------------------------


def test_option_labels_are_stored_locale_first_on_the_canonical_option():
    spec = build_spec(
        "mood",
        "enum",
        options=["Calm", "Tense"],
        option_labels={"zh-CN": {"calm": " 平静 ", "TENSE": "紧张"}, "EN": {"Calm": "Calm"}},
    )
    # Locale keys normalize like `labels`; option keys land on the canonical option.
    assert spec["option_labels"] == {"zh": {"Calm": "平静", "Tense": "紧张"}, "en": {"Calm": "Calm"}}


def test_option_label_text_is_capped_like_a_variable_label():
    spec = build_spec("mood", "enum", options=["calm"], option_labels={"en": {"calm": "x" * 200}})
    assert spec["option_labels"]["en"]["calm"] == "x" * MAX_LABEL_LEN


def test_junk_inside_option_labels_is_dropped_not_fatal():
    spec = build_spec(
        "mood",
        "enum",
        options=["calm", "tense"],
        option_labels={
            "en": {"calm": "Calm", "panicked": "not an option", "tense": ""},
            "zh": {"calm": 5},
            "fr": "not a mapping",
            7: {"calm": "bad locale"},
        },
    )
    assert spec["option_labels"] == {"en": {"calm": "Calm"}}


def test_a_spec_without_option_labels_keeps_its_exact_stored_shape():
    spec = build_spec("mood", "enum", options=["calm"], option_labels={"en": {"nope": "x"}})
    assert "option_labels" not in spec
    assert "option_labels" not in build_spec("mood", "enum", options=["calm"])


def test_the_strict_define_path_refuses_option_labels_on_a_non_enum():
    with pytest.raises(ValueError, match="option_labels only apply to the enum kind"):
        build_spec("doom", "number", option_labels={"en": {"1": "one"}})


def test_stored_state_keeps_option_labels_and_tolerantly_drops_them_from_a_non_enum():
    spec = _column_spec()
    assert normalize_spec(spec["id"], json.loads(json.dumps(spec))) == spec
    text = normalize_spec("note", {"kind": "text", "option_labels": {"en": {"a": "A"}}})
    assert text is not None and "option_labels" not in text
    state = normalize_state({"specs": {"column_state": spec}, "values": {"column_state": "marching"}})
    assert state["specs"]["column_state"]["option_labels"] == spec["option_labels"]


# --- wire: value_label ----------------------------------------------------------------


def test_value_label_names_the_current_option_and_value_stays_the_id():
    entry = _wire(_column_spec(), "marching", "zh")
    assert entry["value"] == "marching"
    assert entry["value_label"] == "在道上"
    assert entry["label"] == "纵队"
    assert _wire(_column_spec(), "marching", "en")["value_label"] == "On the road"


def test_value_label_falls_back_like_the_variable_label():
    # zh has no name for `done`: English is next, exactly as `label_for` falls back.
    assert _wire(_column_spec(), "done", "zh")["value_label"] == "Done"
    # A locale with no table at all: exact → en → any.
    assert _wire(_column_spec(), "marching", "fr")["value_label"] == "On the road"
    only_zh = _column_spec(option_labels={"zh": {"marching": "在道上"}})
    assert _wire(only_zh, "marching", "en")["value_label"] == "在道上"


def test_value_label_is_absent_when_no_language_names_the_option():
    entry = _wire(_column_spec(), "forming", "zh")
    assert entry["value"] == "forming"
    assert "value_label" not in entry
    assert "value_label" not in _wire(build_spec("mood", "enum", options=["calm"]), "calm", "en")


def test_non_enum_kinds_never_carry_value_label():
    spec = build_spec("doom", "number", minimum=0, maximum=10)
    spec["option_labels"] = {"en": {"3": "three"}}  # a hand-edited store cannot smuggle one in
    assert option_label_for(spec, 3, "en") is None
    state = apply_define(empty_state(), spec)
    state, _old, _new = apply_set(state, "doom", 3)
    assert "value_label" not in wire_entries(state, "en")[0]


# --- lorecard: option_labels parse ------------------------------------------------------


def _card(variables) -> bytes:
    return json.dumps(
        {"format": LORECARD_FORMAT, "format_version": 1, "name": "Column", "variables": variables},
        ensure_ascii=False,
    ).encode("utf-8")


def test_lorecard_carries_option_labels_into_the_spec():
    card = parse_lorecard_bytes(
        _card(
            [
                {
                    "id": "column_state",
                    "kind": "enum",
                    "labels": {"zh": "纵队"},
                    "options": ["waiting", "marching"],
                    "option_labels": {"zh": {"waiting": "未成形", "marching": "在道上"}},
                }
            ]
        )
    )
    assert card.warnings == ()
    assert card.variable_specs[0]["option_labels"] == {"zh": {"waiting": "未成形", "marching": "在道上"}}


@pytest.mark.parametrize(
    ("variable", "fragment"),
    [
        (
            {"id": "c", "kind": "enum", "options": ["a"], "option_labels": {"en": {"zz": "unknown option"}}},
            "1 label(s) dropped",
        ),
        (
            {"id": "c", "kind": "enum", "options": ["a"], "option_labels": {"en": {"a": 5}}},
            "1 label(s) dropped",
        ),
        (
            {"id": "c", "kind": "enum", "options": ["a"], "option_labels": {"en": "not a mapping"}},
            "1 label(s) dropped",
        ),
        (
            {"id": "c", "kind": "enum", "options": ["a"], "option_labels": ["a"]},
            "must map a locale",
        ),
        (
            {"id": "c", "kind": "text", "option_labels": {"en": {"a": "A"}}},
            "only an enum variable names its options",
        ),
    ],
    ids=["unknown-option", "non-text-label", "non-mapping-locale", "not-a-mapping", "non-enum"],
)
def test_lorecard_option_labels_are_tolerant_dropped_with_a_warning(variable, fragment):
    card = parse_lorecard_bytes(_card([variable]))
    # The variable itself always survives — tolerant, like `labels`.
    assert [spec["id"] for spec in card.variable_specs] == ["c"]
    assert "option_labels" not in card.variable_specs[0]
    assert len(card.warnings) == 1 and fragment in card.warnings[0]
    assert card.warnings[0].startswith("variables[0].option_labels")
