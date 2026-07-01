"""Build the WebSocket `state` frame's payload for one room (M4 spec §1).

`build_room_state` is a read-only snapshot: the caller's own active
character, the shared party roster, the game clock, the initiative order
and the current scene. Every piece is independently optional — a
brand-new room has none of them yet — so a missing/unset piece is simply
left out of the returned dict (or reduced to an empty list for
`party`/`initiative`) instead of raising, letting
`net.tui_server.TuiServer` call this unconditionally on join and after
every turn.

`online` is left at `0` here: a room's live connection count (and which
party members are currently connected) is `TuiServer`'s concern, not this
module's — the server overlays the real numbers before broadcasting.
"""

from __future__ import annotations

import json
from typing import Any

from agent.context import AgentCtx
from agent.services import Services
from core.character_manager import CharacterSheet

_COC_SYSTEM = "CoC"
_DND_CURRENT_HP_KEY = "生命值"
_UNSET_CHARACTER_NAME = "default"


async def build_room_state(services: Services, ctx: AgentCtx) -> dict[str, Any]:
    """Assemble one `state` frame's payload (including `type`) for `ctx`'s room."""
    party = await _party(services, ctx.chat_key)
    initiative = await _initiative(services, ctx.chat_key)
    initiative_by_name = {entry["name"]: entry["value"] for entry in initiative}

    sheet = await _active_character(services, ctx)
    active_name = sheet.name if sheet is not None else ""
    for member in party:
        member["active"] = bool(active_name) and member["name"] == active_name
        if member["name"] in initiative_by_name:
            member["initiative"] = initiative_by_name[member["name"]]

    state: dict[str, Any] = {"type": "state", "party": party, "initiative": initiative, "online": 0}

    if sheet is not None:
        state["character"] = await _character_payload(services, ctx.chat_key, sheet)

    scene = await _scene(services, ctx.chat_key)
    if scene is not None:
        state["scene"] = scene

    clock = await _clock(services, ctx.chat_key)
    if clock is not None:
        state["clock"] = clock

    return state


async def _active_character(services: Services, ctx: AgentCtx) -> CharacterSheet | None:
    try:
        sheet = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    except Exception:
        return None
    if not sheet or not sheet.name or sheet.name == _UNSET_CHARACTER_NAME:
        return None
    return sheet


async def _character_payload(services: Services, chat_key: str, sheet: CharacterSheet) -> dict[str, Any]:
    attrs = sheet.attributes
    if sheet.system == _COC_SYSTEM:
        hp, hpmax = attrs.get("HP"), attrs.get("HPMAX")
        mp, mpmax = attrs.get("MP"), attrs.get("MPMAX")
        san, sanmax = attrs.get("SAN"), attrs.get("SANMAX")
    else:
        hp = sheet.secondary_attributes.get(_DND_CURRENT_HP_KEY)
        hpmax, mp, mpmax, san, sanmax = hp, None, None, None, None

    status_effects: list[Any] = []
    try:
        roster = await services.characters.get_party_roster(chat_key)
        member = next((item for item in roster if item.get("name") == sheet.name), None)
        if member:
            status_effects = list(member.get("status_effects") or [])
    except Exception:
        pass

    return {
        "name": sheet.name,
        "system": sheet.system,
        "hp": hp,
        "hpmax": hpmax,
        "mp": mp,
        "mpmax": mpmax,
        "san": san,
        "sanmax": sanmax,
        "attributes": dict(attrs),
        "status_effects": status_effects,
    }


async def _party(services: Services, chat_key: str) -> list[dict[str, Any]]:
    try:
        roster = await services.characters.get_party_roster(chat_key)
    except Exception:
        return []
    companion_names = await _companion_sheet_names(services, chat_key)
    return [
        {
            "name": member.get("name", ""),
            "online": True,
            "active": False,
            # M10: tag AI-companion party members so clients can render an "AI" badge.
            "ai": member.get("name", "") in companion_names,
        }
        for member in roster
    ]


async def _companion_sheet_names(services: Services, chat_key: str) -> set[str]:
    """Character-sheet names belonging to AI player companions in this room (best-effort, may be empty)."""
    try:
        from agent.npc import NpcManager

        records = await NpcManager(services.store).list_companions(chat_key)
    except Exception:
        return set()
    return {record.stat_char or record.name for record in records}


async def _initiative(services: Services, chat_key: str) -> list[dict[str, Any]]:
    try:
        raw = await services.store.get(user_key="", store_key=f"initiative.{chat_key}")
        entries = json.loads(raw) if raw else []
    except Exception:
        return []
    if not isinstance(entries, list):
        return []
    return [
        {"name": entry.get("name", ""), "value": entry.get("init", 0), "current": index == 0}
        for index, entry in enumerate(entries)
        if isinstance(entry, dict)
    ]


async def _scene(services: Services, chat_key: str) -> dict[str, Any] | None:
    try:
        raw = await services.store.get(user_key="", store_key=f"kp_notes.{chat_key}")
        notes = json.loads(raw) if raw else {}
    except Exception:
        notes = {}

    name = notes.get("current_scene") if isinstance(notes, dict) else None
    if name:
        scene: dict[str, Any] = {"name": name}
        focus = notes.get("current_focus")
        if focus:
            scene["focus"] = focus
        return scene

    try:
        raw = await services.store.get(user_key="", store_key=f"module_player_pool.{chat_key}")
        pool = json.loads(raw) if raw else {}
    except Exception:
        pool = {}

    scenes = pool.get("scenes") if isinstance(pool, dict) else None
    if scenes:
        first = scenes[0]
        scene = {"name": first.get("name", "")}
        if first.get("focus"):
            scene["focus"] = first["focus"]
        return scene
    return None


async def _clock(services: Services, chat_key: str) -> dict[str, Any] | None:
    try:
        raw = await services.store.get(user_key="", store_key=f"game_clock.{chat_key}")
        clock = json.loads(raw) if raw else {}
    except Exception:
        clock = {}

    time_value = clock.get("current_time") if isinstance(clock, dict) else None
    return {"time": time_value} if time_value else None
