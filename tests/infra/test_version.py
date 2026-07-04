"""Offline coverage for `infra/version.py`'s fallback chain and `python -m app
--version`'s CLI surface. Deterministic — no real git/network calls; each source in
the chain is monkeypatched independently."""

from __future__ import annotations

import re
import subprocess
import sys
from importlib import metadata

import pytest

from infra import version as version_mod


def test_resolve_version_prefers_scm_module(monkeypatch):
    monkeypatch.setattr(version_mod, "_from_scm_module", lambda: "1.2.3")
    monkeypatch.setattr(version_mod, "_from_installed_metadata", lambda: "9.9.9")
    monkeypatch.setattr(version_mod, "_from_frozen_sidecar", lambda: "8.8.8")
    assert version_mod.resolve_version() == "1.2.3"


def test_resolve_version_falls_back_to_installed_metadata(monkeypatch):
    monkeypatch.setattr(version_mod, "_from_scm_module", lambda: None)
    monkeypatch.setattr(version_mod, "_from_installed_metadata", lambda: "2.0.0")
    monkeypatch.setattr(version_mod, "_from_frozen_sidecar", lambda: "8.8.8")
    assert version_mod.resolve_version() == "2.0.0"


def test_resolve_version_falls_back_to_frozen_sidecar(monkeypatch):
    monkeypatch.setattr(version_mod, "_from_scm_module", lambda: None)
    monkeypatch.setattr(version_mod, "_from_installed_metadata", lambda: None)
    monkeypatch.setattr(version_mod, "_from_frozen_sidecar", lambda: "3.4.5")
    assert version_mod.resolve_version() == "3.4.5"


def test_resolve_version_falls_back_to_constant_when_everything_is_missing(monkeypatch):
    monkeypatch.setattr(version_mod, "_from_scm_module", lambda: None)
    monkeypatch.setattr(version_mod, "_from_installed_metadata", lambda: None)
    monkeypatch.setattr(version_mod, "_from_frozen_sidecar", lambda: None)
    assert version_mod.resolve_version() == version_mod.FALLBACK_VERSION


def test_from_scm_module_missing_module_returns_none(monkeypatch):
    # `_lw_version` may genuinely not exist (no build has ever run in this checkout).
    monkeypatch.setitem(sys.modules, "_lw_version", None)
    assert version_mod._from_scm_module() is None


def test_from_installed_metadata_returns_none_when_package_not_found(monkeypatch):
    def _raise(_name):
        raise metadata.PackageNotFoundError

    monkeypatch.setattr(metadata, "version", _raise)
    assert version_mod._from_installed_metadata() is None


def test_from_frozen_sidecar_returns_none_when_not_frozen(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert version_mod._from_frozen_sidecar() is None


def test_from_frozen_sidecar_reads_version_file(monkeypatch, tmp_path):
    (tmp_path / "VERSION").write_text("7.8.9\n", encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    assert version_mod._from_frozen_sidecar() == "7.8.9"


def test_from_frozen_sidecar_missing_file_returns_none(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    assert version_mod._from_frozen_sidecar() is None


_VERSION_RE = re.compile(r"^\d+\.\d+|^0\.0\.0\+unknown")


def test_cli_version_flag_exits_zero_and_prints_pep440_ish_string():
    result = subprocess.run(
        [sys.executable, "-m", "app", "--version"],
        check=False,
        capture_output=True,
        text=True,
    )
    output = result.stdout.strip()
    assert result.returncode == 0, result.stdout + result.stderr
    assert _VERSION_RE.match(output), output
