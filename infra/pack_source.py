"""Resolve a `.lwpack` ref — local path / https direct link / ``gh:owner/repo[@tag]`` — to a
local file.

Git IS the registry: a ``gh:`` ref asks the GitHub API for a release's ``*.lwpack``
asset (``@tag`` pins a release; without it the latest release is used). That ONE
request — the release-metadata call this module builds itself, never a URL a caller
typed — is anonymous unless ``GITHUB_TOKEN``/``GH_TOKEN`` is set, in which case the
credential lifts the per-IP anonymous rate limit. Downloads (including the release
asset, which is served from another host) are always anonymous, and a cross-host
redirect drops the credential rather than forwarding it.
There is deliberately no central package registry. All network code lives here (infra
plumbing — ``core.pack`` stays offline-pure and re-validates every byte on inspect);
the ``fetch`` callable is injectable so tests run fully offline.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

# Mirrors core.pack.MAX_PACK_BYTES / PACK_SUFFIX without importing core (the repo's
# layering is core -> infra, never infra -> core); core.pack re-checks its own caps
# on every inspect/install, so drift here can only make downloads stricter/looser
# before the authoritative check, never bypass it.
_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
_PACK_SUFFIX = ".lwpack"

_GH_REF_RE = re.compile(r"^gh:([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})(?:@([^\s@]{1,120}))?$")
_USER_AGENT = "loreweaver-pack"
_FETCH_TIMEOUT_SECONDS = 30.0

# The ONE host a GitHub credential may be sent to, and only on the release-metadata request
# this module composes. Two separate rules, because host-matching alone is not scoping:
#   * a caller-named ref is NEVER authenticated, even when it names the API host — a keeper
#     who types `.pack install https://api.github.com/...` must not spend the server's PAT on
#     a URL the server did not build;
#   * a redirect that leaves the host drops the credential (`_AuthStrippingRedirect`), because
#     `urllib` forwards every header across hosts by default and release assets redirect to
#     objects.githubusercontent.com.
_GITHUB_API_HOST = "api.github.com"
_TOKEN_ENV_VARS = ("GITHUB_TOKEN", "GH_TOKEN")

Fetcher = Callable[[str], bytes]


class PackRefError(ValueError):
    """A ref could not be resolved/downloaded. Technical English detail; the CLI wraps it."""


def _github_token() -> str:
    for name in _TOKEN_ENV_VARS:
        token = (os.environ.get(name) or "").strip()
        if token:
            return token
    return ""


def _request_headers(url: str, *, authenticated: bool) -> dict[str, str]:
    """Headers for ``url``. The GitHub credential rides along only when the caller asked
    for an authenticated request AND the host is the API host — both, never either.

    Anonymous API calls are rate-limited per IP, which a shared or cloud-hosted server
    exhausts quickly; a token lifts that limit. Only this module's own release-metadata
    request passes ``authenticated=True``; every download, and every ref a caller typed,
    is anonymous whatever host it names.
    """
    headers = {"User-Agent": _USER_AGENT, "Accept": "*/*"}
    if not authenticated:
        return headers
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "https" and (parsed.hostname or "").lower() == _GITHUB_API_HOST:
        token = _github_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers


class _AuthStrippingRedirect(urllib.request.HTTPRedirectHandler):
    """Drop ``Authorization`` when a redirect leaves the host it was minted for.

    `urllib`'s own handler copies every header except the content ones into the new
    request, so a credential set for ``api.github.com`` would follow a 302 to whatever
    host the response named — and the release-asset path redirects off-host by design.
    Same-host redirects (a renamed repo) keep the header, so this costs nothing real.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new_request = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_request is None:
            return None
        old_host = (urllib.parse.urlsplit(req.full_url).hostname or "").lower()
        new_host = (urllib.parse.urlsplit(newurl).hostname or "").lower()
        if old_host != new_host:
            # Request normalizes header names to Capitalized-Form; drop every casing.
            for name in [key for key in new_request.headers if key.lower() == "authorization"]:
                del new_request.headers[name]
        return new_request


def _open(url: str, *, authenticated: bool) -> bytes:
    request = urllib.request.Request(url, headers=_request_headers(url, authenticated=authenticated))
    opener = urllib.request.build_opener(_AuthStrippingRedirect)
    with opener.open(request, timeout=_FETCH_TIMEOUT_SECONDS) as response:
        data = response.read(_MAX_DOWNLOAD_BYTES + 1)
    return data


def _default_fetch(url: str) -> bytes:
    """Download anything, anonymously — the fetcher every caller-named ref goes through."""
    return _open(url, authenticated=False)


def _default_api_fetch(url: str) -> bytes:
    """Fetch a URL THIS module composed against the GitHub API, with the credential."""
    return _open(url, authenticated=True)


def _checked_pack_bytes(data: bytes, source: str) -> bytes:
    if not data:
        raise PackRefError(f"empty download from {source}")
    if len(data) > _MAX_DOWNLOAD_BYTES:
        raise PackRefError(f"download from {source} exceeds the {_MAX_DOWNLOAD_BYTES}-byte cap")
    return data


def _cache_bytes(data: bytes, cache_dir: Path) -> Path:
    """Content-addressed cache write: same bytes -> same path, written atomically."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(data).hexdigest()
    target = cache_dir / f"{digest[:16]}{_PACK_SUFFIX}"
    if not target.exists():
        staging = cache_dir / f".tmp-{digest[:16]}"
        staging.write_bytes(data)
        staging.replace(target)
    return target


def _resolve_github(ref: str, *, cache_dir: Path, fetch: Fetcher, api_fetch: Fetcher) -> Path:
    match = _GH_REF_RE.match(ref)
    if match is None:
        raise PackRefError(f"invalid gh ref (expected gh:owner/repo[@tag]): {ref!r}")
    owner, repo, tag = match.groups()
    release_url = (
        f"https://api.github.com/repos/{owner}/{repo}/releases/tags/{urllib.parse.quote(tag, safe='')}"
        if tag
        else f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
    )
    try:
        # `api_fetch`, not `fetch`: this is the one request the credential is for.
        release = json.loads(api_fetch(release_url).decode("utf-8"))
    except PackRefError:
        raise
    except Exception as exc:
        raise PackRefError(f"could not resolve {ref!r} via the GitHub API: {exc}") from exc
    assets = release.get("assets") if isinstance(release, dict) else None
    if not isinstance(assets, list):
        raise PackRefError(f"no release assets found for {ref!r}")
    download_url = ""
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get("name") or "")
        url = str(asset.get("browser_download_url") or "")
        if name.endswith(_PACK_SUFFIX) and url.startswith("https://"):
            download_url = url
            break
    if not download_url:
        raise PackRefError(f"release for {ref!r} has no {_PACK_SUFFIX} asset")
    try:
        data = _checked_pack_bytes(fetch(download_url), download_url)
    except PackRefError:
        raise
    except Exception as exc:
        raise PackRefError(f"download failed for {ref!r}: {exc}") from exc
    return _cache_bytes(data, cache_dir)


def resolve_pack_ref(ref: str, *, cache_dir: Path, fetch: Fetcher | None = None) -> Path:
    """Resolve ``ref`` to a local ``.lwpack`` file path.

    Accepted forms: an existing local path; an ``https://`` direct link (downloaded to
    the content-addressed ``cache_dir``); ``gh:owner/repo[@tag]`` (resolved through the
    anonymous GitHub releases API to the release's first ``*.lwpack`` asset). Plain
    ``http://`` and every other scheme are refused.
    """
    ref = (ref or "").strip()
    if not ref:
        raise PackRefError("empty pack ref")
    # An injected fetcher stands in for BOTH lanes (tests run one offline double); the
    # production split is what scopes the credential to the API call.
    api_fetch = fetch or _default_api_fetch
    fetch = fetch or _default_fetch
    if ref.startswith("gh:"):
        return _resolve_github(ref, cache_dir=cache_dir, fetch=fetch, api_fetch=api_fetch)
    if ref.startswith("https://"):
        try:
            data = _checked_pack_bytes(fetch(ref), ref)
        except PackRefError:
            raise
        except Exception as exc:
            raise PackRefError(f"download failed for {ref!r}: {exc}") from exc
        return _cache_bytes(data, cache_dir)
    if ref.startswith(("http://", "ftp://", "file://")):
        raise PackRefError(f"refusing non-https ref: {ref!r}")
    local = Path(ref).expanduser()
    if local.is_file():
        return local
    raise PackRefError(f"pack ref is neither an existing file, https://, nor gh:owner/repo[@tag]: {ref!r}")
