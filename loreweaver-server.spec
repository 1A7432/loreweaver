# -*- mode: python -*-
"""PyInstaller build spec for the self-contained `loreweaver-server` bundle.

Built via `scripts/package_server.py` (which also smoke-tests + archives the result); do not
run `pyinstaller` on this file directly outside that wrapper unless you're debugging, since the
wrapper is what proves the bundle actually works before it's ever archived.

ONEDIR (not onefile): faster start, fewer AV false-positives, and the natural shape for
bundling a native dependency (`iroh`)'s shared library alongside pure-Python code.

Datas MIRROR the repo layout inside the bundle's `_internal/` support directory
(`("locales", "locales")` etc.) so the existing `Path(__file__).resolve().parent.parent` root
computation in `infra/i18n.py`, `core/rulepacks.py`, and `core/skills.py` keeps resolving to the
right directory unmodified in a frozen build — proven by `scripts/package_server.py`'s
`--doctor` smoke, which is the one thing that would fail loudly if this ever stopped holding.
"""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

REPO_ROOT = Path(SPECPATH)  # noqa: F821 -- SPECPATH is injected by PyInstaller's spec exec

# Bake the resolved version into the bundle: a frozen binary has neither the
# setuptools-scm-generated `_lw_version` module nor installed package metadata to read
# at runtime (see `infra/version.py`'s resolution order), so `--version`/`--doctor`
# instead read this `VERSION` sidecar out of the bundle's data directory
# (`sys._MEIPASS`). Freshly resolved on every build (in THIS process, run in the build
# env by `scripts/package_server.py` / CI, where `.git` — or an already-built
# `_lw_version.py` — is present) so it is never stale; gitignored, never hand-edited.
sys.path.insert(0, str(REPO_ROOT))
from infra.version import resolve_version  # noqa: E402

VERSION_PATH = REPO_ROOT / "VERSION"
VERSION_PATH.write_text(resolve_version() + "\n", encoding="utf-8")

datas = [
    (str(REPO_ROOT / "locales"), "locales"),
    (str(REPO_ROOT / "rulepacks"), "rulepacks"),
    (str(REPO_ROOT / "skills"), "skills"),
    (str(REPO_ROOT / ".env.example"), "."),
    (str(VERSION_PATH), "."),
    (str(REPO_ROOT / "adapters" / "cli" / "demo_module_en.txt"), "adapters/cli"),
]
binaries = []
hiddenimports = []

# Native extensions and dynamically imported SDK modules need explicit collection. `d20` also
# ships its parser grammar as package data; `nacl` and `davey` provide Discord voice binaries.
# Telegram and Feishu are optional source-install extras, but release bundles deliberately ship
# their SDKs so every documented `--platforms` value works in the self-contained executable.
for _pkg in (
    "iroh",
    "openai",
    "anthropic",
    "google.genai",
    "pydantic",
    "d20",
    "discord",
    "nacl",
    "davey",
    "telegram",
    "lark_oapi",
):
    _datas, _binaries, _hidden = collect_all(_pkg)
    datas += _datas
    binaries += _binaries
    hiddenimports += _hidden

a = Analysis(  # noqa: F821
    [str(REPO_ROOT / "app.py")],
    pathex=[str(REPO_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="loreweaver-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="loreweaver-server",
)
