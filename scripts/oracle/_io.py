"""Shared plumbing for the reference-vector exporters.

Three jobs live here:

* ``hermetic()`` -- make the process safe to import the engine from: no ``.env``, no ``TRPG_*``
  environment, and an audit hook that aborts the moment anything opens a private directory.
* ``scripted_random`` -- replace the global ``random`` draw functions with a scripted source that
  RECORDS every draw, so a vector never depends on CPython's ``random`` stream.
* ``write_jsonl`` -- the deterministic writers (sorted keys, one object per line, gzip with a zeroed
  header past ~1 MB).

Import this module BEFORE importing anything from ``core``/``infra``/``agent``.
"""

from __future__ import annotations

import contextlib
import gzip
import hashlib
import io
import json
import os
import random
import sys
import tempfile
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "server" / "test" / "fixtures" / "reference"

# Above this many bytes of JSON-lines text a file is written gzip-compressed.
GZIP_THRESHOLD = 1_000_000

# Paths the exporter must never read (private material lives there).
_FORBIDDEN = tuple(
    (REPO_ROOT / name).resolve() for name in ("content", "data", "modules", "playtest", "shared", ".env", "keys.toml")
)

_SCRATCH: tempfile.TemporaryDirectory[str] | None = None
_HOOKED = False


def scratch_dir() -> Path:
    """A process-private temp directory for anything the engine insists on writing."""
    global _SCRATCH
    if _SCRATCH is None:
        _SCRATCH = tempfile.TemporaryDirectory(prefix="oracle-")
    return Path(_SCRATCH.name)


# Every attempt to touch a forbidden path, kept even if the engine swallows the PermissionError.
VIOLATIONS: list[str] = []

_AUDITED_EVENTS = frozenset({"open", "os.listdir", "os.scandir"})


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if event not in _AUDITED_EVENTS or not args:
        return
    target = args[0]
    if isinstance(target, int) or target is None:
        return
    try:
        resolved = Path(os.fsdecode(target)).resolve()
    except (OSError, ValueError, TypeError):
        return
    for banned in _FORBIDDEN:
        if resolved == banned or banned in resolved.parents:
            VIOLATIONS.append(f"{event} {resolved}")
            raise PermissionError(f"oracle exporter must not read {resolved}")


def assert_no_private_reads() -> None:
    """Fail the export if anything tried to open a private path, even when the engine caught the error."""
    if VIOLATIONS:
        raise AssertionError("private paths were touched: " + "; ".join(sorted(set(VIOLATIONS))))


def hermetic() -> None:
    """Scrub the environment and install the read guard (idempotent)."""
    global _HOOKED
    for key in [key for key in os.environ if key.startswith("TRPG_")]:
        del os.environ[key]
    os.environ["TRPG_ENV_FILE"] = os.devnull
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    if not _HOOKED:
        sys.addaudithook(_audit)
        _HOOKED = True


hermetic()


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------


def dumps(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def jsonable(value: Any) -> Any:
    """Plain JSON data for engine values (tuples -> lists, dataclasses -> dicts, sets -> sorted lists)."""
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return {"$float": repr(value)}
        return value
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted((jsonable(item) for item in value), key=dumps)
    if hasattr(value, "__dataclass_fields__"):
        return {name: jsonable(getattr(value, name)) for name in value.__dataclass_fields__}
    raise TypeError(f"not JSON-able: {type(value).__name__}")


def error_dict(exc: BaseException) -> dict[str, str]:
    """An engine exception as plain data: its class name and its English message."""
    return {"class": type(exc).__name__, "message": str(exc)}


# ---------------------------------------------------------------------------
# Deterministic writers
# ---------------------------------------------------------------------------


def write_jsonl(name: str, rows: Iterable[Any]) -> tuple[str, int, str]:
    """Write ``<name>.jsonl`` (or ``<name>.jsonl.gz`` past ~1 MB) into the reference directory.

    Returns ``(filename, row_count, sha256_of_the_uncompressed_jsonl_text)``. The hash covers the
    logical content, so it does not depend on the zlib build that produced a ``.gz``.
    """
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    lines = [dumps(row) for row in rows]
    data = ("\n".join(lines) + "\n").encode("utf-8") if lines else b""
    plain = OUT_DIR / f"{name}.jsonl"
    packed = OUT_DIR / f"{name}.jsonl.gz"
    if len(data) > GZIP_THRESHOLD:
        buffer = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as handle:
            handle.write(data)
        packed.write_bytes(buffer.getvalue())
        plain.unlink(missing_ok=True)
        filename = packed.name
    else:
        plain.write_bytes(data)
        packed.unlink(missing_ok=True)
        filename = plain.name
    return filename, len(lines), hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# Scripted randomness
# ---------------------------------------------------------------------------

_MASK = (1 << 64) - 1


def splitmix64(state: int) -> int:
    """The SplitMix64 output function (Vigna), applied to ``state``."""
    z = (state + 0x9E3779B97F4A7C15) & _MASK
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK
    return z ^ (z >> 31)


def scripted_value(seed: int, k: int, lo: int, hi: int, step: int = 1) -> int:
    """The k-th (0-based) generated draw of a vector: uniform over ``lo, lo+step, .., hi``.

    ``index = splitmix64(seed * 2**32 + k) mod n`` where ``n`` is the number of values in the
    range; the value is ``lo + index * step``.
    """
    count = (hi - lo) // step + 1
    return lo + step * (splitmix64(((seed & 0xFFFFFFFF) << 32) + k) % count)


class DrawLog:
    """One vector's randomness: optional forced values first, then the seeded generator.

    ``draws`` lists every draw in call order as ``[lo, hi, value, step]`` -- the inclusive range of
    values the engine could end up using, the value it did use, and the stride between possible
    values. ``randint(a, b)`` records ``[a, b, value, 1]``. The ``d20`` library draws a die as the
    zero-based ``random.randrange(size)`` and adds 1; that draw is recorded as the FACE it produced,
    ``[1, size, face, 1]`` (and the zero-based index is what the library gets back). A percentile
    ``d%`` die is ``randrange(0, 100, 10)`` and is recorded as ``[0, 90, tens, 10]``.

    ``forced`` values are interpreted in the recorded domain (faces for dice, values for ``randint``).
    A forced value outside the range of the draw it lands on raises when ``strict``; otherwise it is
    clamped into range (the recorded value is always the one the engine really received).
    """

    def __init__(self, seed: int, forced: Sequence[int] | None = None, strict: bool = True) -> None:
        self.seed = int(seed)
        self.forced = list(forced or [])
        self.strict = strict
        self.draws: list[list[int]] = []

    def _next(self, lo: int, hi: int, stride: int) -> int:
        k = len(self.draws)
        if k < len(self.forced):
            value = self.forced[k]
            if not (lo <= value <= hi and (value - lo) % stride == 0):
                if self.strict:
                    raise AssertionError(f"forced draw #{k} = {value} is outside [{lo}, {hi}] step {stride}")
                value = min(max(value, lo), hi)
                value -= (value - lo) % stride
        else:
            value = scripted_value(self.seed, k, lo, hi, stride)
        self.draws.append([lo, hi, value, stride])
        return value

    def randrange(self, start: int, stop: int | None = None, step: int = 1) -> int:
        if stop is None:
            # d20's die: a zero-based index into a `start`-faced die. Logged as the face.
            if start < 1:
                raise ValueError("empty range for randrange()")
            return self._next(1, start, 1) - 1
        span = range(start, stop, step)
        if len(span) == 0:
            raise ValueError("empty range for randrange()")
        lo, hi = span[0], span[-1]
        if lo > hi:
            lo, hi = hi, lo
        return self._next(lo, hi, abs(span.step))

    def randint(self, a: int, b: int) -> int:
        return self.randrange(a, b + 1)


def _poisoned(name: str):
    def _refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(f"random.{name} is not scripted; the exporter must not touch it")

    return _refuse


_POISON = (
    "random",
    "uniform",
    "choice",
    "choices",
    "shuffle",
    "sample",
    "getrandbits",
    "randbytes",
    "gauss",
    "triangular",
)


class _PositionOrderedSet(set):
    """A ``set`` that iterates in the order its members sit in the dice set they were selected from."""

    _order: dict[int, int]

    def __iter__(self) -> Iterator[Any]:
        order = self._order
        return iter(sorted(set.__iter__(self), key=lambda die: order.get(id(die), len(order))))


@contextlib.contextmanager
def _pinned_d20_order() -> Iterator[None]:
    """Make the ``d20`` library's reroll order reproducible.

    ``SetOperator.select`` returns a plain Python ``set`` of ``Die`` objects and ``rr`` / ``ro`` roll
    them in that set's iteration order -- which follows object ADDRESSES, so with two or more
    matching dice the assignment of draws to dice differs from one process to the next (the real
    engine is not deterministic here). The exporter pins it to left-to-right die position, the
    order a reimplementation should use.
    """
    import d20.expression as expression

    original = expression.SetOperator.select

    def select(self: Any, target: Any, max_targets: int | None = None) -> set[Any]:
        chosen = original(self, target, max_targets)
        ordered = _PositionOrderedSet(chosen)
        ordered._order = {id(node): index for index, node in enumerate(target.set)}
        return ordered

    expression.SetOperator.select = select  # type: ignore[method-assign]
    try:
        yield
    finally:
        expression.SetOperator.select = original  # type: ignore[method-assign]


@contextlib.contextmanager
def scripted_random(seed: int, forced: Sequence[int] | None = None, strict: bool = True) -> Iterator[DrawLog]:
    """Swap ``random.randint``/``random.randrange`` for a recording scripted source.

    The engine draws through exactly these two (``DiceRoller`` via ``random.randint``, the ``d20``
    library via ``random.randrange``). Every other ``random`` draw function raises, so a stray use
    of CPython's stream cannot leak into a vector. The real functions are restored on exit. Also
    pins the one address-dependent ordering inside ``d20`` (see ``_pinned_d20_order``).
    """
    log = DrawLog(seed, forced, strict)
    saved = {name: getattr(random, name) for name in ("randint", "randrange", *_POISON)}
    random.randint = log.randint  # type: ignore[assignment]
    random.randrange = log.randrange  # type: ignore[assignment]
    for name in _POISON:
        setattr(random, name, _poisoned(name))
    try:
        with _pinned_d20_order():
            yield log
    finally:
        for name, original in saved.items():
            setattr(random, name, original)


def assert_scripts_held(rows: Iterable[dict[str, Any]]) -> None:
    """Fail the export if any vector died on a mis-scripted forced draw (a bug in an exporter's case list)."""
    for row in rows:
        error = row.get("error")
        if isinstance(error, dict) and error.get("class") == "AssertionError":
            raise AssertionError(f"mis-scripted vector: {dumps(row)[:300]}")
