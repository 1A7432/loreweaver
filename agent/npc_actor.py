"""The knowledge-scoped NPC sub-actor (`docs/specs/M5.md` §3) -- the piece that makes
anti-metagaming *structural* rather than a prompt-pleading request.

`voice_npc` drives ONE NPC's in-character turn via a nested LLM call whose entire context is built
from that single `agent.npc.NpcRecord` -- its own persona/style/secret_agenda/knowledge/disposition
-- plus the situation text and light hints (`allowed_actions`/`tone`/`target`/`recent`) the KP tool
layer (`agent.kp_tools_npc.NpcTools.speak_as_npc`) passes in. It NEVER receives the keeper pool,
another NPC's record, or any other room-wide state, so it structurally cannot leak or act on
information this NPC doesn't have -- there is simply nothing in its prompt TO leak.

Iron rule (matches the project's "dice-first"/deterministic-vs-generative discipline): the actor
only PERFORMS (dialogue + action intent + mood). It never rolls dice or invents world facts; the KP
and the deterministic core adjudicate all mechanics/consequences from its output, exactly as they
would from a player's stated action.
"""

from __future__ import annotations

import json
import re
from typing import Any

from agent.npc import NpcRecord
from agent.services import Services
from infra.i18n import I18n

_CODE_FENCE_PREFIX_RE = re.compile(r"^```[a-zA-Z]*\s*")
_CODE_FENCE_SUFFIX_RE = re.compile(r"\s*```$")


def _extract_json_object(content: str) -> dict[str, Any] | None:
    """Tolerant best-effort JSON-object extraction (fenced or bare; leading/trailing prose tolerated).

    Returns `None` (never raises) when no JSON object can be recovered -- `voice_npc` then falls back
    to treating the raw content as the dialogue itself.
    """
    text = _CODE_FENCE_SUFFIX_RE.sub("", _CODE_FENCE_PREFIX_RE.sub("", content.strip())).strip()

    candidates = [text]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidates.append(text[start : end + 1])

    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _knowledge_bullets(i18n: I18n, knowledge: list[str]) -> str:
    facts = [fact.strip() for fact in knowledge if fact and fact.strip()]
    if not facts:
        return i18n.t("npc.actor_system.no_knowledge")
    return "\n".join(f"- {fact}" for fact in facts)


def _build_system_prompt(i18n: I18n, npc: NpcRecord, allowed_actions: str) -> str:
    """Render the sub-actor's system prompt from ONLY `npc`'s own fields.

    CRITICAL -- information isolation: this is the one place the sub-actor's whole world gets built.
    Nothing outside this single `NpcRecord` (no keeper pool, no other NPC, no module/session state) is
    ever consulted here -- see the module docstring.
    """
    allowed_clause = (
        i18n.t("npc.actor_system.allowed_actions_clause", allowed_actions=allowed_actions)
        if allowed_actions.strip()
        else ""
    )
    return i18n.t(
        "npc.actor_system",
        name=npc.name,
        persona=npc.persona or i18n.t("npc.actor_system.no_persona"),
        style=npc.style or i18n.t("npc.actor_system.no_style"),
        secret_agenda=npc.secret_agenda or i18n.t("npc.actor_system.no_secret_agenda"),
        knowledge=_knowledge_bullets(i18n, npc.knowledge),
        disposition=npc.disposition or "neutral",
        allowed_actions_clause=allowed_clause,
    )


def _build_user_message(i18n: I18n, situation: str, tone: str, target: str, recent: list[str]) -> str:
    parts: list[str] = []
    if recent:
        parts.append(i18n.t("npc.actor_user.recent_heading"))
        parts.extend(str(line) for line in recent)
        parts.append("")
    parts.append(situation)
    if tone.strip():
        parts.append(i18n.t("npc.actor_user.tone_line", tone=tone))
    if target.strip():
        parts.append(i18n.t("npc.actor_user.target_line", target=target))
    return "\n".join(parts)


async def voice_npc(
    services: Services,
    npc: NpcRecord,
    situation: str,
    *,
    allowed_actions: str = "",
    tone: str = "",
    target: str = "",
    recent: list[str] | None = None,
) -> dict[str, str]:
    """Voice ONE NPC's turn. Returns `{"dialogue": str, "action_intent": str, "mood": str}`.

    CRITICAL -- information isolation: the messages handed to `services.llm.chat` are built from
    `npc`'s own record plus the caller-supplied situation/hints ONLY (see `_build_system_prompt`).
    NEVER pass the keeper pool, another NPC's record, or any other module/session state into this
    function -- that is what makes the anti-metagaming guarantee structural rather than a prompt
    instruction the model could ignore.

    Model = `services.settings.llm.npc_model or services.settings.llm.chat_model` (the config
    addition this spec makes). The reply is parsed as JSON tolerantly (fenced or bare); on any parse
    failure the raw reply becomes `dialogue` with `action_intent`/`mood` left empty, so a malformed
    response still reads as in-character speech rather than surfacing a broken payload.
    """
    i18n = services.i18n
    system_prompt = _build_system_prompt(i18n, npc, allowed_actions)
    user_message = _build_user_message(i18n, situation, tone, target, recent or [])
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
        return {"dialogue": content, "action_intent": "", "mood": ""}

    dialogue = parsed.get("dialogue")
    return {
        "dialogue": str(dialogue) if dialogue is not None else content,
        "action_intent": str(parsed.get("action_intent") or ""),
        "mood": str(parsed.get("mood") or ""),
    }
