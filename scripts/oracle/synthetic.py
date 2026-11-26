"""Literal rule packs that exercise DSL features none of the three built-in packs use.

The built-in packs (coc7 / dnd5e / wod) leave most of the pack DSL untouched: a dc-kind system
WITH difficulty transforms, a ``margin`` expression next to a variant ladder, ``floor_div`` /
``half_of`` / banded string results, vitals that start from an expression, a locale-keyed resource
label, a field-based hit-point meter next to an attribute-backed one, ``loss_ceiling``, the
``max`` fumble policy, budgets with alternatives, point-buy... Each pack below is written as YAML
text, recorded VERBATIM in the vectors (``{"kind": "pack", "yaml": ...}``), and registered with the
engine's pack discovery so the same exporter code can drive it by id.

``install()`` writes the packs into a private scratch directory and adds it to rulepack discovery
(a built-in id always wins; these ids are new). It is idempotent.
"""

from __future__ import annotations

from typing import Any

from . import _io  # noqa: F401  (must be imported before the engine; installs the guards)
from ._io import scratch_dir

from core import rulepacks  # isort: skip
from core.rulepacks import load_rulepack  # isort: skip

SYNTH_ID = "oraclesynth"
POOL_ID = "oraclepool"

SYNTH_YAML = """\
names: [oraclesynth, "oracle synth"]
set_keys: [oraclesynth]
defaults:
  muscle: 10
  nerve: 10
  wit: 10
  grit: 3
  level: 1
  athletics: 0
  bluff: 0
  lore: 0
alias:
  muscle: [mus, 肌力, Might]
  nerve: [nrv, 神经]
  wit: [wits, 机智]
  grit: [gr, 毅力]
  level: [lvl, 等级]
  athletics: [athl, 运动力, sport]
  bluff: [bl, 虚张]
  lore: [知识面, "lore master"]
  hp: [HP, 生命]
  hpmax: [HPMAX, 生命上限]
  fate: [FATE, 命运]
derived:
  muscle_mod: {floor_div: {of: muscle, by: 4}}
  nerve_mod: {half_of: nerve}
  wit_mod: {expr: "floor((wit - 10) / 2)"}
  reach: {copy_of: muscle}
  band:
    sum_ranges:
      of: [muscle, nerve]
      ranges: [[0, 9, feeble], [10, 19, weak], [20, 29, fair]]
      else: {expr: "floor((muscle + nerve) / 10)", format: "top-{}"}
  guard: {expr: "if(muscle > 12, 2, 0) + max(1, floor(nerve / 4)) + abs(wit - 10)"}
  prof: {expr: "2 + floor((level - 1) / 4)"}
  fatemax: {expr: "ceil(grit / 2) + min(level, 5)"}
  athletics: {copy_of: muscle_mod}
  bluff: {copy_of: wit_mod}
resolution:
  version: 1
  roll: 1d20
  target: dc
  compare: ">="
  modifiers:
    boon: {roll: "2d20kh1"}
    bane: {roll: "2d20kl1"}
  check:
    favorable: boon
    unfavorable: bane
    default_target: 12
    proficiency: prof
    default_skill: athletics
  difficulties:
    easy: {target: "max(target - 5, 1)", prefixes: {en: [easy], zh: [简单]}}
    hard: {target: "target + 5", prefixes: {en: [hard]}}
    brutal: {target: "max(target + 10, 20)"}
    thirds: {target: "ceil(target / 3)"}
    swing: {target: "abs(target - 15)"}
    flat: {target: "12"}
    plain: {}
  ranks:
    - {id: crit, when: "dice[0] == 20", success: true, critical: true, tier: 4}
    - {id: fumble, when: "dice[0] == 1", fumble: true, tier: 0}
    - {id: strong, when: "roll >= target + 10", success: true, tier: 3}
    - {id: weak, when: "roll >= target", success: true, tier: 2}
    - {id: close, when: "roll >= target - 2 && roll != target - 1", tier: 1}
    - {id: fail, tier: 1}
  variants:
    lenient:
      ranks:
        - {id: crit, when: "dice[0] >= 19", success: true, critical: true, tier: 4}
        - {id: fumble, when: "dice[0] == 1 && roll < target", fumble: true}
        - {id: success, when: "roll >= target", success: true}
        - {id: fail}
  margin: "roll - target"
labels:
  en:
    crit: [Triumph]
    strong: {display: Strong hit, markers: [Clean win]}
    weak: {display: Weak hit, markers: []}
    close: {display: Near miss, markers: []}
    fail: {display: Miss, markers: []}
    fumble: [Disaster]
    success: {display: Success, markers: []}
  zh:
    crit: [大捷]
    strong: {display: 强命中, markers: []}
    fail: {display: 未命中, markers: []}
display:
  zh: {boon: 恩赐, bane: 厄运, muscle: 肌力, nerve: 神经}
  en: {boon: Boon, bane: Bane, muscle: Muscle}
creation_constraints:
  attributes:
    MUS: {min: 3, max: 20, roll: "3d6"}
    NRV: {min: 3, max: 20, roll: "3d6"}
    WIT: {min: 3, max: 20, roll: "4d6kh3"}
  skills:
    default: {min: 0, max: 50, growth_max: 60}
  budgets:
    skill_points:
      parts:
        - "wit * 2"
        - max: ["muscle * 2", "nerve * 3"]
  methods:
    point_buy:
      budget: 20
      min: 6
      max: 14
      costs: {6: 0, 7: 1, 8: 2, 9: 3, 10: 4, 11: 6, 12: 8, 13: 10, 14: 13}
initiative:
  roll: "1d20 + {wit_mod}"
subsystems:
  stress_check:
    template: check_with_loss
    stat: FATE
    stat_max: FATEMAX
    fumble_loss: max
    loss_ceiling: {when: "tag == 'safe' || stat_data.level >= 5", value: 2}
    display: {en: Stress, zh: 压力}
  grow:
    template: improvement_check
    roll: 1d20
    improve: 1d4
    cap: 20
    auto_success_above: 18
    display: {en: Growth, zh: 成长}
  spend_fate:
    template: resource_spend_adjust
    stat: FATE
    display: {en: Fate, zh: 命运}
  clash:
    template: opposed
    display: {en: Clash}
  omen:
    template: table_draw
    default: minor
    display: {en: Omen, zh: 征兆}
    tables:
      minor:
        display: {en: Minor omen, zh: 小征兆}
        aliases: [small, 小]
        entries: [crow, salt, thread]
      major:
        entries: [flood, fire]
sheet:
  label: OracleSynth
  attr_keys: {muscle: MUS, nerve: NRV, wit: WIT, grit: GRIT, fate: FATE, fatemax: FATEMAX}
  skill_keys: {lore: LORE}
  secondary_keys: {prof: PROF, guard: GUARD}
  field_keys: {level: level, class: klass}
  check_values: {muscle: muscle_mod, wit: wit_mod}
  attributes: {MUS: 10, NRV: 10, WIT: 10, GRIT: 3}
  secondary: {PROF: 2, GUARD: 1}
  skills: {LORE: 0, sneak: 5, brawl: 15}
  fields: {level: 1, klass: ""}
  hit_points: {current: 11, max: 11}
  derived_skills: {athletics: athletics, bluff: bluff}
  derived_attrs: {FATEMAX: fatemax}
  derived_secondary: {PROF: prof, GUARD: guard}
  vitals:
    FATE: {max_key: FATEMAX, start: {expr: "min(grit, fatemax)"}}
  resources:
    - {id: hp, label: {en: HP, zh: 体力, ja: 体力値}, source: hit_points}
    - {id: fate, label: Fate, value: FATE, max: FATEMAX}
"""

POOL_YAML = """\
names: [oraclepool]
set_keys: [oraclepool]
defaults: {}
resolution:
  version: 1
  roll: "{pool}d6>={need}"
  target: none
  compare: ">="
  params:
    pool: {min: 1, max: 30, default: 3}
    need: {min: 2, max: 6, default: 5}
  ranks:
    - {id: triumph, when: "successes >= 3", success: true, critical: true, tier: 3}
    - {id: edge, when: "successes >= 1 && successes > ones", success: true, tier: 2}
    - {id: snag, when: "successes >= 1", tier: 1}
    - {id: disaster, when: "ones > 0 && successes == 0", fumble: true, tier: 0}
    - {id: nothing, tier: 1}
  margin: "successes - ones"
"""

SCRIPT_ID = "oraclescript"

SCRIPT_YAML = """\
names: [oraclescript]
set_keys: [oraclescript]
defaults: {}
resolution:
  version: 1
  roll: 1d20
  target: dc
  compare: ">="
  script: resolve.js
  difficulties:
    hard: {target: "target + 5"}
"""

# The QuickJS script lane: the engine pre-rolls, hands the script ONE plain JSON object, and validates
# whatever comes back. The `variant` input steers the deliberately malformed returns.
SCRIPT_JS = """\
function resolve(input) {
  var v = input.variant;
  if (v === 'bad_id') return {rank: {id: 'Bad Id', tier: 1}, margin: null};
  if (v === 'tier_high') return {rank: {id: 'x', tier: 99}, margin: null};
  if (v === 'tier_negative') return {rank: {id: 'x', tier: -1}, margin: null};
  if (v === 'tier_float') return {rank: {id: 'x', tier: 1.5}, margin: null};
  if (v === 'flag_string') return {rank: {id: 'x', tier: 1, success: 'yes'}, margin: null};
  if (v === 'extra_key') return {rank: {id: 'x', tier: 1}, margin: null, state: 1};
  if (v === 'extra_rank_key') return {rank: {id: 'x', tier: 1, label: 'L'}, margin: null};
  if (v === 'margin_float') return {rank: {id: 'x', tier: 1}, margin: 1.5};
  if (v === 'margin_string') return {rank: {id: 'x', tier: 1}, margin: '3'};
  if (v === 'no_rank') return {margin: 1};
  if (v === 'not_object') return 'hello';
  if (v === 'array') return [1, 2];
  if (v === 'null') return null;
  if (v === 'throws') throw new Error('boom');
  if (v === 'undefined') return undefined;
  var margin = input.target === null ? null : input.roll - input.target;
  var first = input.dice.length ? input.dice[0] : 0;
  if (first === 20) return {rank: {id: 'nat20', tier: 3, success: true, critical: true}, margin: margin};
  if (first === 1) return {rank: {id: 'nat1', tier: 0, fumble: true}, margin: margin};
  if (input.target === null) return {rank: {id: 'ungraded', tier: 1}, margin: null};
  if (margin >= 0) return {rank: {id: input.difficulty === 'hard' ? 'hard_win' : 'win', tier: 2, success: true}, margin: margin};
  return {rank: {id: 'loss', tier: 1}, margin: margin};
}
"""

PACKS: dict[str, str] = {SYNTH_ID: SYNTH_YAML, POOL_ID: POOL_YAML, SCRIPT_ID: SCRIPT_YAML}
PACK_FILES: dict[str, dict[str, str]] = {SCRIPT_ID: {"resolve.js": SCRIPT_JS}}

_INSTALLED = False


def install() -> None:
    """Register the literal packs with rulepack discovery (idempotent)."""
    global _INSTALLED
    if _INSTALLED:
        return
    directory = scratch_dir() / "synthetic-packs"
    directory.mkdir(exist_ok=True)
    for pack_id, text in PACKS.items():
        (directory / f"{pack_id}.yaml").write_text(text, encoding="utf-8")
    for pack_id, files in PACK_FILES.items():
        (directory / pack_id).mkdir(exist_ok=True)
        for filename, source in files.items():
            (directory / pack_id / filename).write_text(source, encoding="utf-8")
    rulepacks.set_extra_rulepack_dirs([directory])
    for pack_id in PACKS:
        load_rulepack(pack_id)  # fail loudly here if a literal pack stopped compiling
    _INSTALLED = True


def pack_rows() -> list[dict[str, Any]]:
    """The literal pack sources, recorded verbatim so another implementation can load them."""
    return [
        {"kind": "pack", "pack": pack_id, "yaml": text, "files": PACK_FILES.get(pack_id, {})}
        for pack_id, text in PACKS.items()
        if pack_id != SCRIPT_ID
    ]


def script_pack_rows() -> list[dict[str, Any]]:
    """The script-lane pack: its YAML plus the JavaScript file it names."""
    return [{"kind": "pack", "pack": SCRIPT_ID, "yaml": SCRIPT_YAML, "files": PACK_FILES[SCRIPT_ID]}]
