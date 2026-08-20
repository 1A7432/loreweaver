"""Offline tests for infra.pack_source: local / https / gh:owner/repo[@tag] ref
resolution with an injected fetcher (no network ever)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
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


# ---------------------------------------------------------------------------
# GITHUB_TOKEN / GH_TOKEN: the anonymous API rate limit is per IP, which a shared cloud host
# burns through. The credential rides ONLY on api.github.com requests — never on the asset
# host, never on a caller-supplied https ref.
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self) -> None:
        self.body = b"pack-bytes"

    def read(self, _size: int) -> bytes:
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> bool:
        return False


def _captured_headers(monkeypatch: pytest.MonkeyPatch, url: str, *, api: bool = True) -> dict[str, str]:
    """Headers one fetch would send. `api=True` uses the credentialed lane this module
    reserves for the release-metadata request it composes itself; `api=False` is the
    download lane every caller-named ref goes through."""
    seen: dict[str, str] = {}

    class _Opener:
        def open(self, request, timeout=None):
            seen.update(request.headers)
            return _FakeResponse()

    monkeypatch.setattr(pack_source.urllib.request, "build_opener", lambda *_h: _Opener())
    (pack_source._default_api_fetch if api else pack_source._default_fetch)(url)
    return seen


API_URL = "https://api.github.com/repos/ada/blackmoor/releases/latest"


def test_github_token_is_sent_to_the_api_host_only(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GITHUB_TOKEN", "s3cret")
    monkeypatch.delenv("GH_TOKEN", raising=False)

    assert _captured_headers(monkeypatch, API_URL).get("Authorization") == "Bearer s3cret"

    for other in (
        "https://objects.githubusercontent.com/ada/blackmoor/a.lwpack",
        "https://example.test/a.lwpack",
        "https://api.github.com.evil.test/repos/ada/blackmoor/releases/latest",
    ):
        assert "Authorization" not in _captured_headers(monkeypatch, other), other


def test_a_caller_named_ref_is_never_authenticated_even_on_the_api_host(monkeypatch: pytest.MonkeyPatch):
    """`.pack install https://api.github.com/…` must not spend the server's PAT: the
    credential belongs to the request this module composes, not to a matching hostname."""
    monkeypatch.setenv("GITHUB_TOKEN", "s3cret")
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert "Authorization" not in _captured_headers(monkeypatch, API_URL, api=False)


def test_a_cross_host_redirect_drops_the_credential(monkeypatch: pytest.MonkeyPatch):
    """urllib forwards every header across hosts by default, and the asset lane redirects
    off-host by design. Same-host redirects (a renamed repo) keep it."""
    monkeypatch.setenv("GITHUB_TOKEN", "s3cret")
    handler = pack_source._AuthStrippingRedirect()
    original = urllib.request.Request(API_URL, headers={"Authorization": "Bearer s3cret"})

    class _Headers(dict):
        def get_all(self, _name, _default=None):
            return None

    offhost = handler.redirect_request(
        original, None, 302, "Found", _Headers(), "https://objects.githubusercontent.com/x.lwpack"
    )
    assert offhost is not None
    assert not any(key.lower() == "authorization" for key in offhost.headers)

    samehost = handler.redirect_request(
        original, None, 302, "Found", _Headers(), "https://api.github.com/repos/new/name/releases/latest"
    )
    assert samehost is not None
    assert any(key.lower() == "authorization" for key in samehost.headers)


def test_a_same_host_scheme_downgrade_drops_the_credential(monkeypatch: pytest.MonkeyPatch):
    """The host check alone let a 302 to http:// on the SAME host keep the header, which
    puts the token on the wire in clear — the very leak the host check exists to prevent."""
    monkeypatch.setenv("GITHUB_TOKEN", "s3cret")
    handler = pack_source._AuthStrippingRedirect()
    original = urllib.request.Request(API_URL, headers={"Authorization": "Bearer s3cret"})

    class _Headers(dict):
        def get_all(self, _name, _default=None):
            return None

    downgraded = handler.redirect_request(
        original, None, 302, "Found", _Headers(), "http://api.github.com/repos/o/r/releases/latest"
    )
    assert downgraded is not None
    assert not any(key.lower() == "authorization" for key in downgraded.headers)


def test_gh_token_is_the_fallback_env_var(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("GH_TOKEN", "other")
    assert _captured_headers(monkeypatch, API_URL).get("Authorization") == "Bearer other"


def test_no_token_configured_stays_anonymous(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert "Authorization" not in _captured_headers(monkeypatch, API_URL)


def test_a_403_from_the_api_names_the_remedy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A `gh:` install from a shared or cloud address hits the per-IP anonymous limit as an
    HTTP 403. The engine has honoured GITHUB_TOKEN/GH_TOKEN since 2026-08-19, but the keeper
    reading "HTTP 403" had no way to learn that, so the error carries the remedy's i18n key."""
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)

    def fetch(url: str) -> bytes:
        raise urllib.error.HTTPError(url, 403, "rate limit exceeded", {}, None)

    with pytest.raises(PackRefError) as caught:
        resolve_pack_ref("gh:ada/blackmoor", cache_dir=tmp_path, fetch=fetch)

    assert "403" in str(caught.value)
    assert pack_source.pack_ref_hint(caught.value) == "pack.ref.github_rate_limit"


def test_a_403_with_a_token_already_set_suggests_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """"Set a token" is wrong advice for an operator who set one — a 403 then means
    something else (a private repo, a revoked PAT), and the raw detail is the honest answer."""
    monkeypatch.setenv("GITHUB_TOKEN", "s3cret")

    def fetch(url: str) -> bytes:
        raise urllib.error.HTTPError(url, 403, "forbidden", {}, None)

    with pytest.raises(PackRefError) as caught:
        resolve_pack_ref("gh:ada/blackmoor", cache_dir=tmp_path, fetch=fetch)

    assert pack_source.pack_ref_hint(caught.value) == ""


def test_other_ref_failures_carry_no_hint(tmp_path: Path):
    """The hint is a diagnosis, not decoration: a 404 or a bad ref must not tell an operator
    to go configure a credential that would change nothing."""
    def fetch(url: str) -> bytes:
        raise urllib.error.HTTPError(url, 404, "not found", {}, None)

    with pytest.raises(PackRefError) as caught:
        resolve_pack_ref("gh:ada/blackmoor", cache_dir=tmp_path, fetch=fetch)
    assert pack_source.pack_ref_hint(caught.value) == ""

    with pytest.raises(PackRefError) as bad_ref:
        resolve_pack_ref("gh:not-a-ref", cache_dir=tmp_path, fetch=lambda url: b"")
    assert pack_source.pack_ref_hint(bad_ref.value) == ""
