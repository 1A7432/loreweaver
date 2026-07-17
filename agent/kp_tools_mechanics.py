"""AI-KP tools: character sheets, dice/skill checks, and initiative tracking.

Ported from ``nekro_trpg_dice_plugin``'s ``trpg_dice/plugin.py`` sandbox
methods (``create_character``, ``get_character_sheet``, ``skill_check``, ...
``initiative_tracker``) per ``docs/specs/M1.md`` §6.3. Each tool BODY is kept
faithful to the source; only the wiring changes:

- ``@plugin.mount_sandbox_method(...)`` -> ``@tool(...)`` (source AGENT /
  BEHAVIOR method types both collapse to a plain tool - none of the tools in
  this module are ``keeper_only``);
- ``_ctx: AgentCtx`` -> our ``ctx: AgentCtx``; user id via ``ctx.uid()``;
- managers/dice/store come from the injected ``Services`` bundle
  (``self.services.characters`` / ``.dice`` / ``.battles`` / ``.store`` /
  ``.i18n``), never module globals;
- ``DiceRoller.roll_expression(...)``-style staticmethod calls become
  ``self.services.dice.roll_expression(...)`` instance calls - the ported
  ``core.dice_engine.DiceRoller`` requires an instance (see its module
  docstring);
- COC success levels are the canonical ``-2..4`` rank codes produced by
  ``core.coc_rules.result_check_base`` - called directly (``opposed_check``)
  or surfaced through ``core.dice_engine``'s check helpers (``sanity_check``,
  ``skill_check``) - and rendered to a localized label at the edge via
  ``coc_rank_label``/``services.i18n``; never compared against a hardcoded CN
  string the way the source compares ``result["level"] == "大失败"``, and
  never re-implemented as a second, private ladder.

Every user-visible string is localized via ``self.services.i18n`` (see
``locales/{en,zh}/kp_tools.json``). CJK/EN game-data literals - skill and
attribute names/aliases, and the ``random_madness`` symptom tables - are
exempt from i18n, the same convention ``core`` already uses (see
``core/character_manager.py``'s ``CharacterTemplate.synonyms`` and
``core/prompt_sections.py``'s module docstring).
"""

from __future__ import annotations

import json
import random
import time

from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from core.battle_report import NPC_USER_ID, SessionRecord
from core.character_manager import CharacterSheet, get_hit_points, recompute_dnd_derived, set_hit_points
from core.character_rules import render_validation_notice, validate_sheet
from core.coc_rules import DEFAULT_COC_RULE, DIFFICULTY_REGULAR, result_check_base
from core.dice_engine import DiceResult, coc_rank_label
from core.luck import adjust_check_with_luck, find_latest_character_check, is_luck_eligible_check
from core.rulepacks import load_rulepack

# COC7 base-attribute names, recognized by `skill_check` so "STR"/"POW"/...
# route to an attribute check instead of a skill lookup. Game data (mirrors
# `core.character_manager.CharacterSheet`'s CoC attribute keys), not UI text.
_COC_ATTRIBUTE_NAMES = {"STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"}

# "Credit Rating" skill aliases (CN/EN), routed to the "信用" skill under the
# display name "信用评级". CJK/EN game-data skill-name aliases, exempt from
# i18n per the same convention as `core.character_manager.CharacterTemplate.synonyms`.
_CREDIT_RATING_ALIASES = {"信用", "credit rating", "信用评级", "信誉"}

# COC7 random-madness symptom tables, ported verbatim from plugin.py's
# `random_madness`. Madness-table entries are CJK game data, explicitly
# exempt from i18n (same convention `core` already uses).
_MADNESS_SYMPTOMS: dict[str, list[str]] = {
    "temp": [
        "失忆：调查员会发现自己只记得最后身处的安全地点，却没有任何来到这里的记忆。",
        "假性残疾：调查员陷入了心理性的失明、失聪或躯体缺失感中。",
        "暴力倾向：调查员陷入了六亲不认的暴力行为中。",
        "偏执：调查员陷入了严重的偏执妄想之中，所有人都想要伤害他。",
        "人际依赖：调查员因为一些原因而将某人当作了支柱。",
        "昏厥：调查员当场昏倒。",
        "逃避行为：调查员会用任何手段试图逃离现场。",
        "歇斯底里：调查员表现出大笑、哭泣、嘶吼、害怕等极端情绪反应。",
    ],
    "long": [
        "恐惧症：调查员患上了一种恐惧症，如幽闭恐惧症、恐高症等。",
        "躁狂症：调查员患上了一种躁狂症，如盗窃癖、纵火癖等。",
        "幻觉：调查员持续产生幻觉。",
        "偏执：调查员持续处于偏执状态。",
        "解离性障碍：调查员的人格发生分裂或记忆丧失。",
        "强迫症：调查员产生了强迫性的行为模式。",
        "抑郁症：调查员陷入了严重的抑郁状态。",
        "创伤后应激障碍：调查员因恐怖经历而产生持续的心理创伤。",
    ],
    "indefinite": [
        "强烈的被迫害妄想，认为周围的一切都在针对自己。",
        "无法控制的重复行为，如不断洗手、检查门锁等。",
        "严重的解离症状，感觉自己不属于这个世界。",
        "持续的噩梦和失眠，精神极度衰弱。",
        "对某种颜色或声音的极度恐惧和排斥。",
        "出现第二人格，完全不同于平时的自己。",
        "失去对时间的感知，认为时间倒流或停滞。",
        "坚信自己变成了某种非人生物。",
    ],
}

# madness_type input (CN/EN aliases) -> canonical `_MADNESS_SYMPTOMS` key.
_MADNESS_TYPE_ALIASES = {
    "temp": "temp",
    "临时": "temp",
    "temporary": "temp",
    "long": "long",
    "总结": "long",
    "总结性": "long",
    "indefinite": "indefinite",
    "不定": "indefinite",
    "不定性": "indefinite",
}


async def _get_active_character(services: Services, ctx: AgentCtx) -> CharacterSheet:
    """Fetch `ctx`'s active character (a fresh, unsaved `"default"`-named sheet if none exists)."""
    return await services.characters.get_character(ctx.uid(), ctx.chat_key)


def _has_character(character: CharacterSheet | None) -> bool:
    """Whether `character` is a real (saved) character, not the `"default"` not-found placeholder."""
    return bool(character) and character.name != "default"


async def _resolve_actor_identity(
    services: Services,
    ctx: AgentCtx,
    active_name: str,
    actor: str | None,
) -> tuple[str, bool]:
    """Return the canonical actor name and whether it is outside the player roster."""
    actor_name = (actor or "").strip()
    if not actor_name:
        return active_name, False

    roster_names = {active_name.casefold(): active_name} if active_name else {}
    try:
        roster = await services.characters.get_party_roster(ctx.chat_key)
        roster_names.update(
            {
                str(member.get("name", "")).strip().casefold(): str(member.get("name", "")).strip()
                for member in roster
                if isinstance(member, dict) and str(member.get("name", "")).strip()
            }
        )
    except Exception:
        pass
    matched_name = roster_names.get(actor_name.casefold())
    return (matched_name, False) if matched_name else (actor_name, True)


class CharacterTools:
    """AI-KP tools for creating, inspecting and mutating player character sheets."""

    def __init__(self, services: Services) -> None:
        self.services = services

    @tool
    async def create_character(
        self, ctx: AgentCtx, name: str, system: str = "coc7", auto_generate: bool = True
    ) -> str:
        """Create a new TRPG character sheet.

        Args:
            name: Character name.
            system: Game system (coc7/dnd5e).
            auto_generate: Whether to auto-roll attributes per the system's rules.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        system_map = {"coc7": "coc7", "dnd5e": "dnd5e", "CoC": "coc7", "DnD5e": "dnd5e"}
        template_key = system_map.get(system, "coc7")
        system_name = "CoC" if template_key == "coc7" else "DnD5e"

        try:
            if auto_generate:
                character = self.services.characters.generate_character(template_key, name)
                character.system = system_name
            else:
                character = CharacterSheet(name=name, system=system_name)

            character, violations = validate_sheet(
                character,
                template_key,
                initialize_vitals=True,
                creation_method="rolled" if template_key == "dnd5e" and auto_generate else None,
            )
            await self.services.characters.save_character(ctx.uid(), ctx.chat_key, character)

            attrs = character.attributes
            if system_name == "CoC":
                result = i18n.t(
                    "kp_tools.character.create.success_coc",
                    name=name,
                    STR=attrs.get("STR", "?"),
                    CON=attrs.get("CON", "?"),
                    DEX=attrs.get("DEX", "?"),
                    INT=attrs.get("INT", "?"),
                    POW=attrs.get("POW", "?"),
                    APP=attrs.get("APP", "?"),
                    SIZ=attrs.get("SIZ", "?"),
                    EDU=attrs.get("EDU", "?"),
                    LUC=attrs.get("LUC", "?"),
                    HP=attrs.get("HP", "?"),
                    HPMAX=attrs.get("HPMAX", "?"),
                    SAN=attrs.get("SAN", "?"),
                    SANMAX=attrs.get("SANMAX", "?"),
                    MP=attrs.get("MP", "?"),
                    MPMAX=attrs.get("MPMAX", "?"),
                )
            else:
                result = i18n.t(
                    "kp_tools.character.create.success_dnd",
                    name=name,
                    STR=attrs.get("STR", "?"),
                    DEX=attrs.get("DEX", "?"),
                    CON=attrs.get("CON", "?"),
                    INT=attrs.get("INT", "?"),
                    WIS=attrs.get("WIS", "?"),
                    CHA=attrs.get("CHA", "?"),
                )
            notice = render_validation_notice(i18n, violations)
            return f"{result}\n{notice}" if notice else result
        except Exception as exc:
            return i18n.t("kp_tools.character.create.failed", error=str(exc))

    @tool
    async def get_character_sheet(self, ctx: AgentCtx) -> str:
        """Get the current user's character sheet details."""
        i18n = self.services.i18n.with_locale(ctx.locale)
        character = await _get_active_character(self.services, ctx)
        if not _has_character(character):
            return i18n.t("kp_tools.character.none")

        attrs = character.attributes
        lines = [
            i18n.t("kp_tools.character.sheet.title", name=character.name),
            i18n.t("kp_tools.character.sheet.system_line", system=character.system),
        ]

        if character.system == "CoC":
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.attributes_header"))
            for attr in ("STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"):
                if attr in attrs:
                    lines.append(i18n.t("kp_tools.character.sheet.attr_line", attr=attr, value=attrs[attr]))

            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.status_header"))
            lines.append(
                i18n.t("kp_tools.character.sheet.hp_line", hp=attrs.get("HP", "?"), hpmax=attrs.get("HPMAX", "?"))
            )
            lines.append(
                i18n.t("kp_tools.character.sheet.san_line", san=attrs.get("SAN", "?"), sanmax=attrs.get("SANMAX", "?"))
            )
            lines.append(
                i18n.t("kp_tools.character.sheet.mp_line", mp=attrs.get("MP", "?"), mpmax=attrs.get("MPMAX", "?"))
            )

            if character.occupation:
                lines.append("")
                lines.append(i18n.t("kp_tools.character.sheet.occupation_line", occupation=character.occupation))
            if character.age:
                lines.append(i18n.t("kp_tools.character.sheet.age_line", age=character.age))
        else:
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.attributes_header"))
            for attr, value in attrs.items():
                lines.append(i18n.t("kp_tools.character.sheet.attr_line", attr=attr, value=value))
            hp, hp_max = get_hit_points(character)
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.status_header"))
            lines.append(i18n.t("kp_tools.character.sheet.hp_line", hp=hp, hpmax=hp_max))

        if character.skills:
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.skills_header"))
            for skill, value in sorted(character.skills.items(), key=lambda item: item[1], reverse=True):
                lines.append(i18n.t("kp_tools.character.sheet.skill_line", skill=skill, value=value))

        if character.equipment:
            lines.append("")
            lines.append(
                i18n.t("kp_tools.character.sheet.equipment_line", equipment=", ".join(character.equipment))
            )
        if character.background:
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.background_line", background=character.background))
        if character.notes:
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.notes_line", notes=character.notes))

        return "\n".join(lines)

    @tool
    async def update_character_skill(self, ctx: AgentCtx, skill_name: str, value: int) -> str:
        """Update a character's skill value.

        Args:
            skill_name: Skill name (CN/EN aliases supported, e.g. "侦查" or "spot hidden").
            value: The new skill value.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")

            standard_name = characters.find_skill_by_alias(character, skill_name)
            target_skill = standard_name if standard_name else skill_name

            old_value = character.skills.get(target_skill, i18n.t("kp_tools.character.value_unset"))
            character.skills[target_skill] = value
            character, violations = validate_sheet(character, character.system)
            new_value = character.skills.get(target_skill, value)

            await characters.save_character(ctx.uid(), ctx.chat_key, character)

            result = i18n.t(
                "kp_tools.character.skill.updated", name=character.name, skill=target_skill, old=old_value, new=new_value
            )
            notice = render_validation_notice(i18n, violations)
            return f"{result}\n{notice}" if notice else result
        except Exception as exc:
            return i18n.t("kp_tools.character.skill.failed", error=str(exc))

    @tool
    async def update_character_attribute(self, ctx: AgentCtx, attribute: str, value: int) -> str:
        """Update a character's attribute value.

        Args:
            attribute: Attribute name (e.g. STR, DEX, POW).
            value: The new attribute value.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")

            hp_field = attribute.strip().upper()
            if hp_field in {"HP", "HPMAX"}:
                hp, hp_max = get_hit_points(character)
                old_value = hp if hp_field == "HP" else hp_max
                if hp_field == "HP":
                    set_hit_points(character, current=value)
                else:
                    set_hit_points(character, maximum=value)
            else:
                old_value = character.attributes.get(attribute, i18n.t("kp_tools.character.value_unset"))
                character.attributes[attribute] = value

            character, violations = validate_sheet(character, character.system)
            if character.system == "DnD5e":
                recompute_dnd_derived(character)
            if hp_field in {"HP", "HPMAX"}:
                hp, hp_max = get_hit_points(character)
                new_value = hp if hp_field == "HP" else hp_max
            else:
                new_value = character.attributes.get(attribute, value)

            await characters.save_character(ctx.uid(), ctx.chat_key, character)

            result = i18n.t(
                "kp_tools.character.attribute.updated",
                name=character.name,
                attribute=attribute,
                old=old_value,
                new=new_value,
            )
            notice = render_validation_notice(i18n, violations)
            return f"{result}\n{notice}" if notice else result
        except Exception as exc:
            return i18n.t("kp_tools.character.attribute.failed", error=str(exc))

    @tool
    async def list_characters(self, ctx: AgentCtx) -> str:
        """List all of the user's character sheets."""
        i18n = self.services.i18n.with_locale(ctx.locale)
        try:
            characters = await self.services.characters.list_characters(ctx.uid(), ctx.chat_key)
            if not characters:
                return i18n.t("kp_tools.character.list.empty")

            lines = [i18n.t("kp_tools.character.list.header")]
            for index, char in enumerate(characters, 1):
                lines.append(
                    i18n.t("kp_tools.character.list.item", index=index, name=char["name"], system=char["system"])
                )
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.character.list.failed", error=str(exc))

    @tool
    async def switch_character(self, ctx: AgentCtx, name: str) -> str:
        """Switch to a different character sheet.

        Args:
            name: The character name to switch to.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        try:
            character = await characters.get_character(ctx.uid(), ctx.chat_key, name)
            if character.name == "default" and name != "default":
                return i18n.t("kp_tools.character.switch.not_found", name=name)

            # Only sheets the CALLING user owns are switchable. Without this the AI KP,
            # running in the acting player's ctx, can re-point that player's active sheet
            # to a companion/NPC it wants to see act (observed in live play) — silently
            # hijacking the player's character.
            owned = await characters.list_characters(ctx.uid(), ctx.chat_key)
            if not any(entry.get("name") == character.name for entry in owned):
                return i18n.t("kp_tools.character.switch.not_found", name=name)

            await characters.set_active_character(ctx.uid(), ctx.chat_key, name)
            return i18n.t("kp_tools.character.switch.success", name=character.name, system=character.system)
        except Exception as exc:
            return i18n.t("kp_tools.character.switch.failed", error=str(exc))

    @tool
    async def delete_character(self, ctx: AgentCtx, name: str) -> str:
        """Delete the named character sheet.

        Args:
            name: The character name to delete.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        try:
            success = await self.services.characters.delete_character(ctx.uid(), ctx.chat_key, name)
            if success:
                return i18n.t("kp_tools.character.delete.success", name=name)
            return i18n.t("kp_tools.character.delete.failed_generic", name=name)
        except Exception as exc:
            return i18n.t("kp_tools.character.delete.failed", error=str(exc))

    @tool
    async def update_character_status(self, ctx: AgentCtx, status_effects: str) -> str:
        """Update the active character's status effects (poisoned, afraid, injured, insane, ...).

        Args:
            status_effects: A JSON array of status strings, e.g. '["Poisoned", "Afraid"]'. Synced into
                the shared party roster and injected into the AI's context on every turn.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        try:
            effects = json.loads(status_effects)
        except (json.JSONDecodeError, TypeError):
            return i18n.t("kp_tools.character.status.invalid")
        if not isinstance(effects, list):
            return i18n.t("kp_tools.character.status.invalid")

        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")

            await self.services.characters.sync_party_roster(ctx.chat_key, character, status_effects=effects)
            return i18n.t("kp_tools.character.status.updated", effects=", ".join(str(effect) for effect in effects))
        except Exception as exc:
            return i18n.t("kp_tools.character.status.failed", error=str(exc))


class DiceTools:
    """AI-KP tools for dice rolls, skill/sanity/growth/opposed checks, HP and WoD pools."""

    def __init__(self, services: Services) -> None:
        self.services = services

    async def _record_dice_roll(
        self, ctx: AgentCtx, expression: str, result: DiceResult, actor: str | None = None
    ) -> None:
        """Best-effort battle-report recording, mirroring plugin.py's `/r` command handler.

        The manager lazily starts a session when needed. A recording failure
        never breaks the roll.
        """
        try:
            character = await _get_active_character(self.services, ctx)
            active_name = character.name if character else ""
            char_name, is_npc = await _resolve_actor_identity(
                self.services,
                ctx,
                active_name,
                actor,
            )
            user_id = NPC_USER_ID if is_npc else ctx.uid()
            critical_type = (
                "success"
                if result.is_critical_success()
                else "failure"
                if result.is_critical_failure()
                else ""
            )
            await self.services.battles.add_dice_roll(
                ctx.chat_key,
                user_id,
                char_name,
                expression,
                result.total,
                bool(critical_type),
                critical_type,
            )
        except Exception:
            pass

    async def _record_skill_check(
        self,
        ctx: AgentCtx,
        char_name: str,
        skill: str,
        target: int,
        roll: int,
        *,
        success: bool,
        rank: int,
        actor: str | None = None,
        actor_is_npc: bool | None = None,
        **details: object,
    ) -> None:
        """Best-effort structured battle-report recording for one check."""
        try:
            actor_name, resolved_is_npc = await _resolve_actor_identity(
                self.services,
                ctx,
                char_name,
                actor,
            )
            is_npc = resolved_is_npc if actor_is_npc is None else actor_is_npc
            await self.services.battles.add_skill_check(
                ctx.chat_key,
                NPC_USER_ID if is_npc else ctx.uid(),
                actor_name,
                skill,
                target,
                roll,
                success=success,
                rank=rank,
                **details,
            )
        except Exception:
            pass

    @staticmethod
    def _effective_coc_target(target: int, difficulty: int) -> int:
        if difficulty == 2:
            return target // 2
        if difficulty == 3:
            return target // 5
        if difficulty == 4:
            return 1
        return target

    @tool
    async def roll_dice(self, ctx: AgentCtx, expression: str, actor: str | None = None) -> str:
        """Roll dice and return the result.

        Args:
            expression: Dice expression, e.g. '1d100', '3d6+2', '2d6*5'.
            actor: Set to the NPC/creature name when rolling for a non-player actor.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        try:
            result = self.services.dice.roll_expression(expression)
        except ValueError as exc:
            return i18n.t("kp_tools.dice.roll.invalid_expression", error=str(exc))
        except Exception as exc:
            return i18n.t("kp_tools.dice.roll.failed", error=str(exc))

        response = i18n.t("kp_tools.dice.roll.result", result=result.format_result(i18n=i18n))
        if result.is_critical_success():
            response += i18n.t("kp_tools.dice.critical_success_suffix")
        elif result.is_critical_failure():
            response += i18n.t("kp_tools.dice.critical_failure_suffix")

        payload: dict[str, object] = {
            "kind": "roll",
            "expr": expression,
            "rolls": list(result.rolls),
            "total": result.total,
            "modifier": result.modifier,
            "critical_success": result.is_critical_success(),
            "critical_failure": result.is_critical_failure(),
        }
        if actor and actor.strip():
            payload["actor"] = actor.strip()
        ctx.emit_dice(payload)
        await self._record_dice_roll(ctx, expression, result, actor=actor)
        return response

    @tool
    async def skill_check(
        self,
        ctx: AgentCtx,
        skill_name: str,
        bonus: int = 0,
        penalty: int = 0,
        dc: int | None = None,
        proficient: bool = False,
        actor: str | None = None,
        npc_target: int | None = None,
    ) -> str:
        """Run a skill check for the active character (auto-detects attribute/Credit-Rating checks).

        Args:
            skill_name: Skill name (CN/EN aliases supported; also accepts attribute names like STR, or
                Credit Rating).
            bonus: Bonus dice (COC) or advantage count (DND5E).
            penalty: Penalty dice (COC) or disadvantage count (DND5E).
            dc: Difficulty class (DND5E only, defaults to 15).
            proficient: Whether the character is proficient in this skill (DND5E only).
            actor: Set to the NPC/creature name when rolling for a non-player actor.
            npc_target: Required with a non-player actor: its skill percentage (COC) or total check
                modifier (DND5E).
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        dice = self.services.dice

        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")
            display_name, is_npc = await _resolve_actor_identity(
                self.services,
                ctx,
                character.name,
                actor,
            )
            if is_npc and npc_target is None:
                return i18n.t("kp_tools.dice.skill_check.npc_target_required")

            standard_name = characters.find_skill_by_alias(character, skill_name)
            attr_upper = skill_name.upper().strip()
            skill_lower = skill_name.lower().strip()

            if character.system == "CoC":
                if is_npc:
                    target_skill = standard_name if standard_name else skill_name
                    skill_value = npc_target
                elif attr_upper in _COC_ATTRIBUTE_NAMES:
                    target_skill = attr_upper
                    skill_value = character.attributes.get(target_skill, 0)
                elif standard_name == "信用" or skill_lower in _CREDIT_RATING_ALIASES:
                    target_skill = "信用评级"
                    skill_value = character.skills.get("信用", 0)
                else:
                    target_skill = standard_name if standard_name else skill_name
                    skill_value = character.skills.get(target_skill, 0)

                result = dice.roll_coc_check_with_bonus(skill_value, bonus, penalty)
                level_label = coc_rank_label(result["rank"], i18n)

                skill_label = load_rulepack("coc7").display_name(target_skill, ctx.locale)
                lines = [i18n.t("kp_tools.dice.skill_check.coc_header", name=display_name, skill=skill_label)]
                target_line = i18n.t("kp_tools.dice.skill_check.target_line", value=skill_value)
                if bonus > 0:
                    target_line += i18n.t("kp_tools.dice.skill_check.bonus_suffix", count=bonus)
                elif penalty > 0:
                    target_line += i18n.t("kp_tools.dice.skill_check.penalty_suffix", count=penalty)
                lines.append(target_line)
                lines.append(i18n.t("kp_tools.dice.skill_check.raw_roll_line", roll=result["roll"]))

                if bonus > 0 or penalty > 0:
                    bp_key = (
                        "kp_tools.dice.skill_check.bonus_label"
                        if bonus > 0
                        else "kp_tools.dice.skill_check.penalty_label"
                    )
                    lines.append(
                        i18n.t(
                            "kp_tools.dice.skill_check.tens_line",
                            label=i18n.t(bp_key),
                            extra=result["extra_tens"],
                            final=result["final_tens"],
                        )
                    )

                lines.append(i18n.t("kp_tools.dice.skill_check.final_line", final=result["final_roll"]))
                outcome_key = (
                    "kp_tools.dice.skill_check.outcome_success"
                    if result["success"]
                    else "kp_tools.dice.skill_check.outcome_failure"
                )
                lines.append(i18n.t(outcome_key, level=level_label))

                ctx.emit_dice(
                    {
                        "kind": "check",
                        **({"actor": display_name} if actor and actor.strip() else {}),
                        "expr": skill_label,
                        "skill": target_skill,
                        "rolls": [result["final_roll"]],
                        "total": result["final_roll"],
                        "target": skill_value,
                        "effective_target": self._effective_coc_target(skill_value, result["difficulty"]),
                        "rank": result["rank"],
                        "success": result["success"],
                        "difficulty": result["difficulty"],
                        "bonus": bonus,
                        "penalty": penalty,
                        "raw_roll": result["roll"],
                        "extra_tens": list(result["extra_tens"]),
                        "final_tens": result["final_tens"],
                    }
                )
                await self._record_skill_check(
                    ctx,
                    character.name,
                    target_skill,
                    skill_value,
                    result["final_roll"],
                    success=result["success"],
                    rank=result["rank"],
                    actor=display_name if actor and actor.strip() else None,
                    actor_is_npc=is_npc,
                    is_critical=result["rank"] in {4, -2},
                    bonus=bonus,
                    penalty=penalty,
                    raw_roll=result["final_roll"],
                    base_roll=result["roll"],
                    extra_tens=result["extra_tens"],
                    final_tens=result["final_tens"],
                    difficulty=result["difficulty"],
                    rule=result["rule"],
                )
                return "\n".join(lines)

            # DND5E: full d20 + ability modifier + proficiency bonus check vs DC.
            target_skill = standard_name if standard_name else skill_name
            modifier = (
                npc_target
                if is_npc
                else characters.get_dnd_skill_modifier(character, target_skill, proficient)
            )
            target_dc = dc if dc is not None else 15

            net_advantage = bonus - penalty
            adv_label = ""
            advantage_rolls: list[int] = []
            disadvantage_rolls: list[int] = []
            if net_advantage > 0:
                roll_result, candidates = dice.roll_advantage_with_candidates("1d20", is_check=True)
                advantage_rolls = [candidate.total for candidate in candidates]
                adv_label = i18n.t("kp_tools.dice.skill_check.advantage_label", count=net_advantage)
            elif net_advantage < 0:
                roll_result, candidates = dice.roll_disadvantage_with_candidates("1d20", is_check=True)
                disadvantage_rolls = [candidate.total for candidate in candidates]
                adv_label = i18n.t("kp_tools.dice.skill_check.disadvantage_label", count=abs(net_advantage))
            else:
                roll_result = dice.roll_expression("1d20", is_check=True)

            total = roll_result.total + modifier
            if roll_result.is_critical_success():
                level_label = i18n.t("kp_tools.dice.dnd.critical_success")
                success = True
            elif roll_result.is_critical_failure():
                level_label = i18n.t("kp_tools.dice.dnd.critical_failure")
                success = False
            else:
                success = total >= target_dc
                level_label = i18n.t("kp_tools.dice.dnd.success" if success else "kp_tools.dice.dnd.failure")

            prof_label = i18n.t("kp_tools.dice.skill_check.proficient_label") if proficient else ""
            lines = [
                i18n.t(
                    "kp_tools.dice.skill_check.dnd_header",
                    name=display_name,
                    skill=load_rulepack("dnd5e").display_name(target_skill, ctx.locale),
                    proficient=prof_label,
                )
            ]
            if adv_label:
                lines.append(adv_label)
            lines.append(
                i18n.t(
                    "kp_tools.dice.skill_check.dnd_roll_line",
                    roll=roll_result.total,
                    modifier=modifier,
                    total=total,
                    dc=target_dc,
                )
            )
            outcome_key = (
                "kp_tools.dice.skill_check.outcome_success"
                if success
                else "kp_tools.dice.skill_check.outcome_failure"
            )
            lines.append(i18n.t(outcome_key, level=level_label))
            rank = 4 if roll_result.is_critical_success() else -2 if roll_result.is_critical_failure() else 1 if success else -1
            candidate_rolls = advantage_rolls or disadvantage_rolls or list(roll_result.rolls)
            ctx.emit_dice(
                {
                    "kind": "check",
                    **({"actor": display_name} if actor and actor.strip() else {}),
                    "expr": load_rulepack("dnd5e").display_name(target_skill, ctx.locale),
                    "skill": target_skill,
                    "rolls": candidate_rolls,
                    "total": total,
                    "target": target_dc,
                    "effective_target": target_dc,
                    "rank": rank,
                    "level": level_label,
                    "success": success,
                    "difficulty": target_dc,
                    "bonus": bonus,
                    "penalty": penalty,
                    "modifier": modifier,
                    "raw_roll": roll_result.total,
                    "advantage_rolls": advantage_rolls,
                    "disadvantage_rolls": disadvantage_rolls,
                    "critical_success": roll_result.is_critical_success(),
                    "critical_failure": roll_result.is_critical_failure(),
                }
            )
            await self._record_skill_check(
                ctx,
                character.name,
                target_skill,
                target_dc,
                total,
                success=success,
                rank=rank,
                actor=display_name if actor and actor.strip() else None,
                actor_is_npc=is_npc,
                is_critical=roll_result.is_critical_success(),
                bonus=bonus,
                penalty=penalty,
                raw_roll=roll_result.total,
                modifier=modifier,
                advantage_rolls=advantage_rolls,
                disadvantage_rolls=disadvantage_rolls,
            )
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.dice.skill_check.failed", error=str(exc))

    @tool
    async def spend_luck(self, ctx: AgentCtx, points: int) -> str:
        """Spend CoC7 Luck to adjust the active character's most recent eligible check.

        This deterministically subtracts points from the existing roll. It never
        rerolls dice and never applies to SAN or Luck checks.

        Args:
            points: Positive number of Luck points to spend.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        if isinstance(points, bool) or not isinstance(points, int) or points <= 0:
            return i18n.t("kp_tools.dice.luck.invalid_points")

        try:
            active_character = await _get_active_character(self.services, ctx)
            if not _has_character(active_character):
                return i18n.t("kp_tools.character.none")
            if active_character.system != "CoC":
                return i18n.t("kp_tools.dice.luck.coc_only")

            character_key = f"characters.{ctx.chat_key}.{active_character.name}"
            session_key = f"session_record.{ctx.chat_key}.current"
            for _attempt in range(2):
                raw_character = await self.services.store.get(
                    user_key=ctx.uid(), store_key=character_key
                )
                raw_session = await self.services.store.get(store_key=session_key)
                if raw_session is None:
                    return i18n.t("kp_tools.dice.luck.no_session")
                if raw_character is None:
                    return i18n.t("kp_tools.character.none")

                character = CharacterSheet.from_dict(json.loads(raw_character))
                luck = int(character.attributes.get("LUC", 0) or 0)
                if points > luck:
                    return i18n.t("kp_tools.dice.luck.insufficient", points=points, luck=luck)

                record = SessionRecord.from_dict(json.loads(raw_session))
                check = find_latest_character_check(
                    record.skill_checks, ctx.uid(), character.name
                )
                if check is None:
                    return i18n.t("kp_tools.dice.luck.no_check")
                if not is_luck_eligible_check(check):
                    return i18n.t(
                        "kp_tools.dice.luck.ineligible", skill=check.get("skill", "")
                    )

                try:
                    adjustment = adjust_check_with_luck(check, points)
                except ValueError as exc:
                    code = str(exc)
                    if code == "luck_cannot_adjust_fumble":
                        return i18n.t("kp_tools.dice.luck.fumble")
                    if code == "luck_points_exceed_roll":
                        return i18n.t(
                            "kp_tools.dice.luck.exceeds_roll",
                            points=points,
                            roll=int(check["roll"]),
                            max=int(check["roll"]) - 1,
                        )
                    raise
                luck_after = luck - points
                character.attributes["LUC"] = luck_after
                character.last_updated = time.time()
                check["luck_before"] = luck
                check["luck_after"] = luck_after
                record.rebuild_player_stats()

                new_character = json.dumps(character.to_dict(), ensure_ascii=False)
                new_session = json.dumps(record.to_dict(), ensure_ascii=False)
                updated = await self.services.store.set_rows_if_values(
                    expected=[
                        (ctx.uid(), character_key, raw_character),
                        ("", session_key, raw_session),
                    ],
                    updates=[
                        (ctx.uid(), character_key, new_character),
                        ("", session_key, new_session),
                    ],
                )
                if not updated:
                    continue

                difficulty = int(check.get("difficulty", DIFFICULTY_REGULAR) or DIFFICULTY_REGULAR)
                target = int(check["target"])
                ctx.emit_dice(
                    {
                        "kind": "check",
                        "expr": load_rulepack("coc7").display_name(
                            str(check.get("skill", "")), ctx.locale
                        ),
                        "skill": check.get("skill", ""),
                        "rolls": [adjustment.after_roll],
                        "total": adjustment.after_roll,
                        "target": target,
                        "effective_target": self._effective_coc_target(target, difficulty),
                        "rank": adjustment.after_rank,
                        "success": adjustment.after_rank >= 1,
                        "difficulty": difficulty,
                        "bonus": int(check.get("bonus", 0) or 0),
                        "penalty": int(check.get("penalty", 0) or 0),
                        "raw_roll": int(check["raw_roll"]),
                        "adjusted_roll": adjustment.after_roll,
                        "luck_spent": adjustment.total_spent,
                        "luck_remaining": luck_after,
                    }
                )
                return i18n.t(
                    "kp_tools.dice.luck.success",
                    points=points,
                    before=coc_rank_label(adjustment.before_rank, i18n),
                    after=coc_rank_label(adjustment.after_rank, i18n),
                    luck=luck_after,
                )
            return i18n.t("kp_tools.dice.luck.conflict")
        except Exception as exc:
            return i18n.t("kp_tools.dice.luck.failed", error=str(exc))

    @tool
    async def sanity_check(self, ctx: AgentCtx, success_loss: str, failure_loss: str) -> str:
        """Run a COC7 Sanity (SAN) check for the active character.

        Args:
            success_loss: Sanity-loss dice expression on success, e.g. "1", "1d4".
            failure_loss: Sanity-loss dice expression on failure, e.g. "1d6", "1d100".
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        dice = self.services.dice
        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")
            if character.system != "CoC":
                return i18n.t("kp_tools.dice.sanity.coc_only")

            san_value = character.attributes.get("SAN", 50)
            result = dice.roll_coc_check(san_value)

            loss_expr = success_loss if result["success"] else failure_loss
            loss_result = dice.roll_expression(loss_expr)
            loss = loss_result.total

            if result["rank"] == -2:
                # Intentional house rule, not CoC7e RAW: a fumble drains ALL remaining SAN,
                # rather than RAW's "loss = the max of the loss-dice range" (e.g. 1d6 -> 6).
                # Faithfully ported from `nekro_trpg_dice_plugin/trpg_dice/plugin.py`'s
                # `sanity_check` (`if result["level"] == "大失败": loss = san_value`, with
                # its own comment "大失败时损失所有SAN" - "lose all SAN on a fumble") - this
                # predates this port and is confirmed intentional, not an accidental
                # divergence introduced here. Locked by
                # `test_sanity_check_fumble_drains_all_remaining_san_house_rule`.
                loss = san_value

            new_san = max(0, san_value - loss)
            character.attributes["SAN"] = new_san
            await characters.save_character(ctx.uid(), ctx.chat_key, character)

            level_label = coc_rank_label(result["rank"], i18n)
            await self._record_skill_check(
                ctx,
                character.name,
                "SAN",
                san_value,
                result["roll"],
                success=result["success"],
                rank=result["rank"],
                is_critical=result["rank"] in {4, -2},
                bonus=result.get("bonus", 0),
                penalty=result.get("penalty", 0),
                raw_roll=result["roll"],
                base_roll=result.get("raw_roll"),
                difficulty=result.get("difficulty"),
                rule=result.get("rule"),
                loss_expr=loss_expr,
                loss=loss,
                san_before=san_value,
                san_after=new_san,
            )
            san_max = character.attributes.get("SANMAX", 99)
            ctx.emit_dice(
                {
                    "kind": "sanity",
                    "expr": "SAN",
                    "rolls": [result["roll"]],
                    "total": result["roll"],
                    "target": san_value,
                    "effective_target": self._effective_coc_target(san_value, result["difficulty"]),
                    "rank": result["rank"],
                    "success": result["success"],
                    "difficulty": result["difficulty"],
                    "bonus": result.get("bonus", 0),
                    "penalty": result.get("penalty", 0),
                    "raw_roll": result.get("raw_roll", result["roll"]),
                    "loss_expr": loss_expr,
                    "loss": loss,
                    "remaining": new_san,
                    "san_max": san_max,
                }
            )
            header_key = (
                "kp_tools.dice.sanity.header_success" if result["success"] else "kp_tools.dice.sanity.header_failure"
            )

            lines = [
                i18n.t(header_key, name=character.name),
                i18n.t("kp_tools.dice.sanity.roll_line", san=san_value, roll=result["roll"]),
                i18n.t("kp_tools.dice.sanity.result_line", level=level_label),
                i18n.t(
                    "kp_tools.dice.sanity.loss_line",
                    loss=loss,
                    expr=loss_expr,
                    detail=loss_result.format_result(i18n=i18n),
                ),
                i18n.t(
                    "kp_tools.dice.sanity.remaining_line", san=new_san, sanmax=san_max
                ),
            ]
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.dice.sanity.failed", error=str(exc))

    @tool
    async def skill_growth(self, ctx: AgentCtx, skill_name: str) -> str:
        """Run a COC7 skill-growth (EN) check for the active character.

        Args:
            skill_name: Skill name.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")

            standard_name = characters.find_skill_by_alias(character, skill_name)
            target_skill = standard_name if standard_name else skill_name
            skill_value = character.skills.get(target_skill, 0)

            if skill_value >= 100:
                return i18n.t("kp_tools.dice.growth.maxed", skill=target_skill, value=skill_value)

            roll = random.randint(1, 100)
            # CoC7e experience check: the skill grows on a roll ABOVE the skill value, and
            # a roll above 95 also always succeeds (so 96-100 grow even at high skill).
            if roll > skill_value or roll > 95:
                growth = random.randint(1, 10)
                old_value = skill_value
                new_value = min(100, skill_value + growth)
                character.skills[target_skill] = new_value
                await characters.save_character(ctx.uid(), ctx.chat_key, character)
                return i18n.t(
                    "kp_tools.dice.growth.success",
                    name=character.name,
                    skill=target_skill,
                    roll=roll,
                    old=old_value,
                    new=new_value,
                    delta=new_value - old_value,
                )

            return i18n.t(
                "kp_tools.dice.growth.failure", name=character.name, skill=target_skill, roll=roll, value=skill_value
            )
        except Exception as exc:
            return i18n.t("kp_tools.dice.growth.failed", error=str(exc))

    @tool
    async def opposed_check(
        self,
        ctx: AgentCtx,
        skill1: str,
        skill2: str,
        skill1_value: int | None = None,
        skill2_value: int | None = None,
    ) -> str:
        """Run a COC7 opposed check between the active character and an opponent.

        Args:
            skill1: The active side's skill name.
            skill2: The passive side's skill name.
            skill1_value: The active side's skill value (read off the active character if omitted).
            skill2_value: The passive side's skill value (defaults to 50 if omitted).
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")

            s1 = characters.get_skill_value(character, skill1) if skill1_value is None else skill1_value
            s2 = character.skills.get(skill2, 50) if skill2_value is None else skill2_value

            r1 = random.randint(1, 100)
            r2 = random.randint(1, 100)

            # Per-side success level: reuse `core.coc_rules.result_check_base` (the
            # authoritative CoC7 ladder, also used by `skill_check`/`sanity_check` via
            # `core.dice_engine`) under the default rulebook rule/difficulty, instead of
            # re-implementing the crit/extreme/hard/fail/fumble bands here. Only the
            # canonical `-2..4` rank is needed for the opposed comparison below - the
            # `critical_success_value` threshold is irrelevant to who wins.
            lv1, _ = result_check_base(DEFAULT_COC_RULE, r1, s1, DIFFICULTY_REGULAR)
            lv2, _ = result_check_base(DEFAULT_COC_RULE, r2, s2, DIFFICULTY_REGULAR)
            name1 = coc_rank_label(lv1, i18n)
            name2 = coc_rank_label(lv2, i18n)

            if lv1 > lv2:
                winner = i18n.t("kp_tools.dice.opposed.winner_active", skill=skill1)
            elif lv2 > lv1:
                winner = i18n.t("kp_tools.dice.opposed.winner_passive", skill=skill2)
            elif s1 > s2:
                winner = i18n.t("kp_tools.dice.opposed.winner_active_tiebreak", skill=skill1)
            elif s2 > s1:
                winner = i18n.t("kp_tools.dice.opposed.winner_passive_tiebreak", skill=skill2)
            else:
                winner = i18n.t("kp_tools.dice.opposed.tie")

            lines = [
                i18n.t("kp_tools.dice.opposed.header", skill1=skill1, skill2=skill2),
                i18n.t("kp_tools.dice.opposed.active_line", skill=skill1, value=s1, roll=r1, level=name1),
                i18n.t("kp_tools.dice.opposed.passive_line", skill=skill2, value=s2, roll=r2, level=name2),
                i18n.t("kp_tools.dice.opposed.result_line", winner=winner),
            ]
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.dice.opposed.failed", error=str(exc))

    @tool
    async def hp_manager(self, ctx: AgentCtx, action: str, value: int = 0) -> str:
        """Manage the active character's hit points.

        Args:
            action: Operation type (show/add/sub/set).
            value: The amount to add/subtract, or the value to set.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")

            hp, hp_max = get_hit_points(character)

            if action == "show":
                pass
            elif action == "add":
                hp, hp_max = set_hit_points(character, delta=value)
            elif action == "sub":
                hp, hp_max = set_hit_points(character, delta=-value)
            elif action == "set":
                hp, hp_max = set_hit_points(character, current=value)
            else:
                return i18n.t("kp_tools.dice.hp.unknown_action", action=action)

            await characters.save_character(ctx.uid(), ctx.chat_key, character)

            ratio = hp / hp_max if hp_max > 0 else 1
            if ratio >= 0.75:
                status_key = "kp_tools.dice.hp.status_healthy"
            elif ratio >= 0.5:
                status_key = "kp_tools.dice.hp.status_light"
            elif ratio >= 0.25:
                status_key = "kp_tools.dice.hp.status_heavy"
            elif hp > 0:
                status_key = "kp_tools.dice.hp.status_dying"
            else:
                status_key = "kp_tools.dice.hp.status_dead"

            return i18n.t(
                "kp_tools.dice.hp.status_line", name=character.name, hp=hp, hpmax=hp_max, status=i18n.t(status_key)
            )
        except Exception as exc:
            return i18n.t("kp_tools.dice.hp.failed", error=str(exc))

    @tool
    async def wod_check(self, ctx: AgentCtx, pool_size: int, difficulty: int = 6) -> str:
        """Run a World of Darkness dice-pool check.

        Args:
            pool_size: Number of d10s in the pool.
            difficulty: Difficulty threshold (defaults to 6).
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        try:
            result = self.services.dice.roll_wod_pool(pool_size, difficulty)
            rolls_str = ", ".join(str(roll) for roll in result["rolls"])

            if result["botch"]:
                level = i18n.t("kp_tools.dice.wod.botch")
            elif result["successes"] == 0:
                level = i18n.t("kp_tools.dice.wod.failure")
            elif result["successes"] == 1:
                level = i18n.t("kp_tools.dice.wod.single_success")
            else:
                level = i18n.t("kp_tools.dice.wod.multi_success", count=result["successes"])

            lines = [
                i18n.t("kp_tools.dice.wod.header", pool=pool_size, difficulty=difficulty),
                i18n.t("kp_tools.dice.wod.rolls_line", rolls=rolls_str),
                i18n.t("kp_tools.dice.wod.successes_line", count=result["successes"]),
                level,
            ]
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.dice.wod.failed", error=str(exc))

    @tool
    async def random_madness(self, ctx: AgentCtx, madness_type: str = "temp") -> str:
        """Generate a random COC7 madness symptom, for the KP/DM to use as needed.

        Args:
            madness_type: Madness category (temp/临时, long/总结, indefinite/不定).
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        key = _MADNESS_TYPE_ALIASES.get(madness_type.lower(), "temp")
        symptom = random.choice(_MADNESS_SYMPTOMS[key])
        type_label = i18n.t(f"kp_tools.dice.madness.type.{key}")
        return i18n.t("kp_tools.dice.madness.result", type_label=type_label, symptom=symptom)


class InitiativeTools:
    """AI-KP tool for tracking combat initiative order."""

    def __init__(self, services: Services) -> None:
        self.services = services

    @tool
    async def initiative_tracker(
        self, ctx: AgentCtx, action: str, name: str | None = None, initiative: int | None = None
    ) -> str:
        """Manage the combat initiative order.

        Args:
            action: Operation (add/list/clear/next).
            name: Character/NPC name (defaults to the active character when adding).
            initiative: Initiative value (auto-rolled for the active character when adding, if omitted).
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        chat_key = ctx.chat_key
        store_key = f"initiative.{chat_key}"
        meta_key = f"initiative_meta.{chat_key}"

        try:
            init_data = await self.services.store.get(user_key="", store_key=store_key)
            init_list = json.loads(init_data) if init_data else []
            meta_data = await self.services.store.get(user_key="", store_key=meta_key)
            parsed_meta = json.loads(meta_data) if meta_data else {}
            meta = parsed_meta if isinstance(parsed_meta, dict) else {}
            round_number = max(1, int(meta.get("round", 1)))
            turns_in_round = max(0, int(meta.get("turns", 0)))

            if action == "add":
                starting_combat = not init_list
                if name is None:
                    character = await _get_active_character(self.services, ctx)
                    name = character.name
                    if initiative is None:
                        if character.system == "DnD5e":
                            init_mod = character.secondary_attributes.get("先攻修正", 0)
                            roll_result = self.services.dice.roll_expression("1d20")
                            initiative = roll_result.total + init_mod
                        else:
                            roll_result = self.services.dice.roll_expression("1d100")
                            initiative = roll_result.total

                init_list.append({"name": name, "init": initiative})
                init_list.sort(key=lambda entry: entry["init"], reverse=True)
                await self.services.store.set(
                    user_key="", store_key=store_key, value=json.dumps(init_list, ensure_ascii=False)
                )
                if starting_combat:
                    round_number = 1
                    turns_in_round = 0
                await self.services.store.set(
                    user_key="",
                    store_key=meta_key,
                    value=json.dumps({"round": round_number, "turns": turns_in_round}),
                )
                await self.services.battles.set_combat_state(
                    chat_key,
                    round_number,
                    str(init_list[0]["name"]),
                    turns_in_round,
                )
                return i18n.t("kp_tools.initiative.added", name=name, initiative=initiative)

            if action in {"list", "show"}:
                if not init_list:
                    return i18n.t("kp_tools.initiative.empty")
                lines = [
                    i18n.t("kp_tools.initiative.list_header"),
                    i18n.t(
                        "kp_tools.initiative.status",
                        round=round_number,
                        current=init_list[0]["name"],
                    ),
                ]
                for index, entry in enumerate(init_list, 1):
                    lines.append(
                        i18n.t(
                            "kp_tools.initiative.list_item",
                            index=index,
                            name=entry["name"],
                            initiative=entry["init"],
                        )
                    )
                return "\n".join(lines)

            if action == "clear":
                await self.services.store.set(user_key="", store_key=store_key, value="[]")
                await self.services.store.delete(user_key="", store_key=meta_key)
                return i18n.t("kp_tools.initiative.cleared")

            if action == "next":
                await self.services.battles.ensure_session_started(chat_key, i18n=i18n)
                session_key = f"session_record.{chat_key}.current"
                for _attempt in range(3):
                    current_init_data = await self.services.store.get(user_key="", store_key=store_key)
                    current_meta_data = await self.services.store.get(user_key="", store_key=meta_key)
                    current_session_data = await self.services.store.get(user_key="", store_key=session_key)
                    current_list = json.loads(current_init_data) if current_init_data else []
                    current_meta = json.loads(current_meta_data) if current_meta_data else {}
                    if not current_list or not current_session_data:
                        return i18n.t("kp_tools.initiative.empty")

                    next_round = max(1, int(current_meta.get("round", 1)))
                    next_turn = max(0, int(current_meta.get("turns", 0))) + 1
                    finished = current_list.pop(0)
                    current_list.append(finished)
                    if next_turn >= len(current_list):
                        next_round += 1
                        next_turn = 0
                    next_name = str(current_list[0]["name"])
                    next_list_data = json.dumps(current_list, ensure_ascii=False)
                    next_meta_data = json.dumps(
                        {"round": next_round, "turns": next_turn, "current": next_name},
                        ensure_ascii=False,
                    )
                    session = SessionRecord.from_dict(json.loads(current_session_data))
                    session.set_combat_state(next_round, next_name, next_turn)
                    next_session_data = json.dumps(session.to_dict(), ensure_ascii=False)
                    committed = await self.services.store.set_rows_if_values(
                        expected=[
                            ("", store_key, current_init_data),
                            ("", meta_key, current_meta_data),
                            ("", session_key, current_session_data),
                        ],
                        updates=[
                            ("", store_key, next_list_data),
                            ("", meta_key, next_meta_data),
                            ("", session_key, next_session_data),
                        ],
                    )
                    if not committed:
                        continue
                    return i18n.t("kp_tools.initiative.next_turn", name=next_name)
                raise RuntimeError("initiative_state_changed")

            return i18n.t("kp_tools.initiative.unknown_action", action=action)
        except Exception as exc:
            return i18n.t("kp_tools.initiative.failed", error=str(exc))
