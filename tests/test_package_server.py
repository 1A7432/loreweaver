"""Offline, deterministic coverage for `scripts/package_server.py`'s pure logic: the
platform -> asset-name mapping and the archive/executable naming derived from it. Does NOT
invoke PyInstaller or run a real build (that's the real, manually-run proof described in the
packaging task, not something the offline suite does)."""

from __future__ import annotations

import tarfile
from pathlib import Path

import pytest

from scripts import package_server
from scripts.package_server import (
    PackagingError,
    archive_name,
    detect_platform_tag,
    executable_name,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.parametrize(
    ("sys_platform", "machine", "expected"),
    [
        ("darwin", "arm64", "macos-arm64"),
        ("linux", "x86_64", "linux-x64"),
        ("linux", "aarch64", "linux-arm64"),
        ("win32", "AMD64", "windows-x64"),
        # Case-insensitivity of the machine string.
        ("linux", "X86_64", "linux-x64"),
    ],
)
def test_detect_platform_tag_maps_supported_combos(sys_platform, machine, expected):
    assert detect_platform_tag(sys_platform, machine) == expected


def test_detect_platform_tag_rejects_macos_intel_explicitly():
    with pytest.raises(PackagingError, match="iroh"):
        detect_platform_tag("darwin", "x86_64")


@pytest.mark.parametrize(
    ("sys_platform", "machine"),
    [
        ("darwin", "unknown"),
        ("linux", "riscv64"),
        ("win32", "arm64"),
        ("freebsd", "x86_64"),
    ],
)
def test_detect_platform_tag_rejects_unsupported_combos(sys_platform, machine):
    with pytest.raises(PackagingError):
        detect_platform_tag(sys_platform, machine)


def test_archive_name_windows_uses_zip_others_use_tar_gz():
    assert archive_name("windows-x64") == "loreweaver-server-windows-x64.zip"
    assert archive_name("macos-arm64") == "loreweaver-server-macos-arm64.tar.gz"
    assert archive_name("linux-x64") == "loreweaver-server-linux-x64.tar.gz"
    assert archive_name("linux-arm64") == "loreweaver-server-linux-arm64.tar.gz"


def test_executable_name_adds_exe_suffix_only_on_windows():
    assert executable_name("windows-x64") == "loreweaver-server.exe"
    assert executable_name("macos-arm64") == "loreweaver-server"
    assert executable_name("linux-x64") == "loreweaver-server"
    assert executable_name("linux-arm64") == "loreweaver-server"


def test_server_tar_materializes_symlinks_as_regular_files(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    target = bundle / "library-real.so"
    target.write_bytes(b"shared-library")
    (bundle / "library.so").symlink_to(target.name)
    monkeypatch.setattr(package_server, "DIST_DIR", tmp_path / "dist")

    archive = package_server.make_archive(bundle, "linux-x64")

    with tarfile.open(archive, "r:gz") as tf:
        member = tf.getmember("loreweaver-server/library.so")
        assert member.isfile()
        extracted = tf.extractfile(member)
        assert extracted is not None
        assert extracted.read() == b"shared-library"


def test_server_bundle_collects_optional_chat_platform_sdks():
    spec = (REPO_ROOT / "loreweaver-server.spec").read_text(encoding="utf-8")

    assert '"discord"' in spec
    assert '"telegram"' in spec
    assert '"lark_oapi"' in spec
