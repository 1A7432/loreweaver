"""Resolve a `.lwpack` ref — local path / https direct link / ``gh:owner/repo[@tag]`` — to a
local file.

Git IS the registry: a ``gh:`` ref asks the anonymous GitHub API for a release's
``*.lwpack`` asset (``@tag`` pins a release; without it the latest release is used).
There is deliberately no central package registry. All network code lives here (infra
plumbing — ``core.pack`` stays offline-pure and re-validates every byte on inspect);
the ``fetch`` callable is injectable so tests run fully offline.
"""

from __future__ import annotations

import hashlib
import json
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

Fetcher = Callable[[str], bytes]


class PackRefError(ValueError):
    """A ref could not be resolved/downloaded. Technical English detail; the CLI wraps it."""


def _default_fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=_FETCH_TIMEOUT_SECONDS) as response:
        data = response.read(_MAX_DOWNLOAD_BYTES + 1)
    return data


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


def _resolve_github(ref: str, *, cache_dir: Path, fetch: Fetcher) -> Path:
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
        release = json.loads(fetch(release_url).decode("utf-8"))
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
    fetch = fetch or _default_fetch
    if ref.startswith("gh:"):
        return _resolve_github(ref, cache_dir=cache_dir, fetch=fetch)
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
