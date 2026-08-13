"""Procedural memory (M20 E): how THIS table plays.

Sorting memory by INFORMATION TYPE rather than by storage mechanism leaves one row of the
table empty:

| type | term | where it lives |
|---|---|---|
| what the world is | semantic | the worldbook — authored |
| what happened that time | episodic | the chronicle + fold — emergent |
| how to run a thing | procedural | `skills/<id>/SKILL.md` — **authored only** |
| the last few rounds | working | the replayed history |

The authored/emergent split between worldbook and chronicle is cleaner than the reference
designs, and the *learned* half of procedure simply did not exist. Nothing made the
session-12 Keeper understand this table better than the session-1 Keeper did:
`agent.scribe.pop_whispers` is read-and-clear, so every observation about how the table
plays was discarded one turn after it was made.

A habit is that observation, survived. Pacing preferences, combat patience, what landed
and what fell flat, a Keeper technique that misfired.

**Two things this type must get right, and both were missing from the first draft.**

1. **The recurrence count needs a home.** The Scribe has no cross-turn memory of its own
   and whispers are read-and-clear, so "I have now seen this three times" cannot live in
   the Scribe. It lives in a `pending` section of THIS document: a candidate accumulates
   sightings until it crosses the threshold, then it is promoted to a durable habit. That
   is what makes the whole feature cost zero additional model calls — the Scribe is
   already reading the turn.
2. **The player-grade projection returns `None`.** Habit records describe the players
   themselves ("they lose patience with long combats", "the flattery gambit fell flat").
   Handing that back to the people it describes is both a metagaming leak and simply rude.
   `tests/documents/` carries the sentinel.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from infra.room_facets import STORAGE_DOCUMENTS, RoomStateFacet

if TYPE_CHECKING:  # pragma: no cover
    from core.documents import Document, Viewer

HABITS_DOC_TYPE = "table_habits"
HABITS_ID = "habits"

# How many independent sightings promote a candidate to a durable habit. Two is a
# coincidence; three is how the table plays.
PROMOTION_THRESHOLD = 3

# Ceilings, because this document is written by a model on every turn and read into the
# prompt on every turn. The index is what stays resident, so it is what must stay small.
MAX_HABITS = 24
MAX_PENDING = 24
MAX_SUMMARY_CHARS = 120
MAX_DETAIL_CHARS = 600


def project_habits(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Keeper-side only. A player-grade viewer sees NOTHING — not a redacted view, None.

    There is no partial view worth designing here: every field describes the players'
    own behaviour as read by the Keeper's ledger clerk. A redacted version would still
    tell them a record about them exists.
    """
    return dict(doc.data) if viewer.is_keeper else None


def validate_habits_write(doc: Document, services: Any) -> list[str]:
    """Shape and ceilings. Content is game data and is never validated for meaning."""
    violations: list[str] = []
    habits = doc.data.get("habits")
    pending = doc.data.get("pending")
    if habits is not None and not isinstance(habits, list):
        violations.append("habits must be a list")
    if pending is not None and not isinstance(pending, list):
        violations.append("pending must be a list")
    if isinstance(habits, list) and len(habits) > MAX_HABITS:
        violations.append(f"at most {MAX_HABITS} habits")
    if isinstance(pending, list) and len(pending) > MAX_PENDING:
        violations.append(f"at most {MAX_PENDING} pending candidates")
    for entry in habits or []:
        if not isinstance(entry, dict) or not str(entry.get("summary", "")).strip():
            violations.append("every habit needs a summary")
            break
    return violations


def normalize(data: dict[str, Any]) -> dict[str, Any]:
    """Clamp a habits document to the ceilings above, newest last."""
    habits = [
        {
            "summary": str(entry.get("summary", "")).strip()[:MAX_SUMMARY_CHARS],
            "detail": str(entry.get("detail", "")).strip()[:MAX_DETAIL_CHARS],
            "seen": int(entry.get("seen", PROMOTION_THRESHOLD) or PROMOTION_THRESHOLD),
        }
        for entry in data.get("habits") or []
        if isinstance(entry, dict) and str(entry.get("summary", "")).strip()
    ][-MAX_HABITS:]
    pending = [
        {
            "summary": str(entry.get("summary", "")).strip()[:MAX_SUMMARY_CHARS],
            "detail": str(entry.get("detail", "")).strip()[:MAX_DETAIL_CHARS],
            "seen": int(entry.get("seen", 1) or 1),
        }
        for entry in data.get("pending") or []
        if isinstance(entry, dict) and str(entry.get("summary", "")).strip()
    ][-MAX_PENDING:]
    return {"habits": habits, "pending": pending}


def observe(data: dict[str, Any], summary: str, detail: str = "") -> tuple[dict[str, Any], bool]:
    """Record one sighting of `summary`; return the new document and whether it promoted.

    Matching is by normalized summary text, which is coarse on purpose: the Scribe writes
    the summary itself, and holding it to an exact restatement would mean a candidate
    could never accumulate. A near-miss simply starts its own candidate and ages out under
    the ceiling — the cost of being wrong here is one unpromoted line, not a wrong habit.
    """
    document = normalize(data)
    key = _match_key(summary)
    if not key:
        return document, False
    if any(_match_key(entry["summary"]) == key for entry in document["habits"]):
        return document, False  # already known; a habit does not get louder by repetition

    pending = [entry for entry in document["pending"] if _match_key(entry["summary"]) != key]
    prior = next((entry for entry in document["pending"] if _match_key(entry["summary"]) == key), None)
    seen = (prior["seen"] if prior else 0) + 1
    candidate = {
        "summary": summary.strip()[:MAX_SUMMARY_CHARS],
        "detail": (detail or (prior or {}).get("detail", "")).strip()[:MAX_DETAIL_CHARS],
        "seen": seen,
    }
    if seen >= PROMOTION_THRESHOLD:
        document["habits"] = [*document["habits"], candidate][-MAX_HABITS:]
        document["pending"] = pending
        return document, True
    document["pending"] = [*pending, candidate][-MAX_PENDING:]
    return document, False


def index_lines(data: dict[str, Any]) -> list[str]:
    """The one-line summaries that stay resident in the prompt.

    Index-only residency: the summaries ride in every turn, the details do not. A habits
    document that grew to fill the prompt would be a fifth memory mechanism competing with
    the four that already work.
    """
    return [str(entry.get("summary", "")).strip() for entry in data.get("habits") or [] if entry.get("summary")]


def _match_key(summary: str) -> str:
    return "".join(character for character in (summary or "").casefold() if character.isalnum())


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="table_habits",
        owner="core.table_habits",
        reset_scope=None,
        survives_because=(
            "procedural memory about how THIS TABLE plays — its people, not its campaign. "
            "The players who start a fresh session are the same players, so the habits "
            "learned about them are still true (M20 E)"
        ),
        doc_types=frozenset({HABITS_DOC_TYPE}),
        storages=frozenset({STORAGE_DOCUMENTS}),
    ),
)
