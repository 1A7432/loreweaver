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
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import Services
from core.prompt_sections import (
    inject_document_context_prompt,
    inject_game_state_prompt,
    inject_interaction_style_prompt,
    inject_session_history_prompt,
    inject_session_recap_prompt,
    inject_system_expertise_prompt,
    inject_trpg_system_prompt,
)
from core.skills import load_skill
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
    world_lore = await inject_world_lore_prompt(
        ctx, services.worldbook, i18n, role="keeper", recent_context=recent_context
    )

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

    skill_bodies = await _enabled_skill_bodies(ctx, services)
    if skill_bodies:
        sections.append(i18n.t("prompt.skills_header") + "\n\n" + "\n\n".join(skill_bodies))

    return "\n\n".join(section for section in sections if section)


async def _enabled_skill_bodies(ctx: AgentCtx, services: Services) -> list[str]:
    """Markdown bodies of every KP skill enabled for `ctx.chat_key`'s room, in
    enablement order. Reads the store flag inline (see module docstring) rather
    than importing `gateway.ops.get_enabled_skills`; an unknown skill id (already
    removed from `skills/`) is silently skipped via `load_skill` returning `None`.
    """
    raw = await services.store.get(store_key=f"skills_enabled.{ctx.chat_key}")
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
