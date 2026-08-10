"""The campaign chronicle, generative half (M18) — the fold flow.

`core.chronicle` holds the deterministic policy (document types, projections,
hysteresis levels, the no-future watermark); this module is the LLM-driven flow
on top of it:

- `maybe_fold_chronicle` — the per-turn hook (wired into `agent.loop.run_kp_turn`
  BEFORE prompt assembly, so both the 0.60 trigger and the 0.85 emergency fold
  land before the next model call). Measured from the room's `usage_stats`
  meter (last turn's provider-reported prompt tokens — a reactive meter, the
  only honest source). Batch-folds the oldest chronicle records into the
  rolling `campaign_summary` until the prompt's chronicle SECTION has given up
  as many tokens as the floor needs, bounded by a per-turn batch budget.
  How many records that is, is solved against the section's own render
  (`_render_delta`) rather than by summing the records' sizes: the section is
  capped (`_TAIL_MAX_ENTRIES`/`_TAIL_MAX_CHARS`), so folding a record it never
  renders frees nothing, and there is no per-record token price to divide by.
  When the section cannot cover the deficit at all, the fold takes everything it
  has — the spec's small-window edge, "fold does its best".
  What remains approximate is only the UNIT: the meter is the provider's
  tokenizer over the whole prompt, `_render_delta` is `estimate_tokens` over the
  section, and folded records can flow back in through topical recall. So both
  guards stay — a routine fold does not run when the section is already at its
  own floor, and does not re-arm until the measured meter actually grows past
  the reading the previous fold acted on. Neither is redundant now that the
  arithmetic is honest: they answer "did this fold pay for itself" from the
  meter, which is the only authority on that. Synchronous by design: a fire-and-forget
  fold could race the NEXT turn's prompt assembly, and folds are rare by
  hysteresis. Best-effort throughout — a fold failure never breaks a turn (the
  session-recap posture).
- `record_entry` — the append path behind the `record_chronicle` tool. Entries
  are stamped with the in-progress turn index (counter + 1); the tool accepts
  no turn parameter, so nothing can be recorded speculatively (past-only).
- `build_chronicle_section` — the ONE prompt section: campaign summary (+ its
  keeper margin) + open threads + the raw unfolded tail + topically recalled
  folded records. KP-grade: this is the Keeper's own system prompt, so keeper
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

logger = logging.getLogger(__name__)

__all__ = [
    "CAMPAIGN_SUMMARY_DOC_TYPE",
    "CAMPAIGN_SUMMARY_ID",
    "CHRONICLE_DOC_TYPE",
    "THREAD_DOC_TYPE",
    "FoldOutcome",
    "advance_chronicle_turn",
    "build_chronicle_section",
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
# is a field allowlist).
_FOLD_METER_FIELD = "fold_meter"
# Prompt-section caps: the raw tail is small by design (the lag window plus one
# fold cycle); the caps bound the pathological "fold did its best" case.
_TAIL_MAX_ENTRIES = 10
_TAIL_MAX_CHARS = 6000
_THREADS_MAX = 12
_RECALL_LIMIT = 4
_RECAP_TAIL_MAX = 8


@dataclass
class FoldOutcome:
    """What one fold pass did (observability for the manual command + tests)."""

    ran: bool = False
    level: str = "none"  # none | fold | emergency | manual
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
    """Increment the completed-turn counter. Wired into `run_kp_turn` right after
    the session-recap refresh; best-effort like its neighbour — never raises."""
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
) -> Document:
    """Append one chronicle entry, stamped with the in-progress turn index.

    Past-only by construction: the stamp comes from the room's turn counter
    (completed turns + 1 = the turn now in flight), never from a caller-supplied
    value, so an entry can never be written ahead of the fiction.
    """
    raw = await services.store.state_get(chat_key, CHRONICLE_SEQ_KEY)
    try:
        seq = int(raw or 0) + 1
    except ValueError:
        seq = 1
    await services.store.state_set(chat_key, CHRONICLE_SEQ_KEY, str(seq))
    turn = await chronicle_turn(services.store, chat_key) + 1
    data = {
        "text": text.strip(),
        "keeper": keeper.strip(),
        "turn": turn,
        "pcs": [str(pc).strip() for pc in pcs if str(pc).strip()],
        "scene": scene.strip(),
        "folded": False,
        "tokens": estimate_tokens(text),
    }
    return await services.documents.put(chat_key, CHRONICLE_DOC_TYPE, f"c{seq:05d}", data)


# ---------------------------------------------------------------------------
# The fold flow
# ---------------------------------------------------------------------------


async def maybe_fold_chronicle(ctx: AgentCtx, services: Services, *, force: bool = False) -> FoldOutcome:
    """Fold old chronicle records into the rolling summary when the meter says so.

    With `force` (the manual `.chronicle fold`) every record past the lag window
    folds regardless of the meter, of the section floor and of the per-turn batch
    budget. Never raises — a broken fold must never break a turn; the previously
    stored summary simply stays in use.

    Two guards keep a ROUTINE fold from spending a generation call it cannot earn
    back (the meter measures the whole assembled prompt; a fold can only ever
    remove chronicle records from it):

    - **the section floor** — `_render_delta` renders the chronicle tail as it
      stands and as it would stand with every foldable record gone, through the
      same renderer the prompt uses. Zero difference means the section is already
      at its own floor: the pressure is somewhere else (a big module), and folding
      would free nothing, so no call is spent.
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
        return await _fold_flow(ctx, services, force=force)
    except Exception:  # noqa: BLE001 — the fold is additive continuity, never fatal
        logger.debug("chronicle fold failed", exc_info=True)
        return FoldOutcome()


async def _fold_flow(ctx: AgentCtx, services: Services, *, force: bool) -> FoldOutcome:
    settings = services.settings.chronicle
    chat_key = ctx.chat_key
    measured, window = await _read_meter(services, chat_key)
    before = measured / window if window > 0 else 0.0
    if force:
        level = "manual"
    else:
        if window <= 0:
            return FoldOutcome()  # no meter yet (a fresh room's first turn)
        level = fold_decision(before, trigger=settings.fold_trigger, emergency=settings.fold_emergency)
        # Runs on EVERY routine turn, including below the trigger: that is where a
        # fold's effect becomes observable, and where a stamp that has done its job
        # is retired (see `_rearm_check`).
        armed = await _rearm_check(services, chat_key, measured, window)
        if level == "none" or not armed:
            return FoldOutcome(before=before, after=before)

    current_turn = await chronicle_turn(services.store, chat_key)
    watermark = fold_watermark(current_turn, settings.lag_turns)
    entries = await services.documents.list(chat_key, CHRONICLE_DOC_TYPE)
    docs_by_id = {doc.id: doc for doc in entries}
    i18n = services.i18n.with_locale(ctx.locale)

    foldable = _foldable_ids(entries, watermark)
    reducible = _render_delta(i18n, entries, set(foldable))
    if not force and reducible <= 0:
        logger.debug("chronicle fold skipped: the section is already at its own floor")
        return FoldOutcome(before=before, after=before)

    # HOW MANY records this pass intends to fold, solved in the renderer's unit —
    # the same `_render_delta` the gate above just used. `deficit` is in METER
    # tokens (what the provider reported for the whole prompt) and the delta is in
    # `estimate_tokens` (CJK-aware, computed over the section's own render), so the
    # two units are close but not identical. That residual approximation — tokenizer
    # differences, plus folded records flowing back in through topical recall
    # (`_RECALL_LIMIT`) — is exactly why BOTH guards above stay: the meter remains
    # the only authority on whether a fold actually paid for itself.
    deficit = 0 if force else max(0, int(measured - settings.fold_floor * window))
    pending = list(foldable) if force else _fold_prefix(
        i18n, entries, foldable, deficit=deficit, reducible=reducible
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
        # No floor re-check here: the target set was solved against the section's own
        # render before the first call, so reaching the end of it IS reaching the floor
        # (or the small-window edge, where there was no floor to reach).
        if not force and outcome.batches >= _FOLD_MAX_BATCHES_PER_TURN:
            break  # this turn's fold budget is spent; the rest drains on later turns
    if not force and attempted:
        # Stamp what the meter read when we acted, successful batch or not: the next
        # turn compares against it instead of trusting this turn's prediction.
        await _stamp_fold_meter(services, chat_key, measured)
    if outcome.folded_ids:
        outcome.through_turn = max(_entry_turn(docs_by_id[doc_id]) for doc_id in outcome.folded_ids)
    if window > 0:
        # What the fold actually removed from the prompt, in the renderer's unit —
        # not the size of the records it consumed. A partial drain (a backlog larger
        # than this turn's batch budget) can legitimately report `after == before`:
        # the records folded so far were all outside what the tail renders.
        outcome.after = (measured - _render_delta(i18n, entries, set(outcome.folded_ids))) / window
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


async def _read_meter(services: Services, chat_key: str) -> tuple[int, int]:
    """(last assembled-prompt tokens, room model's context window), as persisted
    by `infra.usage_stats` after the previous completed turn."""
    try:
        raw = await services.store.state_get(chat_key, "usage_stats")
        payload = json.loads(raw) if raw else {}
        last = payload.get("last") if isinstance(payload, dict) else None
        if not isinstance(last, dict):
            return (0, 0)
        return (int(last.get("prompt", 0) or 0), int(last.get("context_window", 0) or 0))
    except Exception:  # noqa: BLE001 — a corrupt meter reads as "no pressure"
        return (0, 0)


async def _last_fold_meter(services: Services, chat_key: str) -> int | None:
    """The meter reading the previous fold acted on, or `None` if none ever did.

    The fold's own arithmetic can only ever PREDICT a saving: it sizes the records
    it consumes, while the meter sizes the whole assembled prompt. The prompt is the
    authority on whether that prediction came true, and this is where the comparison
    starts from.
    """
    try:
        summary = await services.documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
        if summary is None:
            return None
        raw = summary.data.get(_FOLD_METER_FIELD)
        return int(raw) if isinstance(raw, int) and not isinstance(raw, bool) else None
    except Exception:  # noqa: BLE001 — an unreadable stamp simply means "armed"
        return None


async def _rearm_check(services: Services, chat_key: str, measured: int, window: int) -> bool:
    """Is a ROUTINE fold armed, judged by what the LAST one actually achieved?

    Three states, and the middle one is the whole point:

    - no stamp — nothing to prove: armed.
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
    if measured < last:
        await _clear_fold_meter(services, chat_key)
        return True
    return measured >= last + _FOLD_REARM_GROWTH * window


async def _clear_fold_meter(services: Services, chat_key: str) -> None:
    """Retire the stamp (its fold demonstrably worked)."""
    await _write_summary_fields(services, chat_key, drop=_FOLD_METER_FIELD)


async def _stamp_fold_meter(services: Services, chat_key: str, measured: int) -> None:
    """Record the meter this fold acted on, on the summary singleton it just wrote.

    Only ever UPDATES an existing summary: a fold that produced no summary (the
    no-future refusal) must not conjure one, and an empty chronicle must stay empty.
    """
    await _write_summary_fields(services, chat_key, set_meter=int(measured))


async def _write_summary_fields(
    services: Services, chat_key: str, *, set_meter: int | None = None, drop: str = ""
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


def _render_delta(i18n: I18n, entries: list[Document], exclude: frozenset[str] | set[str]) -> int:
    """How many ASSEMBLED-PROMPT tokens dropping `exclude` from the tail removes.

    THE one measurement both the fold's gate and its batch sizing speak, so the two
    can never drift into different units. The chronicle's prompt footprint is capped
    by construction (`_TAIL_MAX_ENTRIES`/`_TAIL_MAX_CHARS`), so a record the section
    never renders costs the prompt nothing to keep and frees nothing when folded —
    which makes "tokens of the records folded" a unit the section itself falsifies.
    This renders the tail as it stands and again without `exclude`, through the SAME
    `_tail_docs`/`_render_newest` the prompt section uses, and reports the difference.

    The result steps rather than slopes: while more than `_TAIL_MAX_ENTRIES` records
    remain unfolded, dropping the oldest ones changes nothing the prompt renders and
    the delta is exactly 0.
    """
    now = _render_newest(i18n, _tail_docs(entries), _TAIL_MAX_CHARS)
    after = _render_newest(i18n, _tail_docs(entries, exclude=exclude), _TAIL_MAX_CHARS)
    return max(0, estimate_tokens(now) - estimate_tokens(after))


def _foldable_ids(entries: list[Document], watermark: int) -> list[str]:
    """Every unfolded record at or below the watermark, OLDEST FIRST.

    Order is load-bearing twice over: the tail renders the newest records, so only
    folding from the oldest end can shrink it, and the no-future guard requires the
    lag window to stay raw."""
    foldable = [doc for doc in entries if not doc.data.get("folded") and _entry_turn(doc) <= watermark]
    return [doc.id for doc in sorted(foldable, key=lambda doc: (_entry_turn(doc), doc.id))]


def _fold_prefix(
    i18n: I18n, entries: list[Document], foldable: list[str], *, deficit: int, reducible: int
) -> list[str]:
    """The oldest-first prefix of `foldable` whose removal covers `deficit` prompt
    tokens — or all of `foldable` when the section cannot cover it.

    That second case is the spec's small-window edge (M18, "only the foldable portion
    shrinks … fold does its best"): the pressure is somewhere the chronicle cannot
    reach, so the honest answer is everything it has, not a number derived from a
    deficit it was never going to close.

    Solved by walking the prefix rather than dividing a deficit by a per-record size,
    because there is no per-record size: `_render_delta` steps. The walk is linear in
    the backlog and each step renders at most `_TAIL_MAX_ENTRIES` lines; it is not
    hoisted past the leading zero-delta stretch on purpose, since `_render_newest`
    spends its character budget from the newest side — under a binding budget the
    delta stays 0 for LONGER than the entry cap alone would predict, so any shortcut
    derived from the caps would be wrong exactly when the budget matters.
    """
    if deficit >= reducible:
        return list(foldable)
    for count in range(1, len(foldable) + 1):
        if _render_delta(i18n, entries, set(foldable[:count])) >= deficit:
            return foldable[:count]
    return list(foldable)


def _tail_docs(entries: list[Document], *, exclude: frozenset[str] | set[str] = frozenset()) -> list[Document]:
    """The unfolded records the prompt section renders, oldest to newest.

    One definition, shared by `build_chronicle_section` (what the prompt costs) and
    `_reducible_tail_tokens` (what a fold could remove), so the two can never drift.
    """
    return sorted(
        (doc for doc in entries if not doc.data.get("folded") and doc.id not in exclude),
        key=lambda doc: (_entry_turn(doc), doc.id),
    )[-_TAIL_MAX_ENTRIES:]


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


async def build_chronicle_section(ctx: AgentCtx, services: Services, i18n: I18n, *, recent_context: str = "") -> str:
    """The KP's chronicle section: rolling summary (+ keeper margin) + open
    threads + the raw unfolded tail + folded records recalled against this turn.

    "" for a room with no chronicle yet, so a fresh room's prompt stays
    byte-identical to a build from before M18. KP-grade by construction — this
    is the Keeper's own system prompt; player surfaces consume projections.
    """
    try:
        parts: list[str] = []

        summary = await services.documents.get_view(
            ctx.chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, KEEPER_VIEWER
        )
        if summary and str(summary.get("text", "")).strip():
            block = i18n.t("prompt.chronicle.summary_label") + "\n" + str(summary["text"]).strip()
            margin = str(summary.get("keeper", "")).strip()
            if margin:
                block += "\n" + i18n.t("prompt.chronicle.keeper_label") + " " + margin
            parts.append(block)

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

        entries = await services.documents.list(ctx.chat_key, CHRONICLE_DOC_TYPE)
        tail = _tail_docs(entries)
        if tail:
            # Chronological block: under a binding budget keep the NEWEST.
            parts.append(i18n.t("prompt.chronicle.tail_label") + "\n" + _render_newest(i18n, tail, _TAIL_MAX_CHARS))

        if recent_context.strip():
            tail_ids = {doc.id for doc in tail}
            recalled = [doc for doc in await recall_folded_entries(services, ctx.chat_key, recent_context) if doc.id not in tail_ids]
            if recalled:
                # Relevance-ranked block: under a binding budget keep the STRONGEST hits.
                parts.append(
                    i18n.t("prompt.chronicle.recalled_label")
                    + "\n"
                    + _render_most_relevant(i18n, recalled, _TAIL_MAX_CHARS)
                )

        if not parts:
            return ""
        return i18n.t("prompt.chronicle.header") + "\n\n" + "\n\n".join(parts)
    except Exception:  # noqa: BLE001 — a missing section never breaks a turn
        logger.debug("chronicle section build failed", exc_info=True)
        return ""


def _record_line(i18n: I18n, doc: Document) -> str:
    """One record line, keeper-grade (the keeper annotation bracketed in)."""
    text = str(doc.data.get("text", "")).strip()
    margin = str(doc.data.get("keeper", "")).strip()
    if margin:
        text += f"  [{i18n.t('prompt.chronicle.keeper_label')} {margin}]"
    return i18n.t("prompt.chronicle.record_line", turn=_entry_turn(doc), text=text)


def _render_newest(i18n: I18n, docs: list[Document], budget: int) -> str:
    """`docs` oldest→newest: the largest SUFFIX that fits `budget` chars, still
    rendered in chronological order.

    For the raw tail, which is DEFINED as the most recent records — so when the
    budget binds, the records to give up are the oldest ones. Spending the budget
    from the newest end and reversing back is what makes "recent" true of the
    render and not merely of the selection.
    """
    lines: list[str] = []
    for doc in reversed(docs):
        line = _record_line(i18n, doc)
        if budget - len(line) < 0:
            break
        lines.append(line)
        budget -= len(line)
    lines.reverse()
    return "\n".join(lines)


def _render_most_relevant(i18n: I18n, docs: list[Document], budget: int) -> str:
    """`docs` most-relevant→least: the largest PREFIX that fits `budget` chars.

    The asymmetry with `_render_newest` is DELIBERATE — do not "fix" it into
    symmetry. These two blocks are ordered by different things (time vs retrieval
    score), so the part worth keeping sits at opposite ends: dropping the tail of a
    relevance ranking drops the weakest hits, which is exactly right, while doing
    the same to a chronological tail would drop the present moment.
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
