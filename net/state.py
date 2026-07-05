"""Build the WebSocket `state` frame's payload for one room (M4 spec §1).

`build_room_state` is a read-only snapshot: the caller's own active
character, the shared party roster, the game clock, the initiative order,
the current scene, and the room's rolling LLM token/cache usage. Every piece
is independently optional — a brand-new room has none of them yet — so a
missing/unset piece is simply left out of the returned dict (or reduced to
an empty list for `party`/`initiative`) instead of raising, letting
`net.tui_server.TuiServer` call this unconditionally on join and after
every turn.

`online` is left at `0` here: a room's live connection count (and which
party members are currently connected) is `TuiServer`'s concern, not this
module's — the server overlays the real numbers before broadcasting.

`resolve_active_character` (below) is the single, canonical "what character is
this caller playing right now" lookup: `gateway.turn._display_name` (the turn
echo's actor name) reuses it too, rather than re-implementing the same
lookup + `"default"`-sentinel fallback a second time, so the echoed actor name
and this module's `state.character` can never diverge on the same caller.
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

    sheet = await resolve_active_character(services, ctx)
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

    usage = await _usage(services, ctx.chat_key)
    if usage is not None:
        state["usage"] = usage

    return state


async def resolve_active_character(services: Services, ctx: AgentCtx) -> CharacterSheet | None:
    """`ctx.uid()`'s active character for `ctx.chat_key`, or `None` when unset.

    `CharacterManager.get_character` never raises for "no character" — it
    defaults the unresolved active-character pointer to the fixed sentinel
    slot name `"default"` and returns a fresh, unsaved sheet for it — so
    "unset" here means: the lookup itself failed (best-effort — treated the
    same as unset), or the resolved sheet is that `"default"` sentinel.
    """
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

    payload = {
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
    avatar = getattr(sheet, "avatar", None)
    if isinstance(avatar, dict):
        payload["avatar"] = avatar
    return payload


async def _party(services: Services, chat_key: str) -> list[dict[str, Any]]:
    try:
        roster = await services.characters.get_party_roster(chat_key)
    except Exception:
        return []
    companion_names = await _companion_sheet_names(services, chat_key)
    members: list[dict[str, Any]] = []
    for member in roster:
        payload = {
            "name": member.get("name", ""),
            "online": True,
            "active": False,
            # M10: tag AI-companion party members so clients can render an "AI" badge.
            "ai": member.get("name", "") in companion_names,
        }
        avatar = member.get("avatar")
        if isinstance(avatar, dict):
            payload["avatar"] = avatar
        payload.update(_party_member_vitals(member))
        members.append(payload)
    return members


def _party_member_vitals(member: dict[str, Any]) -> dict[str, int]:
    vitals: dict[str, int] = {}
    for value_key, max_key, legacy_key in (
        ("hp", "hpMax", "HP"),
        ("san", "sanMax", "SAN"),
        ("mp", "mpMax", "MP"),
    ):
        value = _int_value(member.get(value_key))
        max_value = _int_value(member.get(max_key))
        if value is None or max_value is None:
            legacy_value, legacy_max = _parse_legacy_vital(member.get(legacy_key))
            value = value if value is not None else legacy_value
            max_value = max_value if max_value is not None else legacy_max
        if value is not None and max_value is not None:
            vitals[value_key] = value
            vitals[max_key] = max_value
    return vitals


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _parse_legacy_vital(value: Any) -> tuple[int | None, int | None]:
    if not isinstance(value, str):
        return (None, None)
    current, separator, maximum = value.partition("/")
    current_value = _int_value(current.strip())
    if current_value is None:
        return (None, None)
    if not separator:
        return (current_value, current_value)
    max_value = _int_value(maximum.strip())
    return (current_value, max_value)


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


async def _usage(services: Services, chat_key: str) -> dict[str, Any] | None:
    """The room's rolling token/cache usage aggregate (`gateway.turn._record_usage_stats`
    writes it), translated to the wire's snake_case shape -- `None` when unset (a
    brand-new room, or one that has never completed a real AI-KP turn), so
    `build_room_state` leaves `state.usage` out entirely rather than sending zeros.
    """
    try:
        raw = await services.store.get(user_key="", store_key=f"usage_stats.{chat_key}")
        stats = json.loads(raw) if raw else {}
    except Exception:
        stats = {}

    if not isinstance(stats, dict) or not stats:
        return None

    last = stats.get("last")
    last = last if isinstance(last, dict) else {}
    session = stats.get("session")
    session = session if isinstance(session, dict) else {}

    return {
        "context_tokens": last.get("prompt", 0),
        "context_window": last.get("context_window", 0),
        "input_tokens": session.get("prompt", 0),
        "output_tokens": session.get("completion", 0),
        "cache_hit_tokens": session.get("cache_hit", 0),
        "cache_miss_tokens": session.get("cache_miss", 0),
    }
