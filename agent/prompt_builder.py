"""Assembles the AI-KP system prompt for one turn from the 6 ``core.prompt_sections``
section builders.

Per the M1 spec (``docs/specs/M1.md`` §6.4), the 6 sections are called in a
fixed order — session history, game state, document/knowledge-pool context,
system-specific expertise, TRPG-system identity, interaction style — and
joined with a blank line between every NON-empty section (a section that
legitimately has nothing to say, e.g. no prior session, is simply omitted
rather than leaving a stray blank block). Immediately after session history a
rolling "story so far" recap of the CURRENT session
(``inject_session_recap_prompt``) is folded in, so the KP keeps concrete facts
established earlier this session even after they scroll out of the loop's
~20-message replay window; it too is omitted until the first recap exists.
``i18n`` is rebound to ``ctx.locale`` so the whole prompt renders in the
caller's locale for this turn, independent of the process-wide default locale.

Whenever an initialized module knowledge pool exists,
``inject_document_context_prompt`` folds in the localized keeper-secrecy
discipline block (``prompt.keeper_discipline``) instructing the KP that
keeper-only material is for its own reasoning only and must never be quoted
to players; that instruction rides along automatically as part of this
assembly, it needs no special handling here.

After the 6 sections, any KP skills (Layer B.1 — ``docs/plugins.md`` "Layer B")
enabled for this room are folded in LAST, so they read as the final/strongest
directive. This module reads the room's enabled-skill ids DIRECTLY off the
store (never importing ``gateway.ops`` — that would invert the layering; only
``core.skills`` is imported, which is below `agent`), tolerating a
missing/corrupt flag the same way ``gateway.ops.get_enabled_skills`` does. A
room with no skills enabled contributes nothing, so its prompt stays
byte-identical to a build with no skills layer at all.

Finally, current deterministic relationship tracks (``core.relationships`` —
好感/情欲, see iron rule #1: the values are real code, only the narration
around them is the model's job) are folded in as the last section, read
straight off the store the same inline way as the skills block above (never
importing ``agent.kp_tools_relationships`` or ``gateway``). A chat with no
relationship state set contributes nothing, so its prompt stays byte-identical
to a build from before this section existed.

Module variables (``core.modvars`` — the same iron-rule-#1 split: validated,
clamped, persisted values the model only narrates around) follow the same
pattern right after the relationships section: the Keeper sees EVERY variable,
with keeper-only ones carrying a localized never-reveal tag (iron rule #3 —
the transport-side filter in ``net.state`` is the structural guarantee; this
tag is the behavioral one). A room with no variables contributes nothing.
"""

from __future__ import annotations

import json
import random

from agent.context import AgentCtx
from agent.services import Services
from core.dice_engine import DiceRoller
from core.ejs_full import create_full_engine
from core.ejs_lite import MacroContext
from core.modvars import describe_modvars, load_modvars
from core.mvu_compat import apply_set, flatten_leaves, load_mvu, save_mvu
from core.preset import style_segments
from core.preset_store import load_preset
from core.prompt_sections import (
    inject_document_context_prompt,
    inject_game_state_prompt,
    inject_interaction_style_prompt,
    inject_session_history_prompt,
    inject_session_recap_prompt,
    inject_system_expertise_prompt,
    inject_trpg_system_prompt,
)
from core.relationships import RelationshipManager
from core.skills import load_skill
from core.varspace import build_resolver
from core.worldbook import inject_world_lore_prompt


async def build_system_prompt(ctx: AgentCtx, services: Services) -> str:
    """Build the full AI-KP system prompt for `ctx`'s current turn.

    Calls the `core.prompt_sections` builders in the exact order the M1 spec
    requires, folds in the M11 world-lore section (retrieved against the recent
    narrative/history, `role="keeper"` so the KP — and only the KP — also sees
    secret lore), and joins every non-empty result with `"\\n\\n"`.
    """
    i18n = services.i18n.with_locale(ctx.locale)

    session_history = await inject_session_history_prompt(ctx, services.battles, i18n)
    # Rolling "story so far" memory of THIS session — keeps the KP coherent over
    # hundreds of turns, past the loop's ~20-message replay window.
    session_recap = await inject_session_recap_prompt(ctx, services.store, i18n)
    document_context = await inject_document_context_prompt(
        ctx, services.vector_db, services.store, i18n, services.settings.enable_vector_db
    )
    # World lore grounds the KP in the reusable world beneath this adventure; the recent
    # narrative + this turn's user message (when threaded via ctx.extra) is the retrieval context.
    extra = getattr(ctx, "extra", {}) or {}
    recent_context = "\n".join(part for part in (session_history, str(extra.get("user_message", "") or "")) if part)
    # One state load serves every conditioned/templated worldbook entry this turn: the closed
    # expression grammar resolves through `core.varspace`, and (when the `ejs` extra is
    # installed and enabled) one per-turn QuickJS sandbox runs full-EJS content against the
    # same snapshots. Template setvar() writes buffer in the engine and flush to the MVU tree
    # right after the lore section renders, so the variable sections below show post-template
    # state — the ST "evaluate at generate time" contract.
    modvar_state = await load_modvars(services.documents, ctx.chat_key)
    mvu_tree = await load_mvu(services.documents, ctx.chat_key)
    variable_resolver = build_resolver(modvar_state["values"], mvu_tree)
    engine = None
    if services.settings.enable_full_ejs:
        room_entries = await services.worldbook.list(ctx.chat_key)
        engine = create_full_engine(
            flat_variables=modvar_state["values"],
            tree=mvu_tree,
            worldinfo={entry.title: entry.content for entry in room_entries},
        )
    macros = await _build_macro_context(services, ctx)
    world_lore = await inject_world_lore_prompt(
        ctx,
        services.worldbook,
        i18n,
        role="keeper",
        recent_context=recent_context,
        resolve=variable_resolver,
        engine=engine,
        macros=macros,
        advance_timers=True,  # the once-per-turn injection path drives sticky/cooldown/delay
        # Keeper-turn injection budget, tuned for imported module cards: their rule/timeline
        # entries are constant (a keeper world import preserves the flag) and a handful run
        # 2-5KB each, so the browse-path default (8 entries / 4000 chars) starves the module.
        # Oversized protocol/teaching blocks (10KB+) still stay out — `_cap_entries` skips
        # anything that alone exceeds the budget, which also keeps ST JSONPatch tutors from
        # steering the model off the engine's `_.set` wire.
        limit=12,
        budget_chars=12_000,
    )
    if engine is not None:
        mvu_tree = await _flush_template_writes(services, ctx.chat_key, engine, mvu_tree)

    # Card-imported module rooms (`.import … world`) have no knowledge pool, so the pool
    # section's keeper_discipline / module_fidelity blocks never fired for them — the
    # model ran whole imported modules with NEITHER block in context (2026-08-05 round-3
    # root cause: every discipline clause silently inapplicable). Fold both blocks in
    # ahead of the lore they govern — but ONLY for rooms that actually loaded a module
    # (the `world_import` marker the keeper's `.import … world` persists). A free-sandbox
    # room whose keeper `.lore add`ed a few setting notes gets plain lore, no
    # run-the-module directives: improvisation is the job there.
    if world_lore:
        world_imported = await services.store.state_get(ctx.chat_key, "world_import")
        if world_imported:
            discipline = i18n.t("prompt.keeper_discipline")
            if discipline not in document_context:
                world_lore = "\n\n".join([discipline, i18n.t("prompt.module_fidelity"), world_lore])

    sections = [
        session_history,
        session_recap,
        await inject_game_state_prompt(ctx, services.characters, services.store, i18n),
        document_context,
        world_lore,
        await inject_system_expertise_prompt(ctx, services.characters, i18n),
        await inject_trpg_system_prompt(ctx, i18n),
        await inject_interaction_style_prompt(ctx, i18n),
    ]

    # Imported-preset style layer (`.preset enable <id>`): folded right after the six
    # sections so keeper-enabled skills (below) still read as the stronger directive.
    # One bounded section — iron rule #5 (single prompt injection) stays intact: the
    # preset shapes style/framework, structurally after (never inside) the state and
    # secrecy sections above.
    preset_section = await _enabled_preset_section(ctx, services, i18n)
    if preset_section:
        sections.append(preset_section)

    # Event-hook inject() texts for THIS turn (Layer C — agent.hook_runtime stashes them on
    # ctx.extra before this build; consumed per turn, never persisted).
    hook_injections = [text for text in (extra.get("hook_injections") or []) if isinstance(text, str)]
    if hook_injections:
        sections.append(i18n.t("prompt.hooks_header") + "\n" + "\n".join(hook_injections))

    skill_bodies = await _enabled_skill_bodies(ctx, services)
    if skill_bodies:
        sections.append(i18n.t("prompt.skills_header") + "\n\n" + "\n\n".join(skill_bodies))

    relationship_lines = await RelationshipManager(services.store).describe(ctx.chat_key, i18n)
    if relationship_lines:
        sections.append(i18n.t("prompt.relationships_header") + "\n" + "\n".join(relationship_lines))

    modvar_lines = await describe_modvars(services.documents, ctx.chat_key, i18n, ctx.locale)
    if modvar_lines:
        sections.append(i18n.t("prompt.modvars_header") + "\n" + "\n".join(f"- {line}" for line in modvar_lines))

    # Imported MVU card variables (core.mvu_compat) — same fold-in pattern: the Keeper sees the
    # current tree every turn (post-template-writes — see above) and updates it via
    # set_stat/adjust_stat (or the card's own UpdateVariable protocol, which agent.loop applies
    # deterministically on the way out).
    mvu_leaves = flatten_leaves(mvu_tree, 100)
    if mvu_leaves:
        leaf_lines = "\n".join(f"- {leaf['path']} = {leaf['value']}" for leaf in mvu_leaves)
        sections.append(i18n.t("prompt.mvu_header") + "\n" + leaf_lines)

    return "\n\n".join(section for section in sections if section)


async def _build_macro_context(services: Services, ctx: AgentCtx) -> MacroContext:
    """The per-turn ST-native macro context: `{{user}}` = the caller's active PC name (the
    `"default"` sentinel means unset — mirrors `net.state.resolve_active_character` without
    importing `net`), `{{time}}`/`{{date}}` = the GAME clock, `{{roll:...}}` = the real dice
    engine (iron rule #2), `{{random/pick:...}}` = real code randomness. `{{char}}` is bound
    statically at card import, so it is deliberately absent here. Best-effort throughout."""
    names: dict[str, str] = {}
    try:
        sheet = await services.characters.get_character(ctx.uid(), ctx.chat_key)
        if sheet is not None and sheet.name and sheet.name != "default":
            names["user"] = sheet.name
    except Exception:
        pass
    clock_time = ""
    try:
        raw = await services.store.state_get(ctx.chat_key, "game_clock")
        clock = json.loads(raw) if raw else {}
        if isinstance(clock, dict):
            clock_time = str(clock.get("current_time") or "")
    except Exception:
        pass
    roller = DiceRoller()

    def _roll(expression: str) -> str:
        return str(roller.roll_expression(expression).total)

    return MacroContext(names=names, clock_time=clock_time, rng=random.Random(), roll=_roll)


async def _flush_template_writes(services: Services, chat_key: str, engine, mvu_tree: dict) -> dict:
    """Apply the full-EJS engine's buffered template `setvar` writes to the MVU tree through
    `core.mvu_compat.apply_set` (tolerant per write — one bad path never blocks the rest),
    persist once, and return the updated tree. A template with no writes is a no-op."""
    writes = engine.pending_writes
    if not writes:
        return mvu_tree
    for path, value in writes:
        try:
            mvu_tree = apply_set(mvu_tree, path, value)
        except (ValueError, TypeError):
            continue
    await save_mvu(services.documents, chat_key, mvu_tree)
    return mvu_tree


async def _enabled_preset_section(ctx: AgentCtx, services: Services, i18n) -> str:
    """The imported-preset style layer for this room, or ``""``.

    Reads the ``preset_enabled`` room_state flag inline off the store (the same
    layering rule as the skills block below: never import ``gateway.ops``), loads the
    preset via `core.preset_store.load_preset`, and joins the non-marker text runs of
    `core.preset.style_segments` (v0 marker policy: markers are boundaries only — the
    finer marker→section mapping can land once real presets demand it; the fold is
    already size-capped inside ``style_segments``). Contributes nothing when no preset
    is enabled or the file is missing/broken — a bad preset never breaks a turn."""
    try:
        raw = await services.store.state_get(ctx.chat_key, "preset_enabled")
    except Exception:
        return ""
    preset_id = str(raw or "").strip()
    if not preset_id:
        return ""
    preset = load_preset(services.settings.data_dir, preset_id)
    if preset is None:
        return ""
    texts = [text for slot, text in style_segments(preset) if slot is None and text]
    if not texts:
        return ""
    return i18n.t("prompt.preset_header") + "\n\n" + "\n\n".join(texts)


async def _enabled_skill_bodies(ctx: AgentCtx, services: Services) -> list[str]:
    """Markdown bodies of every KP skill enabled for `ctx.chat_key`'s room, in
    enablement order. Reads the store flag inline (see module docstring) rather
    than importing `gateway.ops.get_enabled_skills`; an unknown skill id (already
    removed from `skills/`) is silently skipped via `load_skill` returning `None`.
    """
    raw = await services.store.state_get(ctx.chat_key, "skills_enabled")
    if not raw:
        return []
    try:
        skill_ids = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(skill_ids, list):
        return []

    bodies = []
    for skill_id in skill_ids:
        skill = load_skill(str(skill_id))
        if skill is not None:
            bodies.append(skill.body)
    return bodies
