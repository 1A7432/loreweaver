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

`load_hook_state` / `apply_hook_state_writes` are the same two halves for the hook-PRIVATE
state store (`getstate`/`setstate`): one `room_state` row per key under `HOOK_STATE_PREFIX`,
validated by `core.hooks.plan_state_writes`, and deliberately outside the variable space —
no prompt section, no wire frame, no `variables_changed`, no `KPTurnResult.hook_writes`.
Both are plain per-room functions taking the turn's engine, so any dispatch site — a turn
phase today, a mid-turn tool dispatch tomorrow — loads and applies through the same path.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agent.context import AgentCtx
from agent.services import Services
from core.hooks import (
    HookEngine,
    HookOutcome,
    HookScript,
    create_hook_engine,
    decode_state_value,
    plan_state_writes,
    valid_state_key,
)
from core.modvars import load_modvars, set_modvar
from core.mvu_compat import apply_set, load_mvu, save_mvu
from core.skills import load_skill
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet

logger = logging.getLogger(__name__)

ROOM_HOOKS_CAP = 16

# One room_state row per hook-private state key: `hook_state:<key>` → compact JSON. Per-key
# rows so a small write never rewrites the rest, and so undo snapshots, export/import and the
# reset facet below carry it like every other room_state row with no code of their own.
HOOK_STATE_PREFIX = "hook_state:"

# The room's PLAYER-invokable module actions as the last engine built for the room saw them
# (protocol 2.6 `state.actions`): a state frame must not have to build a QuickJS engine to
# list them. A JSON list of `core.hooks.ActionSpec.manifest_entry()`; absent/"" = none.
ACTION_MANIFEST_KEY = "hook_action_manifest"
# Lanes whose engine build refreshes the manifest. The Scribe's veto engine runs outside the
# turn lock and sees the same scripts, so it never writes room state of its own.
_MANIFEST_LANES = frozenset({"hooks", "command"})


async def load_room_hook_engine(
    services: Services,
    ctx: AgentCtx,
    *,
    turn: int | None = None,
    lane: str = "hooks",
    ordinal_offset: int = 0,
    require_event: str | None = None,
) -> HookEngine | None:
    """Build this turn's hook engine, or `None` (hooks inert) when nothing is registered,
    the `ejs` extra is missing, or `enable_full_ejs` is off (that switch governs hooks and
    full EJS only — rules scripts and prep scripts do not read it). Best-effort throughout —
    never raises into the turn.

    `turn` is the turn in flight for `event.seed` — by default the same counter
    `agent.prompt_builder.turn_rng`'s caller uses (completed turns + 1); a lane that runs
    after the turn completed (the Scribe) passes the turn it is about. `lane` keeps two
    engines of one turn from drawing the same seeds; `ordinal_offset` starts its seed
    ordinals elsewhere than 0 (the `.act` lane's persisted counter).

    Every build on the turn and command lanes also refreshes the room's cached player-action
    manifest (`ACTION_MANIFEST_KEY`) — cleared when hooks are off or nothing registered.

    `require_event` skips the build (returns `None`) when no script's source contains that
    event name literally — a caller that will only ever fire one event (the Scribe's `tool_use`
    veto) need not pay for an engine no handler of that event can live in. Handlers register
    with `on("tool_use", …)`; a name assembled at runtime would defeat the check, which is why
    the docs ask for the literal."""
    engine = await _build_room_hook_engine(
        services, ctx, turn=turn, lane=lane, ordinal_offset=ordinal_offset, require_event=require_event
    )
    if lane in _MANIFEST_LANES:
        await store_action_manifest(services, ctx.chat_key, engine)
    return engine


async def _build_room_hook_engine(
    services: Services,
    ctx: AgentCtx,
    *,
    turn: int | None,
    lane: str,
    ordinal_offset: int,
    require_event: str | None = None,
) -> HookEngine | None:
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
        if require_event is not None and not any(require_event in script.code for script in scripts):
            return None

        modvar_state = await load_modvars(services.documents, ctx.chat_key)
        mvu_tree = await load_mvu(services.documents, ctx.chat_key)
        state = await load_hook_state(services, ctx.chat_key)
        if turn is None:
            from agent.chronicle import chronicle_turn

            turn = await chronicle_turn(services.store, ctx.chat_key) + 1
        engine = create_hook_engine(
            scripts,
            flat_variables=modvar_state["values"],
            tree=mvu_tree,
            state=state,
            room=ctx.chat_key,
            turn=turn,
            lane=lane,
            ordinal_offset=ordinal_offset,
        )
        if engine is not None and engine.load_warnings:
            logger.warning("hook script load warnings for %s: %s", ctx.chat_key, engine.load_warnings)
        return engine
    except Exception:
        logger.warning("hook engine load failed, hooks inert this turn", exc_info=True)
        return None


async def store_action_manifest(services: Services, chat_key: str, engine: HookEngine | None) -> None:
    """Cache the room's player-invokable actions for `state` frames. Writes only on change;
    never raises (a stale list is a cosmetic fault, a raise would cost the turn)."""
    try:
        entries = [spec.manifest_entry() for spec in (engine.actions if engine is not None else ()) if spec.player]
        text = json.dumps(entries, ensure_ascii=False, separators=(",", ":")) if entries else ""
        if (await services.store.state_get(chat_key, ACTION_MANIFEST_KEY) or "") != text:
            await services.store.state_set(chat_key, ACTION_MANIFEST_KEY, text)
    except Exception:  # noqa: BLE001 — see docstring
        logger.warning("player-action manifest refresh failed for %s", chat_key, exc_info=True)


async def load_action_manifest(services: Services, chat_key: str) -> list[dict[str, Any]]:
    """The cached player-action manifest (see `store_action_manifest`); [] when none/corrupt."""
    try:
        raw = await services.store.state_get(chat_key, ACTION_MANIFEST_KEY)
        entries = json.loads(raw) if raw else []
    except Exception:  # noqa: BLE001 — a corrupt cache reads as "no actions"
        return []
    return [entry for entry in entries if isinstance(entry, dict) and isinstance(entry.get("id"), str)] if isinstance(entries, list) else []


def manifest_label(entry: dict[str, Any], locale: str) -> str:
    """A manifest entry's label for `locale` (zh* → zh, else en), then a plain-string label,
    then any label, then the action id — the same rule as `core.hooks.ActionSpec.label_for`."""
    labels = entry.get("labels") if isinstance(entry.get("labels"), dict) else {}
    wanted = "zh" if str(locale or "").casefold().startswith("zh") else "en"
    for key in (wanted, "*", "en", "zh"):
        if isinstance(labels.get(key), str) and labels[key]:
            return labels[key]
    return str(entry.get("id", ""))


async def refresh_action_manifest(services: Services, chat_key: str) -> None:
    """Rebuild the room's engine once just to refresh the manifest — after a hook install or a
    skill toggle, so a client's action list follows without waiting for the next turn."""
    await load_room_hook_engine(services, AgentCtx(chat_key=chat_key), lane="command")


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
    await refresh_action_manifest(services, chat_key)
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


async def _read_hook_state(services: Services, chat_key: str) -> dict[str, Any]:
    """The room's hook-private state, key → value. Raises only on a store failure: a row
    with a bad key or an undecodable value is skipped (logged) — "key absent"."""
    state: dict[str, Any] = {}
    for row in await services.store.state_list(chat_key, prefix=HOOK_STATE_PREFIX):
        key = str(row.get("key") or "")[len(HOOK_STATE_PREFIX):]
        value = decode_state_value(row.get("value"))
        if not valid_state_key(key) or value is None:
            logger.warning("hook state row %r in %s is unusable; treated as absent", row.get("key"), chat_key)
            continue
        state[key] = value
    return state


async def load_hook_state(services: Services, chat_key: str) -> dict[str, Any]:
    """The room's hook-private state snapshot for a new `HookEngine`. Never raises: a store
    failure means a turn whose hooks start with no state, not a broken turn."""
    try:
        return await _read_hook_state(services, chat_key)
    except Exception:  # noqa: BLE001 — hooks never break a turn
        logger.warning("hook state load failed for %s; hooks see no state this turn", chat_key, exc_info=True)
        return {}


async def refresh_hook_views(
    services: Services, chat_key: str, engine: HookEngine | None, *, variables: bool = False
) -> None:
    """Reset the engine's sandbox views to the store: the hook-private state always, the
    variable snapshots too when `variables` (a module action must see mid-turn Keeper-tool
    writes). The store is authoritative — hooks are the state's only writer, but a nested
    companion turn runs hooks on an engine of its own — so each phase starts from what is
    persisted. Never raises: on a store failure the view the engine already has stays."""
    if engine is None:
        return
    try:
        state = await _read_hook_state(services, chat_key)
    except Exception:  # noqa: BLE001 — hooks never break a turn
        logger.warning("hook state refresh failed for %s; keeping the current view", chat_key, exc_info=True)
    else:
        engine.sync_state(state)
    if variables:
        try:
            modvar_state = await load_modvars(services.documents, chat_key)
            tree = await load_mvu(services.documents, chat_key)
        except Exception:  # noqa: BLE001 — hooks never break a turn
            logger.warning("hook variable refresh failed for %s; keeping the current view", chat_key, exc_info=True)
        else:
            engine.refresh_variables(modvar_state["values"], tree)


async def apply_hook_state_writes(
    services: Services, chat_key: str, engine: HookEngine | None, outcome: HookOutcome
) -> list[str]:
    """Persist one dispatch's buffered `setstate` writes; return the keys that were applied.

    Validation is `core.hooks.plan_state_writes` over the state AS STORED (not the engine's
    snapshot), so the caps hold across every dispatch of the turn. Refused writes and the
    sandbox-side refusals are logged as hook warnings. Afterwards the engine's sandbox view is
    reset to what was persisted, so a refused write stops being visible to later handlers.
    Never raises — on a store failure nothing is claimed applied and the view is re-read."""
    warnings = list(outcome.state_warnings)
    applied: list[str] = []
    if outcome.state_writes:
        try:
            current = await _read_hook_state(services, chat_key)
            plan = plan_state_writes(current, outcome.state_writes)
            warnings += plan.warnings
            if plan.deletes:
                await services.store.state_delete_keys(
                    chat_key, keys=[HOOK_STATE_PREFIX + key for key in plan.deletes]
                )
            for key, text in plan.upserts.items():
                await services.store.state_set(chat_key, HOOK_STATE_PREFIX + key, text)
            applied = plan.applied
            if engine is not None:
                engine.sync_state(plan.state)
        except Exception:  # noqa: BLE001 — hooks never break a turn
            logger.warning("hook state writes failed for %s", chat_key, exc_info=True)
            applied = []
            if engine is not None:
                engine.sync_state(await load_hook_state(services, chat_key))
    if warnings:
        logger.warning("hook state warnings for %s: %s", chat_key, warnings)
    return applied


# The turn-indexed ring of what hooks actually injected (M23 WS3). Kept small: it exists
# so a turn's prompt can be RECONSTRUCTED, and the reconstructable window is the one undo,
# join replay and playtest forensics work in.
INJECTION_RING_KEY = "hook_injections"
INJECTION_RING_TURNS = 20


async def record_hook_injections(
    services: Services, chat_key: str, turn: int, injections: list[str]
) -> None:
    """Persist, in FULL, what this turn's hooks injected into the prompt. Never raises.

    `hooks.js` inject() texts used to reach the model from process memory alone: the loop
    stashed them on `ctx.extra` and the prompt builder read them there, so nothing about
    the prompt the model actually saw survived the turn. Undo replay, join replay,
    playtest forensics and the behavioural evals were all silently missing a segment.

    Full text rather than a digest (owner 2026-08-13): the volume is trivial next to the
    prompt these texts already ride in, and a hash tells a forensic reader that something
    was injected without telling them what. Best-effort — a side record that raised would
    cost the turn it exists to document.

    Write-only on purpose. Nothing in the engine reads it back: the prompt still consumes
    the injections from `ctx.extra` exactly as before, and this row exists so that a turn
    can be reconstructed AFTERWARDS — by a person, an eval or a forensic tool. A reader
    lands here the day some code path needs one, not before.
    """
    texts = [text for text in injections if isinstance(text, str) and text.strip()]
    if not texts:
        return
    try:
        raw = await services.store.state_get(chat_key, INJECTION_RING_KEY)
        ring = json.loads(raw) if raw else []
        if not isinstance(ring, list):
            ring = []
    except (json.JSONDecodeError, TypeError):
        ring = []
    ring = [item for item in ring if isinstance(item, dict) and item.get("turn") != turn]
    ring.append({"turn": int(turn), "texts": texts})
    ring = ring[-INJECTION_RING_TURNS:]
    try:
        await services.store.state_set(chat_key, INJECTION_RING_KEY, json.dumps(ring, ensure_ascii=False))
    except Exception:  # noqa: BLE001 — see docstring
        logger.warning("hook injection side record failed for %s turn %s", chat_key, turn, exc_info=True)


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
    RoomStateFacet(
        name="hook_injection_ring",
        owner="agent.hook_runtime",
        reset_scope="story",
        # A forensic record of what the MODEL saw, turn by turn: session state, and it goes
        # when the session does. It is not the hooks themselves (those are module state,
        # above) — a fresh session re-runs the same hooks and writes its own ring.
        state_keys=frozenset({INJECTION_RING_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
    RoomStateFacet(
        name="hook_state",
        owner="agent.hook_runtime",
        reset_scope="all",
        # The hooks' private `setstate` store is module machinery in the same sense as the
        # variable space it stands beside: it dies at exactly the scope that kills the module
        # variables (`core.modvars`) and the MVU tree (`core.mvu_compat`). A lighter reset
        # keeps both, so a hook never finds its own machinery out of step with the trackers
        # it drives — mirroring is the whole rule; if those two ever move, this moves with
        # them. It is ordinary room_state, so undo snapshots and export/import carry it with
        # no code here.
        state_prefixes=frozenset({HOOK_STATE_PREFIX}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
    RoomStateFacet(
        name="hook_action_manifest",
        owner="agent.hook_runtime",
        reset_scope="all",
        # A derived cache of what the room's scripts register — mostly the card-installed
        # `room_hooks`, which die at `all`, so the cache dies with them. It is rebuilt by the
        # next engine build (every Keeper turn, every `.act`, a hook install, a skill toggle);
        # until then a client lists fewer actions, never actions that cannot run.
        state_keys=frozenset({ACTION_MANIFEST_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
