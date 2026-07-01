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

from agent.npc import NpcRecord
from agent.npc_actor import _extract_json_object, _knowledge_bullets
from agent.services import Services
from core.character_manager import CharacterSheet
from infra.i18n import I18n

# How many of the companion's highest-value skills to surface in its sheet summary, so the actor
# plays to its strengths without the prompt ballooning with every default-value skill.
_TOP_SKILLS = 8


def _sheet_summary(i18n: I18n, sheet: CharacterSheet) -> str:
    """A compact, player-safe recap of the companion's OWN sheet (stats/HP/SAN + top skills).

    Built purely from `sheet`; nothing here consults the store or any keeper material.
    """
    lines = [i18n.t("companion.sheet.name_line", name=sheet.name or i18n.t("common.unknown"), system=sheet.system)]
    attrs = sheet.attributes

    if sheet.system == "CoC":
        lines.append(
            i18n.t(
                "companion.sheet.coc_status",
                hp=attrs.get("HP", "?"),
                hpmax=attrs.get("HPMAX", "?"),
                san=attrs.get("SAN", "?"),
                sanmax=attrs.get("SANMAX", "?"),
                mp=attrs.get("MP", "?"),
                mpmax=attrs.get("MPMAX", "?"),
            )
        )
        core_attrs = [attr for attr in ("STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC") if attr in attrs]
        if core_attrs:
            lines.append(
                i18n.t(
                    "companion.sheet.attributes_line",
                    attributes=", ".join(f"{attr} {attrs[attr]}" for attr in core_attrs),
                )
            )
    elif attrs:
        lines.append(
            i18n.t("companion.sheet.attributes_line", attributes=", ".join(f"{k} {v}" for k, v in attrs.items()))
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
    """
    i18n = services.i18n
    system_prompt = _build_system_prompt(i18n, companion, sheet)
    user_message = _build_user_message(i18n, situation, recent or [])
    model = services.settings.llm.npc_model or services.settings.llm.chat_model

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
