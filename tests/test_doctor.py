"""Offline subprocess coverage for `python -m app --doctor`: the diagnostics mode that
exercises exactly what a frozen (PyInstaller) bundle tends to break — locale catalogs,
rulepacks, skills, and the resolved data dir — then exits 0 (or non-zero naming what's
missing). `scripts/package_server.py` shells the same `--doctor` flag against the built
binary as part of its build smoke, so this is the offline, source-mode baseline for it."""

from __future__ import annotations

import os
import re
import subprocess
import sys

import pytest

import app
from app import _run_doctor as _run_app_doctor
from infra.config import Settings
from infra.i18n import get_i18n


@pytest.fixture(autouse=True)
def _isolate_runtime_configuration(monkeypatch):
    """Direct doctor calls must not inherit a developer's real bot credentials."""
    for key in tuple(os.environ):
        if key.startswith("TRPG_"):
            monkeypatch.delenv(key)


def _run_doctor() -> tuple[int, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("TRPG_")}
    env["TRPG_ENV_FILE"] = os.devnull
    result = subprocess.run(
        [sys.executable, "-m", "app", "--doctor"],
        check=False,
        capture_output=True,
        text=True,
        env=env,
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


def test_doctor_imports_platform_adapter_registration_path(capsys, monkeypatch):
    calls: list[bool] = []
    monkeypatch.setattr(app, "_register_platform_adapters", lambda: calls.append(True))

    result = _run_app_doctor(Settings(_env_file=None), get_i18n("en"))

    assert result == 0
    assert calls == [True]


def test_doctor_rejects_partial_qq_configuration(capsys):
    settings = Settings(_env_file=None, qq={"app_id": "only-half"})

    result = _run_app_doctor(settings, get_i18n("en"))

    output = capsys.readouterr().err
    assert result == 1
    assert "QQ requires both app_id and secret" in output


def test_doctor_rejects_partial_feishu_configuration(capsys):
    settings = Settings(_env_file=None, feishu={"app_id": "only-half"})

    result = _run_app_doctor(settings, get_i18n("en"))

    output = capsys.readouterr().err
    assert result == 1
    assert "Feishu requires both app_id and app_secret" in output


def test_doctor_rejects_incomplete_onebot_configuration(capsys):
    settings = Settings(
        _env_file=None,
        onebot={"mode": "reverse", "listen_port": 0, "access_token": "configured"},
    )

    result = _run_app_doctor(settings, get_i18n("en"))

    output = capsys.readouterr().err
    assert result == 1
    assert "OneBot requires a valid ws/wss URL" in output


def test_doctor_reports_all_configured_chat_platforms_ready(capsys, monkeypatch):
    real_find_spec = app.importlib.util.find_spec
    monkeypatch.setattr(
        app.importlib.util,
        "find_spec",
        lambda name: object() if name in {"telegram", "lark_oapi"} else real_find_spec(name),
    )
    settings = Settings(
        _env_file=None,
        telegram={"token": "token"},
        feishu={"app_id": "app", "app_secret": "secret"},
        onebot={"mode": "forward", "ws_url": "ws://127.0.0.1:3001"},
    )

    result = _run_app_doctor(settings, get_i18n("en"))

    output = capsys.readouterr().err
    assert result == 0
    assert "Telegram: ready (sdk=True)" in output
    assert "Feishu: ready (sdk=True)" in output
    assert "OneBot 11: ready (forward WebSocket)" in output
