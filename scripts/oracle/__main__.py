"""Run every reference-vector exporter and write ``MANIFEST.json``.

    .venv/bin/python -m scripts.oracle

Exporter modules: ``rules``, ``sheets``, ``dice`` and (only when the file exists) ``stcards``. Each
exposes ``export() -> list[tuple[filename, row_count, sha256]]``. The output is deterministic: two
runs on the same commit produce byte-identical files.
"""

from __future__ import annotations

import gzip
import hashlib
import importlib
import json
import platform
import subprocess
import sys
from importlib import metadata
from pathlib import Path

from . import _io  # noqa: F401  (must be imported before the engine; installs the guards)
from ._io import OUT_DIR, REPO_ROOT, assert_no_private_reads

MODULES = ("rules", "sheets", "dice", "stcards")

# Paths whose state decides whether a vector still describes "the frozen Python engine".
FROZEN_PATHS = ("core", "infra", "agent", "gateway", "net", "rulepacks", "locales", "tests/fixtures", "pyproject.toml")


def _git(*args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args], cwd=REPO_ROOT, check=True, capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return completed.stdout.strip()


def _content_sha256(filename: str) -> str:
    """SHA-256 of a file's JSON-lines text (a ``.gz`` is decompressed first), so every exporter is hashed alike."""
    raw = (OUT_DIR / filename).read_bytes()
    if filename.endswith(".gz"):
        raw = gzip.decompress(raw)
    return hashlib.sha256(raw).hexdigest()


def _manifest(files: list[tuple[str, int, str]]) -> dict[str, object]:
    status = _git("status", "--porcelain", "--", *FROZEN_PATHS)
    return {
        "python": platform.python_version(),
        "d20": metadata.version("d20"),
        "git_commit": _git("rev-parse", "HEAD"),
        "frozen_paths_clean": status == "",
        "sha256_covers": "the uncompressed JSON-lines text (a .gz is hashed after decompression)",
        "files": {name: {"rows": rows, "sha256": _content_sha256(name)} for name, rows, _digest in sorted(files)},
    }


def main() -> int:
    here = Path(__file__).parent
    files: list[tuple[str, int, str]] = []
    for name in MODULES:
        if not (here / f"{name}.py").exists():
            print(f"skip {name} (no such module)", file=sys.stderr)
            continue
        module = importlib.import_module(f"scripts.oracle.{name}")
        written = module.export()
        for filename, rows, _digest in written:
            print(f"{filename}: {rows} rows")
        files.extend(written)
    assert_no_private_reads()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "MANIFEST.json").write_text(json.dumps(_manifest(files), sort_keys=True, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"MANIFEST.json: {len(files)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
