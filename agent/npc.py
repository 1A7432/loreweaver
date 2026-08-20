"""AI-played NPC records + their manager (`docs/specs/M5.md` §2).

`NpcRecord` is the persisted shape of one knowledge-scoped NPC sub-actor: its
own persona/voice, its own *discrete* `knowledge` (the complete epistemic
world `agent.npc_actor.voice_npc` is allowed to draw on — see that module's
docstring for the information-isolation contract this record exists to
support), and light session-state (`disposition`, `location`, `status`).

Persistence (M17): each NPC is one `npc` document (id = the slugified name,
insertion-ordered by the documents table's `seq` — no separate id-list row).
The `npc` document PROJECTION (`core.documents`) is the structural secrecy
contract: the keeper and the NPC's own actor view the full record; every
other viewer gets only the public subset. The async functions below are the
only read/write path; they hand back `NpcRecord`s built from document data.

No user-visible text originates here: every method either returns a
`NpcRecord`/`bool`/`None` or silently no-ops on a missing id, so there is
nothing for `agent.kp_tools_npc` to localize on this layer's behalf — all
framing text lives in the tools/actor layers that call this one.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field, fields
from typing import Any

from core.pregen_roster import pregen_entries
from infra.room_facets import STORAGE_DOCUMENTS, RoomStateFacet

_SLUG_RE = re.compile(r"[^a-z0-9]+")

# The virtual per-player user_key an AI companion's CharacterSheet is stored under.
# One definition: it is how a sheet's `owner` tells a companion (an NPC record with a
# sheet) apart from a PLAYER — see `player_character_names`.
COMPANION_UID_PREFIX = "companion:"


def companion_uid(companion_id: str) -> str:
    return f"{COMPANION_UID_PREFIX}{companion_id}"


class PlayerNameReservedError(ValueError):
    """`name` is a PLAYER character in this room — a player is never an NPC or an AI
    companion, so `create_npc`/`create_companion` refuse to write the record.

    Raised at the WRITER, not in one tool's preamble: the 2026-08-18 《安土》 run had the
    Keeper register a real player as an AI companion `npc-4` (`add_companion`, then
    `companion_act` — a scene narrated twice, the clock overwritten), and a guard that
    covered only `create_npc`/`sketch_npc` would have let that exact call through again.
    Every entry point (the NPC tools, `add_companion`, `.party add`, a character card
    imported `as companion`, a module's NPC seed) reaches this function, so every one of
    them is refused here."""

    def __init__(self, name: str) -> None:
        self.name = name
        # Developer-facing (the tools localize the refusal — `agent.kp_tools_npc.player_name_refusal`).
        super().__init__(f"player_name_reserved: {name!r}")


class KeeperNpcNameTakenError(ValueError):
    """`name` already belongs to a KEEPER NPC, so `create_companion` refuses to write.

    `create_npc` deliberately hands back an EXISTING record on an exact name match rather
    than minting a duplicate (2026-08-06 live playtest: a fresh surface-persona duplicate
    must never shadow a record carrying seeded secrets). `create_companion` wrapped that
    and then stamped `role="player_companion"` / `is_pc=True` onto whatever came back — so
    `add_companion("Villain")` CONVERTED the module's villain into a party-side companion
    in place, keeping its `secret_agenda` and its seeded knowledge, and handing the party
    an actor built from the antagonist's own record.

    A keeper NPC and a party companion are opposite sides of the table; turning one into
    the other is never what a create call meant. So the writer refuses, writes nothing,
    and the tools localize (`agent.kp_tools_npc.keeper_npc_refusal`). Re-adding a name
    that is ALREADY a companion stays idempotent — that is a re-create, not a conversion."""

    def __init__(self, name: str, role: str = "") -> None:
        self.name = name
        self.role = role
        # Developer-facing (the tools localize the refusal).
        super().__init__(f"keeper_npc_name_taken: {name!r}")


def _slugify(name: str) -> str:
    """Turn `name` into a `-`-joined, lowercase slug; falls back to `"npc"` if nothing alphanumeric remains."""
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug or "npc"


NPC_DOC_TYPE = "npc"

# The `role` a party-side AI companion's record carries — the other side of the table from
# the "keeper_npc" default, and the test `create_companion` refuses to cross.
COMPANION_ROLE = "player_companion"


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
    # Compact gender/pronoun hint (e.g. "he/him", "she/her"), inferred structurally on import from a
    # card's own description so the KP is handed the character's gender instead of guessing it from a
    # name. Surfaced in the Keeper-facing companion roster; "" when there was no clear signal.
    pronouns: str = ""
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
            "pronouns": self.pronouns,
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
            pronouns=data.get("pronouns", ""),
            created_time=data.get("created_time") or time.time(),
            updated_time=data.get("updated_time") or time.time(),
        )


# Fields `update_npc` is allowed to blind-`setattr` from caller-supplied kwargs -- excludes `id`
# (identity, never mutated in place) and the timestamps (`_save_record` always restamps `updated_time`).
_MUTABLE_FIELDS = {f.name for f in fields(NpcRecord)} - {"id", "created_time", "updated_time"}


async def _load_all(documents: Any, chat_key: str) -> list[tuple[str, NpcRecord]]:
    pairs: list[tuple[str, NpcRecord]] = []
    for doc in await documents.list(chat_key, NPC_DOC_TYPE):
        try:
            record = NpcRecord.from_dict(dict(doc.data, id=doc.id))
        except Exception:
            continue
        pairs.append((doc.id, record))
    return pairs


async def _save_record(documents: Any, chat_key: str, record: NpcRecord) -> None:
    record.updated_time = time.time()
    await documents.put(chat_key, NPC_DOC_TYPE, record.id, record.to_dict())


async def _resolve_id(documents: Any, chat_key: str, name_or_id: str) -> str | None:
    """Fuzzy id-or-name resolution: exact id -> exact name (case-insensitive) -> slugified id ->
    substring-of-name (case-insensitive). Returns `None` rather than raising when nothing matches.

    Exact NAME outranks the slug lookup: every CJK-only name slugifies to the bare "npc"
    fallback, so a slug-first order resolved any such name to whichever NPC happened to
    hold the fallback id — updating 老周 silently edited 沈茉 (2026-08-06 live playtest)."""
    if not name_or_id or not name_or_id.strip():
        return None

    pairs = await _load_all(documents, chat_key)
    ids = [npc_id for npc_id, _record in pairs]
    if name_or_id in ids:
        return name_or_id

    lowered = name_or_id.strip().lower()
    for npc_id, record in pairs:
        if record.name.strip().lower() == lowered:
            return npc_id

    slug = _slugify(name_or_id)
    if slug != "npc" and slug in ids:
        # The "npc" fallback slug carries none of the name's content — matching it
        # would hijack resolution instead of resolving it.
        return slug

    for npc_id, record in pairs:
        if lowered in record.name.strip().lower():
            return npc_id
    return None


async def find_npc_by_name(documents: Any, chat_key: str, name: str) -> NpcRecord | None:
    """The record whose name is EXACTLY `name` (case-insensitive), or None — the same test
    `create_npc` uses to hand back an existing record instead of minting a duplicate, so a
    caller can tell "this call created it" from "it was already there" before it decides
    what an undo may touch."""
    wanted = name.strip().lower()
    if not wanted:
        return None
    for _npc_id, record in await _load_all(documents, chat_key):
        if record.name.strip().lower() == wanted:
            return record
    return None


async def player_character_names(documents: Any, chat_key: str) -> set[str]:
    """The names this room has given to PLAYER characters, casefolded: every character
    sheet not owned by an AI companion (the sheet name IS the identity — see
    `core.character_manager.CharacterNameTakenError`), plus the module's claimable
    pregens, which a player may take at any moment. Raises when the store cannot be
    read: the callers are about to WRITE a cast record, and a guard that cannot see the
    roster refuses rather than waves the write through."""
    names: set[str] = set()
    for doc in await documents.list(chat_key, "sheet"):
        if str(doc.data.get("owner") or "").startswith(COMPANION_UID_PREFIX):
            continue
        name = str(doc.data.get("name") or doc.id).strip()
        if name:
            names.add(name.casefold())
    for entry in await pregen_entries(documents, chat_key):
        name = str(entry.get("name") or "").strip()
        if name:
            names.add(name.casefold())
    return names


async def create_npc(
    documents: Any,
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

    A name that belongs to a PLAYER character raises `PlayerNameReservedError` and
    writes nothing (see that class). Creating an EXACT already-existing name returns
    that record untouched instead of minting a duplicate: the model's persisted history keeps only final replies (tool
    chatter is dropped by design), so a later turn legitimately re-"creates" an NPC it
    already seeded — and a fresh surface-persona duplicate must never shadow or race a
    record that carries the seeded secret_agenda/knowledge (2026-08-06 live playtest).
    """
    if name.strip().casefold() in await player_character_names(documents, chat_key):
        raise PlayerNameReservedError(name.strip())
    pairs = await _load_all(documents, chat_key)
    ids = [npc_id for npc_id, _record in pairs]
    wanted = name.strip().lower()
    for _npc_id, existing in pairs:
        if existing.name.strip().lower() == wanted:
            return existing
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
    await _save_record(documents, chat_key, record)
    return record


async def create_companion(
    documents: Any,
    chat_key: str,
    name: str,
    *,
    persona: str = "",
    playstyle: str = "",
    knowledge: list[str] | None = None,
    stat_char: str | None = None,
    pronouns: str = "",
) -> NpcRecord:
    """Create a `player_companion` record (M10): a party-side PC voiced by
    `agent.companion_actor`, linked to a CharacterSheet via `stat_char`.

    Thin wrapper over `create_npc` (so id-collision suffixing is reused unchanged)
    that then stamps the companion-only fields `role="player_companion"`,
    `is_pc=True`, `playstyle`, `pronouns` and `stat_char`.

    A name that already belongs to a KEEPER NPC raises `KeeperNpcNameTakenError` and
    writes nothing: `create_npc` returns that existing record, and stamping the companion
    fields onto it would convert the module's own NPC — secrets, knowledge and all — into
    a party member. Re-creating a name that IS already a companion stays idempotent."""
    existing = await find_npc_by_name(documents, chat_key, name)
    if existing is not None and existing.role != COMPANION_ROLE:
        raise KeeperNpcNameTakenError(name.strip(), existing.role)
    record = await create_npc(
        documents, chat_key, name, persona=persona, knowledge=knowledge, stat_char=stat_char, major=True
    )
    record.role = COMPANION_ROLE
    record.is_pc = True
    record.playstyle = playstyle
    record.pronouns = pronouns
    await _save_record(documents, chat_key, record)
    return record


async def list_npcs(documents: Any, chat_key: str) -> list[NpcRecord]:
    return [record for _npc_id, record in await _load_all(documents, chat_key)]


async def list_companions(documents: Any, chat_key: str) -> list[NpcRecord]:
    """Every `player_companion` in this room, in insertion order (keeper NPCs excluded)."""
    return [record for record in await list_npcs(documents, chat_key) if record.role == COMPANION_ROLE]


async def get_npc(documents: Any, chat_key: str, name_or_id: str) -> NpcRecord | None:
    npc_id = await _resolve_id(documents, chat_key, name_or_id)
    if npc_id is None:
        return None
    doc = await documents.get(chat_key, NPC_DOC_TYPE, npc_id)
    if doc is None:
        return None
    try:
        return NpcRecord.from_dict(dict(doc.data, id=doc.id))
    except Exception:
        return None


async def update_npc(documents: Any, chat_key: str, name_or_id: str, **updates: Any) -> NpcRecord | None:
    record = await get_npc(documents, chat_key, name_or_id)
    if record is None:
        return None

    for key, value in updates.items():
        if key in _MUTABLE_FIELDS:
            setattr(record, key, value)

    await _save_record(documents, chat_key, record)
    return record


async def delete_npc(documents: Any, chat_key: str, name_or_id: str) -> bool:
    npc_id = await _resolve_id(documents, chat_key, name_or_id)
    if npc_id is None:
        return False
    return await documents.delete(chat_key, NPC_DOC_TYPE, npc_id)


async def move_npc(documents: Any, chat_key: str, name_or_id: str, location: str) -> NpcRecord | None:
    return await update_npc(documents, chat_key, name_or_id, location=location)


async def set_disposition(documents: Any, chat_key: str, name_or_id: str, disposition: str) -> NpcRecord | None:
    return await update_npc(documents, chat_key, name_or_id, disposition=disposition)


async def add_knowledge(
    documents: Any, chat_key: str, name_or_id: str, facts: list[str], mode: str = "add"
) -> NpcRecord | None:
    """Add (append) or replace (overwrite) `name_or_id`'s `knowledge` list.

    `facts` entries are stripped; blank entries are dropped either way.
    """
    record = await get_npc(documents, chat_key, name_or_id)
    if record is None:
        return None

    cleaned = [fact.strip() for fact in facts if fact and fact.strip()]
    record.knowledge = cleaned if mode == "replace" else [*record.knowledge, *cleaned]

    await _save_record(documents, chat_key, record)
    return record


async def npc_learns(documents: Any, chat_key: str, name_or_id: str, fact: str) -> NpcRecord | None:
    """Append a single newly-learned fact -- a thin convenience over `add_knowledge`."""
    return await add_knowledge(documents, chat_key, name_or_id, [fact], mode="add")


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="npc_records",
        owner="agent.npc",
        reset_scope="story",
        # In-play NPCs are session state: the module's cast is re-created from the module
        # on the next playthrough, and a survivor would arrive already knowing the party.
        doc_types=frozenset({NPC_DOC_TYPE}),
        storages=frozenset({STORAGE_DOCUMENTS}),
    ),
)
