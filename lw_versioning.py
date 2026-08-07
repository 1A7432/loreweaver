"""The package version follows the WIRE PROTOCOL version (owner rule, 2026-08-07).

Before this, `setuptools_scm` derived the version from the last `v*` git tag with the
patch auto-bumped, so the Python package said `1.0.1.dev*` while `net/session.py` and
the published `loreweaver-protocol` npm package both said `2.1`. Three numbers for one
artifact, two of which nobody maintained. Now the base comes from the protocol constant
itself, so it cannot drift: bump `_PROTOCOL_VERSION` and the next build's version
follows on its own.

`net/session.py` stays the single authority (it is what a client negotiates against in
`welcome.protocol`). This module READS it as text rather than importing `net.session`,
because it runs inside the build backend where the runtime dependencies do not exist.

Monotonicity is the one subtlety. A version scheme that always returned
`<protocol>.dev<N>` would regress right after a release: `2.1.dev3` sorts BELOW `2.1.0`
under PEP 440, so the build after tagging `v2.1.0` would claim to be older than the
release it came after. So the base is the LARGER of the protocol version and the
next-patch guess from the last `v*` tag:

    protocol 2.1, last tag v1.0.0   ->  2.1.dev79+g<sha>     (protocol wins)
    protocol 2.1, last tag v2.1.0   ->  2.1.1.dev1+g<sha>    (tag wins; stays ahead)
    protocol 2.2, last tag v2.1.0   ->  2.2.dev5+g<sha>      (protocol wins again)
    on the v2.1.0 tag exactly       ->  2.1.0                (releases are the tag)

Everything here is a pure function of (protocol, tag, distance, exact) so
`tests/architecture/test_protocol_version_sync.py` can pin the behaviour without
installing the build backend. Any failure to read the protocol constant returns None,
which hands the decision back to `setuptools_scm`'s own guess rather than breaking a
build — the source-tarball install tier has no `.git` at all and must keep working.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SESSION_PY = REPO_ROOT / "net" / "session.py"

_PROTOCOL_RE = re.compile(r'^_PROTOCOL_VERSION\s*=\s*"([^"]+)"', re.MULTILINE)


def read_protocol_version(session_py: Path | None = None) -> str | None:
    """The authoritative `major.minor` from `net/session.py`, or None if unreadable."""
    path = SESSION_PY if session_py is None else session_py
    try:
        match = _PROTOCOL_RE.search(path.read_text(encoding="utf-8"))
    except OSError:
        return None
    return match.group(1) if match else None


def _release_tuple(text: str) -> tuple[int, ...] | None:
    """`"2.1"` -> `(2, 1)`. None for anything that is not a plain dotted number."""
    parts = text.strip().lstrip("v").split(".")
    if not parts or not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def _padded(left: tuple[int, ...], right: tuple[int, ...]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    width = max(len(left), len(right))
    return left + (0,) * (width - len(left)), right + (0,) * (width - len(right))


def next_after_tag(tag: str) -> str | None:
    """setuptools_scm's own guess: the next patch after `tag` (`2.1.0` -> `2.1.1`)."""
    release = _release_tuple(tag)
    if release is None:
        return None
    while len(release) < 3:
        release = release + (0,)
    return ".".join(str(part) for part in (*release[:-1], release[-1] + 1))


def dev_base(protocol: str | None, tag: str | None) -> str | None:
    """The base a development build should carry: whichever of the protocol version and
    the next-patch-after-tag guess is HIGHER. None when neither can be read, so the
    caller can fall back to the default scheme."""
    candidates: list[tuple[tuple[int, ...], str]] = []
    for text in (protocol, None if tag is None else next_after_tag(tag)):
        if not text:
            continue
        release = _release_tuple(text)
        if release is not None:
            candidates.append((release, text))
    if not candidates:
        return None
    best_release, best_text = candidates[0]
    for release, text in candidates[1:]:
        left, right = _padded(release, best_release)
        if left > right:
            best_release, best_text = release, text
    return best_text


def format_dev_version(protocol: str | None, tag: str | None, distance: int) -> str | None:
    """`(protocol, tag, distance)` -> the public part of a development version."""
    base = dev_base(protocol, tag)
    return None if base is None else f"{base}.dev{distance}"


def protocol_dev_version(version: object) -> str | None:
    """The `version_scheme` entry point named by `pyproject.toml`.

    Receives a `ScmVersion`; returns the public version, or None to let the next
    configured scheme decide. An exact `v*` tag IS the release, so it passes through
    untouched and only untagged builds get a protocol-derived `.devN`.
    """
    tag = str(getattr(version, "tag", "") or "")
    if getattr(version, "exact", False):
        return tag.lstrip("v") or None
    distance = getattr(version, "distance", 0) or 0
    return format_dev_version(read_protocol_version(), tag, int(distance))
