"""Room-level loading and effect application for the event-hook layer (`core.hooks`).

`load_room_hook_engine` collects a room's registered hook scripts — every enabled skill's
`hooks.js` plus any card-installed scripts under the room_state ``room_hooks`` row — and builds one
sandboxed `HookEngine` per turn over the room's variable snapshots (KEEPER view: hooks are
module logic, the same trust tier as the Keeper prompt; what they choose to `narrate()` is
authorial output, exactly like lore text).

`apply_hook_writes` is the deterministic half of the contract: buffered `setvar` writes route
through validation — a name matching a declared module variable goes through
`core.modvars.set_modvar` (kind/bounds enforced), anything else lands in the MVU tree
via `core.mvu_compat.apply_set`. A failing write is skipped and reported, never fatal.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agent.context import AgentCtx
from agent.services import Services
from core.hooks import HookEngine, HookScript, create_hook_engine
from core.modvars import load_modvars, set_modvar
from core.mvu_compat import apply_set, load_mvu, save_mvu
from core.skills import load_skill
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet

logger = logging.getLogger(__name__)

ROOM_HOOKS_CAP = 16


async def load_room_hook_engine(services: Services, ctx: AgentCtx) -> HookEngine | None:
    """Build this turn's hook engine, or `None` (hooks inert) when nothing is registered,
    the `ejs` extra is missing, or `enable_full_ejs` is off (one switch governs every
    sandboxed-JS surface). Best-effort throughout — never raises into the turn."""
    if not services.settings.enable_full_ejs:
        return None
    try:
        scripts: list[HookScript] = []
        raw = await services.store.state_get(ctx.chat_key, "skills_enabled")
        skill_ids = []
        if raw:
            try:
                loaded = json.loads(raw)
                skill_ids = loaded if isinstance(loaded, list) else []
            except (json.JSONDecodeError, TypeError):
                skill_ids = []
        for skill_id in skill_ids:
            skill = load_skill(str(skill_id))
            if skill is not None and skill.hooks.strip():
                scripts.append(HookScript(source_id=f"skill:{skill.id}", code=skill.hooks))
        scripts.extend(await _room_scripts(services, ctx.chat_key))
        if not scripts:
            return None

        modvar_state = await load_modvars(services.documents, ctx.chat_key)
        mvu_tree = await load_mvu(services.documents, ctx.chat_key)
        engine = create_hook_engine(scripts, flat_variables=modvar_state["values"], tree=mvu_tree)
        if engine is not None and engine.load_warnings:
            logger.warning("hook script load warnings for %s: %s", ctx.chat_key, engine.load_warnings)
        return engine
    except Exception:
        logger.warning("hook engine load failed, hooks inert this turn", exc_info=True)
        return None


async def _room_scripts(services: Services, chat_key: str) -> list[HookScript]:
    raw = await services.store.state_get(chat_key, "room_hooks")
    if not raw:
        return []
    try:
        entries = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(entries, list):
        return []
    scripts = []
    for entry in entries[:ROOM_HOOKS_CAP]:
        if isinstance(entry, dict) and isinstance(entry.get("code"), str) and entry["code"].strip():
            scripts.append(HookScript(source_id=str(entry.get("id") or "room"), code=entry["code"]))
    return scripts


async def install_room_hooks(services: Services, chat_key: str, source_id: str, codes: list[str]) -> int:
    """Register card-shipped hook scripts for a room (idempotent per source: re-import replaces
    that source's scripts rather than stacking duplicates). Returns how many are installed."""
    existing = await _room_scripts(services, chat_key)
    kept = [script for script in existing if not script.source_id.startswith(f"{source_id}#")]
    for index, code in enumerate(codes):
        if isinstance(code, str) and code.strip():
            kept.append(HookScript(source_id=f"{source_id}#{index}", code=code))
    payload = [{"id": script.source_id, "code": script.code} for script in kept[:ROOM_HOOKS_CAP]]
    await services.store.state_set(chat_key, "room_hooks", json.dumps(payload, ensure_ascii=False))
    return len(payload)


async def apply_hook_writes(services: Services, chat_key: str, writes: list[tuple[str, Any]]) -> list[str]:
    """Apply buffered hook writes through validation; returns the list of applied paths."""
    if not writes:
        return []
    applied: list[str] = []
    modvar_state = await load_modvars(services.documents, chat_key)
    tree = await load_mvu(services.documents, chat_key)
    tree_dirty = False
    for name, value in writes:
        try:
            if name in modvar_state["specs"]:
                await set_modvar(services.documents, chat_key, name, value)
            else:
                tree = apply_set(tree, name, value)
                tree_dirty = True
            applied.append(name)
        except (ValueError, TypeError):
            continue
    if tree_dirty:
        await save_mvu(services.documents, chat_key, tree)
    return applied


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="room_hooks",
        owner="agent.hook_runtime",
        reset_scope="all",
        # Card-installed turn-lifecycle handlers arrive with a world import and leave with
        # it; a hook outliving its module would inject into a room that never loaded it.
        state_keys=frozenset({"room_hooks"}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
