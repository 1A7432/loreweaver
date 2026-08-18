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
from core.character_manager import CharacterSheet, character_resources, resource_label_map
from core.documents import KEEPER_VIEWER, MODULE_POOL_ID, MVU_ID, PLAYER_VIEWER, SCENE_ID
from core.modvars import MODVARS_DOC_ID, MODVARS_DOC_TYPE, wire_entries
from infra.usage_stats import USAGE_STATS_KEY

_UNSET_CHARACTER_NAME = "default"


async def build_room_state(services: Services, ctx: AgentCtx) -> dict[str, Any]:
    """Assemble one `state` frame's payload (including `type`) for `ctx`'s room."""
    sheet = await resolve_active_character(services, ctx)
    party = await _party(services, ctx.chat_key, locale=ctx.locale)
    initiative = await _initiative(services, ctx.chat_key)
    initiative_by_name = {entry["name"]: entry["value"] for entry in initiative}

    active_name = sheet.name if sheet is not None else ""
    for member in party:
        member["active"] = bool(active_name) and member["name"] == active_name
        if member["name"] in initiative_by_name:
            member["initiative"] = initiative_by_name[member["name"]]

    state: dict[str, Any] = {"type": "state", "party": party, "initiative": initiative, "online": 0}

    if sheet is not None:
        state["character"] = await _character_payload(services, ctx.chat_key, sheet, ctx.locale)

    scene = await _scene(services, ctx.chat_key)
    if scene is not None:
        state["scene"] = scene

    clock = await _clock(services, ctx.chat_key)
    combat_round = await _combat_round(services, ctx.chat_key)
    if combat_round is not None:
        clock = clock or {"time": ""}
        clock["round"] = combat_round
    if clock is not None:
        state["clock"] = clock

    usage = await _usage(services, ctx.chat_key)
    if usage is not None:
        state["usage"] = usage

    variables = await _variables(services, ctx)
    if variables:
        state["variables"] = variables

    pregens = await _pregens(services, ctx.chat_key)
    if pregens:
        state["pregens"] = pregens

    systems = _rule_systems()
    if systems:
        state["systems"] = systems

    return state


def _rule_systems() -> list[dict[str, str]]:
    """Every discoverable rule system, with the command word that makes a character in it.

    What a client needs to offer "create a character" WITHOUT knowing any rule system:
    the id to name and the dialect word to send. A pack that ships its own system
    therefore appears in every client's picker with no client release — the same reason
    resolution, sheets and commands are pack data (iron rule #1). Nothing secret rides
    here: the install banner prints the packs and `.help` prints their command words.

    A system with no `make_char` binding still lists (it can be imported into); it simply
    carries no word to create with. Both lookups are cached in `core.rulepacks`, so
    rebuilding this on every state snapshot costs a dict walk.

    The word advertised is one that ROUTES BACK to this pack. An `extends:` pack inherits
    its base's whole `commands:` table (base first, then its own — `_merge_extends`), and
    dispatch (`pack_declaring_command`) gives an inherited word to the base pack, so
    `.coc` on a `coc7-antu` row would create a plain CoC7 sheet. Only the pack's own word
    (`antu`) is its entry point; a patch that declares none has no way to create in it,
    and says so by carrying no `make_char` rather than the base's.
    """
    from core.rulepacks import available_systems, load_rulepack, pack_declaring_command

    entries: list[dict[str, str]] = []
    for system in available_systems():
        try:
            pack = load_rulepack(system)
        except Exception:
            continue  # a pack that will not load cannot be offered; the doctor reports it
        entry = {"id": pack.system}
        # Declaration order, so a pack that declares several words picks its own primary.
        for word, binding in pack.commands.items():
            if binding.action != "make_char":
                continue
            maker = pack_declaring_command(word, "make_char")
            if maker is not None and maker.system == pack.system:
                entry["make_char"] = word
                break
        entries.append(entry)
    return entries


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


async def _character_payload(
    services: Services, chat_key: str, sheet: CharacterSheet, locale: str | None = None
) -> dict[str, Any]:
    """Protocol 2.0: vitals ride a generic ``resources`` list ({id,label,value,max})
    instead of per-system field names — a client renders meters without knowing
    any rule system. The sheet layer declares its own resources (M16 stage B:
    `core.character_manager.character_resources`, pack-driven); the WIRE shape
    is final. Labels resolve to ``locale`` here, at the per-viewer boundary (M19)."""
    attrs = _wire_attributes(sheet)
    resources = character_resources(sheet, locale)

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
        "resources": resources,
        "attributes": attrs,
        "status_effects": status_effects,
    }
    avatar = getattr(sheet, "avatar", None)
    if isinstance(avatar, dict):
        payload["avatar"] = avatar
    return payload


def _wire_attributes(sheet: CharacterSheet) -> dict[str, Any]:
    """`state.character.attributes`: the sheet's CHARACTERISTICS, in the pack's order.

    The stored attributes dict also carries what the sheet layer writes beside them —
    the vitals (`HP`/`SAN`/`MP` and their maxima) and derived values (`IDEA`, `KNOW`,
    …). Those are not attributes to a table: the vitals ride `resources` as meters, and
    a derived value is computed, not owned. Sending them here forced every client to
    know, per system, which keys to hide and how to order the rest — the TUI kept a
    CoC table and a D&D table for exactly that. So the wire carries the keys the pack's
    `sheet.attributes` declares, in declaration order; a pack that declares none (a
    system with no sheet spec) sends the dict as stored, since nothing else can say
    what it means.
    """
    from core.rulepacks import load_rulepack

    stored = dict(sheet.attributes)
    try:
        spec = load_rulepack(sheet.system).sheet_spec
        declared = list(spec.attributes.keys()) if spec is not None else []
    except Exception:
        declared = []
    if not declared:
        return stored
    return {key: stored[key] for key in declared if key in stored}


async def _party(
    services: Services,
    chat_key: str,
    *,
    locale: str | None = None,
) -> list[dict[str, Any]]:
    """The room's whole roster, every member with their own meters.

    Mixed-system rooms are real (a module's `extends:` rulepack is a different system
    from the base it patches, and a keeper on one and a player on the other share a
    table), and nothing about the wire needs the members to agree: `resources` is the
    generic ``{id,label,value,max}`` list, its labels resolve from EACH member's own pack
    (``label_maps`` is keyed by the member's system), and every client renders one
    member's bars from that member's list alone. So no member is dropped for their
    system, and none loses their meters for it — a d20 sheet's HP bar beside a CoC
    sheet's HP/MP/SAN bars is exactly what that table looks like.
    """
    try:
        roster = await services.characters.get_party_roster(chat_key)
    except Exception:
        return []
    companion_names = await _companion_sheet_names(services, chat_key)
    label_maps: dict[str, dict[str, str]] = {}
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
        system = str(member.get("system", "") or "")
        if system not in label_maps:
            label_maps[system] = resource_label_map(system, locale)
        resources = _party_member_resources(member, label_maps[system])
        if resources:
            payload["resources"] = resources
        members.append(payload)
    return members


def _party_member_resources(member: dict[str, Any], labels: dict[str, str]) -> list[dict[str, Any]]:
    """Protocol 2.0 party vitals: the same generic ``resources`` list shape as
    ``state.character`` -- read straight off the roster entry. M17:
    `CharacterManager.sync_party_roster` already stores the pack-declared
    meter list (`core.character_manager.character_resources`) verbatim; this
    only validates the wire shape survived the JSON round-trip.

    M19: the STORED label froze whatever locale was current when the roster was
    synced, so ``labels`` (this viewer's, from the member's own system) wins when it
    knows the id; the stored string stays the fallback for a system that no longer
    resolves to a pack."""
    resources: list[dict[str, Any]] = []
    for entry in member.get("resources") or []:
        if not isinstance(entry, dict):
            continue
        res_id, label = entry.get("id"), entry.get("label")
        if not res_id or not label:
            continue
        value = _int_value(entry.get("value"))
        maximum = _int_value(entry.get("max"))
        if value is None or maximum is None:
            continue
        resources.append({"id": res_id, "label": labels.get(res_id, label), "value": value, "max": maximum})
    return resources


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


async def _companion_sheet_names(services: Services, chat_key: str) -> set[str]:
    """Character-sheet names belonging to AI player companions in this room (best-effort, may be empty)."""
    try:
        from agent.npc import list_companions

        records = await list_companions(services.documents, chat_key)
    except Exception:
        return set()
    return {record.stat_char or record.name for record in records}


async def _initiative(services: Services, chat_key: str) -> list[dict[str, Any]]:
    try:
        raw = await services.store.state_get(chat_key, "initiative")
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
    """The `scene` singleton document (all-viewer projection), falling back to
    the module pool's first PLAYER-visible scene for rooms the keeper hasn't
    scened yet."""
    try:
        view = await services.documents.get_view(chat_key, "scene", SCENE_ID, PLAYER_VIEWER)
    except Exception:
        view = None
    name = (view or {}).get("name")
    if name:
        scene: dict[str, Any] = {"name": name}
        focus = (view or {}).get("focus")
        if focus:
            scene["focus"] = focus
        return scene

    try:
        pool = await services.documents.get_view(chat_key, "module_pool", MODULE_POOL_ID, PLAYER_VIEWER)
    except Exception:
        pool = None

    scenes = (pool or {}).get("scenes")
    if scenes:
        first = scenes[0]
        scene = {"name": first.get("name", "")}
        if first.get("focus"):
            scene["focus"] = first["focus"]
        return scene
    return None


async def _clock(services: Services, chat_key: str) -> dict[str, Any] | None:
    try:
        raw = await services.store.state_get(chat_key, "game_clock")
        clock = json.loads(raw) if raw else {}
    except Exception:
        clock = {}

    time_value = clock.get("current_time") if isinstance(clock, dict) else None
    return {"time": time_value} if time_value else None


async def _combat_round(services: Services, chat_key: str) -> int | None:
    try:
        raw = await services.store.state_get(chat_key, "initiative_meta")
        meta = json.loads(raw) if raw else {}
        value = int(meta.get("round", 0)) if isinstance(meta, dict) else 0
    except Exception:
        return None
    return value if value > 0 else None


_MVU_PANEL_CAP = 32
_KEEPER_ROLE = "keeper"
# The single-operator platform set (mirrors `gateway.commands._AUTO_MASTER_PLATFORMS`): a
# `--cli` session is the box's owner running their own table, keeper by construction.
_LOCAL_OPERATOR_PLATFORMS = {"cli"}


def _viewer_is_keeper(ctx: AgentCtx) -> bool:
    """Whether THIS state frame's recipient is the keeper: the local operator platform, or a
    connection whose keystore-authenticated role was threaded into ``ctx.extra["role"]`` by
    `gateway.turn.publish_state` (networked members) / `net.session._ctx_for` (commands)."""
    if ctx.platform in _LOCAL_OPERATOR_PLATFORMS:
        return True
    extra = ctx.extra if isinstance(ctx.extra, dict) else {}
    return extra.get("role") == _KEEPER_ROLE


async def _variables(services: Services, ctx: AgentCtx) -> list[dict[str, Any]]:
    """Module variables for THIS viewer (state frames are built per member), on one wire shape.

    Both sources are consumed as DOCUMENT PROJECTIONS — the one structural
    visibility discipline (iron rule #3, fail-closed):

    - the `modvars` document's PLAYER projection drops keeper-only trackers spec and
      value, so no state frame — any viewer, any transport — ever carries them (the
      panel deliberately shows the player set even to the keeper; keeper-only values
      live in the keeper's prompt, not the HUD);
    - the `mvu_tree` document's player projection ships ONLY keeper-exposed leaves
      (`.var expose <prefix>`); the keeper projection carries every leaf tagged with
      its exposure, so a keeper viewer sees the unexposed remainder flagged
      ``"hidden": true`` and can watch their module's internals live.

    Empty (→ field omitted) when the room has neither; best-effort like every other piece of
    this snapshot.
    """
    try:
        modvar_view = await services.documents.get_view(
            ctx.chat_key, MODVARS_DOC_TYPE, MODVARS_DOC_ID, PLAYER_VIEWER
        )
        entries = wire_entries(modvar_view or {}, ctx.locale)
    except Exception:
        entries = []
    try:
        keeper_view = _viewer_is_keeper(ctx)
        viewer = KEEPER_VIEWER if keeper_view else PLAYER_VIEWER
        mvu_view = await services.documents.get_view(ctx.chat_key, "mvu_tree", MVU_ID, viewer)
        # The projection already filtered a player's leaves (fail-closed) and tagged the
        # keeper's with per-leaf exposure; the panel cap applies to what the viewer SEES.
        shown = 0
        for leaf in (mvu_view or {}).get("leaves", []):
            if shown >= _MVU_PANEL_CAP:
                break
            value = leaf["value"]
            if isinstance(value, bool):
                kind = "bool"
            elif isinstance(value, (int, float)):
                kind = "number"
            elif isinstance(value, str):
                kind = "text"
            else:
                continue  # nested/list leaves are prompt-side detail, not panel material
            entry: dict[str, Any] = {"id": f"mvu.{leaf['path']}", "label": leaf["path"], "kind": kind, "value": value}
            if keeper_view and not leaf.get("exposed", False):
                entry["hidden"] = True
            entries.append(entry)
            shown += 1
    except Exception:
        pass
    return entries


async def _pregens(services: Services, chat_key: str) -> list[dict[str, Any]]:
    """The claimable pregen cast, v1.9 additive: one ``{name, claimed_by}`` per entry,
    insertion-ordered, consumed from the `pregen` documents' PLAYER projection (the cast
    list is table talk; the pristine sheet payload is what the projection withholds).
    Omitted (never an empty list) for roster-less rooms. Best-effort like the rest of
    this snapshot."""
    try:
        pairs = await services.documents.list_views(chat_key, "pregen", PLAYER_VIEWER)
    except Exception:
        return []
    return [
        {"name": str(view.get("name", "")), "claimed_by": str(view.get("claimed_by", ""))}
        for _doc, view in pairs
        if view.get("name")
    ]


async def _usage(services: Services, chat_key: str) -> dict[str, Any] | None:
    """The room's rolling token/cache usage aggregate (`infra.usage_stats.record_usage_stats`
    writes it), translated to the wire's snake_case shape -- `None` when unset (a
    brand-new room, or one that has never completed a real AI-KP turn), so
    `build_room_state` leaves `state.usage` out entirely rather than sending zeros.

    The stored `last` block also records whether its `prompt` figure was MEASURED by
    the provider or ESTIMATED by `agent.loop` (an endpoint that reports no usage on a
    streamed turn). That flag deliberately does NOT cross the wire: describing it
    would be an additive protocol field, and the version bump that entitles one is a
    heavier, owner-facing change than the meter warrants. Nothing is lost by keeping
    it server-side — the only consumer that ACTS on the number is the chronicle fold,
    which reads the stored payload directly. What the HUD renders is a fullness
    percentage, and it was already an approximation in both sources: the meter is the
    previous turn's prompt, and the denominator is a table lookup. Before this, a
    streaming room had NO usage block at all; an approximate meter is what it gains.
    The `session` totals stay measured-only, so a room whose provider never reports
    honestly shows a context figure with zero cumulative tokens beside it.
    """
    try:
        raw = await services.store.state_get(chat_key, USAGE_STATS_KEY)
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
