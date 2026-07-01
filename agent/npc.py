"""AI-played NPC records + their manager (`docs/specs/M5.md` §2).

`NpcRecord` is the persisted shape of one knowledge-scoped NPC sub-actor: its
own persona/voice, its own *discrete* `knowledge` (the complete epistemic
world `agent.npc_actor.voice_npc` is allowed to draw on — see that module's
docstring for the information-isolation contract this record exists to
support), and light session-state (`disposition`, `location`, `status`).

`NpcManager` is a thin CRUD layer over `infra.store.Store`, mirroring
`core.character_manager.CharacterManager`'s shape: async get/save-style
methods keyed by `chat_key`, a room-scoped id list for enumeration, and
fuzzy (id-or-name) lookup so KP tools can resolve an NPC from whatever the
model/player typed. Store keys: `npc.{chat_key}.{id}` (a single NPC record,
JSON; `user_key=""` since NPCs are room-scoped, not per-player) and
`npc_list.{chat_key}` (a JSON array of that room's NPC ids, insertion-ordered).

No user-visible text originates here: every method either returns a
`NpcRecord`/`bool`/`None` or silently no-ops on a missing id, so there is
nothing for `agent.kp_tools_npc` to localize on this layer's behalf — all
framing text lives in the tools/actor layers that call this one.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field, fields
from typing import Any

from infra.store import Store

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    """Turn `name` into a `-`-joined, lowercase slug; falls back to `"npc"` if nothing alphanumeric remains."""
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug or "npc"


def _npc_key(chat_key: str, npc_id: str) -> str:
    return f"npc.{chat_key}.{npc_id}"


def _list_key(chat_key: str) -> str:
    return f"npc_list.{chat_key}"


@dataclass
class NpcRecord:
    """One AI-played NPC's full record — persona/voice, epistemic world, and light session state.

    `knowledge` is deliberately a flat list of discrete facts (not free-form prose): it is the exact
    set `agent.npc_actor.voice_npc` renders as bullets into the sub-actor's system prompt, so keeping
    it atomic keeps that prompt auditable (and keeps `npc_learns`/`add_knowledge` simple appends).
    """

    id: str
    name: str
    persona: str = ""  # who they are, voice, mannerisms, goals
    style: str = ""  # speech style hints
    public_description: str = ""  # what players can openly see
    secret_agenda: str = ""  # private goal/secret the NPC itself knows (never auto-shown to players)
    knowledge: list[str] = field(default_factory=list)  # discrete facts THIS npc currently knows
    disposition: str = "neutral"  # attitude toward the party (+ free notes)
    relationships: dict[str, str] = field(default_factory=dict)  # name -> relation
    location: str = ""
    status: str = ""
    stat_char: str | None = None  # optional CharacterSheet name for combat stats
    major: bool = True  # major NPCs use the actor; trivial ones the KP voices inline
    # M10 generalization: the SAME record shape now also backs AI *player companions*.
    # `role` splits the two kinds -- "keeper_npc" (the M5 default: a KP-side NPC voiced by
    # `agent.npc_actor`) vs. "player_companion" (a party-side PC voiced by
    # `agent.companion_actor`, linked to a real CharacterSheet under user_key
    # `companion:{id}`). `playstyle` is the companion's tactical/RP leaning; `is_pc` marks it
    # as a player character. Keeper NPCs keep every M5 default untouched.
    role: str = "keeper_npc"  # "keeper_npc" | "player_companion"
    playstyle: str = ""  # companion tactical/RP leaning (unused for keeper NPCs)
    is_pc: bool = False  # True for player companions (they own a CharacterSheet)
    created_time: float = field(default_factory=time.time)
    updated_time: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "persona": self.persona,
            "style": self.style,
            "public_description": self.public_description,
            "secret_agenda": self.secret_agenda,
            "knowledge": list(self.knowledge),
            "disposition": self.disposition,
            "relationships": dict(self.relationships),
            "location": self.location,
            "status": self.status,
            "stat_char": self.stat_char,
            "major": self.major,
            "role": self.role,
            "playstyle": self.playstyle,
            "is_pc": self.is_pc,
            "created_time": self.created_time,
            "updated_time": self.updated_time,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> NpcRecord:
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            persona=data.get("persona", ""),
            style=data.get("style", ""),
            public_description=data.get("public_description", ""),
            secret_agenda=data.get("secret_agenda", ""),
            knowledge=list(data.get("knowledge") or []),
            disposition=data.get("disposition", "neutral"),
            relationships=dict(data.get("relationships") or {}),
            location=data.get("location", ""),
            status=data.get("status", ""),
            stat_char=data.get("stat_char"),
            major=data.get("major", True),
            role=data.get("role", "keeper_npc"),
            playstyle=data.get("playstyle", ""),
            is_pc=bool(data.get("is_pc", False)),
            created_time=data.get("created_time") or time.time(),
            updated_time=data.get("updated_time") or time.time(),
        )


# Fields `update_npc` is allowed to blind-`setattr` from caller-supplied kwargs -- excludes `id`
# (identity, never mutated in place) and the timestamps (`_save_record` always restamps `updated_time`).
_MUTABLE_FIELDS = {f.name for f in fields(NpcRecord)} - {"id", "created_time", "updated_time"}


class NpcManager:
    """CRUD over room-scoped `NpcRecord`s, keyed by `chat_key` (mirrors `CharacterManager`'s shape)."""

    def __init__(self, store: Store) -> None:
        self.store = store

    async def _load_ids(self, chat_key: str) -> list[str]:
        raw = await self.store.get(user_key="", store_key=_list_key(chat_key))
        try:
            ids = json.loads(raw) if raw else []
        except (json.JSONDecodeError, TypeError):
            return []
        return ids if isinstance(ids, list) else []

    async def _save_ids(self, chat_key: str, ids: list[str]) -> None:
        await self.store.set(user_key="", store_key=_list_key(chat_key), value=json.dumps(ids, ensure_ascii=False))

    async def _load_record(self, chat_key: str, npc_id: str) -> NpcRecord | None:
        raw = await self.store.get(user_key="", store_key=_npc_key(chat_key, npc_id))
        if not raw:
            return None
        try:
            return NpcRecord.from_dict(json.loads(raw))
        except (json.JSONDecodeError, TypeError):
            return None

    async def _save_record(self, chat_key: str, record: NpcRecord) -> None:
        record.updated_time = time.time()
        await self.store.set(
            user_key="", store_key=_npc_key(chat_key, record.id), value=json.dumps(record.to_dict(), ensure_ascii=False)
        )

    async def _resolve_id(self, chat_key: str, name_or_id: str) -> str | None:
        """Fuzzy id-or-name resolution: exact id -> slugified id -> exact name (case-insensitive) ->
        substring-of-name (case-insensitive). Returns `None` rather than raising when nothing matches."""
        if not name_or_id or not name_or_id.strip():
            return None

        ids = await self._load_ids(chat_key)
        if name_or_id in ids:
            return name_or_id

        slug = _slugify(name_or_id)
        if slug in ids:
            return slug

        records: list[tuple[str, NpcRecord]] = []
        for npc_id in ids:
            record = await self._load_record(chat_key, npc_id)
            if record is not None:
                records.append((npc_id, record))

        lowered = name_or_id.strip().lower()
        for npc_id, record in records:
            if record.name.strip().lower() == lowered:
                return npc_id
        for npc_id, record in records:
            if lowered in record.name.strip().lower():
                return npc_id
        return None

    async def create_npc(
        self,
        chat_key: str,
        name: str,
        *,
        persona: str = "",
        public_description: str = "",
        secret_agenda: str = "",
        knowledge: list[str] | None = None,
        disposition: str = "neutral",
        location: str = "",
        role: str = "",
        major: bool = True,
        stat_char: str | None = None,
    ) -> NpcRecord:
        """Create and persist a new NPC for `chat_key`, id = `slugify(name)` (collision-suffixed).

        `role` is a persona HINT only (used by `agent.kp_tools_npc.NpcTools.import_module_npcs` when
        seeding from a module's `npcs[]`, which has a `role` field but no `persona`): it becomes this
        NPC's `persona` only when `persona` itself is not given.
        """
        ids = await self._load_ids(chat_key)
        base_slug = _slugify(name)
        npc_id = base_slug
        suffix = 2
        while npc_id in ids:
            npc_id = f"{base_slug}-{suffix}"
            suffix += 1

        record = NpcRecord(
            id=npc_id,
            name=name,
            persona=persona or role,
            public_description=public_description,
            secret_agenda=secret_agenda,
            knowledge=list(knowledge or []),
            disposition=disposition,
            location=location,
            major=major,
            stat_char=stat_char,
        )
        await self._save_record(chat_key, record)

        ids.append(npc_id)
        await self._save_ids(chat_key, ids)
        return record

    async def create_companion(
        self,
        chat_key: str,
        name: str,
        *,
        persona: str = "",
        playstyle: str = "",
        knowledge: list[str] | None = None,
        stat_char: str | None = None,
    ) -> NpcRecord:
        """Create a `player_companion` record (M10): a party-side PC voiced by
        `agent.companion_actor`, linked to a CharacterSheet via `stat_char`.

        Thin wrapper over `create_npc` (so id-collision suffixing and the room id
        list are reused unchanged) that then stamps the companion-only fields
        `role="player_companion"`, `is_pc=True`, `playstyle` and `stat_char`. The
        legacy `create_npc(role=...)` *persona-hint* param is deliberately left
        alone so keeper NPCs are wholly unaffected.
        """
        record = await self.create_npc(
            chat_key, name, persona=persona, knowledge=knowledge, stat_char=stat_char, major=True
        )
        record.role = "player_companion"
        record.is_pc = True
        record.playstyle = playstyle
        await self._save_record(chat_key, record)
        return record

    async def list_companions(self, chat_key: str) -> list[NpcRecord]:
        """Every `player_companion` in this room, in insertion order (keeper NPCs excluded)."""
        return [record for record in await self.list_npcs(chat_key) if record.role == "player_companion"]

    async def get_npc(self, chat_key: str, name_or_id: str) -> NpcRecord | None:
        npc_id = await self._resolve_id(chat_key, name_or_id)
        return await self._load_record(chat_key, npc_id) if npc_id is not None else None

    async def list_npcs(self, chat_key: str) -> list[NpcRecord]:
        records = []
        for npc_id in await self._load_ids(chat_key):
            record = await self._load_record(chat_key, npc_id)
            if record is not None:
                records.append(record)
        return records

    async def update_npc(self, chat_key: str, name_or_id: str, **updates: Any) -> NpcRecord | None:
        npc_id = await self._resolve_id(chat_key, name_or_id)
        if npc_id is None:
            return None
        record = await self._load_record(chat_key, npc_id)
        if record is None:
            return None

        for key, value in updates.items():
            if key in _MUTABLE_FIELDS:
                setattr(record, key, value)

        await self._save_record(chat_key, record)
        return record

    async def delete_npc(self, chat_key: str, name_or_id: str) -> bool:
        npc_id = await self._resolve_id(chat_key, name_or_id)
        if npc_id is None:
            return False

        ids = await self._load_ids(chat_key)
        if npc_id in ids:
            ids.remove(npc_id)
            await self._save_ids(chat_key, ids)
        await self.store.delete(user_key="", store_key=_npc_key(chat_key, npc_id))
        return True

    async def move_npc(self, chat_key: str, name_or_id: str, location: str) -> NpcRecord | None:
        return await self.update_npc(chat_key, name_or_id, location=location)

    async def set_disposition(self, chat_key: str, name_or_id: str, disposition: str) -> NpcRecord | None:
        return await self.update_npc(chat_key, name_or_id, disposition=disposition)

    async def add_knowledge(self, chat_key: str, name_or_id: str, facts: list[str], mode: str = "add") -> NpcRecord | None:
        """Add (append) or replace (overwrite) `name_or_id`'s `knowledge` list.

        `facts` entries are stripped; blank entries are dropped either way.
        """
        npc_id = await self._resolve_id(chat_key, name_or_id)
        if npc_id is None:
            return None
        record = await self._load_record(chat_key, npc_id)
        if record is None:
            return None

        cleaned = [fact.strip() for fact in facts if fact and fact.strip()]
        record.knowledge = cleaned if mode == "replace" else [*record.knowledge, *cleaned]

        await self._save_record(chat_key, record)
        return record

    async def npc_learns(self, chat_key: str, name_or_id: str, fact: str) -> NpcRecord | None:
        """Append a single newly-learned fact -- a thin convenience over `add_knowledge`."""
        return await self.add_knowledge(chat_key, name_or_id, [fact], mode="add")
