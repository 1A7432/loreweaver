"""Character sheet management, generic over pack-declared sheet shapes.

M16 stage B: this module holds NO system rules. A sheet's fresh-slot tables,
canonical-name bridges, derived slots, vitals and creation rolls all come from
the sheet's rulepack (``sheet:`` / ``creation_constraints:`` — see
`core.sheets`); this module is the storage + lifecycle layer (documents CRUD,
party roster, active-character pointers) plus the pack-driven `CharacterSheet`
container. ``system`` on a sheet is any name `core.rulepacks.load_rulepack`
resolves; a sheet whose system resolves to no pack degrades to bare storage
dicts with no derivations.
"""

from __future__ import annotations

import copy
import hashlib
import json
import time
from datetime import datetime
from typing import Any

from infra.i18n import t
from infra.room_facets import STORAGE_DOCUMENTS, STORAGE_ROOM_STATE, RoomStateFacet
from infra.store import Store


class CharacterDataError(Exception):
    """A character row exists in the store but cannot be read.

    Raised by `CharacterManager.get_character` when the underlying store read
    fails, or the stored row is present but undecodable (corrupt/truncated
    JSON, schema mismatch). This is deliberately distinct from a *genuinely
    absent* row, which `get_character` still resolves to a fresh default sheet
    so creation flows keep working.

    Mutating callers MUST catch this and abort — otherwise a blank replacement
    sheet (carrying the real character's name) would be saved over the
    unreadable row AND the shared party roster, permanently wiping the
    character. Read-only callers may catch it and degrade gracefully.
    """

    def __init__(self, char_name: str, message: str = "") -> None:
        self.char_name = char_name
        super().__init__(message or f"character data for {char_name!r} is unreadable")


# The fixed slot `get_character` falls back to when a user has no active character:
# a sheet named this is the NOT-FOUND placeholder, never a real character.
UNSET_CHARACTER_NAME = "default"


def has_character(sheet: CharacterSheet | None) -> bool:
    """Whether `sheet` is a real (saved) character rather than `get_character`'s
    not-found placeholder. The ONE predicate every "is there a sheet?" check uses."""
    return bool(sheet) and bool(sheet.name) and sheet.name != UNSET_CHARACTER_NAME


class CharacterNameTakenError(Exception):
    """A sheet write would land on a character owned by a DIFFERENT user.

    Sheet documents are room-scoped and keyed by the character NAME (M17), so
    the name IS the identity: writing one that someone else owns destroys their
    sheet outright. `CharacterManager.save_character` raises this instead of
    writing; callers turn it into a localized "pick another name" answer.

    The `force=True` escape hatch on `save_character`/`delete_character` exists
    for administrative flows that legitimately re-home a sheet across uids.
    """

    def __init__(self, char_name: str, owner: str = "") -> None:
        self.char_name = char_name
        self.owner = owner
        super().__init__(f"character name {char_name!r} belongs to another player")


# Legacy secondary-attribute HP slots some imported sheets still carry (game-data
# keys, read-side only).
_SECONDARY_CURRENT_HP_KEY = "生命值"
_SECONDARY_MAX_HP_KEY = "生命值上限"
# Engine-convention attribute slots for hit points on systems that keep them in
# the attributes dict (or on bare no-pack sheets).
_ATTR_HP_KEY = "HP"
_ATTR_HPMAX_KEY = "HPMAX"


def _numeric_stat(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return int(value)
    return None


def _pack_for(character: CharacterSheet):
    """The loaded rulepack for `character`'s system (None when unresolvable)."""
    from core.rulepacks import load_rulepack

    try:
        return load_rulepack(character.system)
    except Exception:
        return None


def _sheet_spec_for(character: CharacterSheet):
    """The pack sheet spec for `character`'s system (None when unresolvable)."""
    pack = _pack_for(character)
    return None if pack is None else pack.sheet_spec


def get_hit_points(character: CharacterSheet) -> tuple[int, int]:
    """Return authoritative ``(current, maximum)`` hit points."""
    spec = _sheet_spec_for(character)
    if spec is None or spec.hit_points is None:
        current = _numeric_stat(character.attributes.get(_ATTR_HP_KEY))
        maximum = _numeric_stat(character.attributes.get(_ATTR_HPMAX_KEY))
    else:
        current = _numeric_stat(getattr(character, "hp_current", None))
        maximum = _numeric_stat(getattr(character, "hp_max", None))
        secondary = getattr(character, "secondary_attributes", {})
        if current is None:
            current = _numeric_stat(secondary.get(_SECONDARY_CURRENT_HP_KEY))
        if maximum is None:
            maximum = _numeric_stat(secondary.get(_SECONDARY_MAX_HP_KEY))
        if current is None:
            current = _numeric_stat(character.attributes.get(_ATTR_HP_KEY))
        if maximum is None:
            maximum = _numeric_stat(character.attributes.get(_ATTR_HPMAX_KEY))

    if current is None and maximum is None:
        return 0, 0
    if maximum is None:
        maximum = max(0, current or 0)
    if current is None:
        current = maximum
    maximum = max(0, maximum)
    return max(0, min(maximum, current)), maximum


def set_hit_points(
    character: CharacterSheet,
    *,
    current: int | None = None,
    maximum: int | None = None,
    delta: int | None = None,
    allow_raise_max: bool = False,
) -> tuple[int, int]:
    """Apply one deterministic HP update and persist current/max separately."""
    old_current, old_maximum = get_hit_points(character)
    new_maximum = old_maximum if maximum is None else max(0, int(maximum))
    new_current = old_current if current is None else max(0, int(current))
    if delta is not None:
        new_current += int(delta)
    if allow_raise_max and new_current > new_maximum:
        new_maximum = new_current
    new_current = max(0, min(new_maximum, new_current))

    spec = _sheet_spec_for(character)
    if spec is None or spec.hit_points is None:
        character.attributes[_ATTR_HP_KEY] = new_current
        character.attributes[_ATTR_HPMAX_KEY] = new_maximum
    else:
        character.hp_current = new_current
        character.hp_max = new_maximum
        character.secondary_attributes.pop(_SECONDARY_CURRENT_HP_KEY, None)
        character.secondary_attributes.pop(_SECONDARY_MAX_HP_KEY, None)
        character.attributes.pop(_ATTR_HP_KEY, None)
        character.attributes.pop(_ATTR_HPMAX_KEY, None)
    return new_current, new_maximum


def character_resources(character: CharacterSheet, locale: str | None = None) -> list[dict[str, Any]]:
    """The pack-declared generic resource meters (`{id,label,value,max}`) for
    `character` — the wire/panel/roster vitals shape. Empty when no pack.

    `locale` picks the label a pack declared per language (M19 item 8); callers on a
    per-VIEWER wire path pass the viewer's, persistence paths leave it unset."""
    from core.sheets import wire_resources

    pack = _pack_for(character)
    if pack is None:
        return []
    try:
        return wire_resources(character, pack, locale)
    except Exception:
        return []


def resource_label_map(system: str, locale: str | None) -> dict[str, str]:
    """`resource id -> label` for `system` in `locale` (`{}` when it doesn't resolve).

    The roster persists each member's meters with whatever label was current when they
    were saved; a viewer-locale wire build re-labels through this instead of shipping
    that frozen string to every language."""
    from core.rulepacks import load_rulepack

    try:
        pack = load_rulepack(system or "")
        spec = pack.sheet_spec
    except Exception:
        return {}
    if spec is None:
        return {}
    return {resource.id: resource.label_for(locale) for resource in spec.resources}


class CharacterSheet:
    """A single character sheet, shaped by its system's pack `sheet:` spec."""

    def __init__(self, name: str = "", system: str = "") -> None:
        self.name = name
        self.system = system
        self.hp_current: int | None = None
        self.hp_max: int | None = None
        self.attributes: dict[str, Any] = {}
        self.secondary_attributes: dict[str, Any] = {}
        self.skills: dict[str, Any] = {}
        self.equipment: list[Any] = []
        self.background = ""
        self.notes = ""
        self.avatar: dict[str, Any] | None = None

        pack = _pack_for(self)
        spec = None if pack is None else pack.sheet_spec
        if spec is not None:
            self.attributes = {str(key): copy.deepcopy(value) for key, value in spec.attributes.items()}
            self.secondary_attributes = {str(key): copy.deepcopy(value) for key, value in spec.secondary.items()}
            self.skills = {str(key): copy.deepcopy(value) for key, value in spec.skills.items()}
            for field_name, default in spec.fields.items():
                setattr(self, str(field_name), copy.deepcopy(default))
            if spec.hit_points is not None:
                self.hp_current = int(spec.hit_points["current"])
                self.hp_max = int(spec.hit_points["max"])
            from core.sheets import refresh_sheet

            refresh_sheet(self, pack, initialize_vitals=True, preserve_trained=False)

        self.created_time = time.time()
        self.last_updated = time.time()

    def field_values(self) -> dict[str, Any]:
        """The pack-declared meta fields (occupation/level/... — names are pack
        data) currently set on this sheet."""
        spec = _sheet_spec_for(self)
        if spec is None:
            return {}
        return {str(name): getattr(self, str(name), None) for name in spec.fields}

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "system": self.system,
            "attributes": self.attributes,
            "secondary_attributes": getattr(self, "secondary_attributes", {}),
            "hp_current": getattr(self, "hp_current", None),
            "hp_max": getattr(self, "hp_max", None),
            "skills": self.skills,
            "equipment": getattr(self, "equipment", []),
            "background": getattr(self, "background", ""),
            "notes": getattr(self, "notes", ""),
            "avatar": getattr(self, "avatar", None),
            "fields": self.field_values(),
            "created_time": self.created_time,
            "last_updated": self.last_updated,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CharacterSheet:
        character = cls(data.get("name", ""), data.get("system", ""))
        character.attributes = data.get("attributes", {})
        character.secondary_attributes = data.get("secondary_attributes", {})
        character.skills = data.get("skills", {})
        character.equipment = data.get("equipment", [])
        character.background = data.get("background", "")
        character.notes = data.get("notes", "")
        avatar = data.get("avatar")
        character.avatar = avatar if isinstance(avatar, dict) else None
        fields = data.get("fields")
        if isinstance(fields, dict):
            for field_name, value in fields.items():
                setattr(character, str(field_name), value)
        character.created_time = data.get("created_time", time.time())
        character.last_updated = data.get("last_updated", time.time())

        pack = _pack_for(character)
        spec = None if pack is None else pack.sheet_spec
        if spec is not None and spec.hit_points is not None:
            # Field-based HP systems: adopt the stored fields, falling back to
            # legacy slots (secondary/attribute copies), then the fresh default.
            current = _numeric_stat(data.get("hp_current")) if "hp_current" in data else None
            maximum = _numeric_stat(data.get("hp_max")) if "hp_max" in data else None
            if current is None:
                current = _numeric_stat(character.secondary_attributes.get(_SECONDARY_CURRENT_HP_KEY))
            if maximum is None:
                maximum = _numeric_stat(character.secondary_attributes.get(_SECONDARY_MAX_HP_KEY))
            if current is None:
                current = _numeric_stat(character.attributes.get(_ATTR_HP_KEY))
            if maximum is None:
                maximum = _numeric_stat(character.attributes.get(_ATTR_HPMAX_KEY))
            if current is None and maximum is None:
                current = int(spec.hit_points["current"])
                maximum = int(spec.hit_points["max"])
            elif maximum is None:
                maximum = current
            elif current is None:
                current = maximum
            set_hit_points(character, current=current, maximum=maximum, allow_raise_max=True)
        # Deliberately NO refresh here: from_dict is pure deserialization.
        # Readers never trust stored derived slots (`core.sheets.sheet_value`
        # recomputes), and refreshing before validation has clamped the source
        # attributes would wrongly squeeze current pools against garbage maxima.
        return character


class CharacterManager:
    """Character sheet domain service: document-backed CRUD, pack-driven
    generation, alias resolution and roster sync.

    M17 storage: each sheet is one `sheet` document, id = the character NAME
    (room-unique — the same identity the party roster always keyed on), with
    ``data.owner`` recording the controlling uid. The per-user active-character
    pointer and the party-roster display cache are room_state rows. The old
    per-user `characters.{chat}.{name}` KV rows are gone: a room's cast is one
    namespace, and importing/claiming flows set `owner` accordingly."""

    def __init__(self, store: Store) -> None:
        self.store = store
        from core.documents import DocumentStore

        self.documents = DocumentStore(store)

    async def get_character(self, user_id: str, chat_key: str, char_name: str = "") -> CharacterSheet:
        """Fetch a user's character sheet.

        `char_name` defaults to the caller's active character for this
        `chat_key` (falling back to the fixed slot `"default"` if none is
        set); a *genuinely absent* row returns a fresh `CharacterSheet` named
        `char_name` rather than raising (creation flows depend on this).

        A row that is present but unreadable (corrupt JSON / schema mismatch),
        or a store read that fails outright, raises `CharacterDataError` — it
        must NOT silently degrade to a blank sheet, or a subsequent save would
        wipe the real character. See `CharacterDataError`.
        """
        if not char_name:
            try:
                active_name = await self.store.state_get(chat_key, f"active_character.{user_id}")
                char_name = active_name if active_name else UNSET_CHARACTER_NAME
            except Exception:
                char_name = UNSET_CHARACTER_NAME

        try:
            doc = await self.documents.get(chat_key, "sheet", char_name)
        except Exception as exc:
            raise CharacterDataError(char_name) from exc

        if doc is None:
            # Document genuinely absent — return a fresh default sheet.
            return CharacterSheet(name=char_name)

        if doc.corrupt:
            # Document present but undecodable — refuse rather than fabricate a
            # blank sheet that a mutating caller would persist over the real one.
            raise CharacterDataError(char_name)
        try:
            return CharacterSheet.from_dict(doc.data)
        except Exception as exc:
            raise CharacterDataError(char_name) from exc

    async def _sheet_owner(self, chat_key: str, char_name: str) -> str:
        """The uid recorded on the stored sheet named `char_name` (`""` when the
        sheet is absent, unreadable, or carries no owner)."""
        try:
            doc = await self.documents.get(chat_key, "sheet", char_name)
        except Exception:
            return ""
        if doc is None:
            return ""
        owner = doc.data.get("owner")
        return owner if isinstance(owner, str) else ""

    async def save_character(
        self, user_id: str, chat_key: str, character: CharacterSheet, *, force: bool = False
    ) -> None:
        """Persist `character`, and make it the active character / add it to the
        user's character list / sync it into the party roster.

        Sheets are room-scoped documents keyed by the character NAME, so the name
        is the identity: writing one another player owns would destroy their
        sheet. Such a write raises `CharacterNameTakenError` and touches nothing —
        not the document, not the active-character pointer, not the roster.
        `force=True` is the administrative escape hatch that re-homes a sheet
        across uids deliberately.

        Derived slots refresh from the pack DAG before the write (never persist
        stale derived state); the current-pool clamp rides along.
        """
        if not force:
            owner = await self._sheet_owner(chat_key, character.name)
            if owner and owner != user_id:
                raise CharacterNameTakenError(character.name, owner)

        pack = _pack_for(character)
        if pack is not None:
            from core.sheets import refresh_sheet

            refresh_sheet(character, pack)
        character.last_updated = time.time()
        await self.documents.put(
            chat_key, "sheet", character.name, dict(character.to_dict(), owner=user_id)
        )

        await self.set_active_character(user_id, chat_key, character.name)
        await self.sync_party_roster(chat_key, character)

    async def sync_party_roster(
        self, chat_key: str, character: CharacterSheet, status_effects: list | None = None
    ) -> None:
        """Sync `character`'s status into the shared party roster (`party_roster.{chat_key}`)
        for the battle-status panel.

        The summary is pack-shaped: the declared resource meters plus the
        declared meta fields — no engine knowledge of any system's vitals.
        When `status_effects` is omitted (`None`), the character's previously
        recorded `status_effects` in the roster are preserved rather than
        cleared.
        """
        try:
            roster_data = await self.store.state_get(chat_key, "party_roster")
            roster = json.loads(roster_data) if roster_data else {}
        except Exception:
            roster = {}

        previous_status_effects = []
        if status_effects is None:
            previous = roster.get(character.name, {})
            previous_status_effects = previous.get("status_effects", []) if isinstance(previous, dict) else []
        effective_status_effects = status_effects if status_effects is not None else previous_status_effects

        status_summary: dict[str, Any] = {
            "name": character.name,
            "system": character.system,
            "resources": character_resources(character),
            "fields": {
                name: value
                for name, value in character.field_values().items()
                if value not in (None, "")
            },
            "status_effects": effective_status_effects,
            "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        if getattr(character, "avatar", None):
            status_summary["avatar"] = character.avatar
        roster[character.name] = status_summary
        try:
            await self.store.state_set(chat_key, "party_roster", json.dumps(roster, ensure_ascii=False))
        except Exception:
            pass

    async def get_party_roster(self, chat_key: str) -> list[dict[str, Any]]:
        try:
            roster_data = await self.store.state_get(chat_key, "party_roster")
            if roster_data:
                roster = json.loads(roster_data)
                return list(roster.values())
        except Exception:
            pass
        return []

    async def set_active_character(self, user_id: str, chat_key: str, char_name: str) -> None:
        await self.store.state_set(chat_key, f"active_character.{user_id}", char_name)

    async def list_characters(self, user_id: str, chat_key: str) -> list[dict[str, Any]]:
        """`user_id`'s characters in this room — the sheet documents whose ``owner``
        is them (the old separate per-user list row is derived state, gone)."""
        characters = []
        try:
            for doc in await self.documents.list(chat_key, "sheet"):
                if doc.data.get("owner") != user_id:
                    continue
                characters.append(
                    {
                        "name": doc.data.get("name", doc.id),
                        "system": doc.data.get("system", ""),
                        "last_updated": doc.data.get("last_updated", 0),
                    }
                )
        except Exception:
            pass
        return characters

    async def delete_character(
        self, user_id: str, chat_key: str, char_name: str, *, force: bool = False
    ) -> bool:
        """Delete `user_id`'s character `char_name`, returning whether it happened.

        A sheet owned by a DIFFERENT uid is refused (`False`) rather than deleted —
        the room-wide name key would otherwise let any member erase any other
        member's character. `force=True` is the administrative escape hatch.
        """
        if not force:
            owner = await self._sheet_owner(chat_key, char_name)
            if owner and owner != user_id:
                return False
        try:
            await self.documents.delete(chat_key, "sheet", char_name)
            if await self.store.state_get(chat_key, f"active_character.{user_id}") == char_name:
                await self.store.state_delete(chat_key, f"active_character.{user_id}")
            await self.remove_from_party_roster(chat_key, char_name)
            return True
        except Exception:
            return False

    async def remove_from_party_roster(self, chat_key: str, char_name: str) -> None:
        try:
            roster_data = await self.store.state_get(chat_key, "party_roster")
            roster = json.loads(roster_data) if roster_data else {}
            if char_name in roster:
                roster.pop(char_name, None)
                await self.store.state_set(chat_key, "party_roster", json.dumps(roster, ensure_ascii=False))
        except Exception:
            pass

    async def get_daily_luck(self, user_id: str) -> int:
        """Deterministic per-user, per-day "luck" value in `[1, 100]`, cached in the store."""
        today = datetime.now().strftime("%Y-%m-%d")
        store_key = f"daily_luck.{today}"

        try:
            luck_data = await self.store.get(user_key=user_id, store_key=store_key)
            if luck_data:
                return int(luck_data)
        except (ValueError, TypeError):
            pass

        hash_input = f"{user_id}_{today}"
        hash_value = int(hashlib.sha256(hash_input.encode()).hexdigest()[:8], 16)
        luck_value = (hash_value % 100) + 1  # 1-100

        await self.store.set(user_key=user_id, store_key=store_key, value=str(luck_value))
        return luck_value

    def generate_character(self, system: str, char_name: str | None = None) -> CharacterSheet:
        """Generate a new character sheet for `system`, rolling every attribute
        that declares a creation roll in the pack's ``creation_constraints``.

        `char_name` defaults to the localized `character.default_name` i18n
        key when not given, per the "CharacterSheet's own constructor default
        is not localized; callers resolve the display default" convention.
        """
        from core.dice_engine import DiceRoller
        from core.rulepacks import load_rulepack
        from core.sheets import refresh_sheet

        try:
            pack = load_rulepack(system)
        except Exception as exc:
            raise ValueError(t("character.unknown_template", template_name=system)) from exc

        character = CharacterSheet(name=char_name or t("character.default_name"), system=pack.system)
        roller = DiceRoller()
        attribute_rules = (pack.creation_constraints.get("attributes") or {})
        for key, rule in attribute_rules.items():
            expression = rule.get("roll") if isinstance(rule, dict) else None
            if expression:
                character.attributes[str(key)] = roller.roll_expression(str(expression)).total
        refresh_sheet(character, pack, initialize_vitals=True, preserve_trained=False)
        return character

    def find_skill_by_alias(self, character: CharacterSheet, skill_name: str) -> str | None:
        """Resolve `skill_name` to the sheet system's canonical name via the
        pack alias table (None when the pack doesn't know the name)."""
        pack = _pack_for(character)
        if pack is None:
            return None
        return pack.resolve_skill(skill_name)

    def get_skill_value(self, character: CharacterSheet, skill_name: str) -> int:
        """Skill value, resolving `skill_name` through its alias if needed."""
        pack = _pack_for(character)
        if pack is None:
            value = character.skills.get(skill_name, 0)
            return value if isinstance(value, int) else 0
        from core.sheets import sheet_value

        return sheet_value(character, pack, pack.resolve_skill(skill_name) or skill_name)

    def get_attribute_value(self, character: CharacterSheet, attr_name: str) -> int:
        """Attribute value, resolving `attr_name` through the pack alias table if
        it is not already a storage key."""
        if attr_name in character.attributes:
            value = character.attributes[attr_name]
            return value if isinstance(value, int) else 0
        pack = _pack_for(character)
        if pack is None:
            return 0
        from core.sheets import sheet_value

        canonical = pack.resolve_skill(attr_name)
        return sheet_value(character, pack, canonical) if canonical else 0


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="characters",
        owner="core.character_manager",
        reset_scope="chars",
        # Kept by `.reset story` on purpose: the same investigators replaying the same
        # module is the lightest reset's whole point.
        doc_types=frozenset({"sheet"}),
        state_keys=frozenset({"party_roster"}),
        state_prefixes=frozenset({"active_character."}),
        storages=frozenset({STORAGE_DOCUMENTS, STORAGE_ROOM_STATE}),
    ),
)
