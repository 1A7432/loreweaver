"""Offline tests for infra.pack_source: local / https / gh:owner/repo[@tag] ref
resolution with an injected fetcher (no network ever)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import infra.pack_source as pack_source
from infra.pack_source import PackRefError, resolve_pack_ref


def test_local_path_passes_through(tmp_path: Path):
    pack = tmp_path / "x.lwpack"
    pack.write_bytes(b"PK\x05\x06" + bytes(18))
    assert resolve_pack_ref(str(pack), cache_dir=tmp_path / "cache") == pack


def test_https_download_is_content_addressed_and_cached(tmp_path: Path):
    calls: list[str] = []

    def fetch(url: str) -> bytes:
        calls.append(url)
        return b"pack-bytes"

    first = resolve_pack_ref("https://example.test/x.lwpack", cache_dir=tmp_path / "cache", fetch=fetch)
    second = resolve_pack_ref("https://example.test/x.lwpack", cache_dir=tmp_path / "cache", fetch=fetch)
    assert first == second
    assert first.suffix == ".lwpack"
    assert first.read_bytes() == b"pack-bytes"
    assert calls == ["https://example.test/x.lwpack"] * 2


def test_gh_ref_resolves_the_releases_lwpack_asset(tmp_path: Path):
    seen: list[str] = []
    release = {
        "assets": [
            {"name": "notes.txt", "browser_download_url": "https://example.test/notes.txt"},
            {"name": "blackmoor-1.2.0.lwpack", "browser_download_url": "https://example.test/blackmoor.lwpack"},
        ]
    }

    def fetch(url: str) -> bytes:
        seen.append(url)
        if url.startswith("https://api.github.com/"):
            return json.dumps(release).encode("utf-8")
        return b"pack-bytes"

    path = resolve_pack_ref("gh:ada/blackmoor", cache_dir=tmp_path, fetch=fetch)
    assert seen == [
        "https://api.github.com/repos/ada/blackmoor/releases/latest",
        "https://example.test/blackmoor.lwpack",
    ]
    assert path.read_bytes() == b"pack-bytes"


def test_gh_ref_with_tag_pins_that_release(tmp_path: Path):
    def fetch(url: str) -> bytes:
        if url == "https://api.github.com/repos/ada/blackmoor/releases/tags/v1.2.0":
            return json.dumps(
                {"assets": [{"name": "a.lwpack", "browser_download_url": "https://example.test/a.lwpack"}]}
            ).encode("utf-8")
        if url == "https://example.test/a.lwpack":
            return b"tagged"
        raise AssertionError(f"unexpected fetch: {url}")

    path = resolve_pack_ref("gh:ada/blackmoor@v1.2.0", cache_dir=tmp_path, fetch=fetch)
    assert path.read_bytes() == b"tagged"


def test_gh_release_without_an_lwpack_asset_fails(tmp_path: Path):
    def fetch(url: str) -> bytes:
        return json.dumps({"assets": [{"name": "x.zip", "browser_download_url": "https://e/x.zip"}]}).encode("utf-8")

    with pytest.raises(PackRefError, match="lwpack"):
        resolve_pack_ref("gh:ada/blackmoor", cache_dir=tmp_path, fetch=fetch)


def test_non_https_schemes_and_bad_refs_are_refused(tmp_path: Path):
    with pytest.raises(PackRefError, match="non-https"):
        resolve_pack_ref("http://example.test/x.lwpack", cache_dir=tmp_path)
    with pytest.raises(PackRefError, match="gh ref"):
        resolve_pack_ref("gh:not-a-ref", cache_dir=tmp_path, fetch=lambda url: b"")
    with pytest.raises(PackRefError):
        resolve_pack_ref(str(tmp_path / "missing.lwpack"), cache_dir=tmp_path)
    with pytest.raises(PackRefError):
        resolve_pack_ref("", cache_dir=tmp_path)


def test_oversized_download_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(pack_source, "_MAX_DOWNLOAD_BYTES", 8)
    with pytest.raises(PackRefError, match="cap"):
        resolve_pack_ref("https://example.test/big.lwpack", cache_dir=tmp_path, fetch=lambda url: b"123456789")
