"""The Scribe (书记官) — post-turn bookkeeping reconciliation for the AI Keeper.

Born from the K3×K3 live playtest (2026-08-07): a strong narrative model ran a
whole module without ever touching the deterministic state layer — trackers
frozen at their defaults while the fiction sprinted three days ahead. Stale
panels are worse than no panels, and a KP with no ledger of what players EARNED
drifts at the finale. Bookkeeping cannot live on model discipline; it gets its
own quiet actor instead of a pile of engine restrictions (owner design call —
freedom for the KP, a ledger clerk behind it).

Two output lanes, per the owner's verdict:

- **Objective facts write directly** — module-tracker updates plainly evidenced
  by the turn's narration ("she pockets the ring" -> 信物+1). Every write goes
  through `core.modvars` validation/clamping; the scribe proposes, the engine
  disposes.
- **Judgment becomes a whisper** — a short keeper-side note injected into the
  KP's NEXT turn context ("a day seems to have passed; advance the clock",
  "that horror beat may have warranted a sanity check", "players have circled
  for several turns"). The KP keeps the judgment; the scribe only reminds.

The scribe NEVER generates fiction, never rolls dice, never decides outcomes —
iron rule #1 stays intact. It runs as a fire-and-forget task after the reply has
already streamed (zero perceived latency), on a configurable SMALL model
(`TRPG_SCRIBE__*`; blank fields reuse the main client).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agent.context import AgentCtx
from agent.services import Services
from core.documents import KEEPER_VIEWER
from core.modvars import MODVARS_DOC_ID, MODVARS_DOC_TYPE, adjust_modvar, set_modvar, wire_entries
from infra.llm import LLMClient

logger = logging.getLogger(__name__)

WHISPERS_KEY = "scribe_whispers"
MAX_OPS = 8
MAX_WHISPERS = 3
MAX_WHISPER_CHARS = 300
MAX_STORED_WHISPERS = 5
_MAX_TURN_TEXT = 4_000
_MIN_EVIDENCE_CHARS = 4

_PROMPT = """You are the table Scribe for a TTRPG engine — a silent ledger clerk, not a storyteller.

Given ONE game turn (player action + game-master reply) and the room's current trackers, output ONLY a JSON object:
{{"ops": [{{"op": "set", "id": "<tracker id>", "value": <number>, "evidence": "<verbatim quote>"}} | {{"op": "adjust", "id": "<tracker id>", "delta": <number>, "evidence": "<verbatim quote>"}}], "whispers": ["<short keeper-side note>"]}}

Rules:
- "ops" ONLY for tracker changes the narration plainly establishes as fact. "evidence" is REQUIRED: a short verbatim quote copied from the turn text that establishes the tracked quantity ITSELF changed. An op whose evidence is not an exact quote is discarded.
- You see only each tracker's id/label/range, not what earns a point. Acquiring some item is NOT evidence for an item counter unless the text explicitly identifies it as one of the things that counter counts; time passing counts on a day-tracker only when the text states the story moved to a new day. If the tracker's meaning leaves any doubt, do NOT write — whisper instead.
- "whispers" (0-{max_whispers}, each <= {max_whisper_chars} chars) for anything needing the keeper's judgment: scene/clock drift vs the fiction, a beat that likely deserved a dice check or sanity roll, players stuck without progress, an earned gain no tracker captures.
- Write whispers in the language the turn text is written in (Chinese turn -> Chinese whispers).
- Never invent trackers not listed. Never narrate. Empty ops and empty whispers is a fine answer.

Trackers (id | label | value | range):
{trackers}

Tools the game-master called this turn: {tools}

--- TURN ---
Player: {player}
Game master: {reply}
--- END ---

JSON only."""


def _scribe_llm(services: Services) -> LLMClient:
    """The scribe's client: the dedicated small model when configured, else the
    main client. Cached on the services bundle (one construction per process)."""
    cached = getattr(services, "_scribe_llm_cache", None)
    if cached is not None:
        return cached
    settings = services.settings.scribe
    if settings.provider or settings.chat_model or settings.base_url:
        from infra.providers import build_llm

        patched = services.settings.model_copy(deep=True)
        patched.llm.provider = settings.provider or services.settings.llm.provider
        patched.llm.api_key = settings.api_key or services.settings.llm.api_key
        patched.llm.base_url = settings.base_url
        patched.llm.chat_model = settings.chat_model or services.settings.llm.chat_model
        patched.llm.reasoning_effort = settings.reasoning_effort
        client = build_llm(patched)
    else:
        client = services.llm
    services._scribe_llm_cache = client  # noqa: SLF001 — our own bundle, deliberate cache slot
    return client


def _squash_ws(text: str) -> str:
    """Collapse all whitespace runs to single spaces so a model quote survives
    line-wrapping differences while staying a verbatim-substring check."""
    return " ".join(text.split())


def _extract_json(text: str) -> dict[str, Any] | None:
    """Best-effort: the first {...} object in a possibly chatty completion."""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def pop_whispers(services: Services, chat_key: str) -> list[str]:
    """Read-and-clear the pending whispers (the prompt builder's consumption side)."""
    raw = await services.store.state_get(chat_key, WHISPERS_KEY)
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except ValueError:
        parsed = []
    await services.store.state_set(chat_key, WHISPERS_KEY, "")
    return [str(item)[:MAX_WHISPER_CHARS] for item in parsed if str(item).strip()][:MAX_STORED_WHISPERS]


async def run_scribe(
    services: Services,
    ctx: AgentCtx,
    player_text: str,
    reply_text: str,
    tool_names: list[str] | None = None,
) -> bool:
    """One reconciliation pass. Returns True when any tracker actually changed
    (the caller then republishes room state so panels move). Never raises."""
    settings = services.settings.scribe
    if not settings.enabled or not reply_text.strip():
        return False
    try:
        view = await services.documents.get_view(ctx.chat_key, MODVARS_DOC_TYPE, MODVARS_DOC_ID, KEEPER_VIEWER)
        trackers = wire_entries(view or {}, ctx.locale)
    except Exception:  # noqa: BLE001 — a room without trackers still gets whispers
        trackers = []
    tracker_lines = "\n".join(
        f"- {entry.get('id')} | {entry.get('label')} | {entry.get('value')}"
        + (f" | {entry.get('min')}..{entry.get('max')}" if entry.get("min") is not None else "")
        for entry in trackers
    ) or "(none)"
    prompt = _PROMPT.format(
        max_whispers=MAX_WHISPERS,
        max_whisper_chars=MAX_WHISPER_CHARS,
        trackers=tracker_lines,
        tools=", ".join(tool_names or []) or "(none)",
        player=player_text[:_MAX_TURN_TEXT],
        reply=reply_text[:_MAX_TURN_TEXT],
    )
    try:
        result = await _scribe_llm(services).chat([{"role": "user", "content": prompt}])
    except Exception as exc:  # noqa: BLE001 — bookkeeping must never break the table
        logger.debug("scribe: llm call failed: %s", exc)
        return False
    parsed = _extract_json(result.content or "")
    if parsed is None:
        return False

    changed = False
    ops = parsed.get("ops")
    known = {str(entry.get("id")) for entry in trackers}
    # The turn text as the model saw it (same slices) — the quote pool for op evidence.
    haystack = _squash_ws(player_text[:_MAX_TURN_TEXT] + "\n" + reply_text[:_MAX_TURN_TEXT])
    if isinstance(ops, list):
        for op in ops[:MAX_OPS]:
            if not isinstance(op, dict):
                continue
            var_id = str(op.get("id", ""))
            if var_id not in known:
                continue
            evidence = _squash_ws(str(op.get("evidence") or ""))
            if len(evidence) < _MIN_EVIDENCE_CHARS or evidence not in haystack:
                logger.debug("scribe: op on %s dropped (evidence not a verbatim quote)", var_id)
                continue
            try:
                if op.get("op") == "set":
                    old, new = await set_modvar(services.documents, ctx.chat_key, var_id, op.get("value"))
                elif op.get("op") == "adjust":
                    old, new = await adjust_modvar(services.documents, ctx.chat_key, var_id, int(op.get("delta", 0)))
                else:
                    continue
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                logger.debug("scribe: op on %s rejected: %s", var_id, exc)
                continue
            if old != new:
                changed = True

    whispers_raw = parsed.get("whispers")
    if isinstance(whispers_raw, list):
        fresh = [str(item).strip()[:MAX_WHISPER_CHARS] for item in whispers_raw if str(item).strip()][:MAX_WHISPERS]
        if fresh:
            existing = []
            raw = await services.store.state_get(ctx.chat_key, WHISPERS_KEY)
            if raw:
                try:
                    existing = [str(item) for item in json.loads(raw)]
                except ValueError:
                    existing = []
            merged = (existing + fresh)[-MAX_STORED_WHISPERS:]
            await services.store.state_set(ctx.chat_key, WHISPERS_KEY, json.dumps(merged, ensure_ascii=False))
    return changed
