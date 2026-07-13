"""Build a self-contained, per-platform Loreweaver SERVER bundle (PyInstaller onedir).

    uv sync --extra package --extra anthropic --extra gemini
    uv run python scripts/package_server.py [--skip-serve-smoke] [--no-archive]

Produces one archive in `dist/`:

    loreweaver-server-{windows-x64.zip, macos-arm64.tar.gz, linux-x64.tar.gz, linux-arm64.tar.gz}

named for the platform this script is RUN ON (see `detect_platform_tag` — there is no
cross-compilation here). Each archive contains ONE top-level directory `loreweaver-server/`:
the PyInstaller onedir bundle, whose executable is `loreweaver-server` (`loreweaver-server.exe`
on Windows). The actual PyInstaller build is driven by the committed `loreweaver-server.spec`
(sibling of this script's repo root) — this script wraps it with the two things a bare
`pyinstaller` invocation can't do: a real smoke test of the built binary, and archiving.

Flow: PyInstaller build -> smoke the built binary -> archive. The smoke test is what makes a
green build here trustworthy on a machine with none of this repo's Python/uv/toolchain:
    (a) `<binary> --doctor` exits 0 and names coc7 + dnd5e + >=4 skills + en/zh locales
        (a bundle missing datas or hitting a frozen-`__file__` path bug fails LOUD here,
        not silently at first real use);
    (b) unless `--skip-serve-smoke`, `<binary> --serve` actually binds the Iroh p2p transport
        and prints a real ticket, then a clean SIGTERM shutdown — proof the native `iroh`
        extension made it into the bundle and actually loads.
"""

from __future__ import annotations

import argparse
import platform
import queue
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = REPO_ROOT / "dist"
SPEC_PATH = REPO_ROOT / "loreweaver-server.spec"
BUNDLE_NAME = "loreweaver-server"

# The Iroh ticket line printed by `_announce_iroh_ticket` (app.py) always embeds a ticket
# string starting with the literal "endpoint" prefix followed by a long base32-ish tail —
# this is stable across relays/keys, only the tail content varies.
_TICKET_RE = re.compile(r"endpoint[a-z0-9]{20,}")
_SERVE_SMOKE_TIMEOUT = 90.0
_SERVE_SHUTDOWN_TIMEOUT = 20.0


class PackagingError(RuntimeError):
    """A clear, user-facing packaging failure (unsupported platform, failed smoke, ...)."""


# --------------------------------------------------------------------------
# Platform detection (pure functions — unit tested offline).
# --------------------------------------------------------------------------


def detect_platform_tag(sys_platform: str, machine: str) -> str:
    """Map a `(sys.platform, platform.machine())` pair to one of the four pinned
    distribution asset tags: macos-arm64, linux-x64, linux-arm64, windows-x64.

    Raises `PackagingError` with a plain-language message for anything unsupported —
    notably macOS Intel (darwin/x86_64), which the `iroh` native dependency ships no
    wheel for, so a bundle built there could never actually run.
    """
    machine = machine.lower()
    if sys_platform == "darwin":
        if machine in ("arm64", "aarch64"):
            return "macos-arm64"
        if machine in ("x86_64", "amd64"):
            raise PackagingError(
                "macOS Intel (darwin/x86_64) is not a supported build machine: the 'iroh' "
                "native dependency ships no wheel for it. Build on Apple Silicon instead."
            )
        raise PackagingError(f"Unsupported macOS architecture: {machine!r}")
    if sys_platform.startswith("linux"):
        if machine in ("x86_64", "amd64"):
            return "linux-x64"
        if machine in ("aarch64", "arm64"):
            return "linux-arm64"
        raise PackagingError(f"Unsupported Linux architecture: {machine!r}")
    if sys_platform == "win32":
        if machine in ("amd64", "x86_64"):
            return "windows-x64"
        raise PackagingError(f"Unsupported Windows architecture: {machine!r}")
    raise PackagingError(f"Unsupported platform: sys.platform={sys_platform!r} machine={machine!r}")


def current_platform_tag() -> str:
    """`detect_platform_tag` applied to the machine this process is actually running on."""
    return detect_platform_tag(sys.platform, platform.machine())


def archive_name(tag: str) -> str:
    """The pinned `dist/` archive filename for a platform tag, e.g. `loreweaver-server-macos-arm64.tar.gz`."""
    ext = "zip" if tag == "windows-x64" else "tar.gz"
    return f"{BUNDLE_NAME}-{tag}.{ext}"


def executable_name(tag: str) -> str:
    """The bundle's entry-point filename inside `loreweaver-server/` for a platform tag."""
    return f"{BUNDLE_NAME}.exe" if tag == "windows-x64" else BUNDLE_NAME


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------


def run_pyinstaller() -> Path:
    """Run PyInstaller against the committed spec file. Returns the built onedir bundle
    directory, `dist/loreweaver-server/`."""
    if shutil.which("pyinstaller") is not None:
        cmd = ["pyinstaller", "--noconfirm", "--clean", str(SPEC_PATH)]
    else:
        # `uv sync --extra package` normally puts the console script on PATH; this is a
        # fallback for environments where it isn't.
        cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", str(SPEC_PATH)]
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)

    bundle_dir = DIST_DIR / BUNDLE_NAME
    if not bundle_dir.is_dir():
        raise PackagingError(f"PyInstaller did not produce the expected bundle dir: {bundle_dir}")
    return bundle_dir


# --------------------------------------------------------------------------
# Smoke
# --------------------------------------------------------------------------


def smoke_test(bundle_dir: Path, tag: str, *, skip_serve: bool) -> None:
    """Run both smoke checks against the just-built binary. Raises `PackagingError` (never
    lets a broken bundle silently reach the archive step)."""
    binary = bundle_dir / executable_name(tag)
    if not binary.exists():
        raise PackagingError(f"Bundle executable missing: {binary}")
    _smoke_version(binary)
    _smoke_doctor(binary)
    if skip_serve:
        print("--skip-serve-smoke: skipping the --serve smoke.")
    else:
        _smoke_serve(binary)


def _smoke_version(binary: Path) -> None:
    """`<binary> --version` must print the real git-derived version baked in at build
    time (`loreweaver-server.spec`'s `VERSION` sidecar), never the last-resort fallback
    — a frozen bundle has no other way to know its version, so silently falling back
    here would mean the bake step regressed."""
    print(f"$ {binary} --version")
    result = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=60)
    output = (result.stdout + result.stderr).strip()
    print(output)
    if result.returncode != 0:
        raise PackagingError(f"--version exited {result.returncode}:\n{output}")
    if not output or output == "0.0.0+unknown":
        raise PackagingError(f"--version printed the fallback, not a real derived version:\n{output!r}")


def _smoke_doctor(binary: Path) -> None:
    print(f"$ {binary} --doctor")
    result = subprocess.run([str(binary), "--doctor"], capture_output=True, text=True, timeout=60)
    output = result.stdout + result.stderr
    print(output)
    if result.returncode != 0:
        raise PackagingError(f"--doctor exited {result.returncode}:\n{output}")

    required_tokens = ["coc7", "dnd5e", "en", "zh"]
    missing = [token for token in required_tokens if token not in output]
    if missing:
        raise PackagingError(f"--doctor output is missing expected tokens {missing}:\n{output}")

    skills_match = re.search(r"\((\d+)\)", output)
    skill_count = int(skills_match.group(1)) if skills_match else 0
    if skill_count < 4:
        raise PackagingError(f"--doctor reported only {skill_count} skills (need >= 4):\n{output}")


def _smoke_serve(binary: Path) -> None:
    tmpdir = Path(tempfile.mkdtemp(prefix="loreweaver-serve-smoke-"))
    keys_path = tmpdir / "keys.toml"
    cmd = [str(binary), "--serve", "--keys", str(keys_path)]
    print(f"$ {' '.join(cmd)}  (cwd={tmpdir})")

    proc = subprocess.Popen(
        cmd,
        cwd=tmpdir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    line_queue: queue.Queue[str | None] = queue.Queue()

    def _pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            line_queue.put(line)
        line_queue.put(None)

    reader = threading.Thread(target=_pump_stderr, daemon=True)
    reader.start()

    seen: list[str] = []
    ticket_seen = False
    try:
        deadline = time.monotonic() + _SERVE_SMOKE_TIMEOUT
        while time.monotonic() < deadline:
            try:
                line = line_queue.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                break
            if line is None:
                break
            seen.append(line.rstrip("\n"))
            print(f"[serve] {line.rstrip()}")
            if _TICKET_RE.search(line):
                ticket_seen = True
                break

        if not ticket_seen:
            raise PackagingError(
                f"serve smoke: no Iroh ticket line seen on stderr within "
                f"{_SERVE_SMOKE_TIMEOUT:.0f}s. Output so far:\n" + "\n".join(seen)
            )

        # A clean shutdown proves the frozen bundle handles SIGTERM the same way the
        # source app does (app.py's SIGTERM handler cancels the serve task and closes the
        # Iroh endpoint) rather than hanging or crash-looping under a supervisor.
        proc.terminate()
        try:
            returncode = proc.wait(timeout=_SERVE_SHUTDOWN_TIMEOUT)
        except subprocess.TimeoutExpired as exc:
            proc.kill()
            proc.wait(timeout=10)
            raise PackagingError(
                f"serve smoke: server did not exit within {_SERVE_SHUTDOWN_TIMEOUT:.0f}s of "
                "SIGTERM (force-killed)"
            ) from exc
        if returncode != 0:
            raise PackagingError(f"serve smoke: server exited {returncode} after SIGTERM (expected a clean 0 exit)")
        print(f"serve smoke: clean exit after SIGTERM (code {returncode})")
    finally:
        if proc.poll() is None:
            proc.kill()
        reader.join(timeout=5)
        shutil.rmtree(tmpdir, ignore_errors=True)


# --------------------------------------------------------------------------
# Archive
# --------------------------------------------------------------------------


def make_archive(bundle_dir: Path, tag: str) -> Path:
    """Archive `bundle_dir` (`dist/loreweaver-server/`) into the pinned per-platform name,
    preserving ONE top-level `loreweaver-server/` directory inside the archive."""
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DIST_DIR / archive_name(tag)
    if out_path.exists():
        out_path.unlink()

    if tag == "windows-x64":
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(bundle_dir.rglob("*")):
                if path.is_file():
                    zf.write(path, Path(BUNDLE_NAME) / path.relative_to(bundle_dir))
    else:
        # Host-local extraction intentionally rejects link members: even a
        # relative child can escape its staging directory through an earlier
        # symlink/hardlink. Materialise PyInstaller's internal symlinks as
        # regular members so release archives keep that strict contract.
        with tarfile.open(out_path, "w:gz", dereference=True) as tf:
            tf.add(bundle_dir, arcname=BUNDLE_NAME)
    return out_path


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--skip-serve-smoke",
        action="store_true",
        help="Skip the --serve smoke (for CI runners without relay/network access).",
    )
    parser.add_argument(
        "--no-archive",
        action="store_true",
        help="Build + smoke only; skip producing the dist/ archive (debugging).",
    )
    args = parser.parse_args(argv)

    try:
        tag = current_platform_tag()
    except PackagingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"Target platform: {tag}")

    try:
        bundle_dir = run_pyinstaller()
        smoke_test(bundle_dir, tag, skip_serve=args.skip_serve_smoke)
        if args.no_archive:
            print(f"--no-archive: built + smoke-tested {bundle_dir}; skipping the archive step.")
            return 0
        archive_path = make_archive(bundle_dir, tag)
    except PackagingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"error: build/smoke subprocess failed: {exc}", file=sys.stderr)
        return 1

    size_mib = archive_path.stat().st_size / (1024 * 1024)
    print(f"Built {archive_path} ({size_mib:.1f} MiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
