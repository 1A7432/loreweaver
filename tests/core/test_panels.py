"""Tests for core.panels — the M15 module-UI-panel schema: author-time strict
validation of `panels.yaml` (Tier-1 template blocks, bindings, repeat, Tier-2
entry/assets/fallback), the server-side audience filter, and wire-manifest shaping."""

from __future__ import annotations

import pytest

from core.panels import (
    MAX_PANEL_BLOCKS,
    MAX_PANELS_PER_PACK,
    audience_allows,
    parse_panels_text,
    wire_panel,
)

TIER1_YAML = """\
panels:
  - id: case-board
    title: {en: Case Board, zh: 案情板}
    slot: sidebar
    audience: all
    blocks:
      - {kind: meter, label: {en: Fear, zh: 恐慌}, value: {$var: town_fear}, min: 0, max: 10}
      - {kind: stat, label: Day, value: {$var: day}}
      - repeat:
          prefix: "mvu.clues."
          block: {kind: badge, label: {$leaf: label}}
      - {kind: choices, options: [{id: go, label: {en: Go}, input: "I go"}]}
"""

TIER2_YAML = """\
panels:
  - id: manor-map
    title: {en: Manor Map, zh: 庄园地图}
    slot: modal
    entry: ui/manor-map/index.html
    assets: [ui/manor-map/index.html, ui/manor-map/app.js, ui/manor-map/map.webp]
    fallback:
      - {kind: text, text: {en: Map in the rich client., zh: 地图请在富客户端查看。}}
"""

ASSET_INFO = {
    "ui/manor-map/index.html": {"sha256": "a" * 64, "size": 120, "mime": "text/html"},
    "ui/manor-map/app.js": {"sha256": "b" * 64, "size": 80, "mime": "text/javascript"},
    "ui/manor-map/map.webp": {"sha256": "c" * 64, "size": 999, "mime": "image/webp"},
}


def test_tier1_parses_with_bindings_repeat_and_defaults():
    (panel,) = parse_panels_text(TIER1_YAML)
    assert (panel.id, panel.tier, panel.slot, panel.audience) == ("case-board", 1, "sidebar", "all")
    assert panel.blocks[0]["value"] == {"$var": "town_fear"}
    assert panel.blocks[2]["repeat"]["prefix"] == "mvu.clues."
    # A plain-string localized field normalizes to an {en: ...} map.
    assert panel.blocks[1]["label"] == {"en": "Day"}


def test_audience_defaults_to_all_and_validates():
    (panel,) = parse_panels_text(TIER2_YAML)
    assert panel.audience == "all"
    with pytest.raises(ValueError, match="audience"):
        parse_panels_text(TIER1_YAML.replace("audience: all", "audience: gm"))


def test_tier2_requires_explicit_fallback_and_entry_in_assets():
    with pytest.raises(ValueError, match="fallback"):
        parse_panels_text(
            "panels:\n"
            "  - id: m\n"
            "    title: {en: M}\n"
            "    slot: modal\n"
            "    entry: ui/m/index.html\n"
            "    assets: [ui/m/index.html]\n"
        )
    # Explicit `fallback: null` is the sanctioned opt-out.
    (panel,) = parse_panels_text(
        "panels:\n"
        "  - id: m\n"
        "    title: {en: M}\n"
        "    slot: modal\n"
        "    entry: ui/m/index.html\n"
        "    assets: [ui/m/index.html]\n"
        "    fallback: null\n"
    )
    assert panel.tier == 2 and panel.fallback is None
    with pytest.raises(ValueError, match="entry document itself"):
        parse_panels_text(TIER2_YAML.replace("assets: [ui/manor-map/index.html, ", "assets: ["))


def test_tier2_assets_must_stay_under_the_entry_directory():
    with pytest.raises(ValueError, match="outside the entry's directory"):
        parse_panels_text(TIER2_YAML.replace("ui/manor-map/app.js", "ui/shared/app.js"))


def test_schema_rejections_are_author_actionable():
    for mutation, needle in (
        (("id: case-board", "id: Case_Board"), "slug"),
        (("slot: sidebar", "slot: popup"), "slot"),
        (("kind: meter", "kind: gauge"), "kind"),
        (("{$leaf: label}", "{$leaf: color}"), "leaf"),
        (("min: 0, max: 10", "min: 10, max: 10"), "greater than min"),
    ):
        old, new = mutation
        with pytest.raises(ValueError, match=needle):
            parse_panels_text(TIER1_YAML.replace(old, new))
    # Unknown keys are errors, not silent drops.
    with pytest.raises(ValueError, match="unknown keys"):
        parse_panels_text(TIER1_YAML.replace("slot: sidebar", "slot: sidebar\n    color: red"))


def test_leaf_binding_only_inside_repeat_and_repeat_does_not_nest():
    with pytest.raises(ValueError, match="repeat"):
        parse_panels_text(
            "panels:\n"
            "  - id: p\n"
            "    title: {en: P}\n"
            "    slot: sidebar\n"
            "    blocks:\n"
            "      - {kind: badge, label: {$leaf: label}}\n"
        )
    with pytest.raises(ValueError, match="does not nest"):
        parse_panels_text(
            "panels:\n"
            "  - id: p\n"
            "    title: {en: P}\n"
            "    slot: sidebar\n"
            "    blocks:\n"
            "      - repeat:\n"
            "          prefix: a.\n"
            "          block:\n"
            "            repeat:\n"
            "              prefix: b.\n"
            "              block: {kind: divider}\n"
        )


def test_pack_level_caps_panel_count_block_count_and_duplicate_ids():
    one = (
        "  - id: p{n}\n"
        "    title: {{en: P}}\n"
        "    slot: sidebar\n"
        "    blocks: [{{kind: divider}}]\n"
    )
    too_many = "panels:\n" + "".join(one.format(n=index) for index in range(MAX_PANELS_PER_PACK + 1))
    with pytest.raises(ValueError, match="at most"):
        parse_panels_text(too_many)
    dup = "panels:\n" + one.format(n=1) + one.format(n=1)
    with pytest.raises(ValueError, match="duplicate"):
        parse_panels_text(dup)
    blocks = "[" + ", ".join("{kind: divider}" for _ in range(MAX_PANEL_BLOCKS + 1)) + "]"
    with pytest.raises(ValueError, match="blocks"):
        parse_panels_text(
            "panels:\n"
            "  - id: p\n"
            "    title: {en: P}\n"
            "    slot: sidebar\n"
            f"    blocks: {blocks}\n"
        )


def test_audience_filter_is_a_one_way_door():
    # The red line, at its unit: keeper panels reach ONLY keeper viewers.
    assert audience_allows("keeper", "keeper")
    assert not audience_allows("keeper", "player")
    assert not audience_allows("keeper", "")
    assert audience_allows("player", "player") and audience_allows("player", "")
    assert not audience_allows("player", "keeper")
    assert audience_allows("all", "keeper") and audience_allows("all", "player")
    # Unknown audiences fail closed for everyone.
    assert not audience_allows("mystery", "keeper")


def test_wire_panel_shapes_tier1_and_tier2_entries():
    (tier1,) = parse_panels_text(TIER1_YAML)
    entry = wire_panel("blackmoor", tier1, {})
    assert entry["id"] == "blackmoor/case-board"
    assert entry["tier"] == 1 and "audience" not in entry
    assert entry["blocks"][0]["kind"] == "meter"

    (tier2,) = parse_panels_text(TIER2_YAML)
    entry = wire_panel("blackmoor", tier2, ASSET_INFO)
    assert entry["entry"] == {"hash": "a" * 64, "size": 120}
    # Wire asset paths are RELATIVE to the entry's directory; the entry itself is not repeated.
    assert [asset["path"] for asset in entry["assets"]] == ["app.js", "map.webp"]
    assert entry["fallback"][0]["kind"] == "text"

    with pytest.raises(ValueError, match="integrity"):
        wire_panel("blackmoor", tier2, {})


# --- M19 item 6: the static `image` block ------------------------------------

IMAGE_YAML = """\
panels:
  - id: handouts
    title: {en: Handouts, zh: 手边物}
    slot: sidebar
    blocks:
      - {kind: image, src: assets/portrait.png, caption: {en: The Wen portraits, zh: 温府画像组}}
      - {kind: image, src: assets/rubbing.png, alt: A relief rubbing}
      - {kind: text, text: {en: Look closely.}}
"""

IMAGE_ASSETS = {
    "assets/portrait.png": {"sha256": "c" * 64, "size": 4096, "mime": "image/png"},
    "assets/rubbing.png": {"sha256": "d" * 64, "size": 2048, "mime": "image/webp"},
}


def test_image_block_authors_a_path_and_wires_a_content_hash():
    (panel,) = parse_panels_text(IMAGE_YAML)
    # Authored form keeps the pack-relative path; the pack build owns the addressing.
    assert panel.blocks[0] == {
        "kind": "image",
        "src": "assets/portrait.png",
        "caption": {"en": "The Wen portraits", "zh": "温府画像组"},
    }
    assert panel.image_sources == ("assets/portrait.png", "assets/rubbing.png")

    wired = wire_panel("wenfu", panel, IMAGE_ASSETS)["blocks"]
    assert wired[0] == {
        "kind": "image",
        "hash": "c" * 64,
        "size": 4096,
        "mime": "image/png",
        "caption": {"en": "The Wen portraits", "zh": "温府画像组"},
    }
    assert wired[1]["hash"] == "d" * 64 and wired[1]["alt"] == {"en": "A relief rubbing"}
    assert wired[2]["kind"] == "text"


def test_image_without_an_integrity_record_refuses_to_wire():
    # Same fail-closed stance as a tier-2 entry: a hand-edited pack home serves no
    # panel rather than a panel pointing at nothing.
    (panel,) = parse_panels_text(IMAGE_YAML)
    with pytest.raises(ValueError, match="integrity record for image"):
        wire_panel("wenfu", panel, {})


def test_image_src_is_a_literal_relative_path_never_a_binding():
    with pytest.raises(ValueError, match="relative path"):
        parse_panels_text(
            "panels:\n  - {id: p, title: T, slot: sidebar, blocks: [{kind: image, src: {$var: pic}}]}\n"
        )
    with pytest.raises(ValueError, match="no .. segments"):
        parse_panels_text(
            "panels:\n  - {id: p, title: T, slot: sidebar, blocks: [{kind: image, src: ../../etc/passwd}]}\n"
        )
    with pytest.raises(ValueError, match="missing"):
        parse_panels_text("panels:\n  - {id: p, title: T, slot: sidebar, blocks: [{kind: image}]}\n")


def test_tier2_fallback_images_wire_and_count_as_panel_sources():
    yaml = """\
panels:
  - id: array
    title: Array
    slot: modal
    entry: ui/array/index.html
    assets: [ui/array/index.html]
    fallback:
      - {kind: image, src: assets/portrait.png, caption: Nine lanterns}
"""
    (panel,) = parse_panels_text(yaml)
    assert panel.image_sources == ("assets/portrait.png",)
    entry = wire_panel("wenfu", panel, {**IMAGE_ASSETS, "ui/array/index.html": {"sha256": "e" * 64, "size": 10}})
    assert entry["fallback"][0]["hash"] == "c" * 64


# ---------------------------------------------------------------------------
# Text rendering — `render_panel_text`, the terminal / protocol-client fallback.
# The oracle is the reference client's `resolvePanelBlocks` semantics: `$var` miss hides
# the block, `hidden` variables are invisible, repeat expands over VISIBLE matches capped
# at MAX_REPEAT_INSTANCES, `visible_when` runs through core.condexpr.
# ---------------------------------------------------------------------------

RENDER_YAML = """\
panels:
  - id: board
    title: {en: Board, zh: 板}
    slot: sidebar
    audience: all
    blocks:
      - {kind: stat, label: {en: Day, zh: 日}, value: {$var: day}}
      - {kind: meter, label: Timber, value: {$var: timber}, min: 0, max: 24}
      - {kind: stat, label: Ghost, value: {$var: ghost}}
      - {kind: badge, label: Open, visible_when: "gate_open"}
      - {kind: badge, label: Shut, visible_when: "!gate_open"}
      - {kind: divider}
      - repeat:
          prefix: "clue."
          block: {kind: badge, label: {$leaf: label}}
      - {kind: choices, prompt: "Now?", options: [{id: a, label: {en: Go, zh: 走}, input: "I go"}, {id: b, label: {$var: ghost}, input: "x"}]}
      - {kind: title_card, act: {en: Act I}, title: {en: Landing}}
      - {kind: letter, from: Ma, to: Da, body: {en: Come home., zh: 回家。}}
      - {kind: clipping, headline: {en: Flood}, source: Gazette, date: "1926", body: Rain.}
      - {kind: map_pin, src: assets/portrait.png, label: Well, x: 0.2, y: 0.4, note: {$var: ghost}}
      - {kind: map_pin, src: assets/portrait.png, label: Gate, x: 0.5, y: 0.5}
      - {kind: image, src: assets/portrait.png, caption: {en: The gate}}
"""


def _var(id_: str, value, *, label: str | None = None, hidden: bool = False) -> dict:
    entry: dict = {"id": id_, "label": label or id_, "value": value}
    if hidden:
        entry["hidden"] = True
    return entry


def test_render_panel_text_binds_hides_and_localizes_like_the_client():
    from core.panels import render_panel_text

    (panel,) = parse_panels_text(RENDER_YAML)
    variables = [
        _var("day", 15),
        _var("timber", 8),
        _var("gate_open", False),
        _var("clue.1", True, label="A muddy boot"),
        _var("clue.2", True, label="A torn map"),
    ]
    lines = render_panel_text(panel, variables, "en")
    assert lines == [
        "Day: 15",
        "Timber: 8/24",
        "[Shut]",  # gate_open is false → `Open` hidden, `!gate_open` shown
        "—",
        "[A muddy boot]",  # repeat over clue.* with $leaf label
        "[A torn map]",
        "Now?",  # choices: the option bound to the missing `ghost` is dropped, the rest stay
        "  · Go → I go",
        "— Act I · Landing —",
        "✉ Ma · Da",
        "Come home.",
        "📰 Flood (Gazette · 1926)",
        "Rain.",
        "📍 Well",  # its optional note binds to the missing `ghost` → the note drops, the pin stays
        "📍 Gate",
        "🖼 The gate",
    ]
    # `ghost` never existed for this viewer: the stat bound to it is absent, not blank.
    assert not any("Ghost" in line for line in lines)

    zh = render_panel_text(panel, variables, "zh")
    assert zh[0] == "日: 15" and "  · 走 → I go" in zh and "回家。" in zh


def test_render_panel_text_never_reads_a_hidden_variable():
    """A keeper connection receives un-exposed MVU leaves with `hidden: true`; the text
    renderer treats them exactly as the client does — as absent."""
    from core.panels import render_panel_text

    (panel,) = parse_panels_text(RENDER_YAML)
    variables = [
        _var("day", 3, hidden=True),
        _var("clue.secret", True, label="The murderer", hidden=True),
        _var("clue.1", True, label="A muddy boot"),
        _var("gate_open", True),
    ]
    lines = render_panel_text(panel, variables, "en")
    assert "Day: 3" not in lines
    assert "[The murderer]" not in lines and "[A muddy boot]" in lines
    assert "[Open]" in lines


def test_render_panel_text_repeat_filters_before_it_caps():
    """A match that sits past the first N variables of a large tree (an MVU import) is
    still an instance; the cap is on instances, and it is the client's cap."""
    from core.panels import MAX_REPEAT_INSTANCES, render_panel_text

    (panel,) = parse_panels_text(RENDER_YAML)
    filler = [_var(f"mvu.node.{index}", index) for index in range(MAX_REPEAT_INSTANCES * 4 + 10)]
    tail = [_var("clue.late", True, label="Found late")]
    assert "[Found late]" in render_panel_text(panel, filler + tail, "en")

    many = [_var(f"clue.{index}", True, label=f"Clue {index}") for index in range(MAX_REPEAT_INSTANCES + 5)]
    lines = render_panel_text(panel, many, "en")
    assert sum(1 for line in lines if line.startswith("[Clue ")) == MAX_REPEAT_INSTANCES


def test_render_panel_text_uses_the_tier2_fallback_and_reports_none():
    from core.panels import panel_title_text, render_panel_text

    (panel,) = parse_panels_text(TIER2_YAML)
    assert panel_title_text(panel, "zh") == "庄园地图"
    assert render_panel_text(panel, [], "zh") == ["地图请在富客户端查看。"]
    assert render_panel_text(panel, [], "en") == ["Map in the rich client."]

    (rich_only,) = parse_panels_text(
        "panels:\n  - {id: p, title: T, slot: modal, entry: ui/p/index.html, assets: [ui/p/index.html], fallback: null}\n"
    )
    assert render_panel_text(rich_only, [], "en") == []
