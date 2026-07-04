"""Tests for the rule-pack data-plugin foundation (core/rulepacks.py).

Covers: (a) coc7/dnd5e behavior-preservation against pre-refactor baseline
numbers, (b) a brand-new pure-data system loading via the declarative DSL
only, (c) each declarative primitive in isolation (including inclusive range
boundaries), (d) available_systems() discovery, (e) unknown-system errors,
and (f) discovery robustness against one malformed pack file.
"""

from __future__ import annotations

import pytest

import core.rulepacks as rulepacks_module
from core.rulepacks import available_systems, load_rulepack


# ---------------------------------------------------------------------------
# (a) coc7 / dnd5e must stay byte-identical to the pre-refactor behavior.
# These expected numbers were computed from the ORIGINAL hardcoded
# `_COC_DERIVED`/`_DND_DERIVED` tables before the YAML-driven refactor.
# ---------------------------------------------------------------------------


def test_coc7_compute_derived_matches_pre_refactor_baseline():
    pack = load_rulepack("coc7")
    values = dict(pack.defaults)
    values.update({"力量": 60, "体型": 70, "敏捷": 55, "体质": 65, "意志": 50, "教育": 60, "克苏鲁神话": 10})

    assert pack.compute_derived(values) == {
        "DB": "1d4",
        "体格": 1,
        "移动力": 7,
        "生命值上限": 13,
        "生命值": 13,
        "魔法值上限": 10,
        "魔法值": 10,
        "理智上限": 89,
        "母语": 60,
        "闪避": 27,
    }


def test_coc7_compute_derived_matches_baseline_low_totals():
    pack = load_rulepack("coc7")
    values = dict(pack.defaults)
    values.update({"力量": 40, "体型": 40, "敏捷": 90, "体质": 30, "意志": 25, "教育": 45, "克苏鲁神话": 0})

    assert pack.compute_derived(values) == {
        "DB": "-1",
        "体格": -1,
        "移动力": 8,
        "生命值上限": 7,
        "生命值": 7,
        "魔法值上限": 5,
        "魔法值": 5,
        "理智上限": 99,
        "母语": 45,
        "闪避": 45,
    }


def test_coc7_compute_derived_matches_baseline_high_totals_multidice_db():
    pack = load_rulepack("coc7")
    values = dict(pack.defaults)
    values.update({"力量": 90, "体型": 90, "敏捷": 50, "体质": 90, "意志": 90, "教育": 90, "克苏鲁神话": 0})

    assert pack.compute_derived(values) == {
        "DB": "1d6",
        "体格": 2,
        "移动力": 8,
        "生命值上限": 18,
        "生命值": 18,
        "魔法值上限": 18,
        "魔法值": 18,
        "理智上限": 99,
        "母语": 90,
        "闪避": 25,
    }


def test_dnd5e_compute_derived_matches_pre_refactor_baseline():
    pack = load_rulepack("dnd5e")
    values = dict(pack.defaults)
    values.update({"力量": 14, "敏捷": 16, "体质": 12, "智力": 10, "感知": 13, "魅力": 8})

    assert pack.compute_derived(values) == {
        "pp": 10,
        "力量调整值": 2,
        "敏捷调整值": 3,
        "体质调整值": 1,
        "智力调整值": 0,
        "感知调整值": 1,
        "魅力调整值": -1,
        "运动": 2,
        "体操": 3,
        "巧手": 3,
        "隐匿": 3,
        "调查": 0,
        "奥秘": 0,
        "历史": 0,
        "自然": 0,
        "宗教": 0,
        "察觉": 1,
        "洞悉": 1,
        "驯兽": 1,
        "医药": 1,
        "求生": 1,
        "游说": -1,
        "欺瞒": -1,
        "威吓": -1,
        "表演": -1,
    }


def test_coc7_named_computer_matches_declarative_form():
    """母语 (copy_of) and 闪避 (half_of) must equal the old bespoke functions."""
    pack = load_rulepack("coc7")
    values = dict(pack.defaults)
    values.update({"教育": 73, "敏捷": 61})
    derived = pack.compute_derived(values)

    assert derived["母语"] == 73  # _coc_own_language(values) == EDU
    assert derived["闪避"] == 30  # _coc_dodge(values) == DEX // 2


def test_coc7_declarative_derived_matches_old_defaults_on_partial_or_nonnumeric():
    """A declarative copy_of/half_of must int-coerce and fall back to the source stat's
    DECLARED default — byte-identical to the old `_coc_own_language`/`_coc_dodge`
    (both defaulted to 50) for a partial or non-numeric values dict, not None/0."""
    pack = load_rulepack("coc7")

    # Missing 教育/敏捷 -> the stat's declared default (50), exactly like the old functions.
    missing = pack.compute_derived({})
    assert missing["母语"] == 50  # _int_value({}, 教育, 50)
    assert missing["闪避"] == 25  # _int_value({}, 敏捷, 50) // 2

    # Numeric strings are coerced to int (母语 must be int 73, never the str "73").
    numeric_str = pack.compute_derived({"教育": "73", "敏捷": "61"})
    assert numeric_str["母语"] == 73
    assert numeric_str["闪避"] == 30

    # Non-numeric garbage falls back to the default, not passed through.
    garbage = pack.compute_derived({"教育": "abc", "敏捷": "xyz"})
    assert garbage["母语"] == 50
    assert garbage["闪避"] == 25


# ---------------------------------------------------------------------------
# (d) / (e) discovery + resolution over the real rulepacks/ directory.
# ---------------------------------------------------------------------------


def test_available_systems_contains_builtin_packs():
    systems = available_systems()
    assert "coc7" in systems
    assert "dnd5e" in systems
    assert systems == sorted(systems)


def test_load_rulepack_resolves_declared_names_and_set_keys():
    coc = load_rulepack("coc7")
    dnd = load_rulepack("dnd5e")

    assert load_rulepack("coc") is coc
    assert load_rulepack("call of cthulhu") is coc
    assert load_rulepack("CoC7") is coc
    assert load_rulepack("dnd") is dnd
    assert load_rulepack("d&d5e") is dnd


def test_unknown_system_name_raises_value_error():
    with pytest.raises(ValueError):
        load_rulepack("totally-unknown-system-xyz")


# ---------------------------------------------------------------------------
# coc7 intimate/romance aliases (Layer B.2 -- docs/plugins.md "Layer B"): pure
# alias additions to EXISTING canonicals, so romance-forward terms resolve to
# real skills without adding any new default skill to the horror-CoC sheet.
# ---------------------------------------------------------------------------


def test_coc7_intimate_aliases_resolve_to_existing_canonical_skills():
    pack = load_rulepack("coc7")

    assert pack.resolve_skill("魅惑") == "取悦"
    assert pack.resolve_skill("媚惑") == "取悦"
    assert pack.resolve_skill("勾引") == "取悦"
    assert pack.resolve_skill("风情") == "取悦"
    assert pack.resolve_skill("调情") == "话术"
    assert pack.resolve_skill("撩拨") == "话术"
    assert pack.resolve_skill("洞察情感") == "心理学"
    assert pack.resolve_skill("察言观色") == "心理学"
    assert pack.resolve_skill("共情") == "心理学"
    assert pack.resolve_skill("同理心") == "心理学"


def test_coc7_intimate_aliases_add_no_new_default_skills():
    """These romance terms must be aliases only -- none of them is itself a new
    canonical/default skill key on the sheet."""
    pack = load_rulepack("coc7")
    intimate_terms = {
        "魅惑", "媚惑", "勾引", "风情",
        "调情", "撩拨",
        "洞察情感", "察言观色", "共情", "同理心",
    }
    assert intimate_terms.isdisjoint(pack.defaults.keys())


# ---------------------------------------------------------------------------
# (c) declarative primitives in isolation, including inclusive boundaries.
# ---------------------------------------------------------------------------


def test_primitive_copy_of():
    calc = rulepacks_module._compile_derived_spec("test", "母语", {"copy_of": "教育"})
    assert calc({"教育": 55}) == 55
    assert calc({"教育": 0}) == 0


def test_primitive_half_of_uses_integer_floor_division():
    calc = rulepacks_module._compile_derived_spec("test", "闪避", {"half_of": "敏捷"})
    assert calc({"敏捷": 55}) == 27
    assert calc({"敏捷": 54}) == 27
    assert calc({"敏捷": 0}) == 0


def test_primitive_floor_div():
    calc = rulepacks_module._compile_derived_spec("test", "stat", {"floor_div": {"of": "生命值", "by": 3}})
    assert calc({"生命值": 10}) == 3
    assert calc({"生命值": 9}) == 3
    assert calc({"生命值": 11}) == 3


def test_primitive_sum_ranges_inclusive_boundaries():
    spec = {
        "sum_ranges": {
            "of": ["力量", "体型"],
            "ranges": [[0, 64, "low"], [65, 84, "mid"], [85, 124, "high"]],
            "else": "extreme",
        }
    }
    calc = rulepacks_module._compile_derived_spec("test", "stat", spec)

    assert calc({"力量": 30, "体型": 34}) == "low"  # sum == 64, upper bound of "low"
    assert calc({"力量": 30, "体型": 35}) == "mid"  # sum == 65, lower bound of "mid"
    assert calc({"力量": 40, "体型": 44}) == "mid"  # sum == 84, upper bound of "mid"
    assert calc({"力量": 40, "体型": 45}) == "high"  # sum == 85, lower bound of "high"
    assert calc({"力量": 900, "体型": 900}) == "extreme"  # no range matches


def test_primitive_computer_resolves_named_computer():
    calc = rulepacks_module._compile_derived_spec("test", "DB", {"computer": "coc_db"})
    assert calc({"力量": 90, "体型": 90}) == "1d6"


def test_unknown_computer_name_raises_value_error():
    with pytest.raises(ValueError):
        rulepacks_module._compile_derived_spec("test", "stat", {"computer": "no_such_computer"})


def test_unknown_spec_shape_raises_value_error():
    with pytest.raises(ValueError):
        rulepacks_module._compile_derived_spec("test", "stat", {"nonsense_key": 1})


def test_unknown_computer_group_raises_value_error():
    with pytest.raises(ValueError):
        rulepacks_module._compile_derived_section("test", {"whatever": {"computer_group": "no_such_system"}})


# ---------------------------------------------------------------------------
# (b) a brand-new PURE-DATA system, declarative-only, loaded from a fixture
# YAML in a tmp dir. Never pollutes the real rulepacks/ dir or
# available_systems() beyond the scope of this test.
# ---------------------------------------------------------------------------

_PURE_DATA_FIXTURE_YAML = """
names: [puretest, "pure test system"]
defaults:
  力量: 10
  体型: 10
alias:
  力量: [str]
set_keys: [puretest]
derived:
  生命值上限:
    sum_ranges:
      of: [力量, 体型]
      ranges:
        - [0, 15, 5]
        - [16, 25, 10]
      else: 20
  母语:
    copy_of: 力量
  闪避:
    half_of: 体型
"""


def _clear_rulepack_caches() -> None:
    rulepacks_module._discover_registry.cache_clear()
    rulepacks_module._alias_resolver.cache_clear()


def test_pure_data_system_loads_resolves_and_computes(tmp_path, monkeypatch):
    pack_dir = tmp_path / "rulepacks"
    pack_dir.mkdir()
    (pack_dir / "puredata_fixture.yaml").write_text(_PURE_DATA_FIXTURE_YAML, encoding="utf-8")

    monkeypatch.setattr(rulepacks_module, "_RULEPACK_DIR", pack_dir)
    _clear_rulepack_caches()
    try:
        systems = rulepacks_module.available_systems()
        assert systems == ["puredata_fixture"]

        pack = rulepacks_module.load_rulepack("puretest")
        assert pack is rulepacks_module.load_rulepack("pure test system")
        assert pack.system == "puredata_fixture"

        values = dict(pack.defaults)  # 力量=10, 体型=10
        derived = pack.compute_derived(values)
        assert derived["生命值上限"] == 10  # sum=20 falls in [16, 25]
        assert derived["母语"] == 10  # copy_of 力量
        assert derived["闪避"] == 5  # half_of 体型
    finally:
        _clear_rulepack_caches()


# ---------------------------------------------------------------------------
# (f) a malformed pack must not break discovery of the other, valid packs.
# ---------------------------------------------------------------------------


def test_malformed_pack_does_not_break_discovery_of_good_packs(tmp_path, monkeypatch):
    pack_dir = tmp_path / "rulepacks"
    pack_dir.mkdir()
    (pack_dir / "good_fixture.yaml").write_text("names: [goodfixture]\ndefaults: {力量: 5}\n", encoding="utf-8")
    (pack_dir / "broken_syntax.yaml").write_text("not: [valid: yaml: -\n", encoding="utf-8")
    (pack_dir / "broken_derived.yaml").write_text(
        "names: [brokenderived]\nderived:\n  foo: {bogus_key: 1}\n", encoding="utf-8"
    )

    monkeypatch.setattr(rulepacks_module, "_RULEPACK_DIR", pack_dir)
    _clear_rulepack_caches()
    try:
        systems = rulepacks_module.available_systems()
        assert systems == ["good_fixture"]

        pack = rulepacks_module.load_rulepack("goodfixture")
        assert pack.system == "good_fixture"
        assert pack.defaults["力量"] == 5

        with pytest.raises(ValueError):
            rulepacks_module.load_rulepack("brokenderived")
    finally:
        _clear_rulepack_caches()
