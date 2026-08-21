"""The knowledge-scoped AI *player-companion* sub-actor (`docs/specs/M10-companions.md` §2).

Where `agent.npc_actor.voice_npc` voices a KEEPER-side NPC, `companion_action` voices a
PLAYER-side companion: a party member the AI plays to fill an empty seat. It is the exact same
information-isolation discipline one step over -- the companion's whole world is built from ONLY
its own `agent.npc.NpcRecord` (persona / playstyle / player-scoped `knowledge`) plus a summary of
its OWN `core.character_manager.CharacterSheet`. It NEVER receives the module keeper pool, another
character's private data, or any other room-wide state, so it structurally cannot metagame -- it
plays fair, acting only on what the party has actually discovered + its own backstory.

Iron rule (same as the NPC actor, and the project's dice-first discipline): the companion only
DECLARES an action + a line of dialogue, exactly as a player at the table would. It NEVER rolls its
own dice or invents world facts -- the Keeper resolves the declared action through the normal turn
pipeline (`gateway.director.run_companion_turn`), so a companion's `skill_check` is a REAL roll on
its REAL sheet, adjudicated by the KP.
"""

from __future__ import annotations

from dataclasses import replace

from agent.card_text import build_card_text_renderer
from agent.npc import NpcRecord
from agent.npc_actor import _extract_json_object, _knowledge_bullets
from agent.services import Services
from core.character_manager import CharacterSheet, character_resources
from core.rulepacks import load_rulepack
from infra.i18n import I18n
from infra.model_call_trace import lane_scope

# How many of the companion's highest-value skills to surface in its sheet summary, so the actor
# plays to its strengths without the prompt ballooning with every default-value skill.
_TOP_SKILLS = 8


def _sheet_summary(i18n: I18n, sheet: CharacterSheet) -> str:
    """A compact, player-safe recap of the companion's OWN sheet (resources/vitals,
    core attributes, and top skills).

    Built purely from `sheet`; nothing here consults the store or any keeper material.
    Generic over any pack (M16 stage B): vitals come from the pack-declared
    `resources` meters, and the attribute line orders by the pack's own sheet spec
    when the sheet's system resolves to one, else lists whatever attributes it has.
    """
    lines = [i18n.t("companion.sheet.name_line", name=sheet.name or i18n.t("common.unknown"), system=sheet.system)]
    attrs = sheet.attributes

    meters = character_resources(sheet)
    if meters:
        lines.append(
            i18n.t(
                "companion.sheet.status_line",
                meters=" | ".join(f"{meter['label']} {meter['value']}/{meter['max']}" for meter in meters),
            )
        )

    try:
        spec = load_rulepack(sheet.system).sheet_spec
    except Exception:
        spec = None
    keys = [key for key in spec.attributes if key in attrs] if spec is not None else list(attrs)
    if keys:
        lines.append(
            i18n.t(
                "companion.sheet.attributes_line",
                attributes=", ".join(f"{key} {attrs[key]}" for key in keys),
            )
        )

    top_skills = sorted(sheet.skills.items(), key=lambda item: item[1], reverse=True)[:_TOP_SKILLS]
    if top_skills:
        lines.append(i18n.t("companion.sheet.skills_header"))
        lines.extend(f"- {name}: {value}" for name, value in top_skills)
    return "\n".join(lines)


def _build_system_prompt(i18n: I18n, companion: NpcRecord, sheet: CharacterSheet) -> str:
    """Render the companion actor's system prompt from ONLY its own record + its own sheet.

    CRITICAL -- information isolation (same contract as `agent.npc_actor._build_system_prompt`):
    this is the one place the companion's whole world is assembled. Nothing outside `companion` and
    `sheet` is ever consulted here -- no keeper pool, no other character, no module/session truths.
    """
    return i18n.t(
        "companion.actor_system",
        name=companion.name,
        persona=companion.persona or i18n.t("companion.actor_system.no_persona"),
        playstyle=companion.playstyle or i18n.t("companion.actor_system.no_playstyle"),
        sheet_summary=_sheet_summary(i18n, sheet),
        knowledge=_knowledge_bullets(i18n, companion.knowledge),
    )


def _build_user_message(i18n: I18n, situation: str, recent: list[str]) -> str:
    parts: list[str] = []
    if recent:
        parts.append(i18n.t("companion.actor_user.recent_heading"))
        parts.extend(str(line) for line in recent)
        parts.append("")
    parts.append(situation or i18n.t("companion.actor_user.no_situation"))
    return "\n".join(parts)


async def companion_action(
    services: Services,
    companion: NpcRecord,
    sheet: CharacterSheet,
    situation: str,
    *,
    recent: list[str] | None = None,
    locale: str | None = None,
    chat_key: str | None = None,
    user_uid: str | None = None,
) -> dict[str, str]:
    """Voice ONE companion's turn. Returns `{"action": str, "dialogue": str}`.

    CRITICAL -- information isolation: the messages handed to `services.llm.chat` are built from
    `companion`'s own record + its own `sheet` ONLY (see `_build_system_prompt`). NEVER pass the
    keeper pool, another character's data, or any module/session state in here -- that is what makes
    the companion's fair-play guarantee structural rather than a prompt instruction the model could
    ignore.

    Model = `services.settings.llm.npc_model or services.settings.llm.chat_model` (companions reuse
    the NPC-actor model slot). The reply is parsed as JSON tolerantly (fenced or bare); on any parse
    failure the raw reply becomes the `action` (with empty `dialogue`), so a malformed response still
    reads as a stated action rather than surfacing a broken payload.

    `locale` MUST be the room's locale (`ctx.locale`); see `agent.npc_actor.voice_npc` for why the
    process default is the wrong thing to render this prompt in.

    `chat_key`/`user_uid` (M12 card compatibility): same contract as `voice_npc` -- card-derived
    record prose (EJS templates, `{{user}}`/`{{char}}` macros) is rendered here at consumption
    time via `agent.card_text.build_card_text_renderer`, against the PLAYER view of the room's
    variables only (iron rule #3), read-only. Omitting them still strips templates fail-safe.
    """
    i18n = services.i18n if locale is None else services.i18n.with_locale(locale)
    render = await build_card_text_renderer(services, chat_key, char_name=companion.name, user_uid=user_uid)
    # Render on a COPY -- the stored record keeps the raw authored text (see voice_npc).
    companion = replace(
        companion,
        persona=render(companion.persona),
        playstyle=render(companion.playstyle),
        knowledge=[render(fact) for fact in companion.knowledge],
    )
    system_prompt = _build_system_prompt(i18n, companion, sheet)
    user_message = _build_user_message(i18n, situation, recent or [])
    model = services.settings.llm.npc_model or services.settings.llm.chat_model

    with lane_scope("companion", chat_key=chat_key, companion=companion.id):
        result = await services.llm.chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            model=model,
        )

    content = result.content or ""
    parsed = _extract_json_object(content)
    if parsed is None:
        return {"action": content.strip(), "dialogue": ""}

    return {
        "action": str(parsed.get("action") or "").strip(),
        "dialogue": str(parsed.get("dialogue") or "").strip(),
    }
