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
