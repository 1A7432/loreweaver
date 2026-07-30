"""Pre-generated character roster — the claimable cast a keeper's world import ships.

The card split (`core.card_split`) sends a card's machinery to the keeper-only world
path; this module is where the CHARACTER half of that same import goes: a room-scoped
pool of pre-generated, rule-validated sheets that players claim as their own PC
(`.pc list / claim / release`). One keeper import, a whole module cast on the table —
the classic pre-gen investigator flow.

Deterministic bookkeeping (iron rule #1): claims are exclusive by construction; the
roster keeps the PRISTINE imported sheet, a claim materializes a COPY under the
claiming player's own uid (`CharacterManager.save_character` — active + party roster
included), and a release deletes the player's copy while the pristine original stays
for the next claimant. Unclaimed pregens deliberately never touch the party roster —
the panel shows who is AT the table, not the whole cast list.
"""

from __future__ import annotations

import json
import re
from typing import Any, Protocol

from core.character_manager import CharacterManager, CharacterSheet

MAX_ROSTER_ENTRIES = 32
_MAX_SLUG_CHARS = 64
_WS_RE = re.compile(r"\s+")


class _StoreProtocol(Protocol):
    async def get(self, *, user_key: str, store_key: str) -> str | None: ...
    async def set(self, *, user_key: str, store_key: str, value: str) -> None: ...


def _roster_key(chat_key: str) -> str:
    return f"pregen_roster.{chat_key}"


def _sheet_key(chat_key: str, slug: str) -> str:
    return f"pregen_sheet.{chat_key}.{slug}"


def slug_for(name: str) -> str:
    """A stable roster id from a character name: trimmed, casefolded, whitespace
    collapsed to ``-``, capped. CJK passes through untouched."""
    cleaned = _WS_RE.sub("-", str(name).strip().casefold())
    return cleaned[:_MAX_SLUG_CHARS]


class PregenRoster:
    """Async claim/release bookkeeping over a duck-typed store, keyed by `chat_key`."""

    def __init__(self, store: _StoreProtocol) -> None:
        self._store = store

    async def entries(self, chat_key: str) -> list[dict[str, Any]]:
        """This room's roster entries (``{id, name, system, source, claimed_by}``),
        insertion-ordered; ``[]`` on a miss or corrupt value."""
        raw = await self._store.get(user_key="", store_key=_roster_key(chat_key))
        if not raw:
            return []
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return []
        if not isinstance(data, list):
            return []
        return [entry for entry in data if isinstance(entry, dict) and entry.get("id")]

    async def _save_entries(self, chat_key: str, entries: list[dict[str, Any]]) -> None:
        await self._store.set(
            user_key="", store_key=_roster_key(chat_key), value=json.dumps(entries, ensure_ascii=False)
        )

    async def find(self, chat_key: str, ref: str) -> dict[str, Any] | None:
        """Resolve a player-supplied reference (name or id, case-insensitive) to an entry."""
        wanted = slug_for(ref)
        if not wanted:
            return None
        for entry in await self.entries(chat_key):
            if entry["id"] == wanted or slug_for(str(entry.get("name", ""))) == wanted:
                return entry
        return None

    async def add(self, chat_key: str, sheet: CharacterSheet, *, source: str = "") -> dict[str, Any] | None:
        """Register `sheet` as a claimable pregen (pristine copy stored verbatim).

        Re-adding the same character REPLACES its pristine sheet but keeps any live
        claim — a module re-import refreshes the cast without kicking players off
        their PCs. Returns the entry, or `None` when the sheet has no usable name
        or the roster is full.
        """
        slug = slug_for(sheet.name)
        if not slug:
            return None
        entries = await self.entries(chat_key)
        existing = next((entry for entry in entries if entry["id"] == slug), None)
        if existing is None and len(entries) >= MAX_ROSTER_ENTRIES:
            return None
        entry = {
            "id": slug,
            "name": sheet.name,
            "system": sheet.system,
            "source": str(source)[:200],
            "claimed_by": str(existing.get("claimed_by", "")) if existing else "",
        }
        if existing is None:
            entries.append(entry)
        else:
            entries[entries.index(existing)] = entry
        await self._store.set(
            user_key="",
            store_key=_sheet_key(chat_key, slug),
            value=json.dumps(sheet.to_dict(), ensure_ascii=False),
        )
        await self._save_entries(chat_key, entries)
        return entry

    async def pristine_sheet(self, chat_key: str, slug: str) -> CharacterSheet | None:
        raw = await self._store.get(user_key="", store_key=_sheet_key(chat_key, slug))
        if not raw:
            return None
        try:
            return CharacterSheet.from_dict(json.loads(raw))
        except Exception:
            return None

    async def claim(
        self, chat_key: str, ref: str, user_id: str, characters: CharacterManager
    ) -> tuple[str, CharacterSheet | None]:
        """Claim a pregen for `user_id`. Returns ``(status, sheet)`` with status one of
        ``ok`` (fresh claim — pristine copy saved under the player's uid, made active),
        ``yours`` (already theirs — re-activated, progress untouched),
        ``taken`` (someone else's), ``unknown``, ``corrupt`` (pristine sheet unreadable)."""
        entry = await self.find(chat_key, ref)
        if entry is None:
            return "unknown", None
        claimer = str(entry.get("claimed_by", ""))
        if claimer and claimer != user_id:
            return "taken", None
        if claimer == user_id:
            await characters.set_active_character(user_id, chat_key, str(entry["name"]))
            return "yours", await characters.get_character(user_id, chat_key, str(entry["name"]))
        sheet = await self.pristine_sheet(chat_key, str(entry["id"]))
        if sheet is None:
            return "corrupt", None
        await characters.save_character(user_id, chat_key, sheet)
        entries = await self.entries(chat_key)
        for stored in entries:
            if stored["id"] == entry["id"]:
                stored["claimed_by"] = user_id
        await self._save_entries(chat_key, entries)
        return "ok", sheet

    async def release(
        self, chat_key: str, ref: str, user_id: str, characters: CharacterManager, *, force: bool = False
    ) -> str:
        """Release a claim. Players release their own; `force` (the keeper) releases
        anyone's. Returns ``ok`` / ``unknown`` / ``free`` (nobody holds it) /
        ``not_yours``. The player's copy is deleted (progress discarded — the next
        claimant starts from the pristine sheet); the roster entry stays claimable."""
        entry = await self.find(chat_key, ref)
        if entry is None:
            return "unknown"
        claimer = str(entry.get("claimed_by", ""))
        if not claimer:
            return "free"
        if claimer != user_id and not force:
            return "not_yours"
        await characters.delete_character(claimer, chat_key, str(entry["name"]))
        entries = await self.entries(chat_key)
        for stored in entries:
            if stored["id"] == entry["id"]:
                stored["claimed_by"] = ""
        await self._save_entries(chat_key, entries)
        return "ok"
