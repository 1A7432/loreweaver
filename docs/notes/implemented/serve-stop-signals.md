# Implemented: Ctrl-C and `kill -INT` stop the server the way SIGTERM does

- **Problem:** `app._serve_iroh` hooked only SIGTERM and assumed Ctrl-C reached the same
  clean shutdown through `asyncio.run`'s KeyboardInterrupt path. It did not, reliably. A
  server started with a shell `&` (how a script, a test or an agent backgrounds it)
  inherits SIGINT as ignored; Python then installs no SIGINT handler, and
  `asyncio.Runner` only hooks SIGINT over Python's default one, so it installs none
  either. `kill -INT` was a silent no-op: measured on macOS, Python 3.13, iroh 1.1, the
  server was still serving and its client still connected 35 s later, where the same
  signal from a default start exited 0 in ~0.2 s. And where SIGINT did fire, the first
  one only cancelled the main task — clean solely because `except CancelledError: pass`
  turned that into a normal return — while the second raised `KeyboardInterrupt` from
  wherever the loop was, possibly in the middle of `iroh_server.close()`.
- **Decision:** one loop handler for SIGTERM and SIGINT alike: cancel the serve task, so
  `finally: await iroh_server.close()` runs and every client gets a real close instead of
  waiting out the QUIC idle timeout. An explicit handler also replaces an inherited
  `SIG_IGN`, which is what makes `kill -INT` work on a backgrounded server. Both handlers
  are removed BEFORE `close()`, which hands SIGINT back to Python's default: a second
  Ctrl-C during shutdown raises `KeyboardInterrupt`, which `_run_serve` already catches
  (the store is still closed, exit 0), so a close that hangs can still be escaped.
  Windows has no `add_signal_handler` and keeps its old path. No new operator-facing
  strings.
- **Reason:** an operator's Ctrl-C and a supervisor's stop are the same intent and must
  end the same way — clients closed, store closed — whatever the process inherited at
  start. Keeping the handlers through `close()` would have swallowed the second Ctrl-C
  too, leaving a hung close with no way out short of SIGKILL.
- **Rule home:** `docs/defensive-patterns.md` pattern 9; `app.py::_serve_iroh` /
  `_run_serve`; pinned by `tests/net/test_iroh_server.py` (both signals in-process,
  starting SIGINT ignored, plus real-subprocess runs: one SIGINT closes cleanly from a
  default and from an inherited-ignored start, and a second SIGINT abandons a close that
  never returns).
- **Date:** 2026-10-21 (commit 812ad03).
