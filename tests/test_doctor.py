"""Offline subprocess coverage for `python -m app --doctor`: the diagnostics mode that
exercises exactly what a frozen (PyInstaller) bundle tends to break — locale catalogs,
rulepacks, skills, and the resolved data dir — then exits 0 (or non-zero naming what's
missing). `scripts/package_server.py` shells the same `--doctor` flag against the built
binary as part of its build smoke, so this is the offline, source-mode baseline for it."""

from __future__ import annotations

import re
import subprocess
import sys


def _run_doctor() -> tuple[int, str]:
    result = subprocess.run(
        [sys.executable, "-m", "app", "--doctor"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout + result.stderr


def test_doctor_source_mode_exits_zero_and_reports_builtins():
    returncode, output = _run_doctor()

    assert returncode == 0, output
    assert "coc7" in output, output
    assert "dnd5e" in output, output
    assert "en" in output, output
    assert "zh" in output, output


def test_doctor_reports_at_least_four_skills():
    returncode, output = _run_doctor()
    assert returncode == 0, output

    # e.g. "Skills: mature-mode, module-forge, ... (5)" — parse the trailing count.
    match = re.search(r"KP skills:.*\((\d+)\)", output)
    assert match is not None, output
    assert int(match.group(1)) >= 4, output
