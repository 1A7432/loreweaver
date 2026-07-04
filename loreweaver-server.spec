# -*- mode: python ; coding: utf-8 -*-
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

from pathlib import Path

from PyInstaller.utils.hooks import collect_all

REPO_ROOT = Path(SPECPATH)  # noqa: F821 -- SPECPATH is injected by PyInstaller's spec exec

datas = [
    (str(REPO_ROOT / "locales"), "locales"),
    (str(REPO_ROOT / "rulepacks"), "rulepacks"),
    (str(REPO_ROOT / "skills"), "skills"),
    (str(REPO_ROOT / ".env.example"), "."),
    (str(REPO_ROOT / "adapters" / "cli" / "demo_module_en.txt"), "adapters/cli"),
]
binaries = []
hiddenimports = []

# `iroh` ships a native extension (.dylib/.so/.pyd) that plain module-graph analysis won't
# pick up; `openai`/`anthropic`/`google.genai`/`pydantic` all do enough dynamic/plugin-style
# importing (pydantic_core, provider SDK submodules) that being explicit here is cheap
# insurance against a bundle that builds clean but breaks on first real LLM call. `d20` ships
# a non-Python package-data file (`grammar.lark`, its dice-notation parser grammar) that plain
# module-graph analysis never picks up at all -- found the hard way via this spec's own
# `--doctor` smoke (a plain build "succeeds" and then crashes on the very first import).
for _pkg in ("iroh", "openai", "anthropic", "google.genai", "pydantic", "d20"):
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
