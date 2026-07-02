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
  ``core.coc_rules.result_check_base`` (surfaced through
  ``core.dice_engine``'s check helpers) and rendered to a localized label at
  the edge via ``coc_rank_label``/``services.i18n`` - never compared against
  a hardcoded CN string the way the source compares ``result["level"] ==
  "大失败"``.

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

from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from core.character_manager import CharacterSheet
from core.character_rules import render_validation_notice, validate_sheet
from core.dice_engine import DiceResult, coc_rank_label

# COC7 base-attribute names, recognized by `skill_check` so "STR"/"POW"/...
# route to an attribute check instead of a skill lookup. Game data (mirrors
# `core.character_manager.CharacterSheet`'s CoC attribute keys), not UI text.
_COC_ATTRIBUTE_NAMES = {"STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"}

# "Credit Rating" skill aliases (CN/EN), routed to the "信用" skill under the
# display name "信用评级". CJK/EN game-data skill-name aliases, exempt from
# i18n per the same convention as `core.character_manager.CharacterTemplate.synonyms`.
_CREDIT_RATING_ALIASES = {"信用", "credit rating", "信用评级", "信誉"}

# `opposed_check`'s local success-level scale (0..5, ported as-is from
# plugin.py's inline `get_level` helper - distinct from `core.coc_rules`'
# canonical -2..4 codes) -> the matching `dice.json` rank-label i18n key.
_OPPOSED_LEVEL_KEYS = {
    5: "coc.rank.crit",
    4: "coc.rank.extreme",
    3: "coc.rank.hard",
    2: "coc.rank.success",
    1: "coc.rank.fail",
    0: "coc.rank.fumble",
}

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

            character, violations = validate_sheet(character, template_key)
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

            old_value = character.attributes.get(attribute, i18n.t("kp_tools.character.value_unset"))
            character.attributes[attribute] = value

            character, violations = validate_sheet(character, character.system)
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

    async def _record_dice_roll(self, ctx: AgentCtx, expression: str, result: DiceResult) -> None:
        """Best-effort battle-report recording, mirroring plugin.py's `/r` command handler.

        A no-op whenever there's no in-progress session for `ctx.chat_key`
        (`BattleReportManager.add_dice_roll` itself only records against an
        active session) and never lets a recording failure break the roll.
        """
        try:
            character = await _get_active_character(self.services, ctx)
            char_name = character.name if character else ""
            await self.services.battles.add_dice_roll(
                ctx.chat_key, ctx.uid(), char_name, expression, result.total, result.is_critical_success()
            )
        except Exception:
            pass

    async def _record_skill_check(
        self, ctx: AgentCtx, char_name: str, skill: str, target: int, roll: int, level_label: str
    ) -> None:
        """Best-effort battle-report recording, mirroring plugin.py's `/ra` command handler."""
        try:
            await self.services.battles.add_skill_check(
                ctx.chat_key, ctx.uid(), char_name, skill, target, roll, level_label
            )
        except Exception:
            pass

    @tool
    async def roll_dice(self, ctx: AgentCtx, expression: str) -> str:
        """Roll dice and return the result.

        Args:
            expression: Dice expression, e.g. '1d100', '3d6+2', '2d6*5'.
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

        await self._record_dice_roll(ctx, expression, result)
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
    ) -> str:
        """Run a skill check for the active character (auto-detects attribute/Credit-Rating checks).

        Args:
            skill_name: Skill name (CN/EN aliases supported; also accepts attribute names like STR, or
                Credit Rating).
            bonus: Bonus dice (COC) or advantage count (DND5E).
            penalty: Penalty dice (COC) or disadvantage count (DND5E).
            dc: Difficulty class (DND5E only, defaults to 15).
            proficient: Whether the character is proficient in this skill (DND5E only).
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        dice = self.services.dice

        try:
            character = await _get_active_character(self.services, ctx)
            if not _has_character(character):
                return i18n.t("kp_tools.character.none")

            standard_name = characters.find_skill_by_alias(character, skill_name)
            attr_upper = skill_name.upper().strip()
            skill_lower = skill_name.lower().strip()

            if character.system == "CoC":
                if attr_upper in _COC_ATTRIBUTE_NAMES:
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

                lines = [i18n.t("kp_tools.dice.skill_check.coc_header", name=character.name, skill=target_skill)]
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

                await self._record_skill_check(
                    ctx, character.name, target_skill, skill_value, result["final_roll"], level_label
                )
                return "\n".join(lines)

            # DND5E: full d20 + ability modifier + proficiency bonus check vs DC.
            target_skill = standard_name if standard_name else skill_name
            modifier = characters.get_dnd_skill_modifier(character, target_skill, proficient)
            target_dc = dc if dc is not None else 15

            net_advantage = bonus - penalty
            adv_label = ""
            if net_advantage > 0:
                roll_result = dice.roll_advantage("1d20", is_check=True)
                adv_label = i18n.t("kp_tools.dice.skill_check.advantage_label", count=net_advantage)
            elif net_advantage < 0:
                roll_result = dice.roll_disadvantage("1d20", is_check=True)
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
                    name=character.name,
                    skill=target_skill,
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
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.dice.skill_check.failed", error=str(exc))

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

            if result["rank"] == -2:  # fumble: lose all remaining SAN
                loss = san_value

            new_san = max(0, san_value - loss)
            character.attributes["SAN"] = new_san
            await characters.save_character(ctx.uid(), ctx.chat_key, character)

            level_label = coc_rank_label(result["rank"], i18n)
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
                    "kp_tools.dice.sanity.remaining_line", san=new_san, sanmax=character.attributes.get("SANMAX", 99)
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

            def get_level(roll: int, value: int) -> tuple[int, str]:
                if roll == 1:
                    code = 5
                elif roll <= value // 5:
                    code = 4
                elif roll <= value // 2:
                    code = 3
                elif roll <= value:
                    code = 2
                elif roll == 100 or (roll >= 96 and value < 50):
                    code = 0
                else:
                    code = 1
                return code, i18n.t(_OPPOSED_LEVEL_KEYS[code])

            lv1, name1 = get_level(r1, s1)
            lv2, name2 = get_level(r2, s2)

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

            if character.system == "CoC":
                hp = character.attributes.get("HP", 10)
                hp_max = character.attributes.get("HPMAX", 10)
            else:
                hp = character.secondary_attributes.get("生命值", 10)
                hp_max = hp

            if action == "show":
                pass
            elif action == "add":
                hp = min(hp_max, hp + value)
            elif action == "sub":
                hp = max(0, hp - value)
            elif action == "set":
                hp = max(0, min(hp_max, value))
            else:
                return i18n.t("kp_tools.dice.hp.unknown_action", action=action)

            if character.system == "CoC":
                character.attributes["HP"] = hp
            else:
                character.secondary_attributes["生命值"] = hp
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

        try:
            init_data = await self.services.store.get(user_key="", store_key=store_key)
            init_list = json.loads(init_data) if init_data else []

            if action == "add":
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
                return i18n.t("kp_tools.initiative.added", name=name, initiative=initiative)

            if action == "list":
                if not init_list:
                    return i18n.t("kp_tools.initiative.empty")
                lines = [i18n.t("kp_tools.initiative.list_header")]
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
                return i18n.t("kp_tools.initiative.cleared")

            if action == "next":
                if not init_list:
                    return i18n.t("kp_tools.initiative.empty")
                current = init_list.pop(0)
                init_list.append(current)
                await self.services.store.set(
                    user_key="", store_key=store_key, value=json.dumps(init_list, ensure_ascii=False)
                )
                return i18n.t("kp_tools.initiative.next_turn", name=current["name"])

            return i18n.t("kp_tools.initiative.unknown_action", action=action)
        except Exception as exc:
            return i18n.t("kp_tools.initiative.failed", error=str(exc))
