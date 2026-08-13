"""The campaign chronicle, generative half (M18) — the fold flow.

`core.chronicle` holds the deterministic policy (document types, projections,
hysteresis levels, the no-future watermark); this module is the LLM-driven flow
on top of it:

- `maybe_fold_chronicle` — the per-turn hook (wired into `agent.loop.run_kp_turn`
  BEFORE prompt assembly, so both the 0.60 trigger and the 0.85 emergency fold
  land before the next model call). Read from the room's `usage_stats` meter —
  last turn's prompt size, a reactive measurement rather than a prediction.
  Normally that is the provider's own count; for an endpoint that reports none
  it is `agent.loop`'s estimate of the same prompt, flagged as such, because a
  meter that is merely ABSENT reads as "no pressure" and would leave the fold —
  emergency level included — permanently inert. Batch-folds the oldest chronicle
  records into the rolling `campaign_summary` until as many tokens as the floor
  needs have left the prompt, bounded by a per-turn batch budget.
  What a fold actually FREES is replayed HISTORY: writing
  `campaign_summary.through_turn` is what lets `agent.history.trim_folded` stop
  replaying every turn at or below it, and that is the whole of a fold's effect
  on the prompt (the summary itself is bounded and the section renders no raw
  records). So both the gate and the batch sizing are solved in that unit —
  `_history_tokens_through`, the `estimate_tokens` sum over the messages a fold
  through a given turn would drop — rather than by summing the folded records'
  own sizes, which measure text that was never in the prompt twice.
  When history cannot cover the deficit at all, the fold takes everything it
  has — the spec's small-window edge, "fold does its best".
  What remains approximate is only the UNIT: the meter is the provider's
  tokenizer over the whole prompt, `_history_tokens_through` is
  `estimate_tokens` over the replayed messages, and folded records can flow back
  in through topical recall. So both guards stay — a routine fold does not run
  when there is no replayed history left for it to free, and does not re-arm
  until the measured meter actually grows past the reading the previous fold
  acted on. Neither is redundant now that the arithmetic is honest: they answer
  "did this fold pay for itself" from the meter, which is the only authority on
  that. Synchronous by design: a fire-and-forget fold could race the NEXT turn's
  prompt assembly, and folds are rare by hysteresis. Best-effort throughout — a
  fold failure never breaks a turn.
- `record_entry` — the append path behind the `record_chronicle` tool. Entries
  are stamped with the in-progress turn index (counter + 1); the tool accepts
  no turn parameter, so nothing can be recorded speculatively (past-only).
- `build_chronicle_sections` — the prompt injection, split at the same cache
  boundary `agent.prompt_builder` is: the campaign summary (+ its keeper margin)
  rides the STABLE head, open threads and the topically recalled folded records
  ride the volatile tail. No raw unfolded tail is rendered at all: an unfolded
  record's turn is above `through_turn` by construction, so its turn's verbatim
  history is still being replayed and rendering it would put the same events in
  the prompt twice. KP-grade: this is the Keeper's own system prompt, so keeper
  annotations ride along (they never cross `project()` on player surfaces).
- `render_recap` — the player-facing "previously on…", rendered ONLY from
  player projections, so it is spoiler-free by construction.
- folded records join the embedding index (collection "chronicle", the
  worldbook payload scheme) so old history stays topically retrievable —
  chronicle and worldbook never mix stores; they meet only in retrieval.

The fold input is the records' public `text` ONLY — keeper annotations never
enter the fold prompt, so a chatty summarizer cannot copy a secret into the
player-facing summary. Annotations survive in the entry documents themselves
(keeper-side, retrievable), and the summary's `keeper` margin is written by no
fold — it is keeper-editable (`.chronicle note`) and preserved verbatim across
regenerations.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, load_chain, trim_folded
from agent.services import Services
from core.chronicle import (
    CAMPAIGN_SUMMARY_DOC_TYPE,
    CAMPAIGN_SUMMARY_ID,
    CHRONICLE_DOC_TYPE,
    THREAD_DOC_TYPE,
    FoldCandidate,
    estimate_tokens,
    fold_decision,
    fold_watermark,
    select_fold_batch,
    validate_fold_input,
)
from core.documents import KEEPER_VIEWER, PLAYER_VIEWER, Document
from infra.i18n import I18n
from infra.llm import HISTORY_TURN_KEY
from infra.room_facets import STORAGE_DOCUMENTS, STORAGE_ROOM_STATE, STORAGE_VECTORS, RoomStateFacet

logger = logging.getLogger(__name__)

__all__ = [
    "CAMPAIGN_SUMMARY_DOC_TYPE",
    "CAMPAIGN_SUMMARY_ID",
    "CHRONICLE_DOC_TYPE",
    "THREAD_DOC_TYPE",
    "ChronicleSections",
    "FoldOutcome",
    "advance_chronicle_turn",
    "build_chronicle_sections",
    "chronicle_turn",
    "maybe_fold_chronicle",
    "recall_folded_entries",
    "record_entry",
    "render_recap",
    "summary_through_turn",
]

CHRONICLE_TURN_KEY = "chronicle_turn"
CHRONICLE_SEQ_KEY = "chronicle_seq"
CHRONICLE_COLLECTION = "chronicle"

# One fold call consumes at most this many records — a bounded generation input;
# the loop iterates batches until the floor is reached instead.
_FOLD_BATCH_MAX_ENTRIES = 12
# ... and one TURN spends at most this many fold generation calls. A long backlog
# drains over several turns rather than stalling one player's turn behind an
# unbounded chain of sequential summarizations (a 1000-entry backlog was ~84).
# `.chronicle fold` (force) is the manual, unbounded drain.
_FOLD_MAX_BATCHES_PER_TURN = 3
# Re-arm threshold, as a fraction of the context window: after a fold, the next
# ROUTINE fold waits until the measured meter has actually grown this much. See
# `_last_fold_meter` for why the observed meter, not the predicted saving, decides.
_FOLD_REARM_GROWTH = 0.05
# Where that observation is parked: a field on the summary singleton, so it is
# room-scoped, exported, and reset alongside the records it describes — no second
# runtime key to keep in sync. Keeper-side by construction (the player projection
# is a field allowlist). Its value is a `{tokens, estimated}` object, not a bare
# count: the two sources are not on one scale, and a stamp that could not say which
# one it came from would silently invite the comparison in `_rearm_check`.
_FOLD_METER_FIELD = "fold_meter"
_THREADS_MAX = 12
_RECALL_LIMIT = 4
_RECALL_MAX_CHARS = 6000
_RECAP_TAIL_MAX = 8


@dataclass(frozen=True)
class _Meter:
    """One reading of the room's context-fullness meter, WITH its provenance.

    `tokens` is the last completed turn's assembled-prompt size and `window` the
    room model's context window, exactly as `infra.usage_stats` persisted them.
    `estimated` says nobody measured it: the endpoint reported no usage for a
    streamed turn, so `agent.loop` sized the prompt itself.

    The flag travels with the number because the two sources do not share a scale
    — a provider's tokenizer counts framing, tool schemas and its own preamble
    that `estimate_tokens` can only approximate — so a difference between a
    measured and an estimated reading describes the SOURCE, not the room. Only
    `_rearm_check` compares two readings, and it is where that distinction is
    enforced.
    """

    tokens: int = 0
    window: int = 0
    estimated: bool = False


@dataclass
class FoldOutcome:
    """What one fold pass did (observability for the manual command + tests)."""

    ran: bool = False
    level: str = "none"  # none | fold | emergency | manual | recovery
    batches: int = 0
    entries_folded: int = 0
    rejected: int = 0  # fold inputs refused by the no-future guard
    before: float = 0.0
    after: float = 0.0
    through_turn: int = 0
    folded_ids: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# The turn counter (fold watermark + entry stamps derive from it)
# ---------------------------------------------------------------------------


async def chronicle_turn(store: Any, chat_key: str) -> int:
    """The room's count of COMPLETED KP turns (0 for a fresh room)."""
    raw = await store.state_get(chat_key, CHRONICLE_TURN_KEY)
    try:
        return int(raw) if raw else 0
    except (TypeError, ValueError):
        return 0


async def summary_through_turn(services: Services, chat_key: str) -> int:
    """The newest room turn the rolling summary has absorbed (0 when nothing has folded).

    Batches fold oldest-first and each one rewrites this field with its own newest turn,
    so it only ever moves forward — which makes it a stable watermark for anything that
    wants to know "what is now covered by the summary rather than by raw records". The
    loop's history trim (M20 A2) is the first such caller. Never raises: an unreadable
    summary reads as "nothing folded", so the caller keeps everything.
    """
    try:
        summary = await services.documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
        if summary is None:
            return 0
        through = summary.data.get("through_turn", 0)
        return through if isinstance(through, int) and not isinstance(through, bool) and through > 0 else 0
    except Exception:  # noqa: BLE001 — a watermark read must never break a turn
        logger.debug("chronicle summary watermark read failed", exc_info=True)
        return 0


async def advance_chronicle_turn(store: Any, chat_key: str) -> None:
    """Increment the completed-turn counter. Wired into `run_kp_turn` right after the
    turn's history is persisted; best-effort bookkeeping — never raises."""
    try:
        await store.state_set(chat_key, CHRONICLE_TURN_KEY, str(await chronicle_turn(store, chat_key) + 1))
    except Exception:  # noqa: BLE001 — bookkeeping must never break the table
        return


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------


async def record_entry(
    services: Services,
    chat_key: str,
    *,
    text: str,
    keeper: str = "",
    pcs: tuple[str, ...] | list[str] = (),
    scene: str = "",
    turn: int | None = None,
) -> Document:
    """Append one chronicle entry, stamped with the turn it records.

    Past-only for the MODEL by construction: `record_chronicle` exposes no turn
    parameter, so the stamp it gets is the room's own counter (completed turns + 1 =
    the turn now in flight) and nothing can be recorded ahead of the fiction.

    `turn` is for ENGINE callers that already know which turn they are recording and
    run OUTSIDE that turn — the M21 auto-feeder is one: the Scribe runs after
    `run_kp_turn` returned, by which point the counter has advanced past the turn it
    read (and companion sub-turns may have advanced it further). Deriving there would
    stamp the record AHEAD of the turn it summarises, and since `trim_folded` drops
    history by turn index, a folded record carrying too high a stamp would cut history
    no summary covers. The value is the engine's own index, never the model's.
    """
    raw = await services.store.state_get(chat_key, CHRONICLE_SEQ_KEY)
    try:
        seq = int(raw or 0) + 1
    except ValueError:
        seq = 1
    await services.store.state_set(chat_key, CHRONICLE_SEQ_KEY, str(seq))
    stamp = turn if turn is not None and turn > 0 else await chronicle_turn(services.store, chat_key) + 1
    data = {
        "text": text.strip(),
        "keeper": keeper.strip(),
        "turn": stamp,
        "pcs": [str(pc).strip() for pc in pcs if str(pc).strip()],
        "scene": scene.strip(),
        "folded": False,
        "tokens": estimate_tokens(text),
    }
    return await services.documents.put(chat_key, CHRONICLE_DOC_TYPE, f"c{seq:05d}", data)


# ---------------------------------------------------------------------------
# The fold flow
# ---------------------------------------------------------------------------


async def fold_for_overflow(
    ctx: AgentCtx,
    services: Services,
    *,
    history_key: str = DEFAULT_HISTORY_KEY,
    batches_spent: int = 0,
) -> FoldOutcome:
    """Fold because the PROVIDER said the prompt is too big (M23 WS2).

    The routine fold is driven by the usage meter. This entry point exists for the case
    where the meter was wrong: a provider refused the call with a context-overflow error
    (`infra.llm_errors`), which is the one reading that cannot be stale, missing or
    measured in the wrong unit. So it takes no meter reading at all — no trigger, no
    re-arm stamp, no deficit arithmetic, nothing sized against a number that has just
    been proven unreliable. It folds by BATCH, oldest first, and stops at the same
    per-turn budget a routine fold has.

    What it keeps from the routine path is the part that is not about the meter: the
    no-future watermark (a fold may never consume a record from the in-flight scene) and
    the replay-floor guard (if folding would free no replayed history, it frees nothing,
    and the caller must not retry). `entries_folded == 0` therefore means "no progress",
    which is exactly the condition on which `agent/loop.py` declines to retry.

    `batches_spent` is what this turn's ROUTINE fold already used. The two share ONE
    per-turn budget rather than getting one each: a turn that had already folded three
    batches and still overflowed does not get to fold three more, so the per-KP-turn
    generation count stays exactly where the AGENTS.md budget paragraph says it is.
    A remainder of zero means no fold, which means no progress, which means no retry.
    """
    settings = services.settings.chronicle
    if not settings.enabled:
        return FoldOutcome()
    remaining = _FOLD_MAX_BATCHES_PER_TURN - max(0, batches_spent)
    if remaining <= 0:
        logger.debug("chronicle recovery fold skipped: this turn's fold budget is already spent")
        return FoldOutcome()
    try:
        return await _fold_flow(
            ctx, services, force=False, recovery=True, history_key=history_key, max_batches=remaining
        )
    except Exception:  # noqa: BLE001 — same stance as the routine fold: never fatal
        logger.debug("chronicle recovery fold failed", exc_info=True)
        return FoldOutcome()


async def maybe_fold_chronicle(
    ctx: AgentCtx, services: Services, *, force: bool = False, history_key: str = DEFAULT_HISTORY_KEY
) -> FoldOutcome:
    """Fold old chronicle records into the rolling summary when the meter says so.

    `history_key` names the replayed conversation this room's fold would trim — the
    thing a fold actually frees, and therefore what both guards below are measured in.

    With `force` (the manual `.chronicle fold`) every record past the lag window
    folds regardless of the meter, of the replay floor and of the per-turn batch
    budget. Never raises — a broken fold must never break a turn; the previously
    stored summary simply stays in use.

    Two guards keep a ROUTINE fold from spending a generation call it cannot earn
    back (the meter measures the whole assembled prompt; a fold can only ever remove
    the replayed history its new watermark covers):

    - **the replay floor** — `_history_tokens_through` sums the messages that folding
      every foldable record would let `agent.history.trim_folded` drop. Zero means
      there is nothing left to free: the pressure is somewhere else (a big module),
      and folding would change nothing, so no call is spent.
    - **the observed-effect re-arm** — a fold stamps the meter reading it acted on;
      the next turn compares against it. A meter that came DOWN retires the stamp
      (the prediction held). A meter that did NOT disarms the fold until the room
      genuinely grows past it by `_FOLD_REARM_GROWTH` of the window, so a room over
      the trigger for reasons the chronicle cannot touch stops buying one wasted
      fold call every single turn, forever.
    """
    settings = services.settings.chronicle
    if not settings.enabled:
        return FoldOutcome()
    try:
        return await _fold_flow(
            ctx,
            services,
            force=force,
            recovery=False,
            history_key=history_key,
            max_batches=_FOLD_MAX_BATCHES_PER_TURN,
        )
    except Exception:  # noqa: BLE001 — the fold is additive continuity, never fatal
        logger.debug("chronicle fold failed", exc_info=True)
        return FoldOutcome()


async def _fold_flow(
    ctx: AgentCtx,
    services: Services,
    *,
    force: bool,
    recovery: bool,
    history_key: str,
    max_batches: int,
) -> FoldOutcome:
    settings = services.settings.chronicle
    chat_key = ctx.chat_key
    meter = await _read_meter(services, chat_key)
    measured, window = meter.tokens, meter.window
    before = measured / window if window > 0 else 0.0
    if force:
        level = "manual"
    elif recovery:
        # Every gate below this line reads the meter, and the provider has just told us
        # the meter is wrong. A recovery fold skips all of them and folds what it can.
        level = "recovery"
    else:
        if window <= 0:
            return FoldOutcome()  # no meter yet (a fresh room's first turn)
        level = fold_decision(before, trigger=settings.fold_trigger, emergency=settings.fold_emergency)
        # Runs on EVERY routine turn, including below the trigger: that is where a
        # fold's effect becomes observable, and where a stamp that has done its job
        # is retired (see `_rearm_check`).
        armed = await _rearm_check(services, chat_key, meter)
        if level == "none" or not armed:
            return FoldOutcome(before=before, after=before)

    current_turn = await chronicle_turn(services.store, chat_key)
    watermark = fold_watermark(current_turn, settings.lag_turns)
    entries = await services.documents.list(chat_key, CHRONICLE_DOC_TYPE)
    docs_by_id = {doc.id: doc for doc in entries}
    i18n = services.i18n.with_locale(ctx.locale)
    # What this room is REPLAYING right now: the current path, already stripped of
    # what earlier folds cover, so a fold is never credited with freeing a message
    # that stopped being sent turns ago.
    replayed = _replayed_turn_costs(
        await trim_folded(
            services,
            chat_key,
            history_key,
            await load_chain(services, chat_key, history_key),
            await summary_through_turn(services, chat_key),
        )
    )

    foldable = _foldable_ids(entries, watermark)
    reducible = _history_tokens_through(replayed, _newest_turn(foldable, docs_by_id))
    if not force and reducible <= 0:
        logger.debug("chronicle fold skipped: no replayed history left for it to free")
        return FoldOutcome(before=before, after=before)

    # HOW MANY records this pass intends to fold, solved in the unit the gate above
    # just used. `deficit` is in METER tokens (what the provider reported for the
    # whole prompt) while the measurement is `estimate_tokens` (CJK-aware, computed
    # over the replayed messages), so the two units are close but not identical.
    # That residual approximation — tokenizer differences, plus folded records
    # flowing back in through topical recall (`_RECALL_LIMIT`) — is exactly why BOTH
    # guards above stay: the meter remains the only authority on whether a fold
    # actually paid for itself.
    # A recovery fold has no deficit to solve for: the meter it would be solved against
    # is the one that failed. It takes the whole foldable backlog as its target and lets
    # the per-turn batch budget below decide how much of it this turn pays for.
    deficit = 0 if force else max(0, int(measured - settings.fold_floor * window))
    pending = list(foldable) if (force or recovery) else _fold_prefix(
        replayed, docs_by_id, foldable, deficit=deficit, reducible=reducible
    )

    outcome = FoldOutcome(ran=True, level=level, before=before, after=before)
    attempted = False
    while pending:
        candidates = [
            FoldCandidate(id=doc_id, turn=_entry_turn(docs_by_id[doc_id]), tokens=_entry_tokens(docs_by_id[doc_id]))
            for doc_id in pending
        ]
        batch = select_fold_batch(candidates, watermark=watermark, max_entries=_FOLD_BATCH_MAX_ENTRIES)
        if not batch:
            break  # nothing eligible: either done, or fold did its best (small-window edge)
        violations = validate_fold_input(batch, watermark=watermark)
        if violations:
            # The no-future guard, engine-side: refuse the whole fold rather than
            # consume a record from the in-flight scene.
            outcome.rejected += len(violations)
            logger.warning("chronicle fold refused (no-future guard): %s", "; ".join(violations))
            break
        attempted = True
        if not await _fold_batch(services, chat_key, i18n, batch, docs_by_id):
            break  # a failed generation leaves state untouched; retry next turn
        outcome.batches += 1
        outcome.entries_folded += len(batch)
        outcome.folded_ids.extend(candidate.id for candidate in batch)
        pending = pending[len(batch) :]
        # No floor re-check here: the target set was solved against the replayed history
        # before the first call, so reaching the end of it IS reaching the floor (or the
        # small-window edge, where there was no floor to reach).
        if not force and outcome.batches >= max_batches:
            break  # this turn's fold budget is spent; the rest drains on later turns
    if not force and not recovery and attempted:
        # Stamp what the meter read when we acted, successful batch or not: the next
        # turn compares against it instead of trusting this turn's prediction. A recovery
        # fold stamps nothing: it acted on the provider's refusal, and writing the failed
        # meter's reading into the re-arm record would disarm the routine fold with it.
        await _stamp_fold_meter(services, chat_key, meter)
    if outcome.folded_ids:
        outcome.through_turn = max(_entry_turn(docs_by_id[doc_id]) for doc_id in outcome.folded_ids)
    if window > 0:
        # What the fold actually removed from the prompt — the history its new
        # watermark stops replaying, not the size of the records it consumed. A
        # partial drain (a backlog larger than this turn's batch budget) can
        # legitimately report `after == before`: the records folded so far all
        # belong to turns whose messages had already stopped being replayed.
        outcome.after = (measured - _history_tokens_through(replayed, outcome.through_turn)) / window
    return outcome


async def _fold_batch(
    services: Services,
    chat_key: str,
    i18n: I18n,
    batch: list[FoldCandidate],
    docs_by_id: dict[str, Document],
) -> bool:
    """One fold generation: merge `batch` into the rolling summary, then mark the
    records folded and index them for topical recall. All-or-nothing: a failure
    anywhere before the summary write leaves every record untouched."""
    settings = services.settings.chronicle
    try:
        existing = await services.documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
        previous = str(existing.data.get("text", "")).strip() if existing is not None else ""
        keeper_margin = str(existing.data.get("keeper", "")) if existing is not None else ""
        fold_count = int(existing.data.get("fold_count", 0)) if existing is not None else 0
        records = "\n".join(
            i18n.t(
                "prompt.chronicle.record_line",
                turn=candidate.turn,
                text=str(docs_by_id[candidate.id].data.get("text", "")).strip(),
            )
            for candidate in batch
        )
        messages = [
            {
                "role": "system",
                "content": i18n.t("prompt.chronicle.fold_instruction", limit=settings.summary_max_chars),
            },
            {
                "role": "user",
                "content": i18n.t(
                    "prompt.chronicle.fold_user_template",
                    previous=previous or i18n.t("prompt.chronicle.none_yet"),
                    records=records,
                ),
            },
        ]
        result = await services.llm.chat(messages)
        text = (result.content or "").strip()
        if not text:
            return False
        text = _bound_summary(text, settings.summary_max_chars)
        # The keeper margin is NOT regenerated (the fold input is player-facing
        # records only) — it is keeper-editable and carried forward verbatim.
        await services.documents.put(
            chat_key,
            CAMPAIGN_SUMMARY_DOC_TYPE,
            CAMPAIGN_SUMMARY_ID,
            {
                "text": text,
                "keeper": keeper_margin,
                "through_turn": max(candidate.turn for candidate in batch),
                "fold_count": fold_count + 1,
            },
        )
        folded_docs = []
        for candidate in batch:
            doc = docs_by_id[candidate.id]
            await services.documents.put(chat_key, CHRONICLE_DOC_TYPE, doc.id, {**doc.data, "folded": True})
            folded_docs.append(doc)
        await _index_folded_entries(services, chat_key, folded_docs)
        return True
    except Exception:  # noqa: BLE001 — a failed batch simply waits for the next fold
        logger.debug("chronicle fold batch failed", exc_info=True)
        return False


def _bound_summary(text: str, max_chars: int) -> str:
    """Enforce the summary's hard char ceiling, cutting at a paragraph boundary
    when one exists so the truncation reads like an ending, not a crash."""
    text = text.strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars].rfind("\n\n")
    if cut < max_chars // 2:
        cut = text[:max_chars].rfind("\n")
    if cut < max_chars // 2:
        cut = max_chars - 1
    return text[:cut].rstrip() + "…"


async def _read_meter(services: Services, chat_key: str) -> _Meter:
    """The room's context-fullness reading, as persisted by `infra.usage_stats`
    after the previous completed turn (see `_Meter` for the provenance flag)."""
    try:
        raw = await services.store.state_get(chat_key, "usage_stats")
        payload = json.loads(raw) if raw else {}
        last = payload.get("last") if isinstance(payload, dict) else None
        if not isinstance(last, dict):
            return _Meter()
        return _Meter(
            tokens=int(last.get("prompt", 0) or 0),
            window=int(last.get("context_window", 0) or 0),
            estimated=bool(last.get("estimated", False)),
        )
    except Exception:  # noqa: BLE001 — a corrupt meter reads as "no pressure"
        return _Meter()


async def _last_fold_meter(services: Services, chat_key: str) -> _Meter | None:
    """The meter reading the previous fold acted on, or `None` if none ever did.

    The fold's own arithmetic can only ever PREDICT a saving: it sizes the records
    it consumes, while the meter sizes the whole assembled prompt. The prompt is the
    authority on whether that prediction came true, and this is where the comparison
    starts from. `window` is not stamped — only the growth margin needs one, and that
    comes from the CURRENT reading.
    """
    try:
        summary = await services.documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
        if summary is None:
            return None
        raw = summary.data.get(_FOLD_METER_FIELD)
        if not isinstance(raw, dict):
            return None
        tokens = raw.get("tokens")
        if not isinstance(tokens, int) or isinstance(tokens, bool):
            return None
        return _Meter(tokens=tokens, estimated=bool(raw.get("estimated", False)))
    except Exception:  # noqa: BLE001 — an unreadable stamp simply means "armed"
        return None


async def _rearm_check(services: Services, chat_key: str, meter: _Meter) -> bool:
    """Is a ROUTINE fold armed, judged by what the LAST one actually achieved?

    Four states, and the middle two are the whole point:

    - no stamp — nothing to prove: armed.
    - the stamp came from the OTHER source (measured vs estimated) — the two do not
      share a scale, so the difference between them says nothing about the room. A
      stamp that cannot be compared is retired rather than believed: the alternative
      is a room that switched providers (or lost its usage reporting) sitting
      disarmed forever on the strength of an arithmetic that never applied to it.
      Arming costs at most one fold call per switch; disarming costs the fold.
    - the meter came DOWN since the fold that stamped it — the prediction held, so
      the stamp is retired and the plain trigger governs again. (Without this the
      guard would ratchet: every fold would raise the bar for the next one by the
      re-arm margin, until a long campaign stopped folding altogether.)
    - the meter did NOT come down — that fold freed nothing the prompt noticed, so
      the next one would not either. Disarmed until the room genuinely grows past
      the stamp by `_FOLD_REARM_GROWTH` of the window.
    """
    last = await _last_fold_meter(services, chat_key)
    if last is None:
        return True
    if last.estimated != meter.estimated:
        await _clear_fold_meter(services, chat_key)
        return True
    if meter.tokens < last.tokens:
        await _clear_fold_meter(services, chat_key)
        return True
    return meter.tokens >= last.tokens + _FOLD_REARM_GROWTH * meter.window


async def _clear_fold_meter(services: Services, chat_key: str) -> None:
    """Retire the stamp (its fold demonstrably worked, or it is not comparable)."""
    await _write_summary_fields(services, chat_key, drop=_FOLD_METER_FIELD)


async def _stamp_fold_meter(services: Services, chat_key: str, meter: _Meter) -> None:
    """Record the meter this fold acted on, on the summary singleton it just wrote.

    Only ever UPDATES an existing summary: a fold that produced no summary (the
    no-future refusal) must not conjure one, and an empty chronicle must stay empty.
    """
    await _write_summary_fields(
        services, chat_key, set_meter={"tokens": int(meter.tokens), "estimated": bool(meter.estimated)}
    )


async def _write_summary_fields(
    services: Services, chat_key: str, *, set_meter: dict[str, Any] | None = None, drop: str = ""
) -> None:
    """Patch the summary singleton's bookkeeping fields, if it exists at all."""
    try:
        summary = await services.documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
        if summary is None:
            return
        data = {key: value for key, value in summary.data.items() if key != drop}
        if set_meter is not None:
            data[_FOLD_METER_FIELD] = set_meter
        if data == summary.data:
            return
        await services.documents.put(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, data)
    except Exception:  # noqa: BLE001 — bookkeeping, never a failure path
        logger.debug("chronicle fold meter bookkeeping failed", exc_info=True)


def _replayed_turn_costs(history: list[dict]) -> list[tuple[int, int]]:
    """Each replayed message as `(turn, tokens)` — priced once, read many times.

    `_fold_prefix` walks the backlog asking the same question at a moving watermark,
    so the per-message `estimate_tokens` is paid here rather than inside that loop.
    """
    return [
        (int(message.get(HISTORY_TURN_KEY, 0) or 0), estimate_tokens(str(message.get("content") or "")))
        for message in history
    ]


def _history_tokens_through(replayed: list[tuple[int, int]], through_turn: int) -> int:
    """How many REPLAYED-HISTORY tokens a fold through `through_turn` frees.

    THE one measurement both the fold's gate and its batch sizing speak, so the two
    can never drift into different units. A fold's only effect on the prompt is the
    watermark it writes: `agent.history.trim_folded` then stops replaying every
    message at or below it — which is why the condition here is the exact complement
    of that filter, turn-0/unstamped messages included.

    Not "the tokens of the records folded": a chronicle record is a one-line digest of
    a turn whose verbatim exchange is what the prompt actually carries, so the record's
    own size describes neither what the prompt pays nor what folding it recovers.

    The result steps rather than slopes: several records can share a turn, and a turn
    that produced no chronicle record still costs history — so folding one more record
    can free a whole turn's messages, or none at all.
    """
    if through_turn <= 0:
        return 0
    return sum(tokens for turn, tokens in replayed if turn <= through_turn)


def _newest_turn(doc_ids: list[str], docs_by_id: dict[str, Document]) -> int:
    """The highest turn among `doc_ids` — the watermark folding all of them would write."""
    return max((_entry_turn(docs_by_id[doc_id]) for doc_id in doc_ids), default=0)


def _foldable_ids(entries: list[Document], watermark: int) -> list[str]:
    """Every unfolded record at or below the watermark, OLDEST FIRST.

    Order is load-bearing twice over: the watermark a fold writes only ever moves
    forward, so only folding from the oldest end frees history a turn at a time, and
    the no-future guard requires the lag window to stay raw."""
    foldable = [doc for doc in entries if not doc.data.get("folded") and _entry_turn(doc) <= watermark]
    return [doc.id for doc in sorted(foldable, key=lambda doc: (_entry_turn(doc), doc.id))]


def _fold_prefix(
    replayed: list[tuple[int, int]],
    docs_by_id: dict[str, Document],
    foldable: list[str],
    *,
    deficit: int,
    reducible: int,
) -> list[str]:
    """The oldest-first prefix of `foldable` whose removal covers `deficit` prompt
    tokens — or all of `foldable` when the replayed history cannot cover it.

    That second case is the spec's small-window edge (M18, "only the foldable portion
    shrinks … fold does its best"): the pressure is somewhere the chronicle cannot
    reach, so the honest answer is everything it has, not a number derived from a
    deficit it was never going to close.

    Solved by walking the prefix rather than dividing a deficit by a per-record size,
    because there is no per-record size: `_history_tokens_through` steps, and the step
    a record sits on depends on how much was said that turn, which nothing about the
    record itself records.
    """
    if deficit >= reducible:
        return list(foldable)
    for count, doc_id in enumerate(foldable, start=1):
        if _history_tokens_through(replayed, _entry_turn(docs_by_id[doc_id])) >= deficit:
            return foldable[:count]
    return list(foldable)


def _entry_turn(doc: Document) -> int:
    try:
        return int(doc.data.get("turn", 0))
    except (TypeError, ValueError):
        return 0


def _entry_tokens(doc: Document) -> int:
    try:
        tokens = int(doc.data.get("tokens", 0))
    except (TypeError, ValueError):
        tokens = 0
    return tokens if tokens > 0 else estimate_tokens(str(doc.data.get("text", "")))


# ---------------------------------------------------------------------------
# The embedding index (folded records stay topically retrievable)
# ---------------------------------------------------------------------------


def _raw_vector_store(services: Services) -> Any | None:
    """The raw `infra.vector.VectorStore` (the worldbook's payload scheme rides it
    too); `services.vector_db` is the document-RAG manager wrapping it."""
    return getattr(services.vector_db, "vector_store", None)


async def _index_folded_entries(services: Services, chat_key: str, docs: list[Document]) -> None:
    """Index folded records under the collection lane's payload scheme.

    `namespace` is the ONE ownership field of a collection point (worldbook's
    scheme, shared verbatim); the room's `chat_key` is deliberately NOT repeated
    here. A second owner field would be a second source of truth that can drift,
    and `net.room_backup` treats disagreeing owner fields as corrupt by design —
    one field per lane is what keeps export/backup/delete unambiguous.
    """
    try:
        if not docs or not services.settings.enable_vector_db:
            return
        vector_store = _raw_vector_store(services)
        if vector_store is None or services.embeddings is None:
            return
        vectors = await services.embeddings.embed([str(doc.data.get("text", "")) for doc in docs])
        await vector_store.upsert(
            [
                (
                    f"{chat_key}:chronicle:{doc.id}",
                    vector,
                    {"collection": CHRONICLE_COLLECTION, "namespace": str(chat_key), "entry_id": doc.id},
                )
                for doc, vector in zip(docs, vectors, strict=True)
            ]
        )
    except Exception:  # noqa: BLE001 — retrieval is a bonus, never a failure path
        logger.debug("chronicle indexing failed", exc_info=True)


async def recall_folded_entries(
    services: Services, chat_key: str, query: str, *, limit: int = _RECALL_LIMIT
) -> list[Document]:
    """Topically relevant chronicle records, resolved through the document store
    (never the vector payload) so content always reflects the stored document."""
    if not query.strip() or not services.settings.enable_vector_db:
        return []
    vector_store = _raw_vector_store(services)
    if vector_store is None or services.embeddings is None:
        return []
    try:
        [vector] = await services.embeddings.embed([query])
        hits = await vector_store.search(
            vector,
            limit=limit,
            filter={"collection": CHRONICLE_COLLECTION, "namespace": str(chat_key)},
        )
    except Exception:  # noqa: BLE001
        return []
    docs: list[Document] = []
    for hit in hits:
        if hit.score <= 0:
            continue
        entry_id = str(hit.payload.get("entry_id", ""))
        if not entry_id:
            continue
        doc = await services.documents.get(chat_key, CHRONICLE_DOC_TYPE, entry_id)
        if doc is not None:
            docs.append(doc)
    return docs


# ---------------------------------------------------------------------------
# The prompt section (one injection point in agent.prompt_builder)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ChronicleSections:
    """The chronicle's contribution to one prompt, split at its cache boundary.

    Mirrors `agent.prompt_builder.SystemPrompt`'s own halves so the assembler can
    route each without re-deciding what belongs where — the reasoning for the split
    lives with the data it describes (`build_chronicle_sections`).
    """

    stable: str = ""
    volatile: str = ""


async def build_chronicle_sections(
    ctx: AgentCtx, services: Services, i18n: I18n, *, recent_context: str = ""
) -> ChronicleSections:
    """The KP's chronicle injection, split at the prompt's own cache boundary.

    - `stable` — the rolling campaign summary and its keeper margin. It changes only
      when a fold writes it, and that same fold moves `through_turn`, which makes
      `agent.history.trim_folded` cut the FRONT of the replayed history on this very
      turn. The cached prefix is gone either way; the summary rides an invalidation
      that has already happened, and is a cache read on every other turn.
      ONE accepted cost: `.chronicle edit` / `.chronicle note` rewrite this text
      outside a fold, so the next turn pays for the whole prefix once. A deliberate,
      rare keeper action, and cheaper than moving the summary back into the tail
      where every turn would pay for it.
    - `volatile` — open threads (`update_thread` may fire on any turn) and the folded
      records recalled against this turn's context (re-retrieved every turn). Both
      change asynchronously of anything else, so neither may ride the head.

    No raw unfolded tail: an unfolded record's turn is above `through_turn`, so that
    turn's verbatim exchange is still being replayed a few messages later — rendering
    the record too would carry the same events twice.

    Both halves are "" for a room with no chronicle yet, so a fresh room's prompt
    stays byte-identical to a build from before M18. KP-grade by construction — this
    is the Keeper's own system prompt; player surfaces consume projections.
    """
    try:
        stable = ""
        summary = await services.documents.get_view(
            ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, KEEPER_VIEWER
        )
        if summary and str(summary.get("text", "")).strip():
            stable = i18n.t("prompt.chronicle.summary_label") + "\n" + str(summary["text"]).strip()
            margin = str(summary.get("keeper", "")).strip()
            if margin:
                stable += "\n" + i18n.t("prompt.chronicle.keeper_label") + " " + margin

        parts: list[str] = []
        threads = await services.documents.list(ctx.chat_key, THREAD_DOC_TYPE)
        open_threads = [doc for doc in threads if doc.data.get("status") == "open"][:_THREADS_MAX]
        if open_threads:
            lines = []
            for doc in open_threads:
                line = f"- {doc.data.get('label', '')}"
                notes = str(doc.data.get("notes", "")).strip()
                if notes:
                    line += f" — {notes}"
                lines.append(line)
            parts.append(i18n.t("prompt.chronicle.threads_label") + "\n" + "\n".join(lines))

        if recent_context.strip():
            recalled = await recall_folded_entries(services, ctx.chat_key, recent_context)
            if recalled:
                # Relevance-ranked block: under a binding budget keep the STRONGEST hits.
                parts.append(
                    i18n.t("prompt.chronicle.recalled_label")
                    + "\n"
                    + _render_most_relevant(i18n, recalled, _RECALL_MAX_CHARS)
                )

        # The header frames the whole chronicle (what it is, and that its keeper
        # annotations are never quoted to players), so it leads whichever half opens
        # it — the head when there is a summary, the tail otherwise. It is a constant
        # string, so carrying it in the head costs nothing to keep there.
        header = i18n.t("prompt.chronicle.header")
        if stable:
            return ChronicleSections(
                stable=header + "\n\n" + stable,
                volatile="\n\n".join(parts),
            )
        return ChronicleSections(stable="", volatile=header + "\n\n" + "\n\n".join(parts) if parts else "")
    except Exception:  # noqa: BLE001 — a missing section never breaks a turn
        logger.debug("chronicle section build failed", exc_info=True)
        return ChronicleSections()


def _record_line(i18n: I18n, doc: Document) -> str:
    """One record line, keeper-grade (the keeper annotation bracketed in)."""
    text = str(doc.data.get("text", "")).strip()
    margin = str(doc.data.get("keeper", "")).strip()
    if margin:
        text += f"  [{i18n.t('prompt.chronicle.keeper_label')} {margin}]"
    return i18n.t("prompt.chronicle.record_line", turn=_entry_turn(doc), text=text)


def _render_most_relevant(i18n: I18n, docs: list[Document], budget: int) -> str:
    """`docs` most-relevant→least: the largest PREFIX that fits `budget` chars.

    Dropping from the BACK is what a relevance ranking wants — it gives up the
    weakest hits. Do not "generalize" this into a chronological renderer that keeps
    its head: this list is ordered by retrieval score, not by time.
    """
    lines: list[str] = []
    for doc in docs:
        line = _record_line(i18n, doc)
        if budget - len(line) < 0:
            break
        lines.append(line)
        budget -= len(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The player-facing recap (projections only — spoiler-free by construction)
# ---------------------------------------------------------------------------


async def render_recap(services: Services, chat_key: str, i18n: I18n) -> str | None:
    """The "previously on…" for `.recap` (and any join/catch-up surface): the
    campaign summary + the raw recent tail, rendered exclusively from PLAYER
    projections, so keeper annotations structurally cannot appear."""
    try:
        parts: list[str] = []
        summary = await services.documents.get_view(
            chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, PLAYER_VIEWER
        )
        if summary and str(summary.get("text", "")).strip():
            block = str(summary["text"]).strip()
            through = summary.get("through_turn")
            if isinstance(through, int) and not isinstance(through, bool) and through > 0:
                block += "\n" + i18n.t("commands.recap.through_turn", turn=through)
            parts.append(block)

        pairs = await services.documents.list_views(chat_key, CHRONICLE_DOC_TYPE, PLAYER_VIEWER)
        tail = sorted(pairs, key=lambda pair: (_entry_turn(pair[0]), pair[0].id))
        tail = [(doc, view) for doc, view in tail if not doc.data.get("folded")][-_RECAP_TAIL_MAX:]
        if tail:
            lines = [
                i18n.t(
                    "prompt.chronicle.record_line",
                    turn=_entry_turn(doc),
                    text=str(view.get("text", "")).strip(),
                )
                for doc, view in tail
            ]
            parts.append(i18n.t("commands.recap.recent_label") + "\n" + "\n".join(lines))

        if not parts:
            return None
        return i18n.t("commands.recap.header") + "\n\n" + "\n\n".join(parts)
    except Exception:  # noqa: BLE001
        logger.debug("chronicle recap render failed", exc_info=True)
        return None


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="chronicle",
        owner="agent.chronicle",
        reset_scope="story",
        doc_types=frozenset({CHRONICLE_DOC_TYPE, CAMPAIGN_SUMMARY_DOC_TYPE, THREAD_DOC_TYPE}),
        state_keys=frozenset({CHRONICLE_TURN_KEY, CHRONICLE_SEQ_KEY}),
        # Only FOLDED records carry an embedding, and they leave with the records they
        # index: orphaned points would keep winning topical-recall slots for a campaign
        # that no longer exists (b23c450).
        vector_collections=frozenset({CHRONICLE_COLLECTION}),
        storages=frozenset({STORAGE_DOCUMENTS, STORAGE_ROOM_STATE, STORAGE_VECTORS}),
    ),
)
