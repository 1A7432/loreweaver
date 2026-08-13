"""Pre-generated character roster — the claimable cast a keeper's world import ships.

The card split (`core.card_split`) sends a card's machinery to the keeper-only world
path; this module is where the CHARACTER half of that same import goes: a room-scoped
pool of pre-generated, rule-validated sheets that players claim as their own PC
(`.pc list / claim / release`). One keeper import, a whole module cast on the table —
the classic pre-gen investigator flow.

M17: each pregen is ONE `pregen` document (``data = {name, system, source,
claimed_by, sheet}``); the roster IS the document list (insertion-ordered by `seq`),
and the projection withholds the pristine ``sheet`` payload from player-grade viewers
while the cast list itself stays table talk.

Deterministic bookkeeping (iron rule #1): claims are exclusive by construction; the
document keeps the PRISTINE imported sheet, a claim materializes a COPY under the
claiming player's own uid (`CharacterManager.save_character` — active + party roster
included), and a release deletes the player's copy while the pristine original stays
for the next claimant. Unclaimed pregens deliberately never touch the party roster —
the panel shows who is AT the table, not the whole cast list.
"""

from __future__ import annotations

import re
from typing import Any

from core.character_manager import CharacterManager, CharacterNameTakenError, CharacterSheet

MAX_ROSTER_ENTRIES = 32
_MAX_SLUG_CHARS = 64
_WS_RE = re.compile(r"\s+")

PREGEN_DOC_TYPE = "pregen"


def slug_for(name: str) -> str:
    """A stable roster id from a character name: trimmed, casefolded, whitespace
    collapsed to ``-``, capped. CJK passes through untouched."""
    cleaned = _WS_RE.sub("-", str(name).strip().casefold())
    return cleaned[:_MAX_SLUG_CHARS]


def _entry(doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": doc_id,
        "name": str(data.get("name", "")),
        "system": str(data.get("system", "")),
        "source": str(data.get("source", "")),
        "blurb": str(data.get("blurb", "")),
        "claimed_by": str(data.get("claimed_by", "")),
    }


async def pregen_entries(documents: Any, chat_key: str) -> list[dict[str, Any]]:
    """This room's roster entries (``{id, name, system, source, claimed_by}``),
    insertion-ordered; ``[]`` when none."""
    docs = await documents.list(chat_key, PREGEN_DOC_TYPE)
    return [_entry(doc.id, doc.data) for doc in docs if doc.data.get("name")]


async def pregen_find(documents: Any, chat_key: str, ref: str) -> dict[str, Any] | None:
    """Resolve a player-supplied reference (name or id, case-insensitive) to an entry."""
    wanted = slug_for(ref)
    if not wanted:
        return None
    for entry in await pregen_entries(documents, chat_key):
        if entry["id"] == wanted or slug_for(entry["name"]) == wanted:
            return entry
    return None


async def pregen_add(
    documents: Any, chat_key: str, sheet: CharacterSheet, *, source: str = "", blurb: str = ""
) -> dict[str, Any] | None:
    """Register `sheet` as a claimable pregen (pristine copy stored verbatim).

    Re-adding the same character REPLACES its pristine sheet but keeps any live
    claim — a module re-import refreshes the cast without kicking players off
    their PCs (document updates keep their insertion order). Returns the entry,
    or `None` when the sheet has no usable name or the roster is full.
    """
    slug = slug_for(sheet.name)
    if not slug:
        return None
    existing = await documents.get(chat_key, PREGEN_DOC_TYPE, slug)
    if existing is None and len(await documents.list(chat_key, PREGEN_DOC_TYPE)) >= MAX_ROSTER_ENTRIES:
        return None
    data = {
        "name": sheet.name,
        "system": sheet.system,
        "source": str(source)[:200],
        "blurb": str(blurb)[:200],
        "claimed_by": str(existing.data.get("claimed_by", "")) if existing is not None else "",
        "sheet": sheet.to_dict(),
    }
    doc = await documents.put(chat_key, PREGEN_DOC_TYPE, slug, data, source=str(source)[:200] or None)
    return _entry(doc.id, doc.data)


async def pregen_pristine_sheet(documents: Any, chat_key: str, slug: str) -> CharacterSheet | None:
    doc = await documents.get(chat_key, PREGEN_DOC_TYPE, slug)
    if doc is None or not isinstance(doc.data.get("sheet"), dict):
        return None
    try:
        return CharacterSheet.from_dict(doc.data["sheet"])
    except Exception:
        return None


async def _set_claimed(documents: Any, chat_key: str, slug: str, claimed_by: str) -> None:
    doc = await documents.get(chat_key, PREGEN_DOC_TYPE, slug)
    if doc is None:
        return
    data = dict(doc.data)
    data["claimed_by"] = claimed_by
    await documents.put(chat_key, PREGEN_DOC_TYPE, slug, data)


async def pregen_claim(
    documents: Any, chat_key: str, ref: str, user_id: str, characters: CharacterManager
) -> tuple[str, CharacterSheet | None]:
    """Claim a pregen for `user_id`. Returns ``(status, sheet)`` with status one of
    ``ok`` (fresh claim — pristine copy saved under the player's uid, made active),
    ``yours`` (already theirs — re-activated, progress untouched),
    ``taken`` (someone else's), ``unknown``, ``corrupt`` (pristine sheet unreadable),
    ``name_conflict`` (the name is already another player's own, non-pregen sheet)."""
    entry = await pregen_find(documents, chat_key, ref)
    if entry is None:
        return "unknown", None
    claimer = entry["claimed_by"]
    if claimer and claimer != user_id:
        return "taken", None
    if claimer == user_id:
        await characters.set_active_character(user_id, chat_key, entry["name"])
        return "yours", await characters.get_character(user_id, chat_key, entry["name"])
    sheet = await pregen_pristine_sheet(documents, chat_key, entry["id"])
    if sheet is None:
        return "corrupt", None
    try:
        await characters.save_character(user_id, chat_key, sheet)
    except CharacterNameTakenError:
        # The pregen's name is already an independently-created sheet owned by another
        # player (the F01 ownership check refusing an overwrite — the safe branch).
        # Force-saving would destroy that player's progress, so the claim reports
        # instead; the status routes to a localized notice like every other outcome.
        return "name_conflict", None
    await _set_claimed(documents, chat_key, entry["id"], user_id)
    return "ok", sheet


async def pregen_release(
    documents: Any,
    chat_key: str,
    ref: str,
    user_id: str,
    characters: CharacterManager,
    *,
    force: bool = False,
) -> str:
    """Release a claim. Players release their own; `force` (the keeper) releases
    anyone's. Returns ``ok`` / ``unknown`` / ``free`` (nobody holds it) /
    ``not_yours``. The player's copy is deleted (progress discarded — the next
    claimant starts from the pristine sheet); the roster entry stays claimable."""
    entry = await pregen_find(documents, chat_key, ref)
    if entry is None:
        return "unknown"
    claimer = entry["claimed_by"]
    if not claimer:
        return "free"
    if claimer != user_id and not force:
        return "not_yours"
    await characters.delete_character(claimer, chat_key, entry["name"])
    await _set_claimed(documents, chat_key, entry["id"], "")
    return "ok"
