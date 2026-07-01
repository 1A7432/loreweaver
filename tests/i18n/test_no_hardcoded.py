"""Regression tests for the hardcoded user-facing string linter."""

from __future__ import annotations

import subprocess

from scripts.i18n_lint import DEFAULT_SCAN_PATHS, is_hardcoded_ui_literal, scan_tree


def test_literal_classifier_positive_and_negative_controls():
    assert is_hardcoded_ui_literal("You open the creaking door and step inside.")
    assert is_hardcoded_ui_literal("你打开吱呀作响的门，走了进去。")

    assert not is_hardcoded_ui_literal("dice.result")
    assert not is_hardcoded_ui_literal("module_keeper_pool.{chat_key}")
    assert not is_hardcoded_ui_literal("STR")


def test_real_code_tree_has_no_hardcoded_user_facing_strings():
    assert scan_tree(DEFAULT_SCAN_PATHS) == []


def test_i18n_lint_cli_passes():
    result = subprocess.run(
        [".venv/bin/python", "scripts/i18n_lint.py"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
