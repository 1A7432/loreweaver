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


# ---------------------------------------------------------------------------
# Hook-private state store: getstate / setstate (engine half)
# ---------------------------------------------------------------------------


def _state_engine(code: str, state=None):
    engine = create_hook_engine(
        [HookScript(source_id="test", code=code)], flat_variables={}, tree={}, state=state or {}
    )
    assert engine is not None
    return engine


def test_getstate_reads_the_snapshot_and_a_handler_sees_its_own_writes():
    engine = _state_engine(
        "on('turn_start', () => {"
        " const s = getstate('ledger');"
        " setstate('ledger', {n: s.n + 1, log: s.log.concat(['b'])});"
        " narrate(JSON.stringify(getstate('ledger')) + '|' + String(getstate('missing')));"
        "});",
        state={"ledger": {"n": 1, "log": ["a"]}},
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.narrations == ['{"n":2,"log":["a","b"]}|undefined']
    assert outcome.state_writes == [("ledger", {"n": 2, "log": ["a", "b"]})]
    # The state store is not the variable space: nothing reaches the setvar buffer.
    assert outcome.writes == []


def test_getstate_returns_a_copy_and_setstate_captures_the_value_at_call_time():
    engine = _state_engine(
        "on('turn_start', () => {"
        " const s = getstate('box'); s.items.push('stolen');"  # mutating a copy changes nothing
        " const v = {k: 1}; setstate('later', v); v.k = 99;"  # buffered as of the call
        " narrate(JSON.stringify(getstate('box')) + '|' + getstate('later').k);"
        "});",
        state={"box": {"items": []}},
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.narrations == ['{"items":[]}|1']
    assert outcome.state_writes == [("later", {"k": 1})]


def test_setstate_null_or_undefined_deletes():
    engine = _state_engine(
        "on('turn_start', () => { setstate('a', null); setstate('b'); narrate(String(getstate('a'))); });",
        state={"a": 1, "b": 2},
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.state_writes == [("a", None), ("b", None)]
    assert outcome.narrations == ["undefined"]


def test_setstate_refuses_what_cannot_be_json_inside_the_sandbox():
    engine = _state_engine(
        "on('turn_start', () => {"
        " const loop = {}; loop.self = loop;"
        " setstate('cyclic', loop); setstate('nan', NaN); setstate('deep', {x: [Infinity]});"
        " setstate('fn', () => 1); setstate('ok', [1, 'two', true]);"
        " narrate(String(getstate('nan')));"
        "});"
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.state_writes == [("ok", [1, "two", True])]
    assert len(outcome.state_warnings) == 4
    assert outcome.narrations == ["undefined"]  # a refused write never reached the view


def test_state_writes_over_the_per_dispatch_cap_are_dropped_and_reported():
    from core.hooks import MAX_STATE_WRITES

    engine = _state_engine(
        f"on('turn_start', () => {{ for (let i = 0; i < {MAX_STATE_WRITES + 5}; i++) setstate('k' + i, i); }});"
    )
    outcome = engine.fire("turn_start", {})
    assert [key for key, _ in outcome.state_writes] == [f"k{i}" for i in range(MAX_STATE_WRITES)]
    assert any("5 write(s)" in warning for warning in outcome.state_warnings)


def test_state_buffers_reset_per_dispatch():
    engine = _state_engine(
        "on('turn_start', () => setstate('a', 1)); on('reply_ready', () => narrate(String(getstate('a'))));"
    )
    assert engine.fire("turn_start", {}).state_writes == [("a", 1)]
    ready = engine.fire("reply_ready", {"reply": ""})
    assert ready.state_writes == []
    assert ready.narrations == ["1"]  # the in-sandbox view carries across the turn's dispatches


def test_tool_use_state_writes_are_dropped_and_rolled_back():
    engine = _state_engine(
        "on('tool_use', () => { setstate('count', 99); denyTool('no'); });"
        "on('reply_ready', () => narrate(String(getstate('count'))));",
        state={"count": 1},
    )
    veto = engine.fire("tool_use", {"tool": "x", "arguments": {}})
    assert veto.deny == "no"  # the one effect a tool_use dispatch keeps
    assert veto.state_writes == []
    assert veto.state_warnings
    assert engine.fire("reply_ready", {"reply": ""}).narrations == ["1"]


def test_a_failed_dispatch_rolls_the_state_view_back():
    engine = _state_engine(
        "on('turn_start', () => { setstate('count', 99); while (true) {} });"
        "on('reply_ready', () => narrate(String(getstate('count'))));",
        state={"count": 1},
    )
    failed = engine.fire("turn_start", {})
    assert failed.state_writes == []
    assert failed.warnings
    assert engine.fire("reply_ready", {"reply": ""}).narrations == ["1"]


def test_sync_state_resets_the_view_to_what_was_persisted():
    engine = _state_engine(
        "on('turn_start', () => setstate('bad key!', 1)); on('reply_ready', () => narrate(String(getstate('bad key!'))));"
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.state_writes == [("bad key!", 1)]  # the sandbox does not judge keys...
    engine.sync_state({})  # ...the engine does, and the caller re-syncs to its verdict
    assert engine.fire("reply_ready", {"reply": ""}).narrations == ["undefined"]
    assert engine.committed_state == {}


def test_the_ejs_template_bridge_does_not_get_the_state_api():
    """getstate/setstate live in the HOOK prelude only: worldbook templates never see them."""
    from core.ejs_full import _PRELUDE

    assert "getstate" not in _PRELUDE and "setstate" not in _PRELUDE


# ---------------------------------------------------------------------------
# plan_state_writes: the deterministic judge (pure, no sandbox needed)
# ---------------------------------------------------------------------------


def test_plan_accepts_valid_writes_and_names_the_rows_to_change():
    from core.hooks import plan_state_writes

    plan = plan_state_writes({"keep": 1, "drop": 2}, [("new.key:1-a_b", {"x": "é"}), ("drop", None), ("keep", 3)])
    assert plan.state == {"keep": 3, "new.key:1-a_b": {"x": "é"}}
    assert plan.upserts == {"new.key:1-a_b": '{"x":"é"}', "keep": "3"}
    assert plan.deletes == ["drop"]
    assert plan.applied == ["new.key:1-a_b", "drop", "keep"]
    assert plan.warnings == []


@pytest.mark.parametrize("key", ["", "a" * 65, "has space", "ünïcode", "slash/key", 7, None])
def test_plan_refuses_invalid_keys(key):
    from core.hooks import plan_state_writes

    plan = plan_state_writes({}, [(key, 1), ("fine", 2)])
    assert plan.state == {"fine": 2}
    assert len(plan.warnings) == 1


def test_plan_accepts_a_64_char_key():
    from core.hooks import plan_state_writes

    assert plan_state_writes({}, [("k" * 64, 1)]).state == {"k" * 64: 1}


def test_plan_value_cap_counts_utf8_bytes_of_compact_json():
    from core.hooks import MAX_STATE_VALUE_BYTES, plan_state_writes

    fits = "x" * (MAX_STATE_VALUE_BYTES - 2)  # + the two quotes = exactly the cap
    assert plan_state_writes({}, [("v", fits)]).state == {"v": fits}
    # Three UTF-8 bytes per char: well under the cap in characters, over it in bytes.
    wide = "汉" * (MAX_STATE_VALUE_BYTES // 3)
    plan = plan_state_writes({}, [("v", wide)])
    assert plan.state == {} and plan.warnings


def test_plan_key_count_cap_lets_existing_keys_update_and_deletes_free_room():
    from core.hooks import MAX_STATE_KEYS, plan_state_writes

    full = {f"k{i}": i for i in range(MAX_STATE_KEYS)}
    plan = plan_state_writes(full, [("extra", 1), ("k0", "updated")])
    assert "extra" not in plan.state and plan.state["k0"] == "updated"
    assert len(plan.warnings) == 1
    freed = plan_state_writes(full, [("k1", None), ("extra", 1)])
    assert "extra" in freed.state and "k1" not in freed.state and freed.warnings == []


def test_plan_total_cap_is_room_wide():
    from core.hooks import MAX_STATE_TOTAL_BYTES, MAX_STATE_VALUE_BYTES, plan_state_writes

    chunk = "y" * (MAX_STATE_VALUE_BYTES - 2)
    existing = {f"c{i}": chunk for i in range(MAX_STATE_TOTAL_BYTES // MAX_STATE_VALUE_BYTES)}  # exactly the cap
    plan = plan_state_writes(existing, [("one_more", 1), ("c0", "small"), ("one_more", 1)])
    # The first `one_more` would cross the total; shrinking c0 makes room for the second.
    assert plan.state["c0"] == "small" and plan.state["one_more"] == 1
    assert len(plan.warnings) == 1


def test_plan_write_count_cap():
    from core.hooks import MAX_STATE_WRITES, plan_state_writes

    plan = plan_state_writes({}, [(f"k{i}", i) for i in range(MAX_STATE_WRITES + 3)])
    assert len(plan.state) == MAX_STATE_WRITES
    assert len(plan.warnings) == 1


def test_plan_refuses_values_that_are_not_storable_json():
    from core.hooks import plan_state_writes

    plan = plan_state_writes({}, [("nan", float("nan")), ("surrogate", "\ud800"), ("obj", object()), ("ok", [])])
    assert plan.state == {"ok": []}
    assert len(plan.warnings) == 3


def test_a_corrupt_stored_value_decodes_as_absent():
    from core.hooks import decode_state_value

    assert decode_state_value('{"a": 1}') == {"a": 1}
    for corrupt in ("{not json", "NaN", "[Infinity]", "null", None, 42):
        assert decode_state_value(corrupt) is None


def test_a_top_level_setstate_is_dropped_at_load():
    engine = _state_engine(
        "setstate('boot', 1); on('turn_start', () => narrate(String(getstate('boot'))));", state={"boot": 0}
    )
    assert any("outside a handler" in warning for warning in engine.load_warnings)
    outcome = engine.fire("turn_start", {})
    assert outcome.narrations == ["0"]
    assert outcome.state_writes == []


# ---------------------------------------------------------------------------
# __proto__ fidelity (the state view is built with JSON.parse, never an object literal)
# ---------------------------------------------------------------------------


def test_a_nested_proto_member_round_trips_as_an_own_property():
    engine = _state_engine(
        "on('turn_start', () => {"
        " const x = getstate('x'); narrate(JSON.stringify(x));"
        " setstate('y', JSON.parse('{\"__proto__\": {\"b\": 2}}')); narrate(JSON.stringify(getstate('y')));"
        "});",
        state={"x": {"__proto__": {"a": 1}, "c": 3}},
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.narrations == ['{"__proto__":{"a":1},"c":3}', '{"__proto__":{"b":2}}']
    assert outcome.state_writes == [("y", {"__proto__": {"b": 2}})]
    engine.sync_state({"x": {"__proto__": {"a": 1}}})  # the re-sync path is the same builder
    assert engine.fire("turn_start", {}).narrations[0] == '{"__proto__":{"a":1}}'


def test_reserved_top_level_keys_are_refused_and_never_touch_the_view():
    from core.hooks import RESERVED_STATE_KEYS, plan_state_writes, valid_state_key

    assert RESERVED_STATE_KEYS == {"__proto__", "constructor", "prototype"}
    for key in RESERVED_STATE_KEYS:
        assert not valid_state_key(key)
        assert plan_state_writes({}, [(key, 1)]).state == {}
    engine = _state_engine(
        "on('turn_start', () => { setstate('__proto__', {polluted: true});"
        " narrate(String(({}).polluted) + '|' + JSON.stringify(getstate('__proto__'))); });"
    )
    outcome = engine.fire("turn_start", {})
    # An own property in the sandbox (no prototype pollution), and the engine refuses it.
    assert outcome.narrations == ['undefined|{"polluted":true}']


# ---------------------------------------------------------------------------
# event.seed and warning logging
# ---------------------------------------------------------------------------


def _seed_engine(room="seed-room", turn=3, lane="hooks"):
    engine = create_hook_engine(
        [HookScript(source_id="t", code="on('turn_start', (e) => narrate(String(e.seed)));"
                    "on('reply_ready', (e) => narrate(String(e.seed)));")],
        flat_variables={}, tree={}, room=room, turn=turn, lane=lane,
    )
    assert engine is not None
    return engine


def test_event_seed_is_stable_for_the_same_room_turn_and_stream():
    from core.hooks import hook_seed

    first, second = _seed_engine(), _seed_engine()
    seeds = [first.fire("turn_start", {}).narrations[0], first.fire("turn_start", {}).narrations[0],
             first.fire("reply_ready", {"reply": ""}).narrations[0]]
    assert seeds == [second.fire("turn_start", {}).narrations[0], second.fire("turn_start", {}).narrations[0],
                     second.fire("reply_ready", {"reply": ""}).narrations[0]]
    assert len(set(seeds)) == 3  # every dispatch draws its own stream
    assert int(seeds[0]) == hook_seed("seed-room", 3, "hooks:turn_start:0")
    assert all(0 <= int(seed) < 2**53 for seed in seeds)
    for other in (_seed_engine(room="other"), _seed_engine(turn=4), _seed_engine(lane="scribe-hooks")):
        assert other.fire("turn_start", {}).narrations[0] != seeds[0]


def test_handler_errors_and_log_lines_reach_the_server_log(caplog):
    import logging

    engine = create_hook_engine(
        [HookScript(source_id="t", code="on('turn_start', () => { log('tide turned'); throw new Error('boom'); });")],
        flat_variables={}, tree={}, room="log-room",
    )
    with caplog.at_level(logging.WARNING, logger="core.hooks"):
        engine.fire("turn_start", {})
    text = caplog.text
    assert "log-room" in text and "log: tide turned" in text and "boom" in text


# ---------------------------------------------------------------------------
# Module actions: registration and run_action (engine half)
# ---------------------------------------------------------------------------


def _action_engine(code: str, *, flat=None, tree=None, state=None):
    engine = create_hook_engine(
        [HookScript(source_id="test", code=code)], flat_variables=flat or {}, tree=tree or {}, state=state or {}
    )
    assert engine is not None
    return engine


def test_valid_registrations_are_accepted_in_order():
    engine = _action_engine(
        "defineAction('book_hour', {description: 'Book an hour', params: '{pace}', rolls: {march: '8d10'}}, () => 1);"
        "defineAction('tally', {description: 'Count'}, () => 2);"
    )
    assert [spec.name for spec in engine.actions] == ["book_hour", "tally"]
    book = engine.actions[0]
    assert book.description == "Book an hour" and book.params == "{pace}" and book.rolls == (("march", "8d10"),)
    assert engine.load_warnings == []


@pytest.mark.parametrize(
    "registration",
    [
        "defineAction('Bad', {description: 'x'}, () => 1)",
        "defineAction('a' + 'b'.repeat(32), {description: 'x'}, () => 1)",
        "defineAction('no_desc', {}, () => 1)",
        "defineAction('long_desc', {description: 'x'.repeat(201)}, () => 1)",
        "defineAction('long_params', {description: 'x', params: 'p'.repeat(401)}, () => 1)",
        "defineAction('many_rolls', {description: 'x', rolls: {a:'1d6',b:'1d6',c:'1d6',d:'1d6',e:'1d6',f:'1d6',g:'1d6',h:'1d6',i:'1d6'}}, () => 1)",
        "defineAction('bad_slot', {description: 'x', rolls: {'1st': '1d6'}}, () => 1)",
        "defineAction('bad_expr', {description: 'x', rolls: {a: ''}}, () => 1)",
        "defineAction('no_handler', {description: 'x'}, 42)",
        "defineAction('no_spec', undefined, () => 1)",
    ],
)
def test_a_bad_registration_is_dropped_with_a_load_warning(registration):
    engine = _action_engine(registration + "; defineAction('good', {description: 'ok'}, () => 1);")
    assert [spec.name for spec in engine.actions] == ["good"]
    assert len(engine.load_warnings) == 1


def test_duplicates_keep_the_first_and_the_cap_drops_the_rest():
    from core.hooks import MAX_ACTIONS

    engine = _action_engine(
        "defineAction('dup', {description: 'first'}, () => 'first');"
        "defineAction('dup', {description: 'second'}, () => 'second');"
        f"for (let i = 0; i < {MAX_ACTIONS + 2}; i++) defineAction('a' + i, {{description: 'n'}}, () => i);"
    )
    assert len(engine.actions) == MAX_ACTIONS
    assert engine.action("dup").description == "first"
    assert engine.run_action("dup", {}).text == "first"
    assert sum("duplicate" in warning for warning in engine.load_warnings) == 1
    assert sum("cap" in warning for warning in engine.load_warnings) == 3


def test_run_action_returns_text_json_or_none_and_sees_args_and_event():
    engine = _action_engine(
        "defineAction('echo', {description: 'x'}, (args, ev) => 'got ' + args.n + ' ' + ev.actor + ' ' + ev.rolls.d.total + ' ' + typeof ev.seed);"
        "defineAction('obj', {description: 'x'}, () => ({ok: true, list: [1, 2]}));"
        "defineAction('quiet', {description: 'x'}, () => {});"
        "defineAction('later', {description: 'x'}, async (args) => 'async ' + args.n);"
    )
    echo = engine.run_action("echo", {"n": 7}, actor="u1", rolls={"d": {"expr": "1d6", "total": 4, "dice": [4]}})
    assert echo.ok and echo.text == "got 7 u1 4 number"
    assert engine.run_action("obj", {}).text == '{"ok":true,"list":[1,2]}'
    quiet = engine.run_action("quiet", {})
    assert quiet.ok and quiet.text is None
    assert engine.run_action("later", {"n": 2}).text == "async 2"


def test_run_action_truncates_long_results():
    from core.hooks import MAX_ACTION_RESULT_CHARS

    engine = _action_engine(f"defineAction('long', {{description: 'x'}}, () => 'y'.repeat({MAX_ACTION_RESULT_CHARS + 10}));")
    outcome = engine.run_action("long", {})
    assert outcome.truncated and len(outcome.text) == MAX_ACTION_RESULT_CHARS


def test_run_action_effects_come_back_as_buffers_and_voice_emitters_are_ignored():
    engine = _action_engine(
        "defineAction('book', {description: 'x'}, () => {"
        " setvar('crossed', 475); setstate('ledger', {n: 1}); emitUI([{kind:'badge', label:'booked'}]);"
        " emitPanel('pack/board', {n: 1}); inject('no'); narrate('no'); rewriteReply('no'); denyTool('no');"
        " return 'ok'; });"
    )
    outcome = engine.run_action("book", {})
    assert outcome.ok
    assert outcome.writes == [("crossed", 475)]
    assert outcome.state_writes == [("ledger", {"n": 1})]
    assert outcome.ui_blocks and outcome.panel_events
    assert outcome.injections == [] and outcome.narrations == [] and outcome.rewrite is None and outcome.deny is None
    assert sum("ignored inside an action" in warning for warning in outcome.warnings) == 4


@pytest.mark.parametrize(
    "body",
    [
        "() => { setvar('x', 1); setstate('s', 1); throw new Error('boom'); }",
        "() => { setvar('x', 1); setstate('s', 1); while (true) {} }",
        "() => { setvar('x', 1); setstate('s', 1); return () => 1; }",
        "() => { setvar('x', 1); setstate('s', 1); return {n: NaN}; }",
        "async () => { setvar('x', 1); setstate('s', 1); throw new Error('later'); }",
    ],
)
def test_a_failed_action_applies_nothing_and_rolls_the_views_back(body):
    engine = _action_engine(
        f"defineAction('bad', {{description: 'x'}}, {body});"
        "defineAction('peek', {description: 'x'}, () => getvar('x') + '|' + getstate('s'));",
        flat={"x": 0},
        state={"s": 0},
    )
    failed = engine.run_action("bad", {})
    assert not failed.ok and failed.error
    assert failed.writes == [] and failed.state_writes == [] and failed.ui_blocks == []
    assert engine.run_action("peek", {}).text == "0|0"


def test_refresh_variables_updates_what_the_next_action_reads():
    engine = _action_engine("defineAction('peek', {description: 'x'}, () => getvar('fear') + '|' + getvar('trail.seen'));",
                            flat={"fear": 1})
    assert engine.run_action("peek", {}).text == "1|undefined"
    engine.refresh_variables({"fear": 5}, {"trail": {"seen": True}})
    assert engine.run_action("peek", {}).text == "5|true"


def test_an_unknown_action_is_refused_by_the_engine_too():
    engine = _action_engine("defineAction('known', {description: 'x'}, () => 1);")
    outcome = engine.run_action("nope", {})
    assert not outcome.ok and outcome.error


# ---------------------------------------------------------------------------
# Player-invokable actions (protocol 2.6) and the raised capacity caps
# ---------------------------------------------------------------------------


def test_player_and_label_are_parsed_and_resolved_per_locale():
    engine = _action_engine(
        "defineAction('march', {description: 'm', player: true, label: {en: 'March', zh: '行军'}}, () => 1);"
        "defineAction('plain', {description: 'p', player: true, label: 'Look around'}, () => 1);"
        "defineAction('secret', {description: 's'}, () => 1);"
    )
    march, plain, secret = engine.actions
    assert march.player and plain.player and not secret.player
    assert march.label_for("zh") == "行军" and march.label_for("en") == "March" and march.label_for("fr") == "March"
    assert plain.label_for("zh") == "Look around" and secret.label_for("en") == "secret"
    assert march.manifest_entry() == {"id": "march", "description": "m", "labels": {"en": "March", "zh": "行军"}}


@pytest.mark.parametrize(
    "spec",
    [
        "{description: 'x', player: 'yes'}",
        "{description: 'x', label: 'L'.repeat(61)}",
        "{description: 'x', label: {fr: 'Marche'}}",
        "{description: 'x', label: {en: ''}}",
        "{description: 'x', label: 5}",
    ],
)
def test_a_bad_player_or_label_drops_the_action(spec):
    engine = _action_engine(f"defineAction('bad', {spec}, () => 1); defineAction('good', {{description: 'ok'}}, () => 1);")
    assert [action.name for action in engine.actions] == ["good"]


def test_event_source_tells_the_handler_who_called():
    engine = _action_engine("defineAction('who', {description: 'w', player: true}, (a, ev) => ev.source);")
    assert engine.run_action("who", {}).text == "keeper"
    assert engine.run_action("who", {}, source="player").text == "player"


def test_ordinal_offset_moves_every_stream():
    from core.hooks import hook_seed

    engine = create_hook_engine(
        [HookScript("t", "defineAction('s', {description: 's'}, (a, ev) => String(ev.seed));")],
        flat_variables={}, tree={}, room="r", turn=2, lane="command", ordinal_offset=7,
    )
    assert engine.run_action("s", {}).text == str(hook_seed("r", 2, "command:action:7"))


def test_scripts_past_the_room_total_are_skipped_in_order():
    from core.hooks import MAX_HOOK_SOURCE_CHARS, MAX_HOOK_TOTAL_SOURCE_CHARS

    padding = "//" + "x" * (MAX_HOOK_SOURCE_CHARS - 200) + "\n"
    per_script = len(padding) + 60
    fits = MAX_HOOK_TOTAL_SOURCE_CHARS // per_script
    scripts = [
        HookScript(f"s{index}", padding + f"on('turn_start', () => narrate('s{index}'));")
        for index in range(fits + 2)
    ]
    engine = create_hook_engine(scripts, flat_variables={}, tree={})
    assert engine.fire("turn_start", {}).narrations == [f"s{index}" for index in range(fits)]
    assert sum("in total" in warning for warning in engine.load_warnings) == 2


def test_a_script_at_the_raised_per_script_cap_loads():
    from core.hooks import MAX_HOOK_SOURCE_CHARS

    body = "on('turn_start', () => narrate('big'));\n"
    code = body + "//" + "y" * (MAX_HOOK_SOURCE_CHARS - len(body) - 2)
    assert len(code) == MAX_HOOK_SOURCE_CHARS
    engine = create_hook_engine([HookScript("big", code)], flat_variables={}, tree={})
    assert engine.fire("turn_start", {}).narrations == ["big"]
    too_big = create_hook_engine([HookScript("big", code + "z"), HookScript("ok", body)], flat_variables={}, tree={})
    assert too_big.fire("turn_start", {}).narrations == ["big"]  # only the second script ran
