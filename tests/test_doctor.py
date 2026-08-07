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


# --- P2: the Scribe cost advisory -------------------------------------------


def _doctor_stderr(capsys, settings) -> str:
    from app import _run_doctor
    from infra.i18n import get_i18n

    assert _run_doctor(settings, get_i18n(settings.locale)) == 0, "an advisory must never fail the check"
    return capsys.readouterr().err


def test_doctor_warns_when_a_subscription_quota_is_paying_for_bookkeeping(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "chatgpt"
    settings.llm.base_url = ""  # no proxy -> the real subscription OAuth path

    output = _doctor_stderr(capsys, settings)

    assert "SUBSCRIPTION quota" in output
    assert "TRPG_SCRIBE__" in output


def test_doctor_warns_about_flagship_prices_on_a_paid_provider(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "deepseek"

    output = _doctor_stderr(capsys, settings)

    assert "flagship prices" in output


def test_doctor_says_nothing_once_the_scribe_has_its_own_model(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "chatgpt"
    settings.scribe.chat_model = "deepseek-v4-flash"

    assert "TRPG_SCRIBE__" not in _doctor_stderr(capsys, settings)


def test_doctor_says_nothing_with_the_scribe_off(capsys):
    settings = Settings(locale="en")
    settings.llm.provider = "chatgpt"
    settings.scribe.enabled = False

    assert "TRPG_SCRIBE__" not in _doctor_stderr(capsys, settings)


def test_doctor_says_nothing_on_a_local_provider(capsys):
    # Nothing to save: the advice would be pure noise on a model you host yourself.
    settings = Settings(locale="en")
    settings.llm.provider = "ollama"

    assert "TRPG_SCRIBE__" not in _doctor_stderr(capsys, settings)


def test_the_advisory_is_localized(capsys):
    settings = Settings(locale="zh")
    settings.llm.provider = "chatgpt"

    output = _doctor_stderr(capsys, settings)

    assert "书记官" in output and "TRPG_SCRIBE__" in output


def test_provider_cost_class_names_what_an_operator_can_act_on():
    from infra.config import LLMSettings
    from infra.providers import provider_cost_class

    assert provider_cost_class(LLMSettings(provider="chatgpt")) == "subscription"
    assert provider_cost_class(LLMSettings(provider="supergrok")) == "subscription"
    # A `chatgpt` name WITH a base_url is an operator-run proxy, billed per token.
    assert provider_cost_class(LLMSettings(provider="chatgpt", base_url="https://proxy/v1")) == "paid"
    assert provider_cost_class(LLMSettings(provider="openai")) == "paid"
    assert provider_cost_class(LLMSettings(provider="")) == "paid"  # default is openai
    for local in ("ollama", "lmstudio", "vllm"):
        assert provider_cost_class(LLMSettings(provider=local)) == "local"
