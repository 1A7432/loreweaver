"""Offline release-chain checks for the one-line client installers."""

from __future__ import annotations

import hashlib
import io
import os
import subprocess
import tarfile
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BASH_INSTALLER = ROOT / "clients" / "install.sh"
POWERSHELL_INSTALLER = ROOT / "clients" / "install.ps1"


def _client_members(marker: str) -> dict[str, bytes]:
    return {
        "clients/package.json": b"{}\n",
        "clients/bun.lock": b"{}\n",
        "clients/tui/src/index.tsx": b"// test entry\n",
        f"clients/{marker}.txt": marker.encode(),
    }


def _archive(path: Path, marker: str) -> str:
    with tarfile.open(path, "w:gz") as archive:
        for name, payload in _client_members(marker).items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _unsafe_archive(path: Path, *, link_pivot: bool = False) -> str:
    with tarfile.open(path, "w:gz") as archive:
        for name, payload in _client_members("candidate").items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        if link_pivot:
            link = tarfile.TarInfo("clients/pivot")
            link.type = tarfile.SYMTYPE
            link.linkname = "../.."
            archive.addfile(link)
            name = "clients/pivot/escaped.txt"
        else:
            name = "clients/../../escaped.txt"
        payload = b"must not escape"
        info = tarfile.TarInfo(name)
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sidecar(path: Path, digest: str) -> Path:
    sidecar = path.with_name(f"{path.name}.sha256")
    sidecar.write_text(f"{digest}  loreweaver-client.tar.gz\n")
    return sidecar


def _released_installer(tmp_path: Path, *, tag: str, version: str, digest: str) -> Path:
    text = BASH_INSTALLER.read_text()
    replacements = {
        'TRPG_EMBEDDED_RELEASE_TAG=""': f'TRPG_EMBEDDED_RELEASE_TAG="{tag}"',
        'TRPG_EMBEDDED_CLIENT_VERSION=""': f'TRPG_EMBEDDED_CLIENT_VERSION="{version}"',
        'TRPG_EMBEDDED_CLIENT_SHA256=""': f'TRPG_EMBEDDED_CLIENT_SHA256="{digest}"',
    }
    for old, new in replacements.items():
        assert old in text
        text = text.replace(old, new, 1)
    installer = tmp_path / "install.sh"
    installer.write_text(text)
    installer.chmod(0o755)
    return installer


def _fake_commands(tmp_path: Path) -> Path:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    curl = fake_bin / "curl"
    curl.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
url=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2; continue ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done
printf '%s\n' "$url" >> "$INSTALLER_URL_LOG"
if [ -n "${UPDATE_INSTALLER_FILE:-}" ]; then
  case "$url" in
    */install.sh)
      if [ -n "$out" ]; then cp "$UPDATE_INSTALLER_FILE" "$out"; else cat "$UPDATE_INSTALLER_FILE"; fi
      exit 0
      ;;
  esac
fi
primary_archive="$PRIMARY_ARCHIVE"
primary_sidecar="$PRIMARY_SIDECAR"
mirror_archive="$MIRROR_ARCHIVE"
mirror_sidecar="$MIRROR_SIDECAR"
if [ -n "${SECOND_RELEASE_TAG:-}" ] && [[ "$url" == *"/$SECOND_RELEASE_TAG/"* ]]; then
  primary_archive="$SECOND_ARCHIVE"
  primary_sidecar="$SECOND_SIDECAR"
  mirror_archive="$SECOND_ARCHIVE"
  mirror_sidecar="$SECOND_SIDECAR"
fi
case "$url" in
  https://github.com/*)
    [ "${FAIL_PRIMARY:-0}" != "1" ] || exit 22
    case "$url" in
      *.sha256) cp "$primary_sidecar" "$out" ;;
      *) cp "$primary_archive" "$out" ;;
    esac
    ;;
  https://1a7432.site/*)
    case "$url" in
      *.sha256) cp "$mirror_sidecar" "$out" ;;
      *) cp "$mirror_archive" "$out" ;;
    esac
    ;;
  *) exit 22 ;;
esac
"""
    )
    curl.chmod(0o755)
    bun = fake_bin / "bun"
    bun.write_text(
        """#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then printf 'test-bun\n'; fi
if [ "${1:-}" = "install" ] && [ "${FAIL_BUN_INSTALL:-0}" = "1" ]; then exit 42; fi
exit 0
"""
    )
    bun.chmod(0o755)
    return fake_bin


def _run_installer(
    tmp_path: Path,
    installer: Path,
    *,
    primary_archive: Path,
    primary_sidecar: Path,
    mirror_archive: Path,
    mirror_sidecar: Path,
    fail_primary: bool = False,
    fail_bun_install: bool = False,
    release_tag: str = "",
    existing_client: str = "",
) -> tuple[subprocess.CompletedProcess[str], list[str], Path]:
    fake_bin = _fake_commands(tmp_path)
    home = tmp_path / "install-home"
    if existing_client:
        (home / "clients").mkdir(parents=True)
        (home / "clients" / "previous.txt").write_text(existing_client)
    url_log = tmp_path / "urls.log"
    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path / "user-home"),
        "TMPDIR": str(tmp_path),
        "TRPG_HOME": str(home),
        "TRPG_BIN": str(tmp_path / "launcher-bin"),
        "TRPG_LOCAL_SERVER_HOME": str(tmp_path / "server-home"),
        "INSTALLER_URL_LOG": str(url_log),
        "PRIMARY_ARCHIVE": str(primary_archive),
        "PRIMARY_SIDECAR": str(primary_sidecar),
        "MIRROR_ARCHIVE": str(mirror_archive),
        "MIRROR_SIDECAR": str(mirror_sidecar),
        "FAIL_PRIMARY": "1" if fail_primary else "0",
        "FAIL_BUN_INSTALL": "1" if fail_bun_install else "0",
    }
    if release_tag:
        env["TRPG_RELEASE_TAG"] = release_tag
    else:
        env.pop("TRPG_RELEASE_TAG", None)
    result = subprocess.run(
        ["bash", str(installer)],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    urls = url_log.read_text().splitlines() if url_log.exists() else []
    return result, urls, home


def test_source_installer_uses_the_real_github_latest_archive_url(tmp_path: Path):
    archive = tmp_path / "latest.tar.gz"
    digest = _archive(archive, "latest")
    sidecar = _sidecar(archive, digest)

    result, urls, home = _run_installer(
        tmp_path,
        BASH_INSTALLER,
        primary_archive=archive,
        primary_sidecar=sidecar,
        mirror_archive=archive,
        mirror_sidecar=sidecar,
    )

    assert result.returncode == 0, result.stderr
    expected = "https://github.com/1A7432/loreweaver/releases/latest/download/loreweaver-client.tar.gz"
    assert urls[:2] == [expected, f"{expected}.sha256"]
    assert (home / "clients" / "latest.txt").read_text() == "latest"


def test_released_installer_falls_back_to_immutable_tagged_mirror_asset(tmp_path: Path):
    archive = tmp_path / "release.tar.gz"
    digest = _archive(archive, "released")
    sidecar = _sidecar(archive, digest)
    installer = _released_installer(tmp_path, tag="v1.2.3", version="1.2.3", digest=digest)

    result, urls, home = _run_installer(
        tmp_path,
        installer,
        primary_archive=archive,
        primary_sidecar=sidecar,
        mirror_archive=archive,
        mirror_sidecar=tmp_path / "must-not-be-read.sha256",
        fail_primary=True,
    )

    assert result.returncode == 0, result.stderr
    assert urls == [
        "https://github.com/1A7432/loreweaver/releases/download/v1.2.3/loreweaver-client.tar.gz",
        "https://1a7432.site/trpg/releases/v1.2.3/loreweaver-client.tar.gz",
    ]
    assert (home / "clients" / "released.txt").read_text() == "released"
    launcher = (tmp_path / "launcher-bin" / "loreweaver").read_text()
    assert "https://1a7432.site/trpg/install.sh" in launcher
    assert "https://1a7432.site/trpg/releases/v1.2.3/install.sh" not in launcher


def test_pin_different_from_embedded_tag_uses_the_target_sidecar(tmp_path: Path):
    embedded_archive = tmp_path / "embedded.tar.gz"
    embedded_digest = _archive(embedded_archive, "embedded")
    target_archive = tmp_path / "target.tar.gz"
    target_digest = _archive(target_archive, "target")
    target_sidecar = _sidecar(target_archive, target_digest)
    installer = _released_installer(
        tmp_path,
        tag="v2.0.0",
        version="2.0.0",
        digest=embedded_digest,
    )

    result, urls, home = _run_installer(
        tmp_path,
        installer,
        primary_archive=target_archive,
        primary_sidecar=target_sidecar,
        mirror_archive=target_archive,
        mirror_sidecar=target_sidecar,
        fail_primary=True,
        release_tag="release-1.0.0",
    )

    assert result.returncode == 0, result.stderr
    mirror = "https://1a7432.site/trpg/releases/release-1.0.0/loreweaver-client.tar.gz"
    assert urls[-2:] == [mirror, f"{mirror}.sha256"]
    assert (home / "clients" / "target.txt").read_text() == "target"
    launcher = (tmp_path / "launcher-bin" / "loreweaver").read_text()
    assert "https://1a7432.site/trpg/releases/release-1.0.0/install.sh" in launcher


@pytest.mark.parametrize(
    ("overrides", "expected_version", "expected_server_tag"),
    [
        ({}, "2.0.0", "v2.0.0"),
        ({"TRPG_CLIENT_VERSION": "operator-client"}, "operator-client", "v2.0.0"),
        ({"TRPG_RELEASE_VERSION": "operator-release"}, "operator-release", "v2.0.0"),
        ({"TRPG_SERVER_RELEASE_TAG": "operator-server"}, "2.0.0", "operator-server"),
    ],
)
def test_launcher_update_drops_only_its_internal_v1_versions(
    tmp_path: Path,
    overrides: dict[str, str],
    expected_version: str,
    expected_server_tag: str,
):
    v1_archive = tmp_path / "v1.tar.gz"
    v1_digest = _archive(v1_archive, "v1")
    v1_sidecar = _sidecar(v1_archive, v1_digest)
    generated = _released_installer(tmp_path, tag="v1.0.0", version="1.0.0", digest=v1_digest)
    v1_installer = tmp_path / "install-v1.sh"
    generated.rename(v1_installer)

    v2_archive = tmp_path / "v2.tar.gz"
    v2_digest = _archive(v2_archive, "v2")
    v2_sidecar = _sidecar(v2_archive, v2_digest)
    generated = _released_installer(tmp_path, tag="v2.0.0", version="2.0.0", digest=v2_digest)
    v2_installer = tmp_path / "install-v2.sh"
    generated.rename(v2_installer)

    first, _, home = _run_installer(
        tmp_path,
        v1_installer,
        primary_archive=v1_archive,
        primary_sidecar=v1_sidecar,
        mirror_archive=v1_archive,
        mirror_sidecar=v1_sidecar,
    )
    assert first.returncode == 0, first.stderr
    assert (home / "clients" / "v1.txt").exists()

    update_env = {
        **os.environ,
        "PATH": f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path / "user-home"),
        "TMPDIR": str(tmp_path),
        "INSTALLER_URL_LOG": str(tmp_path / "urls.log"),
        "PRIMARY_ARCHIVE": str(v1_archive),
        "PRIMARY_SIDECAR": str(v1_sidecar),
        "MIRROR_ARCHIVE": str(v1_archive),
        "MIRROR_SIDECAR": str(v1_sidecar),
        "UPDATE_INSTALLER_FILE": str(v2_installer),
        "SECOND_RELEASE_TAG": "v2.0.0",
        "SECOND_ARCHIVE": str(v2_archive),
        "SECOND_SIDECAR": str(v2_sidecar),
        "FAIL_PRIMARY": "0",
        "FAIL_BUN_INSTALL": "0",
    }
    for name in ("TRPG_CLIENT_VERSION", "TRPG_RELEASE_VERSION", "TRPG_SERVER_RELEASE_TAG", "TRPG_RELEASE_TAG"):
        update_env.pop(name, None)
    update_env.update(overrides)
    updated = subprocess.run(
        [str(tmp_path / "launcher-bin" / "loreweaver"), "update"],
        cwd=ROOT,
        env=update_env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert updated.returncode == 0, updated.stderr
    assert (home / "clients" / "v2.txt").exists()
    assert not (home / "clients" / "v1.txt").exists()
    launcher = (tmp_path / "launcher-bin" / "loreweaver").read_text()
    assert f"TRPG_CLIENT_VERSION={expected_version}" in launcher
    assert f"TRPG_RELEASE_VERSION={expected_version}" in launcher
    assert f"TRPG_SERVER_RELEASE_TAG={expected_server_tag}" in launcher


def test_integrity_failure_is_fatal_without_extraction_or_mirror_fallback(tmp_path: Path):
    expected_archive = tmp_path / "expected.tar.gz"
    expected_digest = _archive(expected_archive, "expected")
    tampered_archive = tmp_path / "tampered.tar.gz"
    _archive(tampered_archive, "tampered")
    sidecar = _sidecar(tampered_archive, expected_digest)
    installer = _released_installer(
        tmp_path,
        tag="v1.2.3",
        version="1.2.3",
        digest=expected_digest,
    )

    result, urls, home = _run_installer(
        tmp_path,
        installer,
        primary_archive=tampered_archive,
        primary_sidecar=sidecar,
        mirror_archive=expected_archive,
        mirror_sidecar=sidecar,
        existing_client="working version",
    )

    assert result.returncode != 0
    assert "SHA-256 mismatch" in result.stderr
    assert all("1a7432.site" not in url for url in urls)
    assert not (home / "clients" / "tampered.txt").exists()
    assert (home / "clients" / "previous.txt").read_text() == "working version"


def test_dependency_failure_restores_the_previous_client(tmp_path: Path):
    archive = tmp_path / "candidate.tar.gz"
    digest = _archive(archive, "candidate")
    sidecar = _sidecar(archive, digest)

    result, _, home = _run_installer(
        tmp_path,
        BASH_INSTALLER,
        primary_archive=archive,
        primary_sidecar=sidecar,
        mirror_archive=archive,
        mirror_sidecar=sidecar,
        fail_bun_install=True,
        existing_client="working version",
    )

    assert result.returncode != 0
    assert "bun install failed" in result.stderr
    assert (home / "clients" / "previous.txt").read_text() == "working version"
    assert not (home / "clients" / "candidate.txt").exists()


def test_system_tar_rejects_verified_archive_path_traversal(tmp_path: Path):
    archive = tmp_path / "traversal.tar.gz"
    digest = _unsafe_archive(archive)
    sidecar = _sidecar(archive, digest)

    result, _, home = _run_installer(
        tmp_path,
        BASH_INSTALLER,
        primary_archive=archive,
        primary_sidecar=sidecar,
        mirror_archive=archive,
        mirror_sidecar=sidecar,
        existing_client="working version",
    )

    assert result.returncode != 0
    assert "extracting the verified client archive failed" in result.stderr
    assert (home / "clients" / "previous.txt").read_text() == "working version"
    assert not list(tmp_path.rglob("escaped.txt"))


def test_system_tar_rejects_verified_archive_link_pivot(tmp_path: Path):
    archive = tmp_path / "link-pivot.tar.gz"
    digest = _unsafe_archive(archive, link_pivot=True)
    sidecar = _sidecar(archive, digest)

    result, _, home = _run_installer(
        tmp_path,
        BASH_INSTALLER,
        primary_archive=archive,
        primary_sidecar=sidecar,
        mirror_archive=archive,
        mirror_sidecar=sidecar,
        existing_client="working version",
    )

    assert result.returncode != 0
    assert "extracting the verified client archive failed" in result.stderr
    assert (home / "clients" / "previous.txt").read_text() == "working version"
    assert not list(tmp_path.rglob("escaped.txt"))


def test_powershell_installer_keeps_the_same_release_and_fallback_guards():
    text = POWERSHELL_INSTALLER.read_text()
    assert 'return "https://github.com/1A7432/loreweaver/releases/latest/download"' in text
    assert 'return "$origin/releases/$InstallReleaseTag"' in text
    assert 'if ($PinnedReleaseTag) { return "$origin/releases/$InstallReleaseTag/install.ps1" }' in text
    assert 'return "$origin/install.ps1"' in text
    assert "$targetTag -ceq $EmbeddedReleaseTag" in text
    assert 'return "fatal"' in text
    assert '($result -eq "unavailable") -and ($Primary -ne $Mirror)' in text
    assert text.index("Get-FileHash -Algorithm SHA256") < text.index("& tar -xzf $tar")
    assert "Remove-Item (Join-Path $Home_ \"clients\") -Recurse -Force" not in text
    assert "if ($bunInstallExit -ne 0)" in text
    assert "irm $(PsQuote $updInstaller) | iex" in text
    assert "Move-Item $StagedClients $TargetClients" in text
    assert "Move-Item $PreviousClients $TargetClients" in text
    assert 'if defined TRPG_CLIENT_VERSION set `"_LW_CLIENT_VERSION_WAS_SET=1`"' in text
    assert 'set `"TRPG_CLIENT_VERSION=`"' in text
    assert 'set `"TRPG_RELEASE_VERSION=`"' in text
    assert 'set `"TRPG_SERVER_RELEASE_TAG=`"' in text


def test_both_installers_rewrite_absolute_lock_urls_before_bun_install():
    bash = BASH_INSTALLER.read_text()
    powershell = POWERSHELL_INSTALLER.read_text()

    for text in (bash, powershell):
        assert "registry\\.(?:npmjs\\.org|npmmirror\\.com)" in text
        assert "() => registry" in text

    assert bash.index('rewrite_lock_registry "$STAGED_CLIENTS"') < bash.index("bun install --silent")
    assert powershell.rindex("RewriteLockRegistry $StagedClients") < powershell.index("bun install --silent")


@pytest.mark.parametrize(
    ("exact_tag", "expected_tag", "expected_channel", "expected_flag"),
    [
        ("", "release-0.5.1.dev40", "current", "--latest=false"),
        ("v1.2.3", "v1.2.3", "stable", "--latest=false"),
        ("v1.2.3-rc1", "v1.2.3-rc1", "prerelease", "--prerelease"),
    ],
)
def test_release_workflow_channel_truth_table(
    exact_tag: str,
    expected_tag: str,
    expected_channel: str,
    expected_flag: str,
):
    for relative in (".github/workflows/deploy-client.yml", ".github/workflows/release-server.yml"):
        text = (ROOT / relative).read_text()

        resolve_start = text.index('          if [[ "$exact_tag"')
        resolve_end = text.index("          {\n", resolve_start)
        resolve_block = textwrap.dedent(text[resolve_start:resolve_end])
        resolve_script = (
            'exact_tag="$1"; version="$2"; '
            + resolve_block
            + '\nprintf "%s\\t%s" "$tag" "$channel"'
        )
        resolved = subprocess.run(
            ["bash", "-c", resolve_script, "resolve", exact_tag, "0.5.1.dev40"],
            text=True,
            capture_output=True,
            check=True,
        ).stdout.split("\t")
        assert resolved == [expected_tag, expected_channel]

        flags_start = text.index("            release_flags=(", resolve_end)
        flags_end = text.index("            gh release create", flags_start)
        flags_block = textwrap.dedent(text[flags_start:flags_end])
        flags_script = 'CHANNEL="$1"; ' + flags_block + '\nprintf "%s" "${release_flags[*]}"'
        release_flag = subprocess.run(
            ["bash", "-c", flags_script, "flags", expected_channel],
            text=True,
            capture_output=True,
            check=True,
        ).stdout
        assert release_flag == expected_flag

        assert "group: ${{ github.workflow }}-${{ github.ref }}" in text
        assert "cancel-in-progress: ${{ github.ref == 'refs/heads/main' }}" in text


def test_only_client_workflow_promotes_latest_after_client_assets_exist():
    client = (ROOT / ".github/workflows/deploy-client.yml").read_text()
    server = (ROOT / ".github/workflows/release-server.yml").read_text()
    upload = 'gh release upload "$TAG" dist/loreweaver-client.tar.gz'
    promote = 'gh release edit "$TAG" --repo "$R" --prerelease=false --latest'

    assert upload in client
    assert promote in client
    assert client.index(upload) < client.index(promote)
    assert 'if [ "$CHANNEL" != "prerelease" ]; then' in client
    assert "gh release edit" not in server
