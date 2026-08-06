"""Tests for the stage-E script lane: `resolution: {script: ...}` resolvers and
`subsystems: {<id>: {script: ...}}` flows (core/rules_script.py + wiring).

Everything runs through a THIRD-PARTY-shaped fixture pack in a tmp user
rulepack dir — bundled packs stay DSL-only by doctrine, so the script lane is
exercised exactly the way a real extension pack would ship it. Skipped when
the quickjs extra is not installed (same policy as the EJS suite).
"""

import pytest

import core.rulepacks as rulepacks_module
from core.check_outcome import RollDetail
from core.ejs_full import quickjs_available
from core.rules_script import (
    RulesScriptEngine,
    RulesScriptError,
    validate_flow_effect,
    validate_rank_result,
)
from core.rulepacks import load_rulepack, reload_rulepacks

pytestmark = pytest.mark.skipif(not quickjs_available(), reason="quickjs extra not installed")

_SCRIPT_PACK_YAML = """
names: [scriptfate]
defaults:
  勇气: 2
  谨慎: 1
resolution:
  version: 1
  roll: 4d3
  target: dc
  compare: ">="
  script: resolver.js
labels:
  en:
    boon: [Boon]
    hold: [Hold]
    bust: [Bust]
subsystems:
  fate_surge:
    script: surge.js
    rolls: {surge: "2d6"}
    display: {en: Fate surge}
sheet:
  label: ScriptFate
  attributes: {勇气: 2, 谨慎: 1}
  resources: []
"""

# Ladder: total+modifier >= target -> boon (crit when every die shows 3);
# exactly target-1 -> hold; else bust. Margin = roll - target.
_RESOLVER_JS = """
function resolve(input) {
  var target = input.target === null ? 4 : input.target;
  var crit = input.dice.length > 0 && input.dice.every(function (face) { return face === 3; });
  if (input.roll >= target) {
    return {rank: {id: "boon", tier: 2, success: true, critical: crit}, margin: input.roll - target};
  }
  if (input.roll === target - 1) {
    return {rank: {id: "hold", tier: 1}, margin: input.roll - target};
  }
  return {rank: {id: "bust", tier: 0, fumble: true}, margin: input.roll - target};
}
"""

_SURGE_JS = """
function flow(input) {
  var total = input.rolls.surge.total;
  if (total >= 7) {
    return {stat_delta: {勇气: 1}, mark: "surge", narration: "Fate favors the bold."};
  }
  return {stat_delta: {勇气: -1}, narration: "The surge recedes."};
}
"""


@pytest.fixture()
def script_pack(tmp_path):
    (tmp_path / "scriptfate.yaml").write_text(_SCRIPT_PACK_YAML, encoding="utf-8")
    (tmp_path / "resolver.js").write_text(_RESOLVER_JS, encoding="utf-8")
    (tmp_path / "surge.js").write_text(_SURGE_JS, encoding="utf-8")
    original = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    reload_rulepacks()
    try:
        yield load_rulepack("scriptfate")
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original
        reload_rulepacks()


def _rolled(total: int, dice: tuple[int, ...]) -> RollDetail:
    return RollDetail(expression="4d3", dice=dice, total=total)


def test_script_resolver_interprets_success_hold_and_fumble(script_pack):
    resolver = script_pack.resolver
    assert resolver is not None and resolver.script is not None

    boon = resolver.interpret(_rolled(9, (3, 3, 2, 1)), 8)
    assert boon.rank.id == "boon" and boon.rank.success and not boon.rank.critical
    assert boon.margin == 1

    crit = resolver.interpret(_rolled(12, (3, 3, 3, 3)), 8)
    assert crit.rank.critical and crit.rank.success

    hold = resolver.interpret(_rolled(7, (3, 2, 1, 1)), 8)
    assert hold.rank.id == "hold" and not hold.rank.success

    bust = resolver.interpret(_rolled(4, (1, 1, 1, 1)), 8)
    assert bust.rank.fumble and bust.margin == -4


def test_script_resolver_folds_modifier_like_the_dsl_lane(script_pack):
    resolver = script_pack.resolver
    outcome = resolver.interpret(_rolled(6, (2, 2, 1, 1)), 8, modifier=2)
    assert outcome.rank.id == "boon"
    assert outcome.margin == 0


def test_rank_validation_rejects_shape_smuggling():
    with pytest.raises(RulesScriptError, match="unknown keys"):
        validate_rank_result("p", {"rank": {"id": "ok", "tier": 1}, "state": {"evil": 1}})
    with pytest.raises(RulesScriptError, match="unknown keys"):
        validate_rank_result("p", {"rank": {"id": "ok", "tier": 1, "extra": True}})
    with pytest.raises(RulesScriptError, match="must be a boolean"):
        validate_rank_result("p", {"rank": {"id": "ok", "tier": 1, "success": 1}})
    with pytest.raises(RulesScriptError, match="tier"):
        validate_rank_result("p", {"rank": {"id": "ok", "tier": 99}})
    with pytest.raises(RulesScriptError, match="slug"):
        validate_rank_result("p", {"rank": {"id": "Not A Slug", "tier": 1}})


def test_flow_effect_validation_clamps_and_rejects():
    effect = validate_flow_effect("p", "s", {"stat_delta": {"勇气": 5000}, "narration": "x" * 9000})
    assert effect["stat_delta"]["勇气"] == 1000  # magnitude clamp
    assert len(effect["narration"]) == 2000

    with pytest.raises(RulesScriptError, match="unknown effect"):
        validate_flow_effect("p", "s", {"write_file": "/etc/passwd"})
    with pytest.raises(RulesScriptError, match="integers"):
        validate_flow_effect("p", "s", {"stat_delta": {"勇气": "many"}})


def test_infinite_loop_script_fails_at_load_not_hangs():
    with pytest.raises(RulesScriptError, match="failed to load"):
        RulesScriptEngine("p", "resolution.script", "while (true) {}", "resolve")


def test_missing_function_is_a_load_error():
    with pytest.raises(RulesScriptError, match="must define a global function"):
        RulesScriptEngine("p", "resolution.script", "var x = 1;", "resolve")


def test_script_and_ranks_are_mutually_exclusive(tmp_path):
    bad = _SCRIPT_PACK_YAML.replace(
        "  script: resolver.js",
        "  script: resolver.js\n  ranks:\n    - {id: fail, tier: 0}",
    )
    (tmp_path / "badpack.yaml").write_text(bad.replace("[scriptfate]", "[badpack]"), encoding="utf-8")
    (tmp_path / "resolver.js").write_text(_RESOLVER_JS, encoding="utf-8")
    with pytest.raises(ValueError, match="one lane"):
        rulepacks_module.parse_rulepack_text(
            "badpack", (tmp_path / "badpack.yaml").read_text(encoding="utf-8"), script_dir=tmp_path
        )


def test_script_filename_cannot_escape_the_pack_dir(tmp_path):
    sneaky = _SCRIPT_PACK_YAML.replace("script: resolver.js", "script: ../resolver.js")
    (tmp_path / "sneaky.yaml").write_text(sneaky.replace("[scriptfate]", "[sneaky]"), encoding="utf-8")
    with pytest.raises(ValueError, match="bare name"):
        rulepacks_module.parse_rulepack_text(
            "sneaky", (tmp_path / "sneaky.yaml").read_text(encoding="utf-8"), script_dir=tmp_path
        )


def test_script_subsystem_parses_with_rolls_and_engine(script_pack):
    spec = script_pack.subsystems["fate_surge"]
    assert spec.template == "script"
    assert spec.rolls == {"surge": "2d6"}
    assert spec.script is not None
    assert validate_flow_effect(
        "scriptfate", "fate_surge", spec.script.run({"rolls": {"surge": {"total": 9}}, "sheet": {}})
    )["stat_delta"] == {"勇气": 1}
