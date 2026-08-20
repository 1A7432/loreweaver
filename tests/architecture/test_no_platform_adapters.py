"""The chat-platform adapters stay gone (docs/notes/rejected/platform-chat-adapters.md).

All five (Discord/QQ/Telegram/Feishu/OneBot) were removed 2026-07-30 and the rejection
is binding: clients speak `docs/protocol.md`. Until now the only thing keeping them out
was that note — this test makes the rule structural: `adapters/` holds the local CLI
REPL and nothing else, and no module anywhere imports a platform SDK.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ADAPTERS_DIR = REPO_ROOT / "adapters"

ALLOWED_ADAPTER_PACKAGES = {"cli"}

# The SDKs the removed adapters pulled in. Matching an import of one anywhere in the
# production tree is the earliest signal a platform adapter is growing back.
_PLATFORM_SDK_RE = re.compile(
    r"^\s*(?:from|import)\s+(discord|telegram|aiogram|lark_oapi|feishu|botpy|qq_official|onebot|aiocqhttp|nonebot)\b",
    re.MULTILINE,
)


def test_adapters_holds_only_the_cli_repl() -> None:
    packages = sorted(
        path.name for path in ADAPTERS_DIR.iterdir() if path.is_dir() and not path.name.startswith("__")
    )
    assert set(packages) <= ALLOWED_ADAPTER_PACKAGES, (
        f"adapters/ contains {packages}; chat-platform adapters were removed for good "
        "(docs/notes/rejected/platform-chat-adapters.md) — build a protocol client instead"
    )

    # The directory check above misses a SINGLE-FILE adapter (`adapters/discord.py`):
    # the one allowed adapter is the `cli` PACKAGE, so nothing but `__init__.py` may
    # sit directly under `adapters/`.
    stray_modules = sorted(
        path.name
        for path in ADAPTERS_DIR.iterdir()
        if path.is_file() and path.suffix == ".py" and path.name != "__init__.py"
    )
    assert not stray_modules, (
        f"adapters/ contains top-level module(s) {stray_modules}; chat-platform adapters were removed "
        "for good (docs/notes/rejected/platform-chat-adapters.md) — build a protocol client instead"
    )


def test_no_platform_sdk_is_imported_anywhere() -> None:
    offenders: list[str] = []
    for top in ("core", "infra", "agent", "gateway", "net", "adapters"):
        for path in sorted((REPO_ROOT / top).rglob("*.py")):
            text = path.read_text(encoding="utf-8")
            for match in _PLATFORM_SDK_RE.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{line} imports {match.group(1)}")
    assert not offenders, "; ".join(offenders)
