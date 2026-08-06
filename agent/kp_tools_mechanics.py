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
- check grading goes through the sheet system's COMPILED rulepack resolver
  (`core.resolution`): the engine rolls (`DiceRoller.roll_for_check`), the
  pack ladder interprets, and labels render via `RulePack.rank_label` — this
  module never re-implements a success ladder, never names a rule system, and
  only ever branches on the outcome contract's semantic flags plus the pack's
  declared shapes (`resolver.target_kind`, `resolver.check`, sheet spec).
  Name resolution (attribute aliases, bridged skills) is the pack alias table;
  check inputs read through `core.sheets.check_value`.

Every user-visible string is localized via ``self.services.i18n`` (see
``locales/{en,zh}/kp_tools.json``). CJK/EN game-data literals - the
``random_madness`` symptom tables - are exempt from i18n, the same convention
``core`` already uses (see ``core/prompt_sections.py``'s module docstring).
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
    character_resources,
    get_hit_points,
    set_hit_points,
)
from core.character_rules import render_validation_notice, validate_sheet
from core.check_outcome import CheckOutcome, outcome_wire
from core.dice_engine import DiceResult
from core.rulepacks import RulePack, load_rulepack
from core.sheets import check_value, has_check_value, set_sheet_value, sheet_value


async def _get_active_character(services: Services, ctx: AgentCtx) -> CharacterSheet:
    """Fetch `ctx`'s active character (a fresh, unsaved `"default"`-named sheet if none exists)."""
    return await services.characters.get_character(ctx.uid(), ctx.chat_key)


async def _sheet_pack(services: Services, ctx: AgentCtx, character: CharacterSheet) -> RulePack:
    """The rulepack governing `character`: its own system when resolvable,
    falling back to the room's active pack (bare/unset sheets)."""
    from agent.kp_tools_subsystems import room_rulepack

    try:
        return load_rulepack(character.system)
    except Exception:
        return await room_rulepack(services, ctx)


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
        self, ctx: AgentCtx, name: str, system: str = "", auto_generate: bool = True
    ) -> str:
        """Create a new TRPG character sheet.

        Args:
            name: Character name.
            system: Rule system id; omit to use the room's active system.
            auto_generate: Whether to auto-roll attributes per the system's rules.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
        try:
            if system.strip():
                pack = load_rulepack(system)
            else:
                from agent.kp_tools_subsystems import room_rulepack

                pack = await room_rulepack(self.services, ctx)

            if auto_generate:
                character = self.services.characters.generate_character(pack.system, name)
            else:
                character = CharacterSheet(name=name, system=pack.system)

            character, violations = validate_sheet(
                character,
                pack.system,
                initialize_vitals=True,
                creation_method="rolled" if auto_generate else None,
            )
            await self.services.characters.save_character(ctx.uid(), ctx.chat_key, character)

            spec = pack.sheet_spec
            source_keys = list(spec.attributes) if spec is not None else list(character.attributes)
            attributes_str = ", ".join(
                f"{key} {character.attributes[key]}" for key in source_keys if key in character.attributes
            )
            meters_str = " | ".join(
                f"{meter['label']} {meter['value']}/{meter['max']}" for meter in character_resources(character)
            )
            result = i18n.t(
                "kp_tools.character.create.success",
                name=character.name,
                system=character.system,
                attributes=attributes_str,
                meters=meters_str or i18n.t("common.none"),
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

        try:
            pack = load_rulepack(character.system)
        except Exception:
            pack = None
        spec = pack.sheet_spec if pack is not None else None

        source_keys = [key for key in (spec.attributes if spec is not None else attrs) if key in attrs]
        if source_keys:
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.attributes_header"))
            for attr in source_keys:
                lines.append(i18n.t("kp_tools.character.sheet.attr_line", attr=attr, value=attrs[attr]))

        meters = character_resources(character)
        if meters:
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.status_header"))
            for meter in meters:
                lines.append(
                    i18n.t(
                        "kp_tools.character.sheet.meter_line",
                        label=meter["label"],
                        value=meter["value"],
                        max=meter["max"],
                    )
                )
        elif spec is None:
            hp, hp_max = get_hit_points(character)
            if hp_max:
                lines.append("")
                lines.append(i18n.t("kp_tools.character.sheet.status_header"))
                lines.append(i18n.t("kp_tools.character.sheet.meter_line", label="HP", value=hp, max=hp_max))

        field_lines = [
            i18n.t("kp_tools.character.sheet.field_line", name=name, value=value)
            for name, value in character.field_values().items()
            if value not in (None, "")
        ]
        if field_lines:
            lines.append("")
            lines.extend(field_lines)

        skill_entries = dict(character.skills)
        if pack is not None and spec is not None:
            # Untrained derived skills are not stored; surface their computed
            # values so the sheet reads complete.
            for skill_key in spec.derived_skills:
                if skill_key not in skill_entries:
                    skill_entries[skill_key] = sheet_value(character, pack, skill_key)
        if skill_entries:
            lines.append("")
            lines.append(i18n.t("kp_tools.character.sheet.skills_header"))
            for skill, value in sorted(skill_entries.items(), key=lambda item: item[1], reverse=True):
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

            pack = await _sheet_pack(self.services, ctx, character)
            canonical = pack.resolve_skill(skill_name) or skill_name

            had_value = has_check_value(character, pack, canonical)
            old_value = sheet_value(character, pack, canonical) if had_value else i18n.t("kp_tools.character.value_unset")
            set_sheet_value(character, pack, canonical, value)
            character, violations = validate_sheet(character, pack.system)
            new_value = sheet_value(character, pack, canonical)
            target_skill = canonical

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

            pack = await _sheet_pack(self.services, ctx, character)
            hp_field = attribute.strip().upper()
            canonical = pack.resolve_skill(attribute)
            if hp_field in {"HP", "HPMAX"}:
                hp, hp_max = get_hit_points(character)
                old_value = hp if hp_field == "HP" else hp_max
                if hp_field == "HP":
                    set_hit_points(character, current=value)
                else:
                    set_hit_points(character, maximum=value)
            elif canonical:
                old_value = sheet_value(character, pack, canonical)
                set_sheet_value(character, pack, canonical, value)
            else:
                old_value = character.attributes.get(attribute, i18n.t("kp_tools.character.value_unset"))
                character.attributes[attribute] = value

            character, violations = validate_sheet(character, pack.system)
            if hp_field in {"HP", "HPMAX"}:
                hp, hp_max = get_hit_points(character)
                new_value = hp if hp_field == "HP" else hp_max
            elif canonical:
                new_value = sheet_value(character, pack, canonical)
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
    """AI-KP tools for dice rolls, graded checks, HP management and dice pools."""

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
        """Run a skill check for the active character (attribute names and bridged skills resolve too).

        Args:
            skill_name: Skill or attribute name (CN/EN aliases supported).
            bonus: Count of the system's favorable roll modifier (bonus dice / advantage).
            penalty: Count of the system's unfavorable roll modifier (penalty dice / disadvantage).
            dc: Difficulty target, for systems whose checks roll against a declared DC; omit to use
                the system's default. Ignored by systems that roll against the sheet value.
            proficient: Whether the sheet's proficiency bonus applies (systems that declare one).
            params: Roll parameters for rule systems whose check declares them (e.g. a dice-pool
                size and threshold), as an integer mapping. Omit for systems that don't.
            actor: ONLY for a non-player actor: copy the NPC/creature's exact stated name, without
                added titles or roles. For a player character's check OMIT actor entirely — never
                send actor="" or the player's name.
            npc_target: Required with actor: the NPC's real check number — its skill/target value or
                its total check modifier, whichever this system's checks use — as a real integer.
                Omit for player checks — never send 0.
        """
        i18n = self.services.i18n.with_locale(ctx.locale)
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

            pack = await _sheet_pack(self.services, ctx, character)
            resolver = pack.resolver
            if resolver is None:
                return i18n.t("kp_tools.dice.skill_check.unknown_skill", name=skill_name)
            if resolver.params:
                return i18n.t("kp_tools.dice.pool.missing_param", param=resolver.params[0].id)
            check = resolver.check

            canonical = pack.resolve_skill(skill_name) or skill_name.strip()
            if not is_npc and not has_check_value(character, pack, canonical):
                # Unknown name (no alias, not on the sheet): refuse the roll
                # instead of running a degenerate target-0 check where a
                # minimal roll reads as a critical success.
                return i18n.t("kp_tools.dice.skill_check.unknown_skill", name=skill_name)
            sheet_check_value = None if is_npc else check_value(character, pack, canonical)

            # The pack routes the favorable/unfavorable counts to its declared
            # roll modifiers; opposing counts cancel (net), and the engine
            # replays multi-dice semantics for count-style modifiers.
            net_favor = bonus - penalty
            modifiers: dict[str, int] = {}
            favor_label = ""
            if net_favor > 0 and check.favorable:
                modifiers[check.favorable] = net_favor
                favor_label = pack.display_name(check.favorable, ctx.locale)
            elif net_favor < 0 and check.unfavorable:
                modifiers[check.unfavorable] = -net_favor
                favor_label = pack.display_name(check.unfavorable, ctx.locale)

            variant = await room_rule_variant(self.services.store, ctx.chat_key)
            rolled = dice.roll_for_check(resolver, modifiers=modifiers or None)

            if resolver.target_kind == "dc":
                # Roll + sheet modifier against an external difficulty target.
                target = int(dc) if dc is not None else int(check.default_target or 0)
                modifier = int(npc_target) if is_npc else int(sheet_check_value or 0)
                if not is_npc and proficient and check.proficiency:
                    modifier += sheet_value(character, pack, check.proficiency)
            else:
                # Roll against the sheet's own value as the target.
                target = int(npc_target) if is_npc else int(sheet_check_value or 0)
                modifier = 0

            outcome = resolver.interpret(rolled, target, variant=variant, modifier=modifier)
            level_label = pack.rank_label(outcome.rank.id, ctx.locale)
            skill_label = pack.display_name(canonical, ctx.locale)
            total = rolled.total + modifier

            prof_label = i18n.t("kp_tools.dice.skill_check.proficient_label") if proficient and check.proficiency else ""
            lines = [i18n.t("kp_tools.dice.skill_check.header", name=display_name, skill=skill_label, extra=prof_label)]
            if resolver.target_kind == "dc":
                if favor_label:
                    lines.append(
                        i18n.t("kp_tools.dice.skill_check.modifier_line", label=favor_label, count=abs(net_favor))
                    )
                lines.append(
                    i18n.t(
                        "kp_tools.dice.skill_check.roll_vs_line",
                        roll=rolled.total,
                        modifier=modifier,
                        total=total,
                        target=target,
                    )
                )
            else:
                target_line = i18n.t("kp_tools.dice.skill_check.target_line", value=target)
                if favor_label:
                    target_line += i18n.t(
                        "kp_tools.dice.skill_check.modifier_suffix", label=favor_label, count=abs(net_favor)
                    )
                lines.append(target_line)
                base_roll = int(rolled.modifiers.get("base_roll", rolled.total))
                lines.append(i18n.t("kp_tools.dice.skill_check.raw_roll_line", roll=base_roll))
                if favor_label and "final_tens" in rolled.modifiers:
                    lines.append(
                        i18n.t(
                            "kp_tools.dice.skill_check.tens_line",
                            label=favor_label,
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

            candidate_rolls = list(rolled.modifiers.get("dice_all", rolled.dice)) or [rolled.total]
            ctx.emit_dice(
                {
                    "kind": "check",
                    **({"actor": display_name} if actor and actor.strip() else {}),
                    "expr": skill_label,
                    "skill": canonical,
                    "rolls": candidate_rolls,
                    "total": total,
                    "target": target,
                    "effective_target": resolver.effective_target(target),
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
                canonical,
                outcome,
                label=level_label,
                actor=display_name if actor and actor.strip() else None,
                actor_is_npc=is_npc,
                bonus=bonus,
                penalty=penalty,
                modifier=modifier,
                **({"variant": variant} if variant else {}),
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

def roll_initiative(services: Services, character: CharacterSheet) -> DiceResult:
    """Roll the pack-declared initiative expression for `character`.

    ``{name}`` slots in the expression read the sheet's canonical values; a
    system with no declaration falls back to the engine's plain d100 order.
    """
    import re as _re

    try:
        pack = load_rulepack(character.system)
    except Exception:
        pack = None
    expression = pack.initiative_roll if pack is not None else ""
    if expression and pack is not None:
        filled = _re.sub(
            r"\{([^{}]+)\}",
            lambda match: str(sheet_value(character, pack, match.group(1))),
            expression,
        )
        return services.dice.roll_expression(filled, is_check=True)
    return services.dice.roll_expression("1d100", is_check=True)


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
                        initiative = roll_initiative(self.services, character).total

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
