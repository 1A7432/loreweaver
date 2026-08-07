"""Architecture gate: every statement of the wire-protocol version agrees.

The version is written down in five places across two runtimes and the docs —
the server constant, the TypeScript client constant, the npm manifest (version
+ description), the package README, and the protocol document. Nothing but
convention kept them together, and they DID drift: `loreweaver-protocol` sat at
1.9.0 / "protocol v1.7" for two protocol releases while both constants had moved
on, so the published package advertised a protocol it no longer spoke.

`net/session.py` is the authority here (it is what a client actually negotiates
against in `welcome.protocol`); everything else is checked against it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SESSION_PY = REPO_ROOT / "net" / "session.py"
TYPES_TS = REPO_ROOT / "clients" / "protocol" / "src" / "types.ts"
PACKAGE_JSON = REPO_ROOT / "clients" / "protocol" / "package.json"
PROTOCOL_README = REPO_ROOT / "clients" / "protocol" / "README.md"
PROTOCOL_DOC = REPO_ROOT / "docs" / "protocol.md"


def _server_version() -> str:
    """The authoritative `major.minor`, read as text so importing net/ isn't needed."""
    match = re.search(r'^_PROTOCOL_VERSION\s*=\s*"([^"]+)"', SESSION_PY.read_text(encoding="utf-8"), re.MULTILINE)
    assert match, f"{SESSION_PY.name} no longer declares _PROTOCOL_VERSION as a string literal"
    return match.group(1)


def test_typescript_client_constant_matches_server() -> None:
    source = TYPES_TS.read_text(encoding="utf-8")
    match = re.search(r'export const PROTOCOL_VERSION\s*=\s*"([^"]+)"', source)
    assert match, "clients/protocol/src/types.ts no longer exports a literal PROTOCOL_VERSION"
    assert match.group(1) == _server_version(), (
        "the TypeScript client and the server disagree about the protocol version"
    )


def test_npm_manifest_tracks_the_protocol_version() -> None:
    expected = _server_version()
    manifest = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))

    # The package version tracks the protocol version in major.minor; the patch
    # component is free, so protocol-neutral fixes can ship as 2.1.1, 2.1.2, …
    package_version = manifest["version"]
    major_minor = ".".join(package_version.split(".")[:2])
    assert major_minor == expected, (
        f"loreweaver-protocol {package_version} would publish protocol {major_minor}, "
        f"but the server speaks {expected} — bump package.json before publishing"
    )

    # The description is what npmjs.com renders under the package name.
    assert f"protocol v{expected}" in manifest["description"], (
        f"package.json description does not say 'protocol v{expected}'"
    )


def test_readme_states_the_current_protocol_version() -> None:
    expected = _server_version()
    assert f"currently **v{expected}**" in PROTOCOL_README.read_text(encoding="utf-8"), (
        f"clients/protocol/README.md does not call the protocol 'currently **v{expected}**'"
    )


def test_protocol_doc_heading_and_examples_match() -> None:
    expected = _server_version()
    source = PROTOCOL_DOC.read_text(encoding="utf-8")

    heading = re.search(r"^#\s+.*wire protocol\s+(\S+)\s*$", source, re.MULTILINE)
    assert heading, "docs/protocol.md lost its '# … wire protocol <version>' heading"
    assert heading.group(1) == expected, "docs/protocol.md heading names a stale protocol version"

    # Example welcome frames pin the version a client is told to expect.
    quoted = set(re.findall(r'protocol\s*:\s*"([^"]+)"', source))
    stale = quoted - {expected}
    assert not stale, f"docs/protocol.md shows welcome frames with stale protocol version(s): {sorted(stale)}"


# --- The Python package version is the sixth statement of the protocol version ---
# Owner rule 2026-08-07: a Release/package version FOLLOWS the wire protocol, with
# `.devN` on top, so `pyproject.toml` hands setuptools_scm a scheme that reads
# `_PROTOCOL_VERSION` instead of guessing from the last `v*` tag. These exercise the
# pure decision functions, so they need none of the build backend installed.

PYPROJECT = REPO_ROOT / "pyproject.toml"


def test_pyproject_wires_the_protocol_version_scheme() -> None:
    source = PYPROJECT.read_text(encoding="utf-8")
    assert "lw_versioning:protocol_dev_version" in source, (
        "pyproject.toml no longer points setuptools_scm at the protocol-derived version scheme"
    )


def test_dev_version_is_built_on_the_protocol_version() -> None:
    import lw_versioning

    assert lw_versioning.read_protocol_version() == _server_version(), (
        "lw_versioning reads a different protocol version than net/session.py declares"
    )
    # The shipped situation: the protocol has moved past the last release tag.
    assert lw_versioning.format_dev_version("2.1", "v1.0.0", 87) == "2.1.dev87"


def test_dev_version_never_regresses_past_a_release() -> None:
    """`2.1.dev3` sorts BELOW `2.1.0`, so a build made after tagging v2.1.0 must not
    claim the bare protocol version — it takes the next patch instead."""
    import lw_versioning

    assert lw_versioning.format_dev_version("2.1", "v2.1.0", 3) == "2.1.1.dev3"
    assert lw_versioning.format_dev_version("2.1", "v2.1.4", 1) == "2.1.5.dev1"
    # A protocol bump immediately outranks the tag again, with no tagging required.
    assert lw_versioning.format_dev_version("2.2", "v2.1.0", 5) == "2.2.dev5"


def test_unreadable_protocol_falls_back_instead_of_breaking_the_build() -> None:
    """The source-tarball install tier has no `.git`; a scheme that raised there would
    turn a soft fallback into a failed install."""
    import lw_versioning

    assert lw_versioning.format_dev_version(None, "v1.0.0", 4) == "1.0.1.dev4"
    assert lw_versioning.format_dev_version(None, None, 4) is None
    assert lw_versioning.read_protocol_version(REPO_ROOT / "does-not-exist.py") is None


def test_built_version_follows_the_protocol() -> None:
    """End-to-end: the version THIS build actually produced, not just the helper.

    The first cut of this feature passed every pure-function test above while doing
    nothing at all: the isolated PEP 517 build could not import `lw_versioning`, the
    scheme chain fell through to `guess-next-dev`, and the wheel went on saying
    `1.0.1.dev*`. A silent fallback needs an end-to-end assertion or it is not pinned.
    """
    import pytest

    from infra.version import FALLBACK_VERSION, resolve_version

    built = resolve_version()
    if built == FALLBACK_VERSION:
        pytest.skip("no build metadata in this tree (source tarball tier); nothing to pin")

    protocol = _server_version()
    release = built.split("+", 1)[0].split(".dev", 1)[0]
    major_minor = ".".join(release.split(".")[:2])
    assert major_minor == protocol, (
        f"the built version {built!r} does not follow protocol {protocol!r} — the "
        "version scheme is probably falling back silently (see pyproject's build-backend)"
    )
