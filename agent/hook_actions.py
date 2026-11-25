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
from agent.hook_runtime import (
    apply_hook_state_writes,
    apply_hook_writes,
    load_action_manifest,
    load_room_hook_engine,
    manifest_label,
    refresh_hook_views,
)
from agent.services import Services
from core.hooks import (
    MAX_ACTION_ARGS_BYTES,
    MAX_ACTION_CALLS_PER_TURN,
    MAX_ACTION_RESULT_CHARS,
    MAX_PANEL_EVENTS_PER_TURN,
    MODULE_ACTION_TOOL,
    ActionSpec,
    HookEngine,
)
from infra.i18n import t
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet

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


@dataclass
class ActionRun:
    """One action call's verdict, shared by the Keeper's tool and the players' `.act`.

    `status`: "ok", "unknown" (no such action — or, for a player, not a player action),
    "bad_args", or "failed" (dice could not roll, the handler threw/timed out/returned
    non-JSON; NOTHING was applied). On "ok" the effects are already applied and listed."""

    status: str
    spec: ActionSpec | None = None
    text: str | None = None
    truncated: bool = False
    error: str = ""
    rolls: dict[str, Any] = field(default_factory=dict)
    writes: list[str] = field(default_factory=list)
    ui_frames: list[dict] = field(default_factory=list)
    panel_events: list[dict] = field(default_factory=list)


async def run_module_action(
    services: Services,
    ctx: AgentCtx,
    engine: HookEngine,
    name: str,
    raw_args: Any,
    *,
    source: str,
) -> ActionRun:
    """Validate, refresh, pre-roll, run and apply one action call. Never raises.

    The two callers differ only in `source` ("keeper" — the `module_action` tool — or
    "player" — `.act`), in caps and in delivery; everything that decides what happens is here."""
    spec = engine.action(name)
    if spec is None or (source == "player" and not spec.player):
        return ActionRun(status="unknown")
    args = _parse_args(raw_args)
    if args is None:
        return ActionRun(status="bad_args", spec=spec)
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
        return ActionRun(status="failed", spec=spec, error=str(exc)[:500])

    outcome = engine.run_action(name, args, actor=ctx.user_id, rolls=rolls, source=source)
    if not outcome.ok:
        return ActionRun(status="failed", spec=spec, error=outcome.error or "?")
    run = ActionRun(
        status="ok",
        spec=spec,
        text=outcome.text,
        truncated=outcome.truncated,
        rolls=rolls,
        ui_frames=list(outcome.ui_blocks),
        panel_events=list(outcome.panel_events),
    )
    try:
        run.writes = await apply_hook_writes(services, ctx.chat_key, outcome.writes)
        await apply_hook_state_writes(services, ctx.chat_key, engine, outcome)
    except Exception:  # noqa: BLE001 — the handler's answer stands; the write failure is logged
        logger.warning("module action %s: applying its effects failed", name, exc_info=True)
    return run


def action_dice_payload(name: str, rolls: dict[str, Any]) -> dict[str, Any]:
    """The dice frame of an action's pre-rolled slots — shaped exactly like a rulepack script
    flow's (`kind: "subsystem"`), so no client needs to learn anything new."""
    return {
        "kind": "subsystem",
        "subsystem": f"{MODULE_ACTION_TOOL}:{name}",
        "subsystem_label": name,
        "expr": name,
        "rolls": [entry["total"] for entry in rolls.values()],
        "total": sum(entry["total"] for entry in rolls.values()),
        "detail": {"rolls": rolls},
    }


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
    run = await run_module_action(services, ctx, engine, name, arguments.get("args"), source="keeper")
    if run.status == "unknown":
        available = ", ".join(action.name for action in engine.actions)
        return t("loop.module_action.unknown", locale=ctx.locale, action=name[:64], available=available)
    if run.status == "bad_args":
        return t("loop.module_action.args_invalid", locale=ctx.locale, action=name, limit=MAX_ACTION_ARGS_BYTES)
    if run.status == "failed":
        return t("loop.module_action.failed", locale=ctx.locale, action=name, error=run.error)
    effects.writes += run.writes
    effects.ui_frames += run.ui_frames
    effects.panel_events += run.panel_events
    if run.rolls:
        # An action that declares no rolls emits no dice frame.
        ctx.emit_dice(action_dice_payload(name, run.rolls))
    if run.text is None:
        return t("loop.module_action.done", locale=ctx.locale, action=name)
    if run.truncated:
        return run.text + "\n" + t("loop.module_action.truncated", locale=ctx.locale, kept=MAX_ACTION_RESULT_CHARS)
    return run.text


# ---------------------------------------------------------------------------
# The players' lane: `.act` (protocol 2.6)
# ---------------------------------------------------------------------------

# A per-room count of `.act` invocations: the seed stream of the command lane
# (`command:action:<seq>`). Without it every `.act` between two Keeper turns would draw the
# same seed, because a command engine is rebuilt per call at the same turn index.
COMMAND_SEQ_KEY = "hook_command_seq"
# What players ran since the Keeper's last turn, read-and-cleared by the prompt assembler
# (`agent.prompt_builder`) — the Keeper otherwise never learns what a player's action did.
PLAYER_ACTION_LOG_KEY = "player_action_log"
MAX_PLAYER_ACTION_LOG = 8
MAX_PLAYER_ACTION_LOG_CHARS = 400


@dataclass
class PlayerActionReply:
    """What `.act` hands the command layer to deliver: the reply text, whether it reports a
    failure (unicast to the caller) or concerns only the caller, and the table effects."""

    text: str
    failed: bool = False
    private: bool = False
    dice: dict[str, Any] | None = None
    ui_frames: list[dict] = field(default_factory=list)
    panel_events: list[dict] = field(default_factory=list)


def _player_args(rest: str) -> Any:
    """`.act <name> [rest]`: a JSON object is the args; empty is {}; anything else is text."""
    rest = rest.strip()
    if not rest:
        return {}
    try:
        parsed = json.loads(rest)
    except (json.JSONDecodeError, RecursionError):
        return {"text": rest}
    return parsed if isinstance(parsed, dict) else {"text": rest}


async def _next_command_seq(services: Services, chat_key: str) -> int:
    """Take the room's next `.act` sequence number, persisting the increment FIRST."""
    raw = await services.store.state_get(chat_key, COMMAND_SEQ_KEY)
    try:
        seq = max(0, int(raw or 0))
    except (TypeError, ValueError):
        seq = 0
    await services.store.state_set(chat_key, COMMAND_SEQ_KEY, str(seq + 1))
    return seq


async def _record_player_action(services: Services, chat_key: str, actor: str, label: str, text: str) -> None:
    """Append one result to the Keeper's "since your last turn" log. Never raises."""
    try:
        raw = await services.store.state_get(chat_key, PLAYER_ACTION_LOG_KEY)
        log = json.loads(raw) if raw else []
        if not isinstance(log, list):
            log = []
    except (json.JSONDecodeError, TypeError):
        log = []
    log.append({"actor": actor[:80], "action": label[:80], "text": text[:MAX_PLAYER_ACTION_LOG_CHARS]})
    try:
        await services.store.state_set(
            chat_key, PLAYER_ACTION_LOG_KEY, json.dumps(log[-MAX_PLAYER_ACTION_LOG:], ensure_ascii=False)
        )
    except Exception:  # noqa: BLE001 — a lost log line must not cost the action
        logger.warning("player action log write failed for %s", chat_key, exc_info=True)


async def pop_player_action_log(services: Services, chat_key: str) -> list[dict[str, str]]:
    """Read-and-clear the log (the prompt assembler's consumption side, like the whispers)."""
    raw = await services.store.state_get(chat_key, PLAYER_ACTION_LOG_KEY)
    if not raw:
        return []
    await services.store.state_set(chat_key, PLAYER_ACTION_LOG_KEY, "")
    try:
        log = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    entries = []
    for item in log[-MAX_PLAYER_ACTION_LOG:] if isinstance(log, list) else []:
        if isinstance(item, dict):
            entries.append({key: str(item.get(key, ""))[:MAX_PLAYER_ACTION_LOG_CHARS] for key in ("actor", "action", "text")})
    return entries


async def _list_player_actions(services: Services, chat_key: str, locale: str) -> PlayerActionReply:
    """`.act` alone: the room's player actions from the cached manifest — the same list a
    client's `state.actions` shows, and no engine build (a large module's costs real time)."""
    entries = await load_action_manifest(services, chat_key)
    if not entries:
        return PlayerActionReply(t("commands.act.none", locale=locale), private=True)
    lines = [t("commands.act.list_header", locale=locale)]
    for entry in entries:
        params = entry.get("params") if isinstance(entry.get("params"), str) else ""
        lines.append(
            t("commands.act.list_line", locale=locale, label=manifest_label(entry, locale), id=entry["id"],
              description=str(entry.get("description", "")), params=f" [{params}]" if params else "")
        )
    return PlayerActionReply("\n".join(lines), private=True)


async def run_player_action(
    services: Services, ctx: AgentCtx, argument: str, *, actor_name: str
) -> PlayerActionReply:
    """`.act` — list the room's player actions, or run one for the invoking member.

    Runs outside any Keeper turn, on an engine built for this call (lane `command`, seed
    ordinals from the persisted per-room counter). No per-turn cap: ordinary input rate
    limiting covers it. The `tool_use` hook is NOT consulted — this is not a tool call.
    Never raises."""
    locale = ctx.locale
    name, _, rest = argument.strip().partition(" ")
    name = name.strip()
    if not name:
        return await _list_player_actions(services, ctx.chat_key, locale)
    seq = await _next_command_seq(services, ctx.chat_key)
    engine = await load_room_hook_engine(services, ctx, lane="command", ordinal_offset=seq)
    unknown = PlayerActionReply(t("commands.act.unknown", locale=locale, name=name[:64]), failed=True)
    if engine is None:
        return unknown
    run = await run_module_action(services, ctx, engine, name, _player_args(rest), source="player")
    if run.status == "unknown" or run.spec is None:
        return unknown
    label = run.spec.label_for(locale)
    if run.status == "bad_args":
        return PlayerActionReply(
            t("commands.act.bad_args", locale=locale, label=label, limit=MAX_ACTION_ARGS_BYTES), failed=True
        )
    if run.status == "failed":
        return PlayerActionReply(t("commands.act.failed", locale=locale, label=label, error=run.error), failed=True)

    text = run.text if run.text is not None else t("commands.act.done", locale=locale, label=label)
    if run.truncated:
        text += "\n" + t("commands.act.truncated", locale=locale, kept=MAX_ACTION_RESULT_CHARS)
    reply = PlayerActionReply(
        text,
        dice=action_dice_payload(name, run.rolls) if run.rolls else None,
        ui_frames=list(run.ui_frames),
        panel_events=list(run.panel_events),
    )
    if run.writes:
        # Module logic that reacts to variables must behave the same on both paths: the
        # Keeper's turn fires `variables_changed` after its writes, so this does too (once).
        changed = engine.fire("variables_changed", {"writes": [{"path": path, "op": "set"} for path in run.writes]})
        await apply_hook_writes(services, ctx.chat_key, changed.writes)
        await apply_hook_state_writes(services, ctx.chat_key, engine, changed)
        reply.ui_frames += changed.ui_blocks
        reply.panel_events += changed.panel_events
        if changed.narrations:
            reply.text = reply.text.rstrip() + "\n\n" + "\n".join(changed.narrations)
    reply.panel_events = reply.panel_events[:MAX_PANEL_EVENTS_PER_TURN]  # the per-turn cap, per command
    await _record_player_action(services, ctx.chat_key, actor_name, label, reply.text)
    return reply


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="hook_command_seq",
        owner="agent.hook_actions",
        reset_scope="story",
        # The `.act` seed stream is derived from (room, turn in flight, this counter); the
        # turn counter (`chronicle_turn`) restarts with the session, so this does too — a
        # fresh session draws from a clean origin, and an undo rewinds both together.
        state_keys=frozenset({COMMAND_SEQ_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
    RoomStateFacet(
        name="player_action_log",
        owner="agent.hook_actions",
        reset_scope="story",
        # Session content exactly like the Scribe's whisper queue: what players did since the
        # Keeper's last turn belongs to the session that did it.
        state_keys=frozenset({PLAYER_ACTION_LOG_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
