"""Module actions: hook-defined deterministic mechanics the Keeper calls MID-TURN.

A hook script registers `defineAction(name, spec, handler)` (`core.hooks`); this module is
the agent half. Every action of the room is surfaced as ONE generic tool, `module_action`
(`module_action_schemas`), offered only when the turn's hook engine has at least one action,
and dispatched from `agent.loop._dispatch_one` after the `tool_use` veto, at the subsystem
level (`dispatch_module_action`).

Why a tool and not another event: `dice_rolled` and the other reply-phase events run after
the narration is final, so a hook could never answer the Keeper inside the turn — the
Keeper narrated numbers the hook had not booked yet (`docs/notes/implemented/
scribe-writes-answer-to-hook-veto.md`, "Not fixed here"). An action's return value IS the
tool result, so the next round of the same turn reads what the engine booked.

Iron rule #1 holds the same way it does for events: the handler runs in the sandbox against
fresh snapshots, its effects come back as buffers, and deterministic code here applies them
through the existing paths (`apply_hook_writes`, `apply_hook_state_writes`, the turn's UI
and panel frames). Dice are rolled by the real engine BEFORE the handler runs (iron rule #2),
exactly as the rulepack script-flow lane does. Nothing here raises into the turn.

Effects that belong to the turn as a whole (variable paths for `hook_writes`, UI frames,
panel events) are collected per ENGINE — one engine per `run_kp_turn`, so a nested companion
turn's actions can never land in the parent's lists — and drained by the loop before the
reply-phase hooks (`drain_action_effects`).
"""

from __future__ import annotations

import json
import logging
import weakref
from dataclasses import dataclass, field
from typing import Any

from agent.context import AgentCtx
from agent.hook_runtime import apply_hook_state_writes, apply_hook_writes, refresh_hook_views
from agent.services import Services
from core.hooks import (
    MAX_ACTION_ARGS_BYTES,
    MAX_ACTION_CALLS_PER_TURN,
    MAX_ACTION_RESULT_CHARS,
    MODULE_ACTION_TOOL,
    HookEngine,
)
from infra.i18n import t

logger = logging.getLogger(__name__)

_TOOL_SUMMARY = (  # i18n-exempt: model-facing tool schema text
    "Run one of this module's own deterministic mechanics and get its booked result back "  # i18n-exempt: model-facing tool schema text
    "in this turn. The engine rolls any dice the action declares and applies its effects; "  # i18n-exempt: model-facing tool schema text
    "narrate from the result it returns, never from your own estimate. Actions:"  # i18n-exempt: model-facing tool schema text
)
_ACTION_PARAM = "Which action to run."  # i18n-exempt: model-facing tool schema text
_ARGS_PARAM = (  # i18n-exempt: model-facing tool schema text
    "The action's arguments as a JSON object, shaped as its [hint] says; {} when it takes none."  # i18n-exempt: model-facing tool schema text
)


@dataclass
class ActionTurnEffects:
    """What this turn's module actions produced that the TURN reports, in call order."""

    calls: int = 0
    writes: list[str] = field(default_factory=list)
    ui_frames: list[dict] = field(default_factory=list)
    panel_events: list[dict] = field(default_factory=list)


_EFFECTS: weakref.WeakKeyDictionary[HookEngine, ActionTurnEffects] = weakref.WeakKeyDictionary()


def _effects(engine: HookEngine) -> ActionTurnEffects:
    effects = _EFFECTS.get(engine)
    if effects is None:
        effects = _EFFECTS[engine] = ActionTurnEffects()
    return effects


def drain_action_effects(engine: HookEngine | None) -> ActionTurnEffects:
    """Hand the loop what this engine's actions produced, and forget it (the call count stays:
    the per-turn cap is about the turn, not about what was drained)."""
    if engine is None:
        return ActionTurnEffects()
    effects = _effects(engine)
    drained = ActionTurnEffects(
        calls=effects.calls,
        writes=effects.writes,
        ui_frames=effects.ui_frames,
        panel_events=effects.panel_events,
    )
    effects.writes, effects.ui_frames, effects.panel_events = [], [], []
    return drained


def module_action_schemas(engine: HookEngine | None) -> list[dict[str, Any]]:
    """The `module_action` tool, or nothing when this turn's engine has no action.

    Deterministic for a given set of scripts (registration order, no timestamps), so the
    prompt-cache prefix the tool list sits in stays stable while the room's scripts do."""
    if engine is None or not engine.actions:
        return []
    lines = []
    for spec in engine.actions:
        line = f"- {spec.name} — {spec.description}"
        if spec.params:
            line += f" [{spec.params}]"
        lines.append(line)
    return [
        {
            "type": "function",
            "function": {
                "name": MODULE_ACTION_TOOL,
                "description": _TOOL_SUMMARY + "\n" + "\n".join(lines),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [spec.name for spec in engine.actions],
                            "description": _ACTION_PARAM,
                        },
                        "args": {"type": "object", "description": _ARGS_PARAM},
                    },
                    "required": ["action"],
                },
            },
        }
    ]


def offers_module_action(engine: HookEngine | None) -> bool:
    return engine is not None and bool(engine.actions)


def _parse_args(raw: Any) -> dict[str, Any] | None:
    """The call's `args` as an object, or None when it is not one (or is over the cap). A
    JSON-encoded object string is accepted: some providers stringify nested arguments."""
    if raw is None:
        raw = {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else {}
        except (json.JSONDecodeError, RecursionError):
            return None
    if not isinstance(raw, dict):
        return None
    try:
        size = len(json.dumps(raw, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError, RecursionError):
        return None
    return raw if size <= MAX_ACTION_ARGS_BYTES else None


async def dispatch_module_action(
    services: Services, ctx: AgentCtx, engine: HookEngine, arguments: dict[str, Any] | None
) -> str:
    """Run one `module_action` call; the returned string is the tool result. Never raises."""
    arguments = arguments or {}
    effects = _effects(engine)
    effects.calls += 1
    name = str(arguments.get("action") or "")
    if effects.calls > MAX_ACTION_CALLS_PER_TURN:
        return t("loop.module_action.cap", locale=ctx.locale, limit=MAX_ACTION_CALLS_PER_TURN)
    spec = engine.action(name)
    if spec is None:
        available = ", ".join(action.name for action in engine.actions)
        return t("loop.module_action.unknown", locale=ctx.locale, action=name[:64], available=available)
    args = _parse_args(arguments.get("args"))
    if args is None:
        return t("loop.module_action.args_invalid", locale=ctx.locale, action=name, limit=MAX_ACTION_ARGS_BYTES)
    try:
        # The action must see the store as it is NOW: Keeper-tool writes earlier this turn,
        # earlier actions' writes, and anything a nested companion turn persisted.
        await refresh_hook_views(services, ctx.chat_key, engine, variables=True)
        rolls: dict[str, Any] = {}
        for slot, expression in spec.rolls:
            result = services.dice.roll_expression(expression)
            rolls[slot] = {"expr": expression, "total": result.total, "dice": list(result.rolls)}
    except Exception as exc:  # noqa: BLE001 — a bad dice expression is the action's failure
        logger.warning("module action %s could not start: %s", name, exc)
        return t("loop.module_action.failed", locale=ctx.locale, action=name, error=str(exc)[:500])

    outcome = engine.run_action(name, args, actor=ctx.user_id, rolls=rolls)
    if not outcome.ok:
        return t("loop.module_action.failed", locale=ctx.locale, action=name, error=outcome.error or "?")

    try:
        effects.writes += await apply_hook_writes(services, ctx.chat_key, outcome.writes)
        await apply_hook_state_writes(services, ctx.chat_key, engine, outcome)
    except Exception:  # noqa: BLE001 — the handler's answer stands; the write failure is logged
        logger.warning("module action %s: applying its effects failed", name, exc_info=True)
    effects.ui_frames += outcome.ui_blocks
    effects.panel_events += outcome.panel_events
    if rolls:
        # Surfaced to the table exactly like a rulepack script flow's pre-rolled dice; an
        # action that declares no rolls emits no dice frame.
        ctx.emit_dice(
            {
                "kind": "subsystem",
                "subsystem": f"{MODULE_ACTION_TOOL}:{name}",
                "subsystem_label": name,
                "expr": name,
                "rolls": [entry["total"] for entry in rolls.values()],
                "total": sum(entry["total"] for entry in rolls.values()),
                "detail": {"rolls": rolls},
            }
        )
    if outcome.text is None:
        return t("loop.module_action.done", locale=ctx.locale, action=name)
    if outcome.truncated:
        return outcome.text + "\n" + t("loop.module_action.truncated", locale=ctx.locale, kept=MAX_ACTION_RESULT_CHARS)
    return outcome.text
