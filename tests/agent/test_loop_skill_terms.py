"""The dice-first detectors compile their skill vocabulary from the RULEPACK layer:
system-specific skill nouns never live in engine code, and a custom system's skills
earn roll discipline with zero engine change (iron rule #1)."""

from __future__ import annotations

from agent.loop import _compiled_skill_detectors, _player_attempts_checkable_action, _skill_detectors
from core import rulepacks as rulepacks_module
from core.rulepacks import all_check_terms


def test_builtin_pack_vocabulary_reaches_the_detectors():
    terms = all_check_terms()
    assert "图书馆使用" in terms and "library use" in terms  # coc7 aliases, not engine literals
    en_re, zh_terms = _skill_detectors()
    assert en_re.search("I try a library use on the archives")
    assert any(term == "图书馆使用" for term in zh_terms)
    assert _player_attempts_checkable_action("我对档案室进行图书馆使用。")


def test_a_custom_rulepack_skill_triggers_dice_discipline_without_engine_changes(tmp_path):
    (tmp_path / "xiuxian.yaml").write_text(
        "names: [xiuxian]\nset_keys: [xiuxian]\ndefaults:\n  御剑术: 40\nalias:\n  御剑术: [御剑, sword-riding]\n",
        encoding="utf-8",
    )
    original = rulepacks_module._USER_RULEPACK_DIR
    rulepacks_module._USER_RULEPACK_DIR = tmp_path
    rulepacks_module._discover_registry.cache_clear()
    try:
        assert "御剑术" in all_check_terms()
        assert _player_attempts_checkable_action("我尝试御剑追上那道黑影。")
        assert _player_attempts_checkable_action("I attempt sword-riding across the gorge.")
    finally:
        rulepacks_module._USER_RULEPACK_DIR = original
        rulepacks_module._discover_registry.cache_clear()
        _compiled_skill_detectors.cache_clear()
