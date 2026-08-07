"""Tests for core.hooks: the sandboxed event-hook engine (registration, dispatch, effect
buffers, guardrails). Skipped as a module when the `ejs` extra (quickjs) is not installed —
without it the hook layer is inert by design."""

from __future__ import annotations

import pytest

pytest.importorskip("quickjs")

from core.hooks import HookScript, create_hook_engine, sanitize_ui_emissions  # noqa: E402


def _engine(code: str, *, flat=None, tree=None, scripts=None):
    scripts = scripts or [HookScript(source_id="test", code=code)]
    engine = create_hook_engine(scripts, flat_variables=flat or {}, tree=tree or {})
    assert engine is not None
    return engine


def test_no_scripts_means_no_engine():
    assert create_hook_engine([], flat_variables={}, tree={}) is None


def test_handler_registration_and_payload_dispatch():
    engine = _engine("on('turn_start', (event) => { narrate('saw: ' + event.user_message); });")
    outcome = engine.fire("turn_start", {"user_message": "hello"})
    assert outcome.handlers == 1
    assert outcome.narrations == ["saw: hello"]


def test_writes_buffer_through_the_bridge_and_read_variables():
    engine = _engine(
        "on('turn_start', () => { if (getvar('fear') >= 5) setvar('stage', 2); });",
        flat={"fear": 7},
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.writes == [("stage", 2)]


def test_inject_and_rewrite_and_log():
    engine = _engine(
        "on('turn_start', () => inject('the bells toll'));"
        "on('reply_ready', (event) => { rewriteReply(event.reply + '!'); log('done'); });"
    )
    start = engine.fire("turn_start", {})
    assert start.injections == ["the bells toll"]
    ready = engine.fire("reply_ready", {"reply": "Night falls"})
    assert ready.rewrite == "Night falls!"
    assert any("log: done" in warning for warning in ready.warnings)


def test_effect_buffers_are_isolated_per_fire():
    engine = _engine("on('turn_start', () => narrate('once'));")
    assert engine.fire("turn_start", {}).narrations == ["once"]
    assert engine.fire("reply_ready", {"reply": ""}).narrations == []


def test_handler_error_is_tolerated_and_reported():
    engine = _engine(
        "on('turn_start', () => { throw new Error('boom'); });"
        "on('turn_start', () => narrate('still ran'));"
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.narrations == ["still ran"]
    assert any("boom" in warning for warning in outcome.warnings)


def test_infinite_loop_in_registration_is_capped_not_a_hang():
    engine = create_hook_engine(
        [HookScript(source_id="evil", code="while(true){}")], flat_variables={}, tree={}
    )
    assert engine is not None
    assert any("evil" in warning for warning in engine.load_warnings)
    assert engine.fire("turn_start", {}).handlers == 0


def test_infinite_loop_in_a_handler_is_capped_not_a_hang():
    engine = _engine("on('turn_start', () => { while(true){} });")
    outcome = engine.fire("turn_start", {})
    assert any("dispatch failed" in warning or "error" in warning for warning in outcome.warnings)


def test_unknown_event_and_lodash_availability():
    engine = _engine("on('turn_start', () => narrate(_.range(3).join('-')));")
    assert engine.fire("bogus_event", {}).warnings
    assert engine.fire("turn_start", {}).narrations == ["0-1-2"]


def test_emit_ui_validates_blocks_drops_bad_ones_and_keeps_placement():
    engine = _engine(
        "on('turn_start', () => emitUI(["
        "  {kind:'meter', label:'HP', value:7, min:0, max:10},"
        "  {kind:'divider', extra:'stripped'},"
        "  {kind:'badge', label:'omen', tone:'sparkly'},"
        "  {kind:'text', text:'a whisper', style:'quote'},"
        "  {kind:'choices', prompt:'Pick', options:["
        "    {id:'a', label:'Attack', input:'.ra fight'},"
        "    {id:'', label:'bad', input:'x'},"
        "    'garbage'"
        "  ]},"
        "  {kind:'hologram', label:'nope'},"
        "  {kind:'meter', label:'bad', value:'seven', min:0, max:10}"
        "], {panel:'sidebar', id:'hud', replace:true}));"
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.ui_blocks == [
        {
            "blocks": [
                {"kind": "meter", "label": "HP", "value": 7, "min": 0, "max": 10},
                {"kind": "divider"},
                {"kind": "badge", "label": "omen"},  # unknown tone stripped, block kept
                {"kind": "text", "text": "a whisper", "style": "quote"},
                {
                    "kind": "choices",
                    "options": [{"id": "a", "label": "Attack", "input": ".ra fight"}],
                    "prompt": "Pick",
                },
            ],
            "panel": "sidebar",
            "id": "hud",
            "replace": True,
        }
    ]


def test_emit_ui_caps_emissions_defaults_panel_and_isolates_per_fire():
    engine = _engine(
        "on('turn_start', () => {"
        "  for (var i = 0; i < 12; i++) emitUI({kind:'badge', label:'b' + i}, {panel:'holodeck'});"
        "});"
    )
    outcome = engine.fire("turn_start", {})
    assert len(outcome.ui_blocks) == 8  # MAX_UI_EMISSIONS, tail dropped
    assert outcome.ui_blocks[0]["blocks"] == [{"kind": "badge", "label": "b0"}]  # single block auto-wrapped
    assert all(emission["panel"] == "inline" for emission in outcome.ui_blocks)  # unknown panel -> inline
    assert engine.fire("reply_ready", {"reply": ""}).ui_blocks == []  # buffers reset per fire


def test_sanitize_ui_emissions_shapes_caps_and_truncation():
    assert sanitize_ui_emissions("nope") == []
    assert sanitize_ui_emissions(["junk", {"blocks": "nope"}, {"blocks": [{"kind": "text"}]}]) == []
    # A meter whose range is empty (max <= min) can't render — the block drops.
    assert sanitize_ui_emissions([{"blocks": [{"kind": "meter", "label": "x", "value": 1, "min": 5, "max": 5}]}]) == []
    emissions = sanitize_ui_emissions(
        [
            {
                "blocks": [{"kind": "stat", "label": "y" * 500, "value": True}] * 40,
                "id": 7,
                "replace": "yes",
            }
        ]
    )
    assert len(emissions) == 1
    assert len(emissions[0]["blocks"]) == 16  # MAX_UI_BLOCKS, tail dropped
    assert emissions[0]["blocks"][0] == {"kind": "stat", "label": "y" * 120, "value": True}
    assert emissions[0] == {"blocks": emissions[0]["blocks"], "panel": "inline"}  # bad id/replace stripped


def test_multiple_scripts_share_the_room_but_broken_one_is_skipped():
    engine = create_hook_engine(
        [
            HookScript(source_id="a", code="on('turn_start', () => narrate('A'));"),
            HookScript(source_id="broken", code="this is not javascript ((("),
            HookScript(source_id="b", code="on('turn_start', () => narrate('B'));"),
        ],
        flat_variables={},
        tree={},
    )
    assert engine is not None
    assert any("broken" in warning for warning in engine.load_warnings)
    assert engine.fire("turn_start", {}).narrations == ["A", "B"]


def test_emit_panel_buffers_validate_and_reset_per_fire():
    engine = _engine(
        "on('turn_start', () => {"
        "  emitPanel('blackmoor/case-board', {clue: 'ash'});"
        "  emitPanel('', {dropped: true});"
        "  emitPanel('blackmoor/case-board', 7);"
        "});"
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.panel_events == [
        {"panel": "blackmoor/case-board", "payload": {"clue": "ash"}},
        {"panel": "blackmoor/case-board", "payload": 7},
    ]
    # Buffers reset between fires, like every other effect buffer.
    assert engine.fire("reply_ready", {"reply": ""}).panel_events == []


def test_sanitize_panel_events_drops_oversized_and_malformed_entries():
    from core.hooks import MAX_PANEL_EVENT_BYTES, sanitize_panel_events

    big = "x" * (MAX_PANEL_EVENT_BYTES + 1)
    events = sanitize_panel_events(
        [
            {"panel": "p/a", "payload": {"ok": 1}},
            {"panel": "p/a", "payload": big},          # oversized -> dropped whole
            {"panel": "x" * 200, "payload": 1},         # id too long -> dropped
            {"panel": "p/b"},                            # missing payload -> null payload is fine
            "junk",
            {"panel": "p/c", "payload": float("nan")},  # non-JSON-serializable -> dropped
        ]
    )
    assert events == [
        {"panel": "p/a", "payload": {"ok": 1}},
        {"panel": "p/b", "payload": None},
    ]
    assert sanitize_panel_events("nope") == []


# --- M19 item 6: the `image` block --------------------------------------------


def test_sanitize_ui_image_blocks_require_a_whole_sha256():
    emissions = sanitize_ui_emissions(
        [
            {
                "blocks": [
                    {"kind": "image", "hash": f"  {'A' * 64}  ", "mime": "IMAGE/PNG", "caption": "a lantern chart"},
                    # A longer string must NOT be truncated into shape — that would
                    # address a different blob than the author named.
                    {"kind": "image", "hash": "b" * 128},
                    {"kind": "image", "hash": "not-a-hash"},
                    {"kind": "image"},
                    # A non-image mime is stripped as an invalid OPTIONAL field; the
                    # gateway reachability gate stamps the authoritative one anyway.
                    {"kind": "image", "hash": "c" * 64, "mime": "audio/mpeg", "alt": "x" * 500},
                ]
            }
        ]
    )
    blocks = emissions[0]["blocks"]
    assert blocks[0] == {"kind": "image", "hash": "a" * 64, "mime": "image/png", "caption": "a lantern chart"}
    assert [block["hash"] for block in blocks] == ["a" * 64, "c" * 64]
    assert "mime" not in blocks[1] and len(blocks[1]["alt"]) == 120


def test_emit_ui_image_from_a_hook_reaches_the_outcome():
    engine = _engine(
        'on("reply_ready", () => emitUI([{kind: "image", hash: "' + "f" * 64 + '", caption: "手记"}]))'
    )
    outcome = engine.fire("reply_ready", {"reply": "..."})
    assert outcome.ui_blocks[0]["blocks"] == [{"kind": "image", "hash": "f" * 64, "caption": "手记"}]
