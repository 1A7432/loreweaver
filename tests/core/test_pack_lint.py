"""`core.pack_lint` — the advisory pack lint.

One CLEAN bilingual pack that must produce no finding at all, then one mutation per
test: each finding is asserted against the single mistake that causes it, and each
"steps aside" rule against the runtime evidence that makes the mistake uncertain. A lint
that reports a correct pack is worse than no lint, so the silent cases are tests too.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from core.pack import MANIFEST_NAME, PackError, build_pack
from core.pack_lint import MESSAGE_KEY_PREFIX, MESSAGE_KEYS, LintFinding, lint_pack
from infra.i18n import get_i18n

EN = get_i18n("en")
ZH = get_i18n("zh")

MANIFEST = """\
id: harbour-bell
version: 0.1.0
name: {en: Harbour Bell, zh: 港钟}
description: {en: A short mystery., zh: 一桩短案。}
authors: [ada]
license: MIT
engine: {}
contents:
  skills: [skills/bell-keeper]
  cards: [cards/harbour.lorecard.json]
  panels: [ui/panels.yaml]
"""

SKILL_MD = """---
name: Bell Keeper
description: Runs the harbour.
---
Advance the tide when the party rests.
"""


def _lorecard() -> dict[str, Any]:
    return {
        "format": "loreweaver.card",
        "format_version": 1,
        "name": "Harbour",
        "description": "A fishing town.",
        "worldbook": [
            {"title": "The bell", "keys": ["bell"], "content": "It rings at low tide."},
            {"title": "The wreck", "keys": ["wreck"], "content": "Visible at dusk.", "condition": "tide >= 3"},
            {"title": "House rules", "constant": True, "content": "Roll in the open."},
        ],
        "variables": [
            {"id": "tide", "kind": "number", "default": 0, "minimum": 0, "maximum": 9,
             "labels": {"en": "Tide", "zh": "潮位"}},
            {"id": "suspicion", "kind": "number", "default": 0, "minimum": 0, "maximum": 9,
             "visibility": "keeper", "labels": {"en": "Suspicion", "zh": "嫌疑"}},
        ],
        "hooks": ["on('turn_end', () => { if (getvar('suspicion') > 5) narrate('eyes follow you'); });"],
    }


PANELS = """\
panels:
  - id: status
    title: {en: Status, zh: 状态}
    slot: sidebar
    blocks:
      - {kind: stat, label: {en: Tide, zh: 潮位}, value: {$var: tide}}
      - {kind: text, text: {en: The water is high., zh: 水涨了。}, visible_when: "tide >= 5"}
"""


def _source(
    root: Path,
    *,
    manifest: str = MANIFEST,
    card: dict[str, Any] | None = None,
    panels: str = PANELS,
    skill: str = SKILL_MD,
) -> Path:
    src = root / "src"
    (src / "skills/bell-keeper").mkdir(parents=True)
    (src / "skills/bell-keeper/SKILL.md").write_text(skill, encoding="utf-8")
    (src / "cards").mkdir()
    (src / "cards/harbour.lorecard.json").write_text(
        json.dumps(card or _lorecard(), ensure_ascii=False), encoding="utf-8"
    )
    (src / "ui").mkdir()
    (src / "ui/panels.yaml").write_text(panels, encoding="utf-8")
    (src / MANIFEST_NAME).write_text(manifest, encoding="utf-8")
    return src


def _codes(findings: list[LintFinding]) -> list[str]:
    return [finding.code for finding in findings]


def _only(findings: list[LintFinding], code: str) -> LintFinding:
    assert _codes(findings) == [code], [finding.render(EN) for finding in findings]
    return findings[0]


# --- the silent case --------------------------------------------------------


def test_a_correct_pack_has_no_findings(tmp_path):
    src = _source(tmp_path)
    assert lint_pack(src) == []
    # ...and it is a pack the real build accepts, so "clean" means clean of a real pack.
    assert build_pack(src, tmp_path / "out.lwpack").warnings == ()


def test_no_manifest_is_an_error_not_a_finding(tmp_path):
    with pytest.raises(PackError, match="no pack.yaml"):
        lint_pack(tmp_path)


def test_a_file_that_does_not_parse_is_reported_and_the_rest_still_lints(tmp_path):
    card = _lorecard()
    card["variables"][0]["labels"] = {"en": "Tide"}
    src = _source(tmp_path, card=card, panels="panels: [not a panel]\n")
    findings = lint_pack(src)
    assert _codes(findings) == ["unreadable", "locale-gap"]
    assert findings[0].where == "ui/panels.yaml"


# --- panels -----------------------------------------------------------------


def test_panel_bound_to_a_keeper_variable_is_never_drawn(tmp_path):
    panels = PANELS + "      - {kind: stat, label: {en: Heat, zh: 嫌疑}, value: {$var: suspicion}}\n"
    finding = _only(lint_pack(_source(tmp_path, panels=panels)), "panel-var-keeper-only")
    assert finding.where == "ui/panels.yaml: panels[status].blocks[2].value"
    assert "'suspicion'" in finding.message(EN)


def test_keeper_audience_does_not_rescue_a_keeper_variable(tmp_path):
    # The trap the flagship pack itself fell into: `audience: keeper` decides who gets
    # the PANEL, not which variables reach the screen — keeper-visibility trackers ride
    # no state frame at all, the admin's included.
    panels = """\
panels:
  - id: gauges
    title: {en: Gauges, zh: 仪表}
    slot: sidebar
    audience: keeper
    blocks:
      - {kind: stat, label: {en: Tide, zh: 潮位}, value: {$var: tide}}
      - {kind: stat, label: {en: Heat, zh: 嫌疑}, value: {$var: suspicion}}
"""
    _only(lint_pack(_source(tmp_path, panels=panels)), "panel-var-keeper-only")


def test_visible_when_over_a_keeper_variable_is_reported_as_a_gate(tmp_path):
    panels = PANELS.replace('visible_when: "tide >= 5"', 'visible_when: "suspicion >= 5"')
    finding = _only(lint_pack(_source(tmp_path, panels=panels)), "panel-var-keeper-only")
    assert finding.where.endswith(".visible_when")
    assert finding.key == "panel-var-keeper-only.gate"
    assert "as if 'suspicion' were unset" in finding.message(EN)


def test_panel_bound_to_an_undeclared_variable(tmp_path):
    panels = PANELS.replace("{$var: tide}", "{$var: tyde}")
    findings = lint_pack(_source(tmp_path, panels=panels))
    assert _codes(findings) == ["panel-var-unknown"]
    assert "'tyde'" in findings[0].message(EN)


def test_a_variable_the_skill_or_a_hook_names_may_exist_at_runtime(tmp_path):
    # The Keeper can define a tracker at the table because the skill told it to; a hook
    # can write one into the tree. Neither is "undeclared" in any way the lint can know.
    panels = PANELS + "      - {kind: stat, label: {en: Omens, zh: 征兆}, value: {$var: omens}}\n"
    skill = SKILL_MD + "At the first death, define a number tracker `omens` and raise it by one.\n"
    assert lint_pack(_source(tmp_path, panels=panels, skill=skill)) == []


def test_repeat_over_a_prefix_no_player_variable_carries(tmp_path):
    panels = PANELS + (
        "      - repeat:\n"
        "          prefix: clue_\n"
        "          block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}\n"
    )
    finding = _only(lint_pack(_source(tmp_path, panels=panels)), "panel-repeat-empty")
    assert "'clue_'" in finding.message(EN)

    card = _lorecard()
    card["variables"].append({"id": "clue_ledger", "kind": "bool", "labels": {"en": "Ledger", "zh": "账本"}})
    assert lint_pack(_source(tmp_path / "ok", card=card, panels=panels)) == []


def test_a_short_repeat_prefix_is_one_string_prefix_over_native_ids(tmp_path):
    # `m` is also a prefix of `mvu.` — it must still be judged against the native ids
    # this pack actually has, not mistaken for a reach into an imported tree.
    panels = PANELS + (
        "      - repeat:\n"
        "          prefix: t\n"
        "          block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}\n"
    )
    assert lint_pack(_source(tmp_path, panels=panels)) == []
    _only(lint_pack(_source(tmp_path / "m", panels=panels.replace("prefix: t\n", "prefix: m\n"))), "panel-repeat-empty")


# --- imported-card variables ------------------------------------------------

ST_CARD = {
    "spec": "chara_card_v2",
    "data": {
        "name": "Estate",
        "description": "The estate itself.",
        "character_book": {
            "entries": [
                {"comment": "[InitVar]", "content": '{"config": {"difficulty": "standard"}, "clock": {"day": 1}}'},
                {"comment": "Rules", "content": "Clues never lie.", "constant": True},
            ]
        },
    },
}

ST_MANIFEST = """\
id: estate
version: 0.1.0
name: {en: Estate, zh: 庄园}
description: {en: An estate., zh: 一座庄园。}
authors: [ada]
license: MIT
engine: {}
contents:
  cards:
    - path: cards/estate.json
      overlay: cards/estate.overlay.yaml
  panels: [ui/panels.yaml]
"""

ST_PANELS = """\
panels:
  - id: clock
    title: {en: Clock, zh: 时钟}
    slot: sidebar
    blocks:
      - {kind: stat, label: {en: Day, zh: 日}, value: {$var: mvu.clock.day}}
"""


def _st_source(root: Path, *, overlay: str, panels: str = ST_PANELS, card: dict[str, Any] | None = None) -> Path:
    src = root / "st"
    (src / "cards").mkdir(parents=True)
    (src / "cards/estate.json").write_text(json.dumps(card or ST_CARD), encoding="utf-8")
    (src / "cards/estate.overlay.yaml").write_text(overlay, encoding="utf-8")
    (src / "ui").mkdir()
    (src / "ui/panels.yaml").write_text(panels, encoding="utf-8")
    (src / MANIFEST_NAME).write_text(ST_MANIFEST, encoding="utf-8")
    return src


_OVERLAY_HEAD = "format: loreweaver.lore-overlay/1\n"


def test_imported_leaf_exposed_by_the_overlay_is_clean(tmp_path):
    src = _st_source(tmp_path, overlay=_OVERLAY_HEAD + "expose: [clock]\n")
    assert lint_pack(src) == []
    assert build_pack(src, tmp_path / "out.lwpack").warnings == ()


def test_imported_leaf_nothing_exposes_renders_blank_for_players(tmp_path):
    finding = _only(lint_pack(_st_source(tmp_path, overlay=_OVERLAY_HEAD)), "panel-var-unexposed")
    assert "'clock.day'" in finding.message(EN)
    assert ".var expose" in finding.message(EN)


def test_imported_leaf_that_is_not_in_the_tree(tmp_path):
    panels = ST_PANELS.replace("mvu.clock.day", "mvu.clock.dya")
    src = _st_source(tmp_path, overlay=_OVERLAY_HEAD + "expose: [clock]\n", panels=panels)
    _only(lint_pack(src), "panel-var-unknown")


def test_bare_id_that_is_really_an_imported_leaf_gets_the_spelling_hint(tmp_path):
    panels = ST_PANELS.replace("mvu.clock.day", "clock.day")
    src = _st_source(tmp_path, overlay=_OVERLAY_HEAD + "expose: [clock]\n", panels=panels)
    finding = _only(lint_pack(src), "panel-var-unknown")
    assert "'mvu.clock.day'" in finding.message(EN)


def test_a_foreign_cards_extension_blobs_are_not_read_as_translations(tmp_path):
    card = json.loads(json.dumps(ST_CARD))
    card["data"]["extensions"] = {"some_tool": {"greeting": {"en": "hello"}}}
    src = _st_source(tmp_path, overlay=_OVERLAY_HEAD + "expose: [clock]\n", card=card)
    assert lint_pack(src) == []


def test_overlay_exposing_a_prefix_the_tree_lacks(tmp_path):
    src = _st_source(tmp_path, overlay=_OVERLAY_HEAD + "expose: [clock, klock]\n")
    finding = _only(lint_pack(src), "overlay-expose-unknown")
    assert finding.where == "cards/estate.overlay.yaml: expose"
    assert "'klock'" in finding.message(EN)


def test_an_unreadable_initvar_block_turns_the_tree_checks_off(tmp_path):
    # The static parser could not read the declaration, so "this leaf does not exist" is
    # no longer something the lint knows. Exposure is still certain, and still reported.
    card = json.loads(json.dumps(ST_CARD))
    card["data"]["character_book"]["entries"][0]["content"] = "<%- not a tree at all %>"
    src = _st_source(tmp_path, overlay=_OVERLAY_HEAD + "expose: [klock]\n", card=card)
    _only(lint_pack(src), "panel-var-unexposed")


# --- variables --------------------------------------------------------------


def test_variable_nothing_mentions(tmp_path):
    card = _lorecard()
    card["variables"].append({"id": "weather", "kind": "number", "labels": {"en": "Weather", "zh": "天气"}})
    finding = _only(lint_pack(_source(tmp_path, card=card)), "var-unused")
    assert finding.where == "cards/harbour.lorecard.json: variables[weather]"


@pytest.mark.parametrize(
    "mention",
    [
        "Raise `weather` by one each dawn.",  # by id
        "每到黎明把「天气」加一。",  # by its label, which is how a skill usually speaks
    ],
)
def test_variable_the_skill_talks_about_is_used(tmp_path, mention):
    card = _lorecard()
    card["variables"].append({"id": "weather", "kind": "number", "labels": {"en": "Weather", "zh": "天气"}})
    assert lint_pack(_source(tmp_path, card=card, skill=SKILL_MD + mention + "\n")) == []


def test_an_ascii_id_is_not_mentioned_by_a_longer_word(tmp_path):
    card = _lorecard()
    card["variables"].append({"id": "day", "kind": "number", "labels": {"en": "Daycount", "zh": "日数"}})
    skill = SKILL_MD + "Today the birthday party ends.\n"
    _only(lint_pack(_source(tmp_path, card=card, skill=skill)), "var-unused")


def test_setup_variable_is_read_by_the_setup_flow(tmp_path):
    card = _lorecard()
    card["variables"].append(
        {"id": "difficulty", "kind": "enum", "options": ["easy", "hard"], "setup": True,
         "labels": {"en": "Difficulty", "zh": "难度"},
         "option_labels": {"en": {"easy": "Easy", "hard": "Hard"}, "zh": {"easy": "轻松", "hard": "残酷"}}}
    )
    assert lint_pack(_source(tmp_path, card=card)) == []


# --- lore -------------------------------------------------------------------


def test_live_entry_with_no_keyword_and_not_always_on(tmp_path):
    card = _lorecard()
    card["worldbook"].append({"title": "The cellar", "keys": ["  "], "content": "Damp."})
    finding = _only(lint_pack(_source(tmp_path, card=card)), "lore-no-keys")
    assert finding.where == "cards/harbour.lorecard.json: entry 'The cellar'"


def test_a_parked_entry_is_not_judged(tmp_path):
    card = _lorecard()
    card["worldbook"].append({"title": "The cellar", "content": "Damp.", "enabled": False})
    assert lint_pack(_source(tmp_path, card=card)) == []


def test_probability_zero_never_fires(tmp_path):
    card = _lorecard()
    card["worldbook"][0]["probability"] = 0
    _only(lint_pack(_source(tmp_path, card=card)), "lore-never-fires")


def test_condition_over_a_variable_nothing_declares(tmp_path):
    card = _lorecard()
    card["worldbook"][1]["condition"] = "variables.tyde >= 3"
    finding = _only(lint_pack(_source(tmp_path, card=card)), "lore-condition-unknown-var")
    assert "'tyde'" in finding.message(EN)


def test_condition_over_a_keeper_variable_is_fine(tmp_path):
    # Lore is selected keeper-side against the full variable state; only screens are
    # limited to the player set.
    card = _lorecard()
    card["worldbook"][1]["condition"] = "suspicion >= 3"
    assert lint_pack(_source(tmp_path, card=card)) == []


def test_native_parser_notes_are_surfaced(tmp_path):
    card = _lorecard()
    card["worldbook"].append({"title": "Blank", "keys": ["x"], "content": "   "})
    finding = _only(lint_pack(_source(tmp_path, card=card)), "card-note")
    assert "empty content" in finding.message(EN)


# --- locale gaps ------------------------------------------------------------


def test_bilingual_pack_with_a_one_sided_label(tmp_path):
    panels = PANELS.replace("label: {en: Tide, zh: 潮位}", "label: {en: Tide}")
    finding = _only(lint_pack(_source(tmp_path, panels=panels)), "locale-gap")
    assert finding.where == "ui/panels.yaml: panels[status].blocks[0].label"
    assert "en only" in finding.message(EN)


def test_a_bare_string_is_the_same_everywhere_not_a_gap(tmp_path):
    panels = PANELS.replace("label: {en: Tide, zh: 潮位}", "label: HP")
    assert lint_pack(_source(tmp_path, panels=panels)) == []


def test_single_language_pack_has_no_locale_gaps(tmp_path):
    manifest = MANIFEST.replace("name: {en: Harbour Bell, zh: 港钟}", "name: {zh: 港钟}")
    panels = PANELS.replace("label: {en: Tide, zh: 潮位}", "label: {zh: 潮位}")
    assert lint_pack(_source(tmp_path, manifest=manifest, panels=panels)) == []


def test_option_labels_missing_one_option_in_one_language(tmp_path):
    card = _lorecard()
    card["variables"].append(
        {"id": "difficulty", "kind": "enum", "options": ["easy", "hard"], "setup": True,
         "labels": {"en": "Difficulty", "zh": "难度"},
         "option_labels": {"en": {"easy": "Easy", "hard": "Hard"}, "zh": {"easy": "轻松"}}}
    )
    finding = _only(lint_pack(_source(tmp_path, card=card)), "locale-gap")
    assert finding.where == "cards/harbour.lorecard.json: variables[difficulty].option_labels.hard"


def test_finding_serializes_for_tools():
    finding = LintFinding("locale-gap", "pack.yaml: name", "locale-gap", {"present": "en", "missing": "zh"})
    assert finding.render(EN) == "pack.yaml: name: written in en only — a zh viewer is shown the other language [locale-gap]"
    assert finding.to_dict(ZH) == {
        "code": "locale-gap",
        "where": "pack.yaml: name",
        "message": "只写了 en——用 zh 的玩家看到的是另一种语言",
    }


def test_every_message_key_is_in_both_catalogs_and_nothing_else_is(tmp_path):
    """A finding must never reach an author as a raw key, in either language — and a
    catalog entry no code can emit is a translation someone maintains for nothing."""
    import json as _json

    from infra.i18n import _REPO_ROOT

    for locale in ("en", "zh"):
        catalog = _json.loads((_REPO_ROOT / "locales" / locale / "pack_lint.json").read_text(encoding="utf-8"))
        assert set(catalog) == {MESSAGE_KEY_PREFIX + key for key in MESSAGE_KEYS}, locale
    # The code of a finding is its key up to the first dot — what tools filter on.
    assert {key.split(".", 1)[0] for key in MESSAGE_KEYS} >= {"panel-var-keeper-only", "lore-no-keys", "locale-gap"}


def test_messages_fill_every_placeholder_in_both_languages(tmp_path):
    """Render every finding the fixtures above can produce in both locales: a template
    whose placeholder the code never passes would surface as literal braces."""
    card = _lorecard()
    card["worldbook"][0]["probability"] = 0
    card["worldbook"][1]["condition"] = "variables.tyde >= 3"
    card["worldbook"].append({"title": "Cellar", "keys": [], "content": "Damp."})
    card["worldbook"].append({"title": "Blank", "keys": ["x"], "content": " "})
    card["variables"].append({"id": "weather", "kind": "number", "labels": {"en": "Weather"}})
    panels = PANELS + (
        "      - {kind: stat, label: {en: Heat, zh: 嫌疑}, value: {$var: suspicion}}\n"
        "      - {kind: stat, label: {en: X, zh: 某}, value: {$var: tyde}, visible_when: \"suspicion > 1 && nope\"}\n"
        "      - repeat:\n"
        "          prefix: clue_\n"
        "          block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}\n"
    )
    findings = lint_pack(_source(tmp_path / "native", card=card, panels=panels))
    st_panels = ST_PANELS + (
        "      - {kind: stat, label: {en: D, zh: 难}, value: {$var: mvu.config.difficulty}, visible_when: \"mvu.config.x\"}\n"
        "      - {kind: stat, label: {en: D, zh: 难}, value: {$var: config.difficulty}}\n"
        "      - {kind: stat, label: {en: D, zh: 难}, value: {$var: mvu.nope}, visible_when: \"mvu.clock.day > 1\"}\n"
        "      - repeat:\n"
        "          prefix: mvu.config\n"
        "          block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}\n"
    )
    findings += lint_pack(_st_source(tmp_path, overlay=_OVERLAY_HEAD + "expose: [klock]\n", panels=st_panels))
    findings += lint_pack(_source(tmp_path / "broken", panels="panels: [nope]\n"))
    seen = {finding.key for finding in findings}
    # Everything but the one shape no fixture above builds.
    assert seen == set(MESSAGE_KEYS) - {"lore-never-fires.secondary"}, sorted(set(MESSAGE_KEYS) - seen)
    for finding in findings:
        for i18n in (EN, ZH):
            text = finding.message(i18n)
            assert "{" not in text.replace("{{", "") or finding.key in {"unreadable", "card-note"}, (finding.key, text)
            assert not text.startswith(MESSAGE_KEY_PREFIX)
