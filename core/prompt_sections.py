"""System-prompt section builders for the AI Keeper/DM.

Ported from ``nekro_trpg_dice_plugin``'s ``core/prompt_injection.py`` per the
M0 spec (``docs/specs/M0.md`` §5) and the M1 spec (``docs/specs/M1.md``
§6.4). The 6 ``inject_*`` functions are ``@mount_prompt_inject_method``
NekroPlugin callbacks in the source; here they are **plain async
functions** with no decorators, so ``agent/prompt_builder.py`` (M1) can call
them directly and in a fixed order.

Decoupling: these functions never import ``core.character_manager`` or
``core.battle_report``. ``character_manager``, ``store``, ``vector_db`` and
``battle_report_manager`` are received as injected, duck-typed parameters
(tests pass minimal inline fakes) — this module only depends on the async
method *shapes* documented alongside each function below.

i18n: every fixed piece of framing text (section headers, tool-usage
rules, narrative-style guidance, the keeper-secrecy discipline block) is
looked up via ``i18n.t("prompt.*")`` — see ``locales/{en,zh}/prompt.json``.
The one sanctioned exception is ``summarize_knowledge_item``: it formats
*game data* pulled from the module knowledge pool (scene/timeline/truth
entries), and the test suite asserts its exact Chinese literal glue
("焦点:", "位置:", "指向:", "SAN损失:", "条目", "；" separators) byte-for-byte,
so those stay as literals rather than i18n keys (M0 spec §5). Internal data
*keys* used purely as storage/lookup conventions (e.g. the ``"default"``
sentinel character name, the ``"开局"`` opening-fact time tag, or
``CharacterSheet.secondary_attributes``'s ``"护甲等级"`` key) are likewise
left untouched — they are not user-visible text, they are the data schema.
"""

from __future__ import annotations

import json
from typing import Any

from infra.i18n import I18n
from infra.store import Store

# Document-type -> emoji used when rendering vector-search fallback results.
# Purely a decorative icon lookup keyed by an internal (English) data tag,
# not natural-language text, so it is not routed through i18n.
_DOCUMENT_TYPE_EMOJI = {
    "module": "\U0001F4D8",  # 📘
    "rule": "\U0001F4DC",  # 📜
    "story": "\U0001F4D6",  # 📖
    "background": "\U0001F30D",  # 🌍
}
_DEFAULT_DOCUMENT_EMOJI = "\U0001F4C4"  # 📄


def summarize_knowledge_item(item: Any) -> str:
    """Compress a knowledge-pool entry (scene/npc/clue/timeline/truth/...) into one summary line.

    Ported byte-for-byte from the source's ``_summarize_knowledge_item``.
    This formats *game data*, not UI framing text, so its glue literals are
    the sanctioned exception to the "no hardcoded strings" rule — see the
    module docstring and M0 spec §5.
    """
    if not isinstance(item, dict):
        return str(item)

    title = item.get("name") or item.get("title") or item.get("time") or item.get("event") or "条目"
    summary = (
        item.get("summary")
        or item.get("description")
        or item.get("event")
        or item.get("background")
        or item.get("role")
        or item.get("location")
        or ""
    )

    extras = []
    if item.get("focus"):
        extras.append(f"焦点: {item['focus']}")
    if item.get("location") and item.get("location") != title:
        extras.append(f"位置: {item['location']}")
    if item.get("leads_to"):
        extras.append(f"指向: {item['leads_to']}")
    if item.get("san_loss"):
        extras.append(f"SAN损失: {item['san_loss']}")

    detail = str(summary).strip()
    if extras:
        detail = f"{detail} ({'；'.join(extras)})" if detail else "；".join(extras)
    if len(detail) > 180:
        detail = detail[:180] + "..."
    return f"- {title}: {detail}" if detail else f"- {title}"


async def inject_trpg_system_prompt(ctx: Any, i18n: I18n) -> str:
    """TRPG system-identity section: available AI-KP tools and behavior guidelines.

    Pure framing text (no game state involved), so it never fails and is
    always non-empty for any ``i18n``.
    """
    parts = [
        i18n.t("prompt.system.intro"),
        "",
        i18n.t("prompt.system.tools_header"),
        i18n.t("prompt.system.tools_character"),
        "",
        i18n.t("prompt.system.tools_dice"),
        "",
        i18n.t("prompt.system.tools_status"),
        "",
        i18n.t("prompt.system.tools_document"),
        "",
        i18n.t("prompt.system.guidelines_header"),
        i18n.t("prompt.system.guidelines"),
    ]
    return "\n".join(parts)


async def inject_game_state_prompt(ctx: Any, character_manager: Any, store: Store, i18n: I18n) -> str:
    """Minimal "battle status" panel: scene, clock, party roster, NPCs, clues, world changes, initiative.

    Reads store keys ``game_clock.{chat_key}``, ``kp_notes.{chat_key}``,
    ``module_player_pool.{chat_key}``, ``initiative.{chat_key}`` and
    ``character_manager.get_party_roster``/``get_character``. Every optional
    lookup is independently guarded so a partially-seeded (or entirely
    empty) game state still renders the fixed header/footer instead of
    raising.
    """
    try:
        user_id = ctx.user_id
        chat_key = ctx.chat_key
        divider = i18n.t("prompt.divider")
        lines = [divider, i18n.t("prompt.game_state.title"), divider]

        scene_name = i18n.t("common.unknown")
        focus = i18n.t("prompt.game_state.default_focus")
        clock_time = i18n.t("prompt.game_state.clock_not_set")

        try:
            clock_data = await store.get(user_key="", store_key=f"game_clock.{chat_key}")
            if clock_data:
                clock = json.loads(clock_data)
                clock_time = clock.get("current_time", clock_time)
        except Exception:
            pass

        try:
            notes_data = await store.get(user_key="", store_key=f"kp_notes.{chat_key}")
            if notes_data:
                notes = json.loads(notes_data)
                scene_name = notes.get("current_scene", scene_name)
                focus = notes.get("current_focus", focus)
        except Exception:
            pass

        lines.extend(
            [
                i18n.t("prompt.game_state.scene_line", scene=scene_name),
                i18n.t("prompt.game_state.clock_line", time=clock_time),
                i18n.t("prompt.game_state.focus_line", focus=focus),
            ]
        )

        # -- party roster (fall back to the single active character) -----
        try:
            roster = await character_manager.get_party_roster(chat_key)
            if roster:
                lines.append("")
                lines.append(i18n.t("prompt.game_state.roster_header"))
                for member in roster:
                    name = member.get("name", "?")
                    system = member.get("system", "CoC")
                    status_eff = member.get("status_effects", [])
                    eff_str = " | ".join(status_eff) if status_eff else i18n.t("common.none")
                    if system == "CoC":
                        hp = member.get("HP", "?/?")
                        san = member.get("SAN", "?/?")
                        mp = member.get("MP", "?/?")
                        lines.append(
                            i18n.t(
                                "prompt.game_state.roster_coc_line",
                                name=name,
                                hp=hp,
                                san=san,
                                mp=mp,
                                effects=eff_str,
                            )
                        )
                    else:
                        hp = member.get("HP", "?")
                        ac = member.get("AC", "?")
                        lines.append(
                            i18n.t(
                                "prompt.game_state.roster_other_line",
                                name=name,
                                hp=hp,
                                ac=ac,
                                effects=eff_str,
                            )
                        )
            else:
                character = await character_manager.get_character(user_id, chat_key)
                if character and character.name != "default":
                    attrs = character.attributes
                    if character.system == "CoC":
                        hp = f"{attrs.get('HP', '?')}/{attrs.get('HPMAX', '?')}"
                        san = f"{attrs.get('SAN', '?')}/{attrs.get('SANMAX', '?')}"
                        mp = f"{attrs.get('MP', '?')}/{attrs.get('MPMAX', '?')}"
                        lines.append(
                            i18n.t(
                                "prompt.game_state.solo_coc_line",
                                name=character.name,
                                hp=hp,
                                san=san,
                                mp=mp,
                            )
                        )
                    else:
                        hp = attrs.get("HP", "?")
                        ac = getattr(character, "secondary_attributes", {}).get("护甲等级", "?")
                        lines.append(
                            i18n.t("prompt.game_state.solo_other_line", name=character.name, hp=hp, ac=ac)
                        )
        except Exception:
            pass

        # -- active NPCs (last 3) -----------------------------------------
        try:
            notes_data = await store.get(user_key="", store_key=f"kp_notes.{chat_key}")
            if notes_data:
                notes = json.loads(notes_data)
                npc_items = notes.get("npc_status", [])[-3:]
                if npc_items:
                    lines.append("")
                    lines.append(i18n.t("prompt.game_state.npc_header"))
                    for item in npc_items:
                        lines.append(i18n.t("prompt.game_state.bullet", content=item.get("content", "")))
        except Exception:
            pass

        # -- investigation background (opening facts, tagged "开局") -------
        try:
            notes_data = await store.get(user_key="", store_key=f"kp_notes.{chat_key}")
            if notes_data:
                notes = json.loads(notes_data)
                all_facts = notes.get("confirmed_facts", [])
                opening = [f for f in all_facts if f.get("time") == "开局"]
                if opening:
                    lines.append("")
                    lines.append(i18n.t("prompt.game_state.background_header"))
                    for item in opening[-5:]:
                        lines.append(i18n.t("prompt.game_state.bullet", content=item.get("content", "")))
        except Exception:
            pass

        # -- confirmed facts (last 5, excluding the opening ones) ---------
        try:
            notes_data = await store.get(user_key="", store_key=f"kp_notes.{chat_key}")
            if notes_data:
                notes = json.loads(notes_data)
                facts = [f for f in notes.get("confirmed_facts", []) if f.get("time") != "开局"][-5:]
                lines.append("")
                if facts:
                    lines.append(i18n.t("prompt.game_state.facts_header"))
                    for item in facts:
                        lines.append(i18n.t("prompt.game_state.bullet", content=item.get("content", "")))
                else:
                    lines.append(i18n.t("prompt.game_state.facts_empty"))
        except Exception:
            pass

        # -- ongoing clues (from the player pool) --------------------------
        try:
            player_data = await store.get(user_key="", store_key=f"module_player_pool.{chat_key}")
            if player_data:
                player = json.loads(player_data)
                clues = player.get("clues", [])
                if clues:
                    lines.append("")
                    lines.append(i18n.t("prompt.game_state.clues_header"))
                    for c in clues[-5:]:
                        desc = c.get("description", "")[:40]
                        lines.append(
                            i18n.t("prompt.game_state.clue_line", name=c.get("name", "?"), description=desc)
                        )
        except Exception:
            pass

        # -- world changes (last 3) ----------------------------------------
        try:
            notes_data = await store.get(user_key="", store_key=f"kp_notes.{chat_key}")
            if notes_data:
                notes = json.loads(notes_data)
                changes = notes.get("world_changes", [])[-3:]
                if changes:
                    lines.append("")
                    lines.append(i18n.t("prompt.game_state.world_changes_header"))
                    for item in changes:
                        lines.append(i18n.t("prompt.game_state.bullet", content=item.get("content", "")))
        except Exception:
            pass

        # -- initiative order (combat only) ---------------------------------
        try:
            init_data = await store.get(user_key=user_id, store_key=f"initiative.{chat_key}")
            if init_data:
                initiative_list = json.loads(init_data)
                if initiative_list:
                    lines.append("")
                    lines.append(i18n.t("prompt.game_state.initiative_header"))
                    for idx, entry in enumerate(initiative_list[:5], 1):
                        marker = " \U0001F448" if idx == 1 else ""
                        lines.append(
                            i18n.t(
                                "prompt.game_state.initiative_line",
                                index=idx,
                                name=entry["name"],
                                initiative=entry["init"],
                                marker=marker,
                            )
                        )
        except Exception:
            pass

        lines.append(divider)
        return "\n".join(lines)

    except Exception:
        return ""


async def inject_system_expertise_prompt(ctx: Any, character_manager: Any, i18n: I18n) -> str:
    """Game-system-specific Keeper/DM guidance (CoC7 / DnD5e / WoD / generic fallback)."""
    try:
        user_id = ctx.user_id
        character = await character_manager.get_character(user_id, ctx.chat_key)
        game_system = character.system if character else "CoC"

        if game_system == "CoC":
            return i18n.t("prompt.expertise.coc")
        if game_system == "DnD5e":
            return i18n.t("prompt.expertise.dnd5e")
        if game_system == "WoD":
            return i18n.t("prompt.expertise.wod")
        return i18n.t("prompt.expertise.generic")

    except Exception:
        return ""


async def inject_document_context_prompt(
    ctx: Any, vector_db: Any, store: Store, i18n: I18n, enable_vector_db: bool = True
) -> str:
    """Module knowledge-pool / raw-document context, prioritizing the initialized knowledge pool.

    Precedence: an initialized knowledge pool (``module_init_status`` ==
    ``"ready"``) beats an in-progress one (``"processing"``), which beats a
    vector-search fallback over raw uploaded documents. Whenever a keeper
    pool is present this always carries the strong, localized
    ``prompt.keeper_discipline`` instruction telling the KP that
    keeper/module-secret content is for its own reasoning only and must
    NEVER be quoted to players.
    """
    if not enable_vector_db:
        return ""

    chat_key = ctx.chat_key

    try:
        status = await store.get(user_key="", store_key=f"module_init_status.{chat_key}")

        if status == "ready":
            keeper_data = await store.get(user_key="", store_key=f"module_keeper_pool.{chat_key}")
            player_data = await store.get(user_key="", store_key=f"module_player_pool.{chat_key}")

            divider = i18n.t("prompt.divider")
            prompt_parts = [
                divider,
                i18n.t("prompt.document.pool_title"),
                divider,
                "",
                i18n.t("prompt.keeper_discipline"),
                "",
            ]

            if keeper_data:
                keeper_pool = json.loads(keeper_data)
                prompt_parts.append(i18n.t("prompt.document.keeper_pool_label"))
                for category, items in keeper_pool.items():
                    if category in ("summary", "background"):
                        if items:
                            text = str(items)
                            if len(text) > 300:
                                text = text[:300] + "..."
                            prompt_parts.append(f"### {category}\n{text}")
                    elif items:
                        prompt_parts.append(f"### {category}")
                        for item in items[:20]:
                            prompt_parts.append(summarize_knowledge_item(item))
                            if isinstance(item, dict) and item.get("spoiler_tags"):
                                prompt_parts.append(
                                    i18n.t("prompt.document.spoiler_line", tags=", ".join(item["spoiler_tags"]))
                                )
                prompt_parts.append("")

            if player_data:
                player_pool = json.loads(player_data)
                prompt_parts.append(i18n.t("prompt.document.player_pool_label"))
                for category, items in player_pool.items():
                    if category in ("summary", "background"):
                        if items:
                            text = str(items)
                            if len(text) > 300:
                                text = text[:300] + "..."
                            prompt_parts.append(f"### {category}\n{text}")
                    elif items:
                        prompt_parts.append(f"### {category}")
                        for item in items[:20]:
                            prompt_parts.append(summarize_knowledge_item(item))
                prompt_parts.append("")

            prompt_parts.append(i18n.t("prompt.document.catalog_hint"))
            return "\n".join(prompt_parts)

        if status == "processing":
            divider = i18n.t("prompt.divider")
            return "\n".join(
                [
                    divider,
                    i18n.t("prompt.document.processing_title"),
                    divider,
                    "",
                    i18n.t("prompt.document.processing_body"),
                ]
            )

        # No knowledge pool at all yet: fall back to vector search over the
        # raw uploaded documents.
        queries = [
            i18n.t("prompt.document.fallback_query_setting"),
            i18n.t("prompt.document.fallback_query_npc"),
            i18n.t("prompt.document.fallback_query_clues"),
        ]

        seen_ids = set()
        all_results = []

        for query in queries:
            results = await vector_db.search_documents(query=query, chat_key=chat_key, limit=5)
            for r in results:
                doc_id = f"{r['filename']}:{r.get('chunk_index', 0)}"
                if doc_id not in seen_ids:
                    seen_ids.add(doc_id)
                    all_results.append(r)

        if all_results:
            divider = i18n.t("prompt.divider")
            prompt_parts = [
                divider,
                i18n.t("prompt.document.fallback_title"),
                divider,
                "",
                i18n.t("prompt.document.fallback_intro"),
                "",
                i18n.t("prompt.document.fallback_retrieved_label"),
            ]

            for idx, result in enumerate(all_results[:10], 1):
                doc_emoji = _DOCUMENT_TYPE_EMOJI.get(result["document_type"], _DEFAULT_DOCUMENT_EMOJI)
                prompt_parts.append(
                    i18n.t(
                        "prompt.document.fragment_heading",
                        emoji=doc_emoji,
                        filename=result["filename"],
                        index=idx,
                    )
                )
                text = result["text"]
                if len(text) > 1500:
                    text = text[:1500] + "..."
                prompt_parts.append(text)
                prompt_parts.append("")

            prompt_parts.append("")
            prompt_parts.append(divider)
            prompt_parts.append(i18n.t("prompt.document.digest_title"))
            prompt_parts.append(divider)
            prompt_parts.append("")
            prompt_parts.append(i18n.t("prompt.document.digest_intro"))
            prompt_parts.append("")
            prompt_parts.append(i18n.t("prompt.document.digest_visible"))
            prompt_parts.append("")
            prompt_parts.append(i18n.t("prompt.document.digest_hidden"))
            prompt_parts.append("")
            prompt_parts.append(i18n.t("prompt.document.digest_rules"))
            prompt_parts.append("")
            prompt_parts.append(i18n.t("prompt.document.prohibited_title"))
            prompt_parts.append(i18n.t("prompt.document.prohibited_list"))
            prompt_parts.append("")
            prompt_parts.append(i18n.t("prompt.document.search_hint"))

            return "\n".join(prompt_parts)

    except Exception:
        pass

    return ""


async def inject_session_history_prompt(ctx: Any, battle_report_manager: Any, i18n: I18n) -> str:
    """Recap of the most recently archived session, so the KP can pick up continuity."""
    try:
        summary = await battle_report_manager.get_last_session_summary(ctx.chat_key, i18n)
        return summary or ""
    except Exception:
        return ""


async def inject_session_recap_prompt(ctx: Any, store: Store, i18n: I18n) -> str:
    """Rolling "story so far" recap of the CURRENT (in-progress) session.

    Reads the bounded recap persisted under ``session_recap.{chat_key}`` by
    ``agent.session_recap`` and frames it with a localized header, so the KP
    stays consistent with concrete facts established far earlier this session
    (names, places, promises, clues, open threads) even once they scroll out of
    the loop's ~20-message replay window. Empty ("") until the first refresh.

    The recap is distilled only from in-session play, so — unlike the module
    knowledge pool — it carries no keeper-secret material and needs no secrecy
    discipline block.
    """
    try:
        recap = await store.get(user_key="", store_key=f"session_recap.{ctx.chat_key}")
        if not recap or not recap.strip():
            return ""
        return "\n".join([i18n.t("prompt.session_recap.header"), "", recap.strip()])
    except Exception:
        return ""


async def inject_interaction_style_prompt(ctx: Any, i18n: I18n) -> str:
    """Fixed narrative-voice / tool-usage / scene-response guidance for the KP.

    Pure framing text (no game state involved), so it never fails and is
    always non-empty for any ``i18n``.
    """
    parts = [
        i18n.t("prompt.style.narrative"),
        "",
        i18n.t("prompt.style.tool_usage"),
        "",
        i18n.t("prompt.style.scene_response"),
        "",
        i18n.t("prompt.style.examples"),
        "",
        i18n.t("prompt.style.principles"),
    ]
    return "\n".join(parts)
