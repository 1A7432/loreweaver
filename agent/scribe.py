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

M19 adds a third, tiny lane: **场记 (beat classification)**. Having already read the
whole turn, the scribe is the cheapest place to notice that a MOMENT just landed —
a scene change, an act turning over, a handout appearing, a critical spike — and cue
the Stage Director (`agent.stage_director`) to dress it. That cue is an ENUM and
nothing else: the scribe reads keeper trackers, and the Director's whole guarantee is
that it never receives keeper material, so a written "summary" crossing from here to
there would be a covert channel out of the keeper half. 场记 says WHICH KIND of
moment; the Director works out what happened from the player-visible stream it
receives directly.

M21 adds a fourth, and it is this module's own argument one more time: **the automatic
chronicle record**. M18 gave the campaign chronicle its documents, its fold and its
topical recall, and left the KEEPER calling `record_chronicle` as the only thing that
could ever author a record — durable memory resting on model discipline, exactly what
the Scribe exists to stop resting on. It rested on it twice over: the fold is also the
ONLY place history is ever trimmed (M20 A2's `trim_folded` keys off what the fold
absorbed), so a Keeper who never recorded got no long-term memory AND an unbounded
replayed history. Having already read the whole turn, the Scribe writes that record at
zero extra model calls — the PLAYER-GRADE text only, since the keeper spoiler margin
stays exclusively on the voluntary tool (see `_record_auto_chronicle`).

The fifth lane (born from k3 run 2, 2026-08-13) is the **NPC boundary watch**. That run's
KP voiced every NPC directly — the sub-actor channel went uncalled for 74 turns — and kept
every knowledge boundary on discipline alone, which broke exactly once: an NPC spoke a
secret name her record does not contain. A guard nobody walks past guards nothing, so the
boundary moved to where the Scribe already sits: when a room HAS NPC knowledge records,
the pass sees them and may flag one line of dialogue that crossed its speaker's recorded
boundary. FUZZY BY DESIGN (owner call): a knowledge list marks secret boundaries, not a
complete mind, so the crossing is the Scribe's judgment — the engine only frames it (the
watch arms only where records exist, the note passes the same verbatim-evidence gate as
every other claim, and it rides the ordinary whisper channel: observe, never enforce).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

from agent.chronicle import record_entry
from agent.context import AgentCtx
from agent.npc import list_npcs
from agent.services import Services
from agent.stage_director import BEATS
from agent.tool_trace import trace_event
from core.documents import KEEPER_VIEWER
from core.modvars import MODVARS_DOC_ID, MODVARS_DOC_TYPE, adjust_modvar, set_modvar, wire_entries
from core.table_habits import HABITS_DOC_TYPE, HABITS_ID, observe
from infra.llm import LLMClient
from infra.model_call_trace import lane_scope
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScribePass:
    """What one reconciliation pass produced for its caller.

    ``changed`` -> republish room state (a tracker actually moved, so panels are stale).
    ``beat`` -> cue the Stage Director; ``""`` for the ordinary turn that is not a
    moment. Deliberately just these two: everything the scribe LEARNED stays on the
    keeper side (trackers written, whispers stored), and only the enum crosses.
    """

    changed: bool = False
    beat: str = ""

    def __bool__(self) -> bool:
        return self.changed or bool(self.beat)


WHISPERS_KEY = "scribe_whispers"
MAX_OPS = 8
SCRIBE_TRACE_KIND = "scribe"

MAX_WHISPERS = 3
MAX_WHISPER_CHARS = 300
MAX_STORED_WHISPERS = 5
_MAX_TURN_TEXT = 4_000
_MIN_EVIDENCE_CHARS = 4
# Hard ceiling on one auto-written chronicle record. Records land in a document the
# fold consumes and the prompt tail renders, both of which are already capped — a
# record is a LINE of campaign history, not a retelling of the turn.
_MAX_CHRONICLE_CHARS = 400
# The boundary watch's input budget: how many scoped NPCs one pass shows, and how many
# characters of each one's fact list. Rooms with no knowledge records pay nothing —
# the prompt stays byte-identical (see `_npc_watch_section`).
_NPC_WATCH_MAX = 8
_NPC_WATCH_FACTS_CHARS = 300

# Appended to the prompt ONLY when the room has scoped NPCs (double braces survive the
# outer `.format`). The instruction mirrors the fuzzy semantics deliberately: the list
# is a secrets boundary, not a complete mind, and "unsure" means stay silent.
_NPC_WATCH_BLOCK = """
NPC knowledge boundaries — KEEPER-ONLY, never to be repeated outward (name | the facts this NPC knows). These lists mark SECRET boundaries, not complete minds — everyday knowledge (weather, town routine, their own trade) never crosses one. If dialogue the game-master reply attributes to one of these NPCs reveals something clearly beyond both its listed facts and everyday knowledge, add one extra key to the JSON: "npc_overreach": {{"npc": "<name>", "quote": "<verbatim dialogue quote from the reply>", "fact": "<what it revealed beyond its boundary>"}} — at most one, the clearest crossing. Omit the key when nothing crossed or you are unsure.
{npc_lines}
"""

_PROMPT = """You are the table Scribe for a TTRPG engine — a silent ledger clerk, not a storyteller.

Given ONE game turn (player action + game-master reply) and the room's current trackers, output ONLY a JSON object:
{{"ops": [{{"op": "set", "id": "<tracker id>", "value": <number>, "evidence": "<verbatim quote>"}} | {{"op": "adjust", "id": "<tracker id>", "delta": <number>, "evidence": "<verbatim quote>"}}], "whispers": ["<short keeper-side note>"], "unrolled_check": {{"skill": "<skill>", "evidence": "<verbatim quote>"}} or null, "habit": {{"summary": "<one line>", "detail": "<a sentence or two>"}} or null, "chronicle": "<one line of campaign history, or empty>", "beat": "<beat>"}}

Rules:
- "ops" ONLY for tracker changes the narration plainly establishes as fact. "evidence" is REQUIRED: a short verbatim quote copied from the GAME-MASTER reply that establishes the tracked quantity ITSELF changed. The player's message states what they ATTEMPT, never what happened — it can never be evidence, and an op whose evidence is not an exact quote of the game-master reply is discarded.
- You see only each tracker's id/label/range, not what earns a point. Acquiring some item is NOT evidence for an item counter unless the text explicitly identifies it as one of the things that counter counts; time passing counts on a day-tracker only when the text states the story moved to a new day. If the tracker's meaning leaves any doubt, do NOT write — whisper instead.
- "unrolled_check": set it when this turn resolved something whose outcome was genuinely uncertain and no dice were rolled for it — name the skill it called for and quote the exact text that shows the resolution. Tools the game-master called this turn are listed below; if a dice tool is among them, this is null. A declared intention with no outcome yet, a foregone conclusion, and pure conversation are all null. You are reporting an observation for the keeper to judge, not issuing an instruction — say nothing when unsure.
- "habit": how THIS TABLE plays, when the turn shows it — pacing they prefer, how much combat they have patience for, what kind of scene they lean into, a keeper technique that landed or fell flat. Write about the group's behaviour, not about the story: "they cut short investigation scenes to get to confrontation" is a habit, "they found the key" is not. Only when the turn actually shows it; null is the right answer most turns. Repeated observations are what make it stick, so write the same habit the same way each time you see it.
- "whispers" (0-{max_whispers}, each <= {max_whisper_chars} chars) for anything needing the keeper's judgment: scene/clock drift vs the fiction, players stuck without progress, an earned gain no tracker captures.
- Write whispers in the language the turn text is written in (Chinese turn -> Chinese whispers).
- "chronicle": ONE short past-tense line recording what this turn established for the campaign's history — what the table would want to remember months from now. This record is shown to PLAYERS, and the game-master reply is the ONLY thing you may build it from: write what that reply said out loud, never a motive or consequence it left unsaid. Everything else in this prompt — tracker labels and values, NPC knowledge lists — is keeper-only material the players have not learned; a name, object or explanation that appears there but not in the reply must stay out of this line, however true it is. Empty string when the turn established nothing that outlasts it (talk, out-of-character chatter, an intention with no outcome yet). Write it in the language of the turn text.
- "beat" classifies this turn as a MOMENT worth staging, one of: {beats}, or "none". Use "none" unless the turn clearly is one of them — most turns are "none".
  - scene_change: the group moved somewhere else, or time visibly moved on.
  - act_transition: a chapter/day/act of the story turned over.
  - handout: a document, picture, map or object the players can now LOOK at appeared.
  - spike: a critical success, a fumble, or a shock the table will remember.
  It is a single word, not a description — write nothing else about the beat.
- Never invent trackers not listed. Never narrate. Empty ops and empty whispers is a fine answer.

Trackers (id | label | value | range):
{trackers}
{npc_watch}
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


def _unrolled_check_note(raw: Any, haystack: str, services: Services, locale: str) -> str:
    """A whisper naming a check the turn resolved without dice, or `""`.

    Held to the SAME evidence gate as a tracker write (5601795): a claim that cannot quote
    the game-master's own text does not get to reach the Keeper. The reasoning is the same
    one iron rule #2 rests on — the player's message says what they attempted, the reply
    says what happened, and only the second can evidence an unrolled resolution.

    Phrasing matters here. The note observes; it does not instruct. The engine gates on
    nothing and prescribes nothing, so the Keeper reads it and decides — including
    deciding that no check was warranted.
    """
    if not isinstance(raw, dict):
        return ""
    skill = str(raw.get("skill") or "").strip()[:60]
    evidence = _squash_ws(str(raw.get("evidence") or ""))
    if not skill or len(evidence) < _MIN_EVIDENCE_CHARS or evidence not in haystack:
        logger.debug("scribe: unrolled_check dropped (evidence not a verbatim quote)")
        return ""
    return services.i18n.with_locale(locale).t(
        "scribe.whisper.unrolled_check", skill=skill, quote=evidence[:MAX_WHISPER_CHARS // 2]
    )[:MAX_WHISPER_CHARS]


async def _npc_watch_section(services: Services, chat_key: str) -> tuple[str, frozenset[str]]:
    """The boundary watch's prompt block and the names it covers, or `("", ∅)`.

    Only scoped NPCs are watched — a boundary can only be crossed where someone drew
    one — so a room where nobody ever called `set_npc_knowledge` keeps a byte-identical
    Scribe prompt and this lane costs nothing. These records are keeper-side material,
    and this pass has ONE player-facing output — the `chronicle` line (M21, added after
    this lane's first draft). So the block is labelled keeper-only where it enters and
    the chronicle rule names it where it could leave; keeping the record inside what the
    reply said aloud is a prompt constraint the secrecy evals check, like every other
    Scribe claim about the fiction.
    """
    try:
        records = await list_npcs(services.documents, chat_key)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — a room whose NPC docs won't load still gets everything else
        return "", frozenset()
    scoped = [record for record in records if record.name.strip() and record.knowledge][:_NPC_WATCH_MAX]
    if not scoped:
        return "", frozenset()
    lines = "\n".join(
        f"- {record.name} | {'; '.join(record.knowledge)[:_NPC_WATCH_FACTS_CHARS]}" for record in scoped
    )
    return _NPC_WATCH_BLOCK.format(npc_lines=lines), frozenset(record.name for record in scoped)


def _npc_overreach_note(
    raw: Any, haystack: str, watched: frozenset[str], services: Services, locale: str
) -> str:
    """A whisper naming an NPC line that crossed its recorded knowledge, or `""`.

    Held to the same evidence gate as every other Scribe claim (5601795): the quote must
    be the game-master reply verbatim, and the speaker must be an NPC the pass actually
    showed a boundary for — a name the model invented cannot smuggle a note in. What the
    gate deliberately does NOT judge is the crossing itself: that is the fuzzy half, and
    it belongs to the model. Like the unrolled-check note, this observes and never
    instructs — the Keeper decides whether the line needs smoothing over, and nothing
    here touches the fiction that already streamed.
    """
    if not isinstance(raw, dict):
        return ""
    npc = str(raw.get("npc") or "").strip()[:60]
    fact = str(raw.get("fact") or "").strip()[:120]
    quote = _squash_ws(str(raw.get("quote") or ""))
    if not npc or npc not in watched or not fact:
        return ""
    if len(quote) < _MIN_EVIDENCE_CHARS or quote not in haystack:
        logger.debug("scribe: npc_overreach dropped (quote not verbatim from the reply)")
        return ""
    return services.i18n.with_locale(locale).t(
        "scribe.whisper.npc_overreach", npc=npc, fact=fact, quote=quote[: MAX_WHISPER_CHARS // 3]
    )[:MAX_WHISPER_CHARS]


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


async def _record_habit(services: Services, ctx: AgentCtx, raw: Any) -> None:
    """Fold one observed habit into the room's table-habits document. Never raises."""
    if not isinstance(raw, dict):
        return
    summary = str(raw.get("summary") or "").strip()
    if not summary:
        return
    try:
        existing = await services.documents.get(ctx.chat_key, HABITS_DOC_TYPE, HABITS_ID)
        data, promoted = observe(existing.data if existing else {}, summary, str(raw.get("detail") or ""))
        await services.documents.put(ctx.chat_key, HABITS_DOC_TYPE, HABITS_ID, data)
        if promoted:
            logger.debug("scribe: table habit promoted for %s: %s", ctx.chat_key, summary)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — bookkeeping must never break the table
        logger.debug("scribe: habit note dropped: %s", exc)


async def _record_auto_chronicle(
    services: Services, ctx: AgentCtx, raw: Any, *, turn: int, tool_names: list[str]
) -> bool:
    """Append this turn's automatic chronicle record (M21). Never raises. True if written.

    PLAYER-GRADE BY CONSTRUCTION: `keeper` is never written from here. The spoiler
    margin — what the players missed, which secret consequence is now armed — stays
    exclusively on the voluntary `record_chronicle` tool, where the Keeper adds it
    deliberately. So whatever the model wrote in this field, this path cannot author
    keeper-side material at all (iron rule #3). What is left is that the TEXT must stay
    inside what the reply already said aloud, which the prompt instructs and the
    secrecy evals check — the same division of labour every other Scribe lane uses.
    """
    settings = services.settings.chronicle
    if not settings.enabled or not settings.auto_record:
        return False
    if turn <= 0:
        # No committed turn to record against — the provider-error early return writes
        # no history and never advances the counter. A record stamped on a turn that
        # has no history would let a later fold trim history it never summarised.
        return False
    if "record_chronicle" in tool_names:
        # The Keeper recorded this turn deliberately, and may have annotated it. That
        # record stands; a near-duplicate would only add fold and recall noise.
        return False
    text = str(raw or "").strip()[:_MAX_CHRONICLE_CHARS]
    if not text:
        return False  # a quiet turn records nothing — most turns of pure talk land here
    try:
        await record_entry(services, ctx.chat_key, text=text, turn=turn)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — bookkeeping must never break the table
        logger.debug("scribe: auto chronicle record dropped: %s", exc)
        return False
    return True


async def run_scribe(
    services: Services,
    ctx: AgentCtx,
    player_text: str,
    reply_text: str,
    tool_names: list[str] | None = None,
    turn: int = 0,
) -> ScribePass:
    """One reconciliation pass (see :class:`ScribePass`).

    Operational failures never raise — bookkeeping must not break the table.
    ``asyncio.CancelledError`` is not an operational failure and always
    propagates, so a lifecycle cancel-and-drain can abort mid-write.
    """
    settings = services.settings.scribe
    if not settings.enabled:
        # Without this the probe cannot tell "the Scribe never ran" from "the Scribe
        # died" — both used to look like a session with zero whispers, zero habits,
        # zero chronicle lines, and no way to tell why.
        trace_event(SCRIBE_TRACE_KIND, {"outcome": "disabled"}, chat_key=ctx.chat_key)
        return ScribePass()
    if not reply_text.strip():
        trace_event(SCRIBE_TRACE_KIND, {"outcome": "empty_reply"}, chat_key=ctx.chat_key)
        return ScribePass()
    try:
        view = await services.documents.get_view(ctx.chat_key, MODVARS_DOC_TYPE, MODVARS_DOC_ID, KEEPER_VIEWER)
        trackers = wire_entries(view or {}, ctx.locale)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — a room without trackers still gets whispers
        trackers = []
    tracker_lines = "\n".join(
        f"- {entry.get('id')} | {entry.get('label')} | {entry.get('value')}"
        + (f" | {entry.get('min')}..{entry.get('max')}" if entry.get("min") is not None else "")
        for entry in trackers
    ) or "(none)"
    npc_watch, watched_npcs = await _npc_watch_section(services, ctx.chat_key)
    prompt = _PROMPT.format(
        max_whispers=MAX_WHISPERS,
        max_whisper_chars=MAX_WHISPER_CHARS,
        beats=", ".join(BEATS),
        trackers=tracker_lines,
        npc_watch=npc_watch,
        tools=", ".join(tool_names or []) or "(none)",
        player=player_text[:_MAX_TURN_TEXT],
        reply=reply_text[:_MAX_TURN_TEXT],
    )
    try:
        with lane_scope("scribe", chat_key=ctx.chat_key):
            result = await _scribe_llm(services).chat([{"role": "user", "content": prompt}])
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — bookkeeping must never break the table
        logger.debug("scribe: llm call failed: %s", exc)
        trace_event(SCRIBE_TRACE_KIND, {"outcome": "llm_failed"}, chat_key=ctx.chat_key)
        return ScribePass()
    parsed = _extract_json(result.content or "")
    if parsed is None:
        trace_event(SCRIBE_TRACE_KIND, {"outcome": "parse_failed"}, chat_key=ctx.chat_key)
        return ScribePass()

    changed = False
    applied_ops = 0
    ops = parsed.get("ops")
    proposed_ops = len(ops) if isinstance(ops, list) else 0
    known = {str(entry.get("id")) for entry in trackers}
    # The quote pool is the KEEPER's narration only (same slice the model saw). A
    # player message is an ATTEMPT, never an outcome — the same reason iron rule #2
    # lets the dice decide instead of the player's assertion — so player text may
    # inform a whisper but can never be the verbatim evidence for a tracker write.
    haystack = _squash_ws(reply_text[:_MAX_TURN_TEXT])
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
            applied_ops += 1
            if old != new:
                changed = True

    whispers_raw = parsed.get("whispers")
    fresh_whispers = (
        [str(item).strip()[:MAX_WHISPER_CHARS] for item in whispers_raw if str(item).strip()][:MAX_WHISPERS]
        if isinstance(whispers_raw, list)
        else []
    )
    # M20 C3: "should this have been checked?" is a judgement that needs the fiction read,
    # so it lives here rather than in a lexicon inside the loop. It rides the ordinary
    # whisper channel into the Keeper's next turn — the engine prescribes NO action and
    # gates on nothing. That is the watcher-actor line: the Scribe observes, the Keeper
    # judges. It stops being enforcement and becomes observability, which costs nothing
    # measurable: the deleted lexicon's enforcement value was never established, because
    # the metric that watched it shared its blind spots.
    unrolled = _unrolled_check_note(parsed.get("unrolled_check"), haystack, services, ctx.locale)
    if unrolled:
        fresh_whispers = [*fresh_whispers, unrolled][:MAX_WHISPERS]

    # The NPC boundary watch (see module docstring). Consulted ONLY when the watch was
    # armed this pass — a field the model volunteers for a room with no records is a
    # hallucination and is ignored, never gated on.
    if watched_npcs:
        overreach = _npc_overreach_note(parsed.get("npc_overreach"), haystack, watched_npcs, services, ctx.locale)
        if overreach:
            fresh_whispers = [*fresh_whispers, overreach][:MAX_WHISPERS]

    if fresh_whispers:
        existing = []
        raw = await services.store.state_get(ctx.chat_key, WHISPERS_KEY)
        if raw:
            try:
                existing = [str(item) for item in json.loads(raw)]
            except ValueError:
                existing = []
        merged = (existing + fresh_whispers)[-MAX_STORED_WHISPERS:]
        await services.store.state_set(ctx.chat_key, WHISPERS_KEY, json.dumps(merged, ensure_ascii=False))

    # M20 E procedural memory: a habit is only a habit once it recurs, and the Scribe has
    # no cross-turn memory to count with — so the tally lives in the document's own
    # `pending` section, and a candidate promotes at the threshold. Zero additional model
    # calls: the Scribe already read the whole turn to do everything above.
    await _record_habit(services, ctx, parsed.get("habit"))

    # M21 durable memory: one player-grade line of campaign history per material turn,
    # so the chronicle (and the fold that trims history off the back of it) no longer
    # waits on the Keeper remembering a tool. Zero extra model calls, same as the habit.
    wrote_chronicle = await _record_auto_chronicle(
        services, ctx, parsed.get("chronicle"), turn=turn, tool_names=tool_names or []
    )

    # 场记: a single word from a closed vocabulary, or nothing. Anything else the model
    # wrote here is discarded rather than forwarded — this field is the ONLY thing that
    # crosses from the keeper-side scribe to the player-side Director.
    beat = str(parsed.get("beat") or "").strip()
    beat = beat if beat in BEATS else ""
    # The verdict, into the tool probe (`TRPG_DEBUG__TOOL_TRACE`). This pass makes
    # decisions that never become a tool call, so without this line a session's
    # bookkeeping — and the beat that cues the Director — leaves no trace to read back.
    trace_event(
        SCRIBE_TRACE_KIND,
        {
            "beat": beat,
            "ops": applied_ops,
            "ops_seen": proposed_ops,
            "whispers": len(fresh_whispers),
            "chronicle": wrote_chronicle,
        },
        chat_key=ctx.chat_key,
    )
    return ScribePass(changed=changed, beat=beat)


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="scribe_whispers",
        owner="agent.scribe",
        reset_scope="story",
        # Owner verdict 2026-08-14: the whisper queue belongs to the session that produced
        # it. A fresh session's first Keeper prompt used to open with the LAST session's
        # scribe notes — "that check went unrolled", about a check nobody in this story ever
        # made. At most a handful of lines could cross (the queue is read-and-cleared each
        # prompt build), which is exactly why nobody noticed.
        state_keys=frozenset({WHISPERS_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
