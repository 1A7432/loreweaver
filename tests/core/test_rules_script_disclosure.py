"""Disclosure + per-pack isolation for the stage-E rules-script lane.

`has_rules_script` is computed at build, re-verified at install and covered by the
tamper-protected field set — and used to be shown to nobody. Three surfaces:

* the pre-install **trust card**, which named hooks and EJS templates but not the
  code that decides whether a player's check succeeds;
* **`--doctor`**, which printed every pack's resolution as the literal "dsl", so a
  script-lane pack was indistinguishable from a declarative one;
* the **install layout**, which dropped every rulepack's scripts into the shared
  user rulepacks dir under their BARE filename — two packs shipping `resolver.js`
  (the name M16's own examples use) silently overwrote each other, and the
  survivor then decided both packs' checks.

Disclosure, not gating: nothing here refuses a pack or asks for a permission.
The operator's protection is knowing what an archive carries before installing it.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import pytest

import app
import core.rulepacks as rulepacks_module
from core.check_outcome import RollDetail
from core.ejs_full import quickjs_available
from core.pack import MANIFEST_NAME, PackManifest, PackTrust, build_pack, install_pack
from core.rulepacks import load_rulepack, reload_rulepacks
from infra.config import Settings
from infra.i18n import get_i18n

requires_quickjs = pytest.mark.skipif(not quickjs_available(), reason="quickjs extra not installed")


# --- fixtures: a third-party-shaped script pack -----------------------------

# `__RULEPACK__`/`__RANK__` are substituted per pack so two packs can ship the
# same script FILENAME with demonstrably different verdicts.
SCRIPT_RULEPACK_YAML = """
names: [__RULEPACK__]
defaults: {勇气: 2}
resolution:
  version: 1
  roll: 1d6
  target: dc
  compare: ">="
  script: resolver.js
labels:
  en:
    __RANK__: [Hit]
    miss: [Miss]
"""

RESOLVER_JS = """
function resolve(input) {
  var target = input.target === null ? 4 : input.target;
  if (input.roll >= target) {
    return {rank: {id: "__RANK__", tier: 1, success: true}, margin: input.roll - target};
  }
  return {rank: {id: "miss", tier: 0}, margin: input.roll - target};
}
"""

PACK_MANIFEST = """\
id: __PACKID__
version: 1.0.0
name: __PACKID__
description: a rules-script fixture
authors: [ada]
license: MIT
engine: {}
contents:
  rulepacks: [rulepacks/__RULEPACK__.yaml]
"""


def _substitute(text: str, *, rulepack_id: str = "", rank_id: str = "", pack_id: str = "") -> str:
    return (
        text.replace("__RULEPACK__", rulepack_id)
        .replace("__RANK__", rank_id)
        .replace("__PACKID__", pack_id)
    )


def _build_script_pack(root: Path, *, pack_id: str, rulepack_id: str, rank_id: str) -> Path:
    """Build a one-rulepack `.lwpack` whose resolver.js grades a hit as `rank_id`."""
    src = root / f"{pack_id}-src"
    (src / "rulepacks").mkdir(parents=True)
    (src / "rulepacks" / f"{rulepack_id}.yaml").write_text(
        _substitute(SCRIPT_RULEPACK_YAML, rulepack_id=rulepack_id, rank_id=rank_id), encoding="utf-8"
    )
    (src / "rulepacks" / "resolver.js").write_text(
        _substitute(RESOLVER_JS, rank_id=rank_id), encoding="utf-8"
    )
    (src / MANIFEST_NAME).write_text(
        _substitute(PACK_MANIFEST, rulepack_id=rulepack_id, pack_id=pack_id), encoding="utf-8"
    )
    return build_pack(src, root / f"{pack_id}.lwpack").path


def _install(pack_path: Path, data_dir: Path):
    return install_pack(
        pack_path,
        packs_dir=data_dir / "packs",
        skills_dir=data_dir / "skills",
        rulepacks_dir=data_dir / "rulepacks",
        presets_dir=data_dir / "presets",
        current_protocol="2.1",
        current_server="1.0.0",
    )


@contextmanager
def _user_rulepack_dir(directory: Path):
    original = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = directory
    reload_rulepacks()
    try:
        yield
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original
        reload_rulepacks()


def _hit_rank(system: str) -> str:
    """The rank id `system`'s own resolver hands back for a made check."""
    resolver = load_rulepack(system).resolver
    assert resolver is not None and resolver.script is not None
    return resolver.interpret(RollDetail(expression="1d6", dice=(6,), total=6), 4).rank.id


# --- (a) the trust card -----------------------------------------------------


def _manifest(*, has_rules_script: bool) -> PackManifest:
    return PackManifest(
        id="scriptpack",
        version="1.0.0",
        name={"en": "Script Pack"},
        description={"en": "a fixture"},
        authors=("ada",),
        license="MIT",
        engine={},
        contents={"rulepacks": ("rulepacks/scripted.yaml",)},
        assets=(),
        trust=PackTrust(rulepacks=1, has_rules_script=has_rules_script),
    )


def test_trust_card_discloses_that_a_pack_decides_its_own_check_outcomes(capsys):
    app._print_trust_card(get_i18n("en"), _manifest(has_rules_script=True), "en")
    disclosed = capsys.readouterr().err

    app._print_trust_card(get_i18n("en"), _manifest(has_rules_script=False), "en")
    dsl_only = capsys.readouterr().err

    assert "rules code: yes" in disclosed, disclosed
    assert "check outcomes" in disclosed, disclosed
    # Positive control: a pack without a script must not be accused of carrying one.
    assert "rules code: no" in dsl_only, dsl_only
    assert "check outcomes" not in dsl_only, dsl_only


def test_the_rules_script_disclosure_is_localized(capsys):
    app._print_trust_card(get_i18n("zh"), _manifest(has_rules_script=True), "zh")
    disclosed = capsys.readouterr().err

    app._print_trust_card(get_i18n("zh"), _manifest(has_rules_script=False), "zh")
    dsl_only = capsys.readouterr().err

    assert "规则脚本:有" in disclosed, disclosed
    assert "判定" in disclosed, disclosed
    assert "规则脚本:无" in dsl_only, dsl_only
    assert "判定" not in dsl_only, dsl_only


# --- (b) --doctor names the resolution lane ---------------------------------


@requires_quickjs
def test_doctor_names_the_resolution_lane_of_each_rulepack(tmp_path, capsys):
    (tmp_path / "scriptlane.yaml").write_text(
        _substitute(SCRIPT_RULEPACK_YAML, rulepack_id="scriptlane", rank_id="hit"), encoding="utf-8"
    )
    (tmp_path / "resolver.js").write_text(_substitute(RESOLVER_JS, rank_id="hit"), encoding="utf-8")

    with _user_rulepack_dir(tmp_path):
        assert app._run_doctor(Settings(locale="en"), get_i18n("en")) == 0
    output = capsys.readouterr().err

    assert "scriptlane (resolution: script" in output, output
    # Positive control: the built-in declarative packs still report the DSL lane.
    assert "coc7 (resolution: dsl" in output, output


# --- (c) two packs, one script filename -------------------------------------


@requires_quickjs
def test_two_packs_shipping_resolver_js_each_resolve_with_their_own(tmp_path):
    alpha = _build_script_pack(
        tmp_path, pack_id="alphapack", rulepack_id="alpharules", rank_id="alpha_hit"
    )
    beta = _build_script_pack(
        tmp_path, pack_id="betapack", rulepack_id="betarules", rank_id="beta_hit"
    )
    data_dir = tmp_path / "data"

    _install(alpha, data_dir)
    with _user_rulepack_dir(data_dir / "rulepacks"):
        # Positive control: alone on disk, alpha obviously grades with alpha's script.
        assert _hit_rank("alpharules") == "alpha_hit"

    _install(beta, data_dir)
    with _user_rulepack_dir(data_dir / "rulepacks"):
        assert _hit_rank("betarules") == "beta_hit"
        # The one that used to break: beta's resolver.js had overwritten alpha's.
        assert _hit_rank("alpharules") == "alpha_hit"


@requires_quickjs
def test_installed_scripts_land_namespaced_under_their_rulepack(tmp_path):
    pack = _build_script_pack(
        tmp_path, pack_id="alphapack", rulepack_id="alpharules", rank_id="alpha_hit"
    )
    data_dir = tmp_path / "data"
    _install(pack, data_dir)

    rulepacks_dir = data_dir / "rulepacks"
    assert (rulepacks_dir / "alpharules.yaml").is_file()  # discovery still globs *.yaml here
    assert (rulepacks_dir / "alpharules" / "resolver.js").is_file()
    # The shared-dir bare name is what two packs used to fight over.
    assert not (rulepacks_dir / "resolver.js").exists()
