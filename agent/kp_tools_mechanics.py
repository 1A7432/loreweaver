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
- check grading goes through the room system's COMPILED rulepack resolver
  (`core.resolution`): the engine rolls (`DiceRoller.roll_for_check`), the
  pack ladder interprets, and labels render via `RulePack.rank_label` — this
  module never re-implements a success ladder and only ever branches on the
  outcome contract's semantic flags.

Every user-visible string is localized via ``self.services.i18n`` (see
``locales/{en,zh}/kp_tools.json``). CJK/EN game-data literals - skill and
attribute names/aliases, and the ``random_madness`` symptom tables - are
exempt from i18n, the same convention ``core`` already uses (see
``core/character_manager.py``'s ``CharacterTemplate.synonyms`` and
``core/prompt_sections.py``'s module docstring).
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.services import Services, room_rule_variant
from agent.tools import tool
from core.battle_recording import record_check, record_dice_roll
from core.battle_report import NPC_USER_ID, SessionRecord
from core.character_manager import (
    CharacterDataError,
    CharacterSheet,
    get_hit_points,
    recompute_dnd_derived,
    set_hit_points,
)
from core.character_rules import render_validation_notice, validate_sheet
from core.check_outcome import CheckOutcome, outcome_wire
from core.dice_engine import DiceResult
from core.rulepacks import load_rulepack

# COC7 base-attribute names, recognized by `skill_check` so "STR"/"POW"/...
# route to an attribute check instead of a skill lookup. Game data (mirrors
# `core.character_manager.CharacterSheet`'s CoC attribute keys), not UI text.
_COC_ATTRIBUTE_NAMES = {"STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"}
# Chinese attribute names the model naturally reaches for ("力量" for a STR check). Without
# this map they fell through to `skills.get(名, 0)` → a degenerate target-0 check that a
# roll of 1 turns into a critical (2026-08-05 play-test, Bug6).
_COC_ATTRIBUTE_ALIASES = {
    "力量": "STR",
    "体质": "CON",
    "体型": "SIZ",
    "敏捷": "DEX",
    "外貌": "APP",
    "智力": "INT",
    "灵感": "INT",
    "意志": "POW",
    "教育": "EDU",
    "幸运": "LUC",
    "运气": "LUC",
}

# "Credit Rating" skill aliases (CN/EN), routed to the "信用" skill under the
# display name "信用评级". CJK/EN game-data skill-name aliases, exempt from
# i18n per the same convention as `core.character_manager.CharacterTemplate.synonyms`.
_CREDIT_RATING_ALIASES = {"信用", "credit rating", "信用评级", "信誉"}

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
        try:
            character = await _get_active_character(self.services, ctx)
        except CharacterDataError:
            return i18n.t("kp_tools.character.data_error")
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
        except CharacterDataError:
            return i18n.t("kp_tools.character.data_error")
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
        except CharacterDataError:
            return i18n.t("kp_tools.character.data_error")
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
        except CharacterDataError:
            return i18n.t("kp_tools.character.data_error")
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
            await record_dice_roll(
                self.services.battles,
                ctx.chat_key,
                user_id,
                char_name,
                expression,
                result,
            )
        except Exception:
            pass

    async def _record_check(
        self,
        ctx: AgentCtx,
        char_name: str,
        skill: str,
        outcome: CheckOutcome,
        *,
        label: str = "",
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
            await record_check(
                self.services.battles,
                ctx.chat_key,
                NPC_USER_ID if is_npc else ctx.uid(),
                actor_name,
                skill,
                outcome,
                label=label,
                **details,
            )
        except Exception:
            pass

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
            "detail": {
                "modifier": result.modifier,
                "critical_success": result.is_critical_success(),
                "critical_failure": result.is_critical_failure(),
            },
        }
        if actor and actor.strip():
            payload["actor"] = actor.strip()
        ctx.emit_dice(payload)
        await self._record_dice_roll(ctx, expression, result, actor=actor)
        return response

    async def _pool_check(self, ctx: AgentCtx, i18n, params: dict, actor: str | None) -> str:
        """Graded pool check for parameterized systems, under the ROOM's pack."""
        from agent.kp_tools_subsystems import room_rulepack

        pack = await room_rulepack(self.services, ctx)
        resolver = pack.resolver
        if resolver is None or not resolver.params:
            return i18n.t("kp_tools.dice.pool.not_parameterized")
        bounds = {spec.id: spec for spec in resolver.params}
        cleaned: dict[str, int] = {}
        for key, spec in bounds.items():
            raw = params.get(key, spec.default)
            if raw is None:
                return i18n.t("kp_tools.dice.pool.missing_param", param=key)
            try:
                value = int(raw)
            except (TypeError, ValueError):
                return i18n.t("kp_tools.dice.pool.missing_param", param=key)
            if isinstance(raw, bool) or not spec.minimum <= value <= spec.maximum:
                return i18n.t(
                    "kp_tools.dice.pool.out_of_range",
                    param=key,
                    minimum=spec.minimum,
                    maximum=spec.maximum,
                )
            cleaned[key] = value
        unknown = set(params) - set(bounds)
        if unknown:
            return i18n.t("kp_tools.dice.pool.unknown_param", param=", ".join(sorted(unknown)))

        rolled = self.services.dice.roll_for_check(resolver, params=cleaned)
        outcome = resolver.interpret(rolled, None)
        level = pack.rank_label(outcome.rank.id, ctx.locale)
        rolls_str = ", ".join(str(face) for face in rolled.dice)
        ctx.emit_dice(
            {
                "kind": "check",
                **({"actor": actor} if actor and actor.strip() else {}),
                "expr": rolled.expression,
                "rolls": list(rolled.dice),
                "total": rolled.total,
                "outcome": outcome_wire(outcome, level),
                "detail": {**dict(rolled.modifiers), **cleaned},
            }
        )
        lines = [
            i18n.t("kp_tools.dice.pool.header", expr=rolled.expression),
            i18n.t("kp_tools.dice.pool.rolls_line", rolls=rolls_str),
            i18n.t("kp_tools.dice.pool.margin_line", count=outcome.margin if outcome.margin is not None else 0),
            level,
        ]
        return "\n".join(lines)

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
        params: dict | None = None,
    ) -> str:
        """Run a skill check for the active character (auto-detects attribute/Credit-Rating checks).

        Args:
            skill_name: Skill name (CN/EN aliases supported; also accepts attribute names like STR, or
                Credit Rating).
            bonus: Bonus dice (COC) or advantage count (DND5E).
            penalty: Penalty dice (COC) or disadvantage count (DND5E).
            dc: Difficulty class (DND5E only, defaults to 15).
            proficient: Whether the character is proficient in this skill (DND5E only).
            params: Roll parameters for rule systems whose check declares them (e.g. a dice-pool
                size and threshold), as an integer mapping. Omit for systems that don't.
            actor: ONLY for a non-player actor: copy the NPC/creature's exact stated name, without
                added titles or roles. For a player character's check OMIT actor entirely — never
                send actor="" or the player's name.
            npc_target: Required with actor: the NPC's real skill percentage (COC) or total check
                modifier (DND5E), as a real integer. Omit for player checks — never send 0.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        characters = self.services.characters
        dice = self.services.dice

        try:
            if params:
                # Pool-parameterized systems (the resolver declares {slot}s):
                # the params ARE the whole input — no sheet required.
                return await self._pool_check(ctx, i18n, params, actor)
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
            # Chinese attribute names resolve to their codes BEFORE the attribute check, so
            # "力量" rolls STR instead of a nonexistent skill.
            attr_upper = _COC_ATTRIBUTE_ALIASES.get(skill_name.strip(), skill_name.upper().strip())
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
                    if target_skill not in character.skills:
                        # Unknown name (no alias, no attribute, not on the sheet): refuse the
                        # roll instead of running a degenerate target-0 check where a 1 reads
                        # as a critical success.
                        return i18n.t("kp_tools.dice.skill_check.unknown_skill", name=skill_name)
                    skill_value = character.skills.get(target_skill, 0)

                pack = load_rulepack(character.system)
                resolver = pack.resolver
                variant = await room_rule_variant(self.services.store, ctx.chat_key)
                rolled = dice.roll_for_check(resolver, modifiers={"bonus": bonus, "penalty": penalty})
                outcome = resolver.interpret(rolled, skill_value, variant=variant)
                level_label = pack.rank_label(outcome.rank.id, ctx.locale)

                skill_label = pack.display_name(target_skill, ctx.locale)
                lines = [i18n.t("kp_tools.dice.skill_check.coc_header", name=display_name, skill=skill_label)]
                target_line = i18n.t("kp_tools.dice.skill_check.target_line", value=skill_value)
                if bonus > 0:
                    target_line += i18n.t("kp_tools.dice.skill_check.bonus_suffix", count=bonus)
                elif penalty > 0:
                    target_line += i18n.t("kp_tools.dice.skill_check.penalty_suffix", count=penalty)
                lines.append(target_line)
                base_roll = int(rolled.modifiers.get("base_roll", rolled.total))
                lines.append(i18n.t("kp_tools.dice.skill_check.raw_roll_line", roll=base_roll))

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
                            extra=list(rolled.modifiers.get("extra_tens", [])),
                            final=rolled.modifiers.get("final_tens", rolled.total // 10 % 10),
                        )
                    )

                lines.append(i18n.t("kp_tools.dice.skill_check.final_line", final=rolled.total))
                outcome_key = (
                    "kp_tools.dice.skill_check.outcome_success"
                    if outcome.rank.success
                    else "kp_tools.dice.skill_check.outcome_failure"
                )
                lines.append(i18n.t(outcome_key, level=level_label))

                ctx.emit_dice(
                    {
                        "kind": "check",
                        **({"actor": display_name} if actor and actor.strip() else {}),
                        "expr": skill_label,
                        "skill": target_skill,
                        "rolls": [rolled.total],
                        "total": rolled.total,
                        "target": skill_value,
                        "effective_target": resolver.effective_target(skill_value),
                        "outcome": outcome_wire(outcome, level_label),
                        "detail": {"bonus": bonus, "penalty": penalty, **dict(rolled.modifiers)},
                    }
                )
                await self._record_check(
                    ctx,
                    character.name,
                    target_skill,
                    outcome,
                    label=level_label,
                    actor=display_name if actor and actor.strip() else None,
                    actor_is_npc=is_npc,
                    bonus=bonus,
                    penalty=penalty,
                    **({"variant": variant} if variant else {}),
                )
                return "\n".join(lines)

            # d20-family: roll + modifier vs DC through the compiled resolver
            # (advantage/disadvantage are the pack's named roll overrides).
            pack = load_rulepack(character.system)
            resolver = pack.resolver
            target_skill = standard_name if standard_name else skill_name
            modifier = (
                npc_target
                if is_npc
                else characters.get_dnd_skill_modifier(character, target_skill, proficient)
            )
            target_dc = dc if dc is not None else 15

            net_advantage = bonus - penalty
            adv_label = ""
            if net_advantage > 0:
                adv_label = i18n.t("kp_tools.dice.skill_check.advantage_label", count=net_advantage)
                rolled = dice.roll_for_check(resolver, modifiers={"advantage": 1})
            elif net_advantage < 0:
                adv_label = i18n.t("kp_tools.dice.skill_check.disadvantage_label", count=abs(net_advantage))
                rolled = dice.roll_for_check(resolver, modifiers={"disadvantage": 1})
            else:
                rolled = dice.roll_for_check(resolver)

            outcome = resolver.interpret(rolled, target_dc, modifier=modifier)
            total = rolled.total + modifier
            success = outcome.rank.success
            level_label = pack.rank_label(outcome.rank.id, ctx.locale)

            prof_label = i18n.t("kp_tools.dice.skill_check.proficient_label") if proficient else ""
            lines = [
                i18n.t(
                    "kp_tools.dice.skill_check.dnd_header",
                    name=display_name,
                    skill=pack.display_name(target_skill, ctx.locale),
                    proficient=prof_label,
                )
            ]
            if adv_label:
                lines.append(adv_label)
            lines.append(
                i18n.t(
                    "kp_tools.dice.skill_check.dnd_roll_line",
                    roll=rolled.total,
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
            candidate_rolls = list(rolled.modifiers.get("dice_all", rolled.dice))
            ctx.emit_dice(
                {
                    "kind": "check",
                    **({"actor": display_name} if actor and actor.strip() else {}),
                    "expr": pack.display_name(target_skill, ctx.locale),
                    "skill": target_skill,
                    "rolls": candidate_rolls,
                    "total": total,
                    "target": target_dc,
                    "effective_target": resolver.effective_target(target_dc),
                    "outcome": outcome_wire(outcome, level_label),
                    "detail": {
                        "bonus": bonus,
                        "penalty": penalty,
                        "modifier": modifier,
                        "proficient": proficient,
                        **dict(rolled.modifiers),
                    },
                }
            )
            await self._record_check(
                ctx,
                character.name,
                target_skill,
                outcome,
                label=level_label,
                actor=display_name if actor and actor.strip() else None,
                actor_is_npc=is_npc,
                modifier=modifier,
                proficient=proficient,
            )
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("kp_tools.dice.skill_check.failed", error=str(exc))

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
        except CharacterDataError:
            return i18n.t("kp_tools.character.data_error")
        except Exception as exc:
            return i18n.t("kp_tools.dice.hp.failed", error=str(exc))

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
        store_key = "initiative"
        meta_key = "initiative_meta"

        try:
            init_data = await self.services.store.state_get(chat_key, store_key)
            init_list = json.loads(init_data) if init_data else []
            meta_data = await self.services.store.state_get(chat_key, meta_key)
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
                ctx.emit_dice({"kind": "init", "actor": name, "expr": name, "rolls": [], "total": initiative})
                await self.services.store.state_set(
                    chat_key, store_key, json.dumps(init_list, ensure_ascii=False)
                )
                if starting_combat:
                    round_number = 1
                    turns_in_round = 0
                await self.services.store.state_set(
                    chat_key, meta_key, json.dumps({"round": round_number, "turns": turns_in_round})
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
                await self.services.store.state_set(chat_key, store_key, "[]")
                await self.services.store.state_delete(chat_key, meta_key)
                return i18n.t("kp_tools.initiative.cleared")

            if action == "next":
                await self.services.battles.ensure_session_started(chat_key, i18n=i18n)
                session_key = "session_record.current"
                for _attempt in range(3):
                    current_init_data = await self.services.store.state_get(chat_key, store_key)
                    current_meta_data = await self.services.store.state_get(chat_key, meta_key)
                    current_session_data = await self.services.store.state_get(chat_key, session_key)
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
                    committed = await self.services.store.state_set_if_values(
                        chat_key,
                        expected=[
                            (store_key, current_init_data),
                            (meta_key, current_meta_data),
                            (session_key, current_session_data),
                        ],
                        updates=[
                            (store_key, next_list_data),
                            (meta_key, next_meta_data),
                            (session_key, next_session_data),
                        ],
                    )
                    if not committed:
                        continue
                    return i18n.t("kp_tools.initiative.next_turn", name=next_name)
                raise RuntimeError("initiative_state_changed")

            return i18n.t("kp_tools.initiative.unknown_action", action=action)
        except Exception as exc:
            return i18n.t("kp_tools.initiative.failed", error=str(exc))
