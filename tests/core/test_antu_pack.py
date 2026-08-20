"""Guard tests for the flagship module pack content/antu (《安土》).

Beyond "the pack builds" (which runs every real engine parser), these tests
pin the module's two structural red lines as CI (全纲 §12 评测计划):

1. Sentinel zero-leak — the five keeper-ciphertext words (井髓 / 勘髓录 /
   拔营颂 / 圣街七签 / 九宫营图) may appear ONLY in worldbook entries marked
   secret, never in player-grade surfaces (public entries, opening, pregens,
   lorebooks, panels). Each sentinel has an earned channel; the pack must not
   smuggle it across projection.
2. Displacement blacklist — the 写古说今 audit (全纲 §11): no modern
   administrative vocabulary anywhere in the module's fiction-facing text.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.lorecard import parse_lorecard_bytes
from core.pack import build_pack

SRC = Path(__file__).resolve().parents[2] / "content" / "antu"

SENTINELS = ["井髓", "勘髓录", "拔营颂", "圣街七签", "九宫营图"]
# The outline's list, plus the modern administrative words the 2026-08-18 build actually
# caught itself using (委员会/配额/政治 read as 近代行政词 in fiction; the in-world words are
# 筹典司 / 水额 / 三钥).
BLACKLIST = ["议会", "民主", "共和", "选举", "政策", "改革", "开放", "委员会", "配额", "政治", "政府", "干部", "群众"]

pytestmark = pytest.mark.skipif(not SRC.is_dir(), reason="flagship module source not checked out")


def _card() -> dict:
    return json.loads((SRC / "cards/antu.lorecard.json").read_text(encoding="utf-8"))


def _player_visible_texts(card: dict) -> list[str]:
    """Every player-grade text surface in the pack."""
    texts: list[str] = [card.get("description", ""), card.get("scenario", "")]
    texts.append(card.get("opening", ""))
    texts.extend(card.get("alternate_openings", []))
    for pg in card.get("pregens", []):
        texts.extend([pg.get("name", ""), pg.get("concept", ""), pg.get("notes", "")])
    for entry in card.get("worldbook", []):
        if not entry.get("secret"):
            texts.extend([entry.get("title", ""), entry.get("content", "")])
    for lb in (SRC / "lorebooks").glob("*.json"):
        for e in json.loads(lb.read_text(encoding="utf-8"))["entries"]:
            texts.append(e["content"])
    return texts


def test_pack_builds(tmp_path):
    # build_pack runs the real manifest/rulepack/card/panel/skill parsers,
    # including extends: resolution against the bundled coc7 base.
    built = build_pack(SRC, tmp_path / "antu.lwpack")
    assert built.manifest.id == "antu"


def test_lorecard_parses():
    card = parse_lorecard_bytes((SRC / "cards/antu.lorecard.json").read_bytes(), "antu.lorecard.json")
    assert card.card.name == "安土"
    assert card.variable_specs and card.pregens


def test_sentinels_only_in_secret_entries():
    card = _card()
    secret_blob = ""
    for entry in card.get("worldbook", []):
        blob = entry.get("title", "") + entry.get("content", "")
        if entry.get("secret"):
            secret_blob += blob
        else:
            for word in SENTINELS:
                assert word not in blob, f"sentinel {word!r} leaked into public entry {entry.get('id')}"
    # Each sentinel must actually live behind the keeper wall (no dead clue).
    for word in SENTINELS:
        assert word in secret_blob, f"sentinel {word!r} missing from keeper entries"
    for text in _player_visible_texts(card):
        for word in SENTINELS:
            assert word not in text, f"sentinel {word!r} leaked into a player-visible surface"


def test_displacement_blacklist():
    card = _card()
    texts = _player_visible_texts(card)
    texts.extend(
        e.get("content", "") for e in card.get("worldbook", []) if e.get("secret")
    )
    for text in texts:
        for word in BLACKLIST:
            assert word not in text, f"blacklisted modern term {word!r} in module text"


# ---------------------------------------------------------------------------
# Ending-gate audit (全纲 §8): the gate table lives in hooks.js as arithmetic and in the
# rulepack as the root band ladder. These tests lock the band boundaries so a content edit
# cannot silently move a threshold the fiction quotes (600/800/12/150/180, 清/闻/识/缠/定).
# ---------------------------------------------------------------------------

quickjs = pytest.importorskip("quickjs")  # noqa: E402 — the hook layer is inert without the ejs extra

from core.hooks import HookScript, create_hook_engine  # noqa: E402
from core.rulepacks import load_raw_rulepack_yaml, parse_rulepack_text  # noqa: E402

HOOKS = SRC / "skills/antu-keeper/hooks.js"


def _defaults() -> dict:
    return {v["id"]: v["default"] for v in _card()["variables"]}


def _engine(**overrides):
    flat = _defaults()
    flat.update(overrides)
    engine = create_hook_engine([HookScript(source_id="antu-keeper", code=HOOKS.read_text(encoding="utf-8"))], flat_variables=flat, tree={})
    assert engine is not None and not engine.load_warnings, engine.load_warnings
    return engine


def _writes(outcome) -> dict:
    return dict(outcome.writes)


def test_calendar_sync_from_clock_advance():
    engine = _engine(day=0)
    w = _writes(engine.fire("clock_advanced", {"from": "六月初一", "to": "六月初四", "delta": "+3天"}))
    assert w["day"] == 3 and w["window_days"] == 147 and "window_state" not in w  # still waiting (default)
    engine = _engine(day=148)
    w = _writes(engine.fire("clock_advanced", {"from": "", "to": "", "delta": "2 days"}))
    # v0.2.2: crossing day 150 also ledgers the keeper whisper — "entered", read
    # (and cleared) by the next turn_start.
    assert w == {"day": 150, "window_days": 0, "window_state": "open", "clock_jump_notice": "entered"}
    engine = _engine(day=179, window_state="open", window_days=0)
    w = _writes(engine.fire("clock_advanced", {"from": "", "to": "", "delta": "+1日"}))
    assert w["window_state"] == "missed"


@pytest.mark.parametrize(
    "mobile,timber,day,expected",
    [(599, 12, 150, False), (600, 12, 150, True), (600, 11, 150, False), (600, 12, 149, False),
     (600, 12, 179, True), (600, 12, 180, False), (800, 24, 160, True)],
)
def test_column_gate_boundaries(mobile, timber, day, expected):
    engine = _engine(mobile_count=mobile, timber_stock=timber, day=day, gate_column=not expected)
    w = _writes(engine.fire("turn_start", {"user_message": "x"}))
    assert w.get("gate_column") is expected


def test_stayed_count_lands_when_the_column_forms():
    engine = _engine(mobile_count=760, timber_stock=12, day=155, column_state="forming")
    w = _writes(engine.fire("turn_start", {"user_message": "x"}))
    assert w["stayed_count"] == 3200 - 760


def test_truth_gate_guards_the_staging_variable():
    engine = _engine(gate_truth=False)
    denied = engine.fire("tool_use", {"tool": "set_variable", "arguments": {"var_id": "truth_staging", "value": "staged"}})
    assert denied.deny and "gate_truth" in denied.deny
    allowed = _engine(gate_truth=True).fire("tool_use", {"tool": "set_variable", "arguments": {"var_id": "truth_staging", "value": "detonated"}})
    assert allowed.deny is None
    # A staging value that slipped past the guard is reverted at the next turn start.
    w = _writes(_engine(gate_truth=False, truth_staging="staged").fire("turn_start", {"user_message": "x"}))
    assert w["truth_staging"] == "unrevealed"


def test_ledger_is_hook_owned_while_marching():
    marching = _engine(column_state="marching")
    assert marching.fire("tool_use", {"tool": "adjust_variable", "arguments": {"var_id": "taken_count", "delta": 5}}).deny
    forming = _engine(column_state="forming")
    assert forming.fire("tool_use", {"tool": "set_variable", "arguments": {"var_id": "belt_load", "value": 0}}).deny is None


def _march(engine, faces):
    text = f"🎲 {len(faces)}d10>=6 = [{', '.join(str(f) for f in faces)}] = {sum(1 for f in faces if f >= 6)}"
    return engine.fire("dice_rolled", {"rolls": [{"tool": "roll_dice", "result": text}]})


def test_crossing_day_hour_clean_march():
    engine = _engine(column_state="marching", mobile_count=800, timber_stock=12, gate_column=True, day=155)
    out = _march(engine, [8, 9, 10, 4, 3, 9, 8, 10])  # s=6, o=0 → 齐速
    w = _writes(out)
    assert w == {"march_hour": 1, "crossed_count": 6 * 25 + 25, "taken_count": 0, "belt_load": 0}
    hour = next(p for p in out.panel_events if p["payload"]["kind"] == "hour")["payload"]
    assert hour["rank"] == "qisu" and hour["phase"] == "day" and hour["blood_arc"] is False


def test_crossing_naming_and_breach_arithmetic():
    engine = _engine(column_state="marching", mobile_count=600, timber_stock=12, gate_column=True, day=155)
    w = _writes(_march(engine, [1, 1, 2, 3, 4, 5, 6, 7]))  # day: s=2, o=2 → 缠窝
    assert w["crossed_count"] == 50 and w["taken_count"] == 20 and w["belt_load"] == 2
    engine = _engine(column_state="marching", mobile_count=600, gate_column=True, march_hour=6, day=155)
    out = _march(engine, [1, 2, 3, 4, 5, 4, 3, 2])  # night hour 7: s=0, o=1 → 决口
    w = _writes(out)
    assert w["march_hour"] == 7 and w["taken_count"] == 10 + 50 and w["belt_load"] == 1
    assert any(p["payload"]["kind"] == "naming" and p["payload"]["count"] == 1 for p in out.panel_events)


def test_overload_doubles_the_take_and_blood_arc_caps_at_eight():
    engine = _engine(column_state="marching", mobile_count=800, gate_column=True, belt_load=12, day=155)
    assert _writes(_march(engine, [1, 2, 3, 4, 5, 2, 3, 4]))["taken_count"] == 20  # doubled at cap 12
    engine = _engine(column_state="marching", mobile_count=800, gate_column=True, belt_load=11, day=155)
    assert _writes(_march(engine, [1, 2, 3, 4, 5, 2, 3, 4]))["taken_count"] == 10  # under cap
    blood = _engine(column_state="marching", mobile_count=800, gate_column=False, belt_load=8, day=100)
    out = _march(blood, [1, 2, 3, 4, 5, 2, 3, 4])
    assert _writes(out)["taken_count"] == 20  # blood arc: cap 8
    assert next(p for p in out.panel_events if p["payload"]["kind"] == "hour")["payload"]["blood_arc"] is True


def test_crossing_ends_at_dawn_and_the_remainder_is_taken():
    engine = _engine(column_state="marching", mobile_count=800, gate_column=True, march_hour=11,
                     crossed_count=500, taken_count=40, day=155)
    w = _writes(_march(engine, [6, 2, 3, 4, 5, 2, 3, 4]))  # s=1 → +25 crossed, then dawn
    assert w["column_state"] == "done" and w["crossed_count"] == 525 and w["taken_count"] == 800 - 525
    finished = _engine(column_state="marching", mobile_count=600, gate_column=True, crossed_count=590, day=155)
    w = _writes(_march(finished, [8, 8, 8, 8, 8, 8]))
    assert w["column_state"] == "done" and w["crossed_count"] == 600 and w["taken_count"] == 0


def test_no_bookkeeping_outside_the_march():
    idle = _engine(column_state="forming", mobile_count=800)
    assert _march(idle, [8, 8, 8]).writes == []
    done = _engine(column_state="marching", march_hour=12)
    assert _march(done, [8, 8, 8]).writes == []


def test_root_band_boundaries():
    src = (SRC / "rulepacks/coc7-antu.yaml").read_text(encoding="utf-8")
    pack = parse_rulepack_text("coc7-antu", src, base_loader=load_raw_rulepack_yaml)
    bands = {0: "清", 14: "清", 15: "闻", 39: "闻", 40: "识", 69: "识", 70: "缠", 89: "缠", 90: "定", 100: "定"}
    for root, band in bands.items():
        assert pack.compute_derived({"根值": root})["根值段"] == band, (root, band)


def test_variables_match_the_canon_gate_table():
    variables = {v["id"]: v for v in _card()["variables"]}
    assert len(variables) == 33
    for gate in ("gate_truth", "gate_window", "gate_column"):
        assert variables[gate]["kind"] == "bool" and variables[gate]["visibility"] == "player"
    assert variables["window_state"]["options"] == ["waiting", "open", "missed"]
    assert variables["column_state"]["options"] == ["waiting", "forming", "marching", "done"]
    assert variables["window_days"]["default"] == 150 and variables["day"]["default"] == 0
    assert variables["belt_load"]["maximum"] == 16 and variables["march_hour"]["maximum"] == 12
    keeper_only = {k for k, v in variables.items() if v["visibility"] == "keeper"}
    assert keeper_only == {"truth_staging", "coalition_wen", "coalition_jiao", "coalition_zhu", "coalition_pei",
                          "therm_shenju", "therm_licheng", "therm_fougen", "therm_qianjing", "therm_yujia", "therm_minqing",
                          # v0.2.2: the hooks' own keeper-side scratch — the clock-jump whisper ledger
                          # and the forming-stall counter. Whisper state, never panel-bound.
                          "clock_jump_notice", "forming_turns"}


def test_authoring_sources_are_in_sync():
    """The card is generated from authoring/lore/*.md — a hand edit of the JSON would be lost."""
    build = SRC / "authoring" / "build_card.py"
    if not build.is_file():
        pytest.skip("authoring sources not present")
    import subprocess
    import sys
    result = subprocess.run([sys.executable, str(build), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr or result.stdout
