"""The prep-phase script hatch (M20 F) — plan-then-apply.

Bulk import, bulk NPC creation, bulk variable definition are low-frequency, broadly
reversible and composition-heavy: forty NPCs from a spreadsheet is forty near-identical
tool calls, and that is the one place a scripted lane pays for itself. Available in the
**prep phase only** — the play path keeps typed tools, because every in-play Keeper write
is irreversible game state and CodeAct's two hard costs land exactly there (actions stop
being atomic, and `keeper_only` cannot be enforced on arbitrary JS).

**The script produces a PLAN; the engine applies it.** This is not a preference. The
QuickJS binding cannot combine an execution time limit with Python callables — the
zero-callable bridge constraint the EJS work already hit — so a script literally cannot
call a tool. It emits an operation list, and the engine applies each operation through the
same `@tool` validation and gating a model-issued call goes through.

That single shape recovers everything the CodeAct exclusion was worried about:

- **atomicity** — the whole plan is read and validated before anything is applied;
- **permission granularity** — `keeper_only` / `gated` / `prep_only` are enforced per
  operation, by the same code, because they ARE the same code;
- **dry run, free** — a plan is data, so previewing it costs nothing extra.

`.import … world` and `.var expose` stay outside the reachable surface by construction:
they are keeper COMMANDS, not tools, and this hatch can only name tools (拆卡 doctrine —
world machinery and MVU exposure are keeper affordances, never model or script ones).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from core.ejs_full import MEMORY_LIMIT_BYTES, TIME_LIMIT_SECONDS

MAX_SCRIPT_CHARS = 20_000
MAX_OPERATIONS = 200
MAX_ARGUMENT_BYTES = 8_000

# Engine-internal diagnostics: they reach the model wrapped in `prep_script.invalid`,
# the same convention the other internal guards in core/ use.
_UNREADABLE = "the script produced no readable plan"  # i18n-exempt

# The sandbox prelude. `plan()` is the ONLY effect a prep script has: it records an
# intention, and nothing runs until the engine has read the whole list back and put every
# entry through the same validation and gating a model-issued tool call goes through.
_PRELUDE = (
    "globalThis.__plan = [];"  # i18n-exempt: JavaScript source, not UI text
    " function plan(tool, args) {"
    " globalThis.__plan.push({ tool: String(tool), args: args === undefined ? {} : args });"
    " }"
)


@dataclass
class PrepPlan:
    """What one script asked for, before anything has happened."""

    operations: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""

    def __bool__(self) -> bool:
        return not self.error


def build_plan(source: str) -> PrepPlan:
    """Run `source` in a sandbox and return the operations it asked for. Never raises.

    The script sees no engine state and no callables — only `plan()` and whatever it
    computes for itself. That is a consequence of the binding, and it is also the right
    shape: a script that could read live state would tempt a plan that is only valid at
    the instant it was built.
    """
    if not source or not source.strip():
        return PrepPlan(error="empty script")  # i18n-exempt: internal diagnostic
    if len(source) > MAX_SCRIPT_CHARS:
        return PrepPlan(error=f"script exceeds {MAX_SCRIPT_CHARS} characters")  # i18n-exempt
    try:
        import quickjs
    except ImportError:
        return PrepPlan(error="the script sandbox is unavailable on this server")  # i18n-exempt

    context = quickjs.Context()
    try:
        context.set_memory_limit(MEMORY_LIMIT_BYTES)
        context.eval(_PRELUDE)
        # The time limit arms BEFORE the untrusted source runs, so a top-level infinite
        # loop times out instead of hanging the server.
        context.set_time_limit(TIME_LIMIT_SECONDS)
        context.eval(source)
        raw = context.eval("JSON.stringify(globalThis.__plan)")
    except Exception as exc:  # noqa: BLE001 — a broken script reports, never raises
        return PrepPlan(error=str(exc))
    return _validate(raw)


def _validate(raw: Any) -> PrepPlan:
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else []
    except ValueError:
        return PrepPlan(error=_UNREADABLE)
    if not isinstance(parsed, list):
        return PrepPlan(error=_UNREADABLE)
    if len(parsed) > MAX_OPERATIONS:
        return PrepPlan(error=f"a plan may hold at most {MAX_OPERATIONS} operations")  # i18n-exempt
    operations: list[dict[str, Any]] = []
    for index, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            return PrepPlan(error=f"operation {index} is not an object")  # i18n-exempt
        tool = str(entry.get("tool") or "").strip()
        if not tool:
            return PrepPlan(error=f"operation {index} names no tool")  # i18n-exempt
        args = entry.get("args")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            return PrepPlan(error=f"operation {index} arguments must be an object")  # i18n-exempt
        if len(json.dumps(args, ensure_ascii=False).encode("utf-8")) > MAX_ARGUMENT_BYTES:
            return PrepPlan(error=f"operation {index} arguments are too large")  # i18n-exempt
        operations.append({"tool": tool, "args": args})
    return PrepPlan(operations=operations)
