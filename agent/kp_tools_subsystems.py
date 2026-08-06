"""Materialized subsystem tools — pack-declared names over generic engine templates.

The room's rulepack declares its extra mechanics in ``subsystems:`` (see
`core.subsystems`): each pack key becomes a KP TOOL of that name, in that room
only. This module is the engine half — one generic body per behavior template,
zero system vocabulary: every name, stat, table and label comes from the spec.

`subsystem_schemas(pack)` builds the function-calling schemas the loop appends
for the room; `dispatch_subsystem(...)` routes a tool call to its template
body (returning ``None`` for names the pack does not declare, so the caller
falls through to the static toolset). Both are keyed by the pack — a system
that declares nothing materializes nothing.
"""

from __future__ import annotations

from typing import Any

from agent.context import AgentCtx
from agent.services import Services, room_rule_variant
from core.character_manager import CharacterDataError, CharacterSheet
from core.check_outcome import RollDetail, outcome_wire
from core.luck import adjust_check_with_luck, find_latest_character_check, is_luck_eligible_check
from core.rulepacks import RulePack, load_rulepack
from core.subsystems import SubsystemSpec
from infra.i18n import I18n

_UNSET_CHARACTER_NAME = "default"


async def _active_character(services: Services, ctx: AgentCtx) -> CharacterSheet:
    return await services.characters.get_character(ctx.uid(), ctx.chat_key)


def _has_character(character: CharacterSheet | None) -> bool:
    return bool(character and character.name and character.name != _UNSET_CHARACTER_NAME)


async def room_rulepack(services: Services, ctx: AgentCtx) -> RulePack:
    """The rule system THIS room plays: the active character's system, falling
    back to the deployment's configured default pack."""
    system = ""
    try:
        character = await _active_character(services, ctx)
        if _has_character(character):
            system = character.system
    except Exception:
        system = ""
    try:
        return load_rulepack(system or services.settings.default_rulepack)
    except Exception:
        return load_rulepack(services.settings.default_rulepack)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

_TEMPLATE_PARAMETERS: dict[str, dict[str, Any]] = {
    "check_with_loss": {
        "type": "object",
        "properties": {
            "success_loss": {
                "type": "string",
                "description": "Loss dice expression applied on a successful check, e.g. \"0\", \"1\", \"1d4\".",  # i18n-exempt: model-facing tool schema text
            },
            "failure_loss": {
                "type": "string",
                "description": "Loss dice expression applied on a failed check, e.g. \"1d6\", \"1d100\".",  # i18n-exempt: model-facing tool schema text
            },
        },
        "required": ["success_loss", "failure_loss"],
    },
    "improvement_check": {
        "type": "object",
        "properties": {
            "skill_name": {"type": "string", "description": "The skill to attempt to improve."},  # i18n-exempt: model-facing tool schema text
        },
        "required": ["skill_name"],
    },
    "resource_spend_adjust": {
        "type": "object",
        "properties": {
            "points": {
                "type": "integer",
                "description": "Positive number of points to spend on adjusting the most recent eligible check.",  # i18n-exempt: model-facing tool schema text
            },
        },
        "required": ["points"],
    },
    "opposed": {
        "type": "object",
        "properties": {
            "skill1": {"type": "string", "description": "The active side's skill name."},  # i18n-exempt: model-facing tool schema text
            "skill2": {"type": "string", "description": "The passive side's skill name."},  # i18n-exempt: model-facing tool schema text
            "skill1_value": {"type": "integer", "description": "Override for the active side's skill value."},  # i18n-exempt: model-facing tool schema text
            "skill2_value": {"type": "integer", "description": "Override for the passive side's skill value."},  # i18n-exempt: model-facing tool schema text
        },
        "required": ["skill1", "skill2"],
    },
    "table_draw": {
        "type": "object",
        "properties": {
            "table": {"type": "string", "description": "Which table to draw from (id or alias)."},  # i18n-exempt: model-facing tool schema text
        },
        "required": [],
    },
}

# Model-facing tool schema descriptions — the same English-only convention as
# every @tool docstring (schemas are not user-visible UI text).
_TEMPLATE_SUMMARY = {
    "check_with_loss": (  # i18n-exempt: model-facing tool schema text
        "Roll this room's {label} check for the active character against their governing "  # i18n-exempt: model-facing tool schema text
        "attribute and apply the outcome's loss dice to it. Give both loss expressions from "  # i18n-exempt: model-facing tool schema text
        "the scene's stakes; the engine rolls, grades, deducts and reports."  # i18n-exempt: model-facing tool schema text
    ),
    "improvement_check": (  # i18n-exempt: model-facing tool schema text
        "Run a {label} roll for the active character: the skill improves when the roll beats "  # i18n-exempt: model-facing tool schema text
        "its current value, per this room's rule system."  # i18n-exempt: model-facing tool schema text
    ),
    "resource_spend_adjust": (  # i18n-exempt: model-facing tool schema text
        "Spend the active character's {label} points to adjust their most recent eligible "  # i18n-exempt: model-facing tool schema text
        "recorded check — the only correct way to apply such an adjustment: it deterministically "  # i18n-exempt: model-facing tool schema text
        "lowers the existing roll, never rerolls."  # i18n-exempt: model-facing tool schema text
    ),
    "opposed": (  # i18n-exempt: model-facing tool schema text
        "Run a {label}: both sides roll this room's check and the higher outcome tier wins "  # i18n-exempt: model-facing tool schema text
        "(raw values break ties)."  # i18n-exempt: model-facing tool schema text
    ),
    "table_draw": "Draw one random {label} entry from this room's rule-system tables.",  # i18n-exempt: model-facing tool schema text
}


def subsystem_schemas(pack: RulePack) -> list[dict[str, Any]]:
    """Function-calling schemas for every subsystem tool `pack` declares."""
    schemas: list[dict[str, Any]] = []
    for name, spec in pack.subsystems.items():
        parameters = _TEMPLATE_PARAMETERS.get(spec.template)
        summary = _TEMPLATE_SUMMARY.get(spec.template)
        if parameters is None or summary is None:
            continue
        description = summary.format(label=spec.label("en"))
        if spec.template == "table_draw" and spec.tables:
            table_words = ", ".join(table.id for table in spec.tables)
            description += f" Tables: {table_words}."
        schemas.append(
            {
                "type": "function",
                "function": {"name": name, "description": description, "parameters": parameters},
            }
        )
    return schemas


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


async def dispatch_subsystem(
    services: Services, ctx: AgentCtx, pack: RulePack, name: str, arguments: dict[str, Any]
) -> str | None:
    """Run subsystem tool `name` if `pack` declares it; ``None`` otherwise."""
    spec = pack.subsystems.get(name)
    if spec is None:
        return None
    i18n = services.i18n.with_locale(ctx.locale)
    arguments = arguments or {}
    try:
        if spec.template == "check_with_loss":
            return await _run_check_with_loss(
                services,
                ctx,
                i18n,
                spec,
                str(arguments.get("success_loss", "0")),
                str(arguments.get("failure_loss", "0")),
            )
        if spec.template == "improvement_check":
            return await _run_improvement_check(services, ctx, i18n, spec, str(arguments.get("skill_name", "")))
        if spec.template == "resource_spend_adjust":
            return await _run_resource_spend(services, ctx, i18n, spec, arguments.get("points"))
        if spec.template == "opposed":
            return await _run_opposed(services, ctx, i18n, spec, arguments)
        if spec.template == "table_draw":
            return await _run_table_draw(services, ctx, i18n, spec, str(arguments.get("table", "")))
    except CharacterDataError:
        return i18n.t("kp_tools.character.data_error")
    except Exception as exc:
        return i18n.t("kp_tools.subsystem.failed", label=spec.label(ctx.locale), error=str(exc))
    return None


async def _run_check_with_loss(
    services: Services, ctx: AgentCtx, i18n: I18n, spec: SubsystemSpec, success_loss: str, failure_loss: str
) -> str:
    character = await _active_character(services, ctx)
    if not _has_character(character):
        return i18n.t("kp_tools.character.none")
    pack = load_rulepack(character.system)
    if pack.subsystems.get(spec.id) is not spec and spec.id not in pack.subsystems:
        return i18n.t("kp_tools.subsystem.not_declared", label=spec.label(ctx.locale))
    resolver = pack.resolver
    if resolver is None:
        return i18n.t("kp_tools.subsystem.not_declared", label=spec.label(ctx.locale))
    label = spec.label(ctx.locale)
    dice = services.dice

    stat_value = int(character.attributes.get(spec.stat, 0) or 0)
    variant = await room_rule_variant(services.store, ctx.chat_key)
    rolled = dice.roll_for_check(resolver)
    outcome = resolver.interpret(rolled, stat_value, variant=variant)

    loss_expr = success_loss if outcome.rank.success else failure_loss
    loss_result = dice.roll_expression(loss_expr)
    loss = loss_result.total
    if outcome.rank.fumble:
        if spec.fumble_loss == "all":
            loss = stat_value
        elif spec.fumble_loss == "max":
            loss = _expression_maximum(dice, loss_expr, fallback=loss)

    new_value = max(0, stat_value - loss)
    character.attributes[spec.stat] = new_value
    await services.characters.save_character(ctx.uid(), ctx.chat_key, character)

    level_label = pack.rank_label(outcome.rank.id, ctx.locale)
    stat_max = int(character.attributes.get(spec.stat_max, 0) or 0) if spec.stat_max else 0
    record_kwargs = {
        "label": level_label,
        "loss_expr": loss_expr,
        "loss": loss,
        "stat_before": stat_value,
        "stat_after": new_value,
    }
    if variant:
        record_kwargs["variant"] = variant
    await _record_subsystem_check(services, ctx, character.name, spec.stat, outcome, **record_kwargs)
    ctx.emit_dice(
        {
            "kind": "subsystem",
            "subsystem": spec.id,
            "expr": spec.stat,
            "rolls": [rolled.total],
            "total": rolled.total,
            "target": stat_value,
            "effective_target": resolver.effective_target(stat_value),
            "outcome": outcome_wire(outcome, level_label),
            "detail": {
                **dict(rolled.modifiers),
                "loss_expr": loss_expr,
                "loss": loss,
                "remaining": new_value,
                **({"resource_max": stat_max} if stat_max else {}),
            },
        }
    )
    header_key = (
        "kp_tools.subsystem.loss.header_success" if outcome.rank.success else "kp_tools.subsystem.loss.header_failure"
    )
    lines = [
        i18n.t(header_key, name=character.name, label=label),
        i18n.t("kp_tools.subsystem.loss.roll_line", label=label, value=stat_value, roll=rolled.total),
        i18n.t("kp_tools.subsystem.loss.result_line", level=level_label),
        i18n.t(
            "kp_tools.subsystem.loss.loss_line",
            loss=loss,
            expr=loss_expr,
            detail=loss_result.format_result(i18n=i18n),
        ),
        i18n.t("kp_tools.subsystem.loss.remaining_line", label=label, value=new_value, maximum=stat_max),
    ]
    return "\n".join(lines)


async def _run_improvement_check(
    services: Services, ctx: AgentCtx, i18n: I18n, spec: SubsystemSpec, skill_name: str
) -> str:
    character = await _active_character(services, ctx)
    if not _has_character(character):
        return i18n.t("kp_tools.character.none")

    standard_name = services.characters.find_skill_by_alias(character, skill_name)
    target_skill = standard_name if standard_name else skill_name
    skill_value = int(character.skills.get(target_skill, 0) or 0)

    if skill_value >= spec.cap:
        return i18n.t("kp_tools.subsystem.improve.maxed", skill=target_skill, value=skill_value)

    roll = services.dice.roll_expression(spec.roll).total
    auto_above = spec.auto_success_above
    if roll > skill_value or (auto_above is not None and roll > auto_above):
        growth = services.dice.roll_expression(spec.improve).total
        old_value = skill_value
        new_value = min(spec.cap, skill_value + growth)
        character.skills[target_skill] = new_value
        await services.characters.save_character(ctx.uid(), ctx.chat_key, character)
        return i18n.t(
            "kp_tools.subsystem.improve.success",
            name=character.name,
            skill=target_skill,
            roll=roll,
            old=old_value,
            new=new_value,
            delta=new_value - old_value,
        )
    return i18n.t(
        "kp_tools.subsystem.improve.failure",
        name=character.name,
        skill=target_skill,
        roll=roll,
        value=skill_value,
    )


async def _run_resource_spend(
    services: Services, ctx: AgentCtx, i18n: I18n, spec: SubsystemSpec, points_raw: Any
) -> str:
    label = spec.label(ctx.locale)
    if isinstance(points_raw, bool) or not isinstance(points_raw, int) or points_raw <= 0:
        try:
            points = int(points_raw)
        except (TypeError, ValueError):
            return i18n.t("kp_tools.subsystem.spend.invalid_points", label=label)
        if isinstance(points_raw, bool) or points <= 0:
            return i18n.t("kp_tools.subsystem.spend.invalid_points", label=label)
    else:
        points = points_raw

    active_character = await _active_character(services, ctx)
    if not _has_character(active_character):
        return i18n.t("kp_tools.character.none")
    pack = load_rulepack(active_character.system)
    if spec.id not in pack.subsystems or pack.resolver is None:
        return i18n.t("kp_tools.subsystem.not_declared", label=label)
    resolver = pack.resolver

    session_key = "session_record.current"
    for _attempt in range(2):
        sheet_doc = await services.documents.get(ctx.chat_key, "sheet", active_character.name)
        raw_session = await services.store.state_get(ctx.chat_key, session_key)
        if raw_session is None:
            return i18n.t("kp_tools.subsystem.spend.no_session", label=label)
        if sheet_doc is None or sheet_doc.corrupt:
            return i18n.t("kp_tools.character.none")

        import json as _json

        from core.battle_report import SessionRecord

        character = CharacterSheet.from_dict(sheet_doc.data)
        available = int(character.attributes.get(spec.stat, 0) or 0)
        if points > available:
            return i18n.t(
                "kp_tools.subsystem.spend.insufficient", label=label, points=points, available=available
            )

        record = SessionRecord.from_dict(_json.loads(raw_session))
        check = find_latest_character_check(record.skill_checks, ctx.uid(), character.name)
        if check is None:
            return i18n.t("kp_tools.subsystem.spend.no_check", label=label)
        if not is_luck_eligible_check(check):
            return i18n.t("kp_tools.subsystem.spend.ineligible", label=label, skill=check.get("skill", ""))

        check_variant = str(check.get("variant", "") or "") or None
        check_difficulty = str(check.get("difficulty", "") or "") or None
        check_target = int(check["target"])

        def _grade(
            roll_value: int,
            *,
            _resolver=resolver,
            _target=check_target,
            _variant=check_variant,
            _difficulty=check_difficulty,
        ):
            return _resolver.interpret(
                RollDetail(_resolver.roll, (roll_value,), roll_value),
                _target,
                variant=_variant,
                difficulty=_difficulty,
            ).rank

        try:
            adjustment = adjust_check_with_luck(check, points, grade=_grade)
        except ValueError as exc:
            code = str(exc)
            if code == "luck_cannot_adjust_fumble":
                return i18n.t("kp_tools.subsystem.spend.fumble", label=label)
            if code == "luck_points_exceed_roll":
                return i18n.t(
                    "kp_tools.subsystem.spend.exceeds_roll",
                    label=label,
                    points=points,
                    roll=int(check["roll"]),
                    max=int(check["roll"]) - 1,
                )
            raise

        remaining = available - points
        character.attributes[spec.stat] = remaining
        check["luck_before"] = available
        check["luck_after"] = remaining
        record.rebuild_player_stats()

        new_session = _json.dumps(record.to_dict(), ensure_ascii=False)
        updated = await services.store.state_set_if_values(
            ctx.chat_key,
            expected=[(session_key, raw_session)],
            updates=[(session_key, new_session)],
        )
        if not updated:
            continue
        await services.documents.put(
            ctx.chat_key,
            "sheet",
            active_character.name,
            dict(character.to_dict(), owner=sheet_doc.data.get("owner", ctx.uid())),
        )

        after_label = pack.rank_label(adjustment.after.id, ctx.locale)
        check["label"] = after_label
        after_outcome = resolver.interpret(
            RollDetail(resolver.roll, (adjustment.after_roll,), adjustment.after_roll),
            check_target,
            variant=check_variant,
            difficulty=check_difficulty,
        )
        ctx.emit_dice(
            {
                "kind": "subsystem",
                "subsystem": spec.id,
                "expr": spec.stat,
                "rolls": [adjustment.after_roll],
                "total": adjustment.after_roll,
                "target": check_target,
                "outcome": outcome_wire(after_outcome, after_label),
                "detail": {
                    "points": points,
                    "raw_roll": int(check["roll"]) + points,
                    "remaining": remaining,
                },
            }
        )
        return i18n.t(
            "kp_tools.subsystem.spend.done",
            label=label,
            name=character.name,
            points=points,
            skill=check.get("skill", ""),
            before=adjustment.before_roll,
            after=adjustment.after_roll,
            level=after_label,
            remaining=remaining,
        )
    return i18n.t("kp_tools.subsystem.spend.conflict", label=label)


async def _run_opposed(
    services: Services, ctx: AgentCtx, i18n: I18n, spec: SubsystemSpec, arguments: dict[str, Any]
) -> str:
    character = await _active_character(services, ctx)
    if not _has_character(character):
        return i18n.t("kp_tools.character.none")
    pack = load_rulepack(character.system)
    resolver = pack.resolver
    if spec.id not in pack.subsystems or resolver is None:
        return i18n.t("kp_tools.subsystem.not_declared", label=spec.label(ctx.locale))

    skill1 = str(arguments.get("skill1", ""))
    skill2 = str(arguments.get("skill2", ""))
    skill1_value = arguments.get("skill1_value")
    skill2_value = arguments.get("skill2_value")
    s1 = services.characters.get_skill_value(character, skill1) if skill1_value is None else int(skill1_value)
    s2 = int(character.skills.get(skill2, 50)) if skill2_value is None else int(skill2_value)

    variant = await room_rule_variant(services.store, ctx.chat_key)
    rolled1 = services.dice.roll_for_check(resolver)
    rolled2 = services.dice.roll_for_check(resolver)
    outcome1 = resolver.interpret(rolled1, s1, variant=variant)
    outcome2 = resolver.interpret(rolled2, s2, variant=variant)
    name1 = pack.rank_label(outcome1.rank.id, ctx.locale)
    name2 = pack.rank_label(outcome2.rank.id, ctx.locale)

    if outcome1.rank.tier > outcome2.rank.tier:
        winner = i18n.t("kp_tools.dice.opposed.winner_active", skill=skill1)
    elif outcome2.rank.tier > outcome1.rank.tier:
        winner = i18n.t("kp_tools.dice.opposed.winner_passive", skill=skill2)
    elif s1 > s2:
        winner = i18n.t("kp_tools.dice.opposed.winner_active_tiebreak", skill=skill1)
    elif s2 > s1:
        winner = i18n.t("kp_tools.dice.opposed.winner_passive_tiebreak", skill=skill2)
    else:
        winner = i18n.t("kp_tools.dice.opposed.tie")

    lines = [
        i18n.t("kp_tools.dice.opposed.header", skill1=skill1, skill2=skill2),
        i18n.t("kp_tools.dice.opposed.active_line", skill=skill1, value=s1, roll=rolled1.total, level=name1),
        i18n.t("kp_tools.dice.opposed.passive_line", skill=skill2, value=s2, roll=rolled2.total, level=name2),
        i18n.t("kp_tools.dice.opposed.result_line", winner=winner),
    ]
    return "\n".join(lines)


async def _run_table_draw(
    services: Services, ctx: AgentCtx, i18n: I18n, spec: SubsystemSpec, table_ref: str
) -> str:
    table = spec.table(table_ref)
    if table is None:
        known = ", ".join(entry.id for entry in spec.tables)
        return i18n.t("kp_tools.subsystem.draw.unknown_table", label=spec.label(ctx.locale), known=known)
    index = services.dice.roll_expression(f"1d{len(table.entries)}").total - 1
    entry = table.entries[max(0, min(index, len(table.entries) - 1))]
    base = str(ctx.locale or "en").replace("_", "-").split("-")[0].casefold()
    table_label = table.display.get(base) or table.display.get("en") or table.id
    return i18n.t("kp_tools.subsystem.draw.result", table=table_label, entry=entry)


def _expression_maximum(dice: Any, expression: str, *, fallback: int) -> int:
    """The maximum total the loss expression can roll (RAW "take the max" fumble
    policy): sampled deterministically by re-rolling under a max-biased seedless
    path is not available, so approximate structurally — NdM(+K) maximizes to
    N*M(+K); anything unparsable keeps the actually-rolled fallback."""
    import re as _re

    match = _re.fullmatch(r"\s*(\d*)[dD](\d+)\s*(?:\+\s*(\d+))?\s*", str(expression))
    if not match:
        try:
            return max(int(str(expression).strip()), fallback)
        except ValueError:
            return fallback
    count = int(match.group(1) or 1)
    faces = int(match.group(2))
    bonus = int(match.group(3) or 0)
    return count * faces + bonus


async def _record_subsystem_check(
    services: Services, ctx: AgentCtx, actor: str, expr: str, outcome, **extra: Any
) -> None:
    """Best-effort session recording, mirroring DiceTools._record_check."""
    try:
        await services.battles.add_skill_check(
            ctx.chat_key,
            ctx.uid(),
            actor,
            expr,
            outcome.target if outcome.target is not None else 0,
            outcome.rolled.total,
            success=outcome.rank.success,
            rank_id=outcome.rank.id,
            tier=outcome.rank.tier,
            **extra,
        )
    except Exception:
        pass
