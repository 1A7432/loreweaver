"""Dice and checks: `.r` / `.rh` / `.ra` / `.rav` / `.sc` / `.init` / `.jrrp` / `.draw`, the
shared check lane (`_cmd_check_generic`) and inline `[[…]]` rolls, plus their parsers."""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from typing import Any

from agent.kp_tools_mechanics import InitiativeTools, roll_initiative
from agent.services import Services, room_rule_variant
from core.battle_recording import record_check, record_dice_roll
from core.character_manager import (
    CharacterSheet,
)
from core.check_outcome import CheckOutcome, outcome_wire
from core.dice_engine import DiceResult
from core.resolution import InvalidRollParamError, MissingRollParamError, ResolutionError
from core.rulepacks import RulePack, load_rulepack
from core.sheets import check_value, set_sheet_value, sheet_value
from gateway.commands.types import CommandCtx
from infra.i18n import I18n, get_i18n

_INLINE_RE = re.compile(r"\[\[([^\[\]]+)\]\]")
_MULTI_PREFIX_RE = re.compile(r"^\s*(\d{1,2})[#＃]\s*(.*)$", re.S)
_TRAILING_NUMBER_RE = re.compile(r"^(.+?)(\d{1,3})$")
_EXPLODE_BANG_RE = re.compile(r"(\d*d(\d+))!", re.I)

# Generic favorable/unfavorable/proficiency command words for check arguments.
# The words route to whatever roll modifiers the room pack's `resolution.check`
# declares; game-term vocabulary, exempt from i18n.
_FAVOR_WORDS = {"adv", "advantage", "优势", "優勢"}
_DISFAVOR_WORDS = {"dis", "disadvantage", "劣势", "劣勢"}
_PROF_WORDS = {"prof", "proficient", "proficiency", "熟练", "熟練"}


@dataclass
class _ParsedCheck:
    name: str
    canonical: str
    difficulty: str | None = None
    bonus: int = 0
    penalty: int = 0
    proficient: bool = False
    temp_value: int | None = None
    remaining: str = ""


def _format_roll(result: DiceResult, i18n: I18n) -> str:
    return result.format_result(i18n=i18n)


def _dice_result_fields(result: DiceResult) -> dict[str, Any]:
    """Public structured fields from the exact ``DiceResult`` already rendered."""
    return {
        "expr": result.expression,
        "rolls": list(result.rolls),
        "total": result.total,
        "detail": {
            "modifier": result.modifier,
            "critical_success": result.is_critical_success(),
            "critical_failure": result.is_critical_failure(),
        },
    }


def _event_side(name: str, outcome: CheckOutcome, label: str, total: int) -> dict[str, Any]:
    return {
        "name": name,
        "target": outcome.target,
        # The number this side actually brought to the contest (a dc-kind system
        # folds the sheet value into it), so the frame agrees with the grading.
        "total": total,
        "outcome": outcome_wire(outcome, label),
    }


def _resolution_notice(i18n: I18n, exc: ResolutionError) -> str:
    """A localized, actionable reply for a check the rule system cannot roll."""
    if isinstance(exc, MissingRollParamError):
        return i18n.t("kp_tools.dice.pool.missing_param", param=exc.param)
    if isinstance(exc, InvalidRollParamError):
        return i18n.t(
            "kp_tools.dice.pool.out_of_range", param=exc.param, minimum=exc.minimum, maximum=exc.maximum
        )
    return i18n.t("runner.error")


def _normalize_roll_expression(expression: str) -> str:
    text = expression.strip() or "1d20"
    return _EXPLODE_BANG_RE.sub(lambda match: f"{match.group(1)}e{match.group(2)}", text)


def _roll_expression(services: Services, expression: str) -> DiceResult:
    mode, expr = _extract_roll_mode(expression)
    expr = _normalize_roll_expression(expr)
    if mode == "adv":
        return services.dice.roll_advantage(expr, is_check=True)
    if mode == "dis":
        return services.dice.roll_disadvantage(expr, is_check=True)
    return services.dice.roll_expression(expr)


def _extract_roll_mode(expression: str) -> tuple[str, str]:
    tokens = expression.split()
    if not tokens:
        return "", "1d20"
    first = tokens[0].casefold()
    last = tokens[-1].casefold()
    if first in _FAVOR_WORDS:
        return "adv", " ".join(tokens[1:]) or "1d20"
    if first in _DISFAVOR_WORDS:
        return "dis", " ".join(tokens[1:]) or "1d20"
    if last in _FAVOR_WORDS:
        return "adv", " ".join(tokens[:-1]) or "1d20"
    if last in _DISFAVOR_WORDS:
        return "dis", " ".join(tokens[:-1]) or "1d20"
    return "", expression


def _split_multi(args: str) -> tuple[int, str]:
    match = _MULTI_PREFIX_RE.match(args)
    if not match:
        return 1, args.strip() or "1d20"
    return max(1, int(match.group(1))), match.group(2).strip() or "1d20"


def _parse_check_args(
    text: str, pack: RulePack, default_name: str = "", *, split_loss: bool = False
) -> _ParsedCheck:
    """Parse one check-command argument string against `pack`'s vocabulary:
    b/p modifier counts, favorable/unfavorable/proficiency words, pack-declared
    difficulty prefixes, and a trailing number as this check's target override.
    ``split_loss`` (loss-rolling subsystem commands) keeps a `/`-bearing tail
    intact in ``remaining`` instead of reading it as the stat name."""
    rest = text.strip() or default_name
    bonus = 0
    penalty = 0
    proficient = False
    rest, bonus, penalty = _consume_bonus_penalty(rest, bonus, penalty)
    difficulty, rest = _consume_difficulty(rest, pack)
    rest, bonus, penalty = _consume_bonus_penalty(rest, bonus, penalty)

    kept_tokens = []
    for token in rest.split():
        word = token.casefold()
        if word in _FAVOR_WORDS:
            bonus += 1
        elif word in _DISFAVOR_WORDS:
            penalty += 1
        elif word in _PROF_WORDS:
            proficient = True
        else:
            kept_tokens.append(token)
    rest = " ".join(kept_tokens)

    name_text = rest.strip() or default_name
    remaining = ""
    if split_loss and "/" in name_text:
        name_text, remaining = default_name, name_text

    temp_value = None
    if remaining == "":
        match = _TRAILING_NUMBER_RE.match(name_text)
        if match and not match.group(1).strip().isdigit():
            name_text = match.group(1).strip()
            temp_value = int(match.group(2))

    canonical = pack.resolve_skill(name_text) or name_text
    return _ParsedCheck(
        name=canonical,
        canonical=canonical,
        difficulty=difficulty,
        bonus=bonus,
        penalty=penalty,
        proficient=proficient,
        temp_value=temp_value,
        remaining=remaining,
    )


def _target_value(character: CharacterSheet, pack: RulePack, canonical: str, temp_value: int | None) -> int:
    """The roll-under target for one check: an explicit per-check override wins,
    else the sheet's check value for the canonical name."""
    if temp_value is not None:
        return temp_value
    return check_value(character, pack, canonical)


async def _pack_for_character(ctx: CommandCtx, character: CharacterSheet) -> RulePack:
    """The rulepack governing `character`: its own system when resolvable,
    falling back to the ROOM's active pack (bare/unset sheets)."""
    try:
        return load_rulepack(character.system)
    except Exception:

        return await ctx.services.room_rulepack(ctx.raw_ctx)


def _consume_bonus_penalty(text: str, bonus: int, penalty: int) -> tuple[str, int, int]:
    rest = text.strip()
    while rest:
        parts = rest.split(maxsplit=1)
        token = parts[0]
        token_cf = token.casefold()
        if re.fullmatch(r"b\d*", token_cf):
            bonus += int(token_cf[1:] or "1")
            rest = parts[1] if len(parts) > 1 else ""
            continue
        if re.fullmatch(r"p\d*", token_cf):
            penalty += int(token_cf[1:] or "1")
            rest = parts[1] if len(parts) > 1 else ""
            continue
        if len(token) > 1 and token[0].casefold() in {"b", "p"} and not token[1].isascii():
            amount = 1
            if token[0].casefold() == "b":
                bonus += amount
            else:
                penalty += amount
            rest = f"{token[1:]} {parts[1] if len(parts) > 1 else ''}".strip()
            continue
        break
    return rest, bonus, penalty


def _consume_difficulty(text: str, pack: RulePack) -> tuple[str | None, str]:
    """Match a leading difficulty word against the pack's OWN declared dialect
    (`resolution.difficulties[*].prefixes`, all locales) — the engine holds no
    difficulty vocabulary of its own."""
    rest = text.strip()
    resolver = pack.resolver
    if resolver is None:
        return None, rest
    parts = rest.split(maxsplit=1)
    first_word = parts[0].casefold() if parts else ""
    for difficulty in resolver.difficulties:
        for words in difficulty.prefixes.values():
            for word in words:
                if not word:
                    continue
                if word.isascii():
                    if first_word == word.casefold():
                        return difficulty.id, parts[1].strip() if len(parts) > 1 else ""
                elif rest.startswith(word):
                    return difficulty.id, rest[len(word):].strip()
    return None, rest


def _signed(value: int) -> str:
    return f"+{value}" if value >= 0 else str(value)


def _split_two_args(text: str) -> tuple[str, str]:
    if "," in text:
        left, right = text.split(",", 1)
        return left.strip(), right.strip()
    parts = text.split()
    if len(parts) >= 2:
        return parts[0], " ".join(parts[1:])
    return text.strip(), ""


def _parse_sanity_loss(text: str) -> tuple[str, str]:
    rest = text.strip()
    if "/" in rest:
        success, failure = rest.split("/", 1)
        return success.strip() or "0", failure.strip() or "0"
    return "0", rest or "1"


def _roll_loss(services: Services, expression: str) -> int:
    text = expression.strip() or "0"
    if re.fullmatch(r"[+-]?\d+", text):
        return max(0, int(text))
    return max(0, services.dice.roll_expression(text).total)


async def _get_rule_variant(ctx: CommandCtx) -> str | None:
    return await room_rule_variant(ctx.services.store, ctx.chat_key)


def _variant_display(variant: str | None) -> str:
    """The community short form for a ladder-variant id (rule2 -> "2", dg stays)."""
    if not variant:
        return "0"
    return variant[4:] if variant.startswith("rule") and variant[4:].isdigit() else variant


class ChecksCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_roll(self, ctx: CommandCtx) -> str:
        args = ctx.args or "1d20"
        times, expression = _split_multi(args)
        times = min(times, 20)
        lines = []
        results: list[DiceResult] = []
        try:
            for _ in range(times):
                result = _roll_expression(ctx.services, expression)
                lines.append(ctx.i18n.t("commands.roll.result", result=_format_roll(result, ctx.i18n)))
                results.append(result)
        except ValueError:
            return ctx.i18n.t("commands.roll.invalid", expr=expression)
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        for result in results:
            ctx.dice("roll", **_dice_result_fields(result))
            await record_dice_roll(
                ctx.services.battles,
                ctx.chat_key,
                ctx.user_id,
                character.name,
                expression,
                result,
            )
        return "\n".join(lines)

    async def cmd_hidden_roll(self, ctx: CommandCtx) -> str:
        expression = ctx.args or "1d20"
        try:
            result = _roll_expression(ctx.services, expression)
        except ValueError:
            return ctx.i18n.t("commands.roll.invalid", expr=expression)
        ctx.dice("roll", **_dice_result_fields(result))
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        # A hidden roll (`.rh`) is unicast to the roller only; it MUST be recorded
        # as hidden so `.report detailed` (player-facing, ungated) can never replay
        # the secret result or even count it in the statistics.
        await record_dice_roll(
            ctx.services.battles,
            ctx.chat_key,
            ctx.user_id,
            character.name,
            expression,
            result,
            hidden=True,
        )
        return ctx.i18n.t("commands.roll.hidden", result=_format_roll(result, ctx.i18n))

    async def cmd_check(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        return await self._cmd_check_generic(ctx, character)

    async def cmd_opposed(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = await _pack_for_character(ctx, character)
        resolver = pack.resolver
        if resolver is None:
            return ctx.i18n.t("commands.pack_word.not_in_system", word=ctx.spec.canonical)
        default_skill = resolver.check.default_skill
        args = ctx.args or default_skill
        left_text, right_text = _split_two_args(args)
        left = _parse_check_args(left_text or default_skill, pack)
        right = _parse_check_args(right_text or left.name, pack)
        variant = await _get_rule_variant(ctx)
        left_value = _target_value(character, pack, left.canonical, left.temp_value)
        right_value = _target_value(character, pack, right.canonical, right.temp_value)
        left_rolled = ctx.services.dice.roll_for_check(resolver)
        right_rolled = ctx.services.dice.roll_for_check(resolver)
        is_contest_of_totals = resolver.target_kind == "dc"
        if is_contest_of_totals:
            # Modifier-vs-modifier systems: each side's check value folds into
            # its roll, and the number it has to beat is the OPPOSING total — a
            # contest declares no external difficulty. (Passing None here graded
            # both sides against a silently-substituted 0, so `roll >= target`
            # was a tautology and ~82% of contests reported a tie — audit F08.)
            left_score = left_rolled.total + left_value
            right_score = right_rolled.total + right_value
            left_outcome = resolver.interpret(left_rolled, right_score, variant=variant, modifier=left_value)
            right_outcome = resolver.interpret(right_rolled, left_score, variant=variant, modifier=right_value)
        else:
            # Roll-under systems: the sheet value IS each side's target, so the
            # roll totals are not comparable across sides — rank tier decides.
            left_score, right_score = left_rolled.total, right_rolled.total
            left_outcome = resolver.interpret(left_rolled, left_value, variant=variant, difficulty=left.difficulty)
            right_outcome = resolver.interpret(right_rolled, right_value, variant=variant, difficulty=right.difficulty)
        left_rank, right_rank = left_outcome.rank, right_outcome.rank
        # Rank tier first (a nat-crit beats a bigger total), then the totals, then
        # a genuine tie — what the comment above has always promised.
        if left_rank.tier != right_rank.tier:
            left_wins = left_rank.tier > right_rank.tier
        elif is_contest_of_totals and left_score != right_score:
            left_wins = left_score > right_score
        else:
            left_wins = None
        if left_wins is None:
            winner, winner_side = ctx.i18n.t("commands.opposed.tie"), "tie"
        elif left_wins:
            winner, winner_side = ctx.i18n.t("commands.opposed.left"), "left"
        else:
            winner, winner_side = ctx.i18n.t("commands.opposed.right"), "right"
        left_name = pack.display_name(left.canonical, ctx.locale)
        right_name = pack.display_name(right.canonical, ctx.locale)
        left_label = pack.rank_label(left_rank.id, ctx.locale)
        right_label = pack.rank_label(right_rank.id, ctx.locale)
        ctx.dice(
            "opposed",
            expr=f"{left_name} vs {right_name}",
            rolls=[left_rolled.total, right_rolled.total],
            total=left_score,
            # The number the grading actually compared against, never a sheet
            # value the ladder never saw.
            target=left_outcome.target,
            outcome=outcome_wire(left_outcome, left_label),
            detail={
                "winner": winner_side,
                "left": _event_side(left_name, left_outcome, left_label, left_score),
                "right": _event_side(right_name, right_outcome, right_label, right_score),
            },
        )
        return ctx.i18n.t(
            "commands.opposed.result",
            left=left_name,
            left_roll=left_score,
            left_rank=left_label,
            right=right_name,
            right_roll=right_score,
            right_rank=right_label,
            winner=winner,
        )

    async def cmd_sanity(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = await _pack_for_character(ctx, character)
        loss_spec = next(
            (spec for spec in pack.subsystems.values() if spec.template == "check_with_loss"), None
        )
        if loss_spec is None or pack.resolver is None:
            return ctx.i18n.t("commands.pack_word.not_in_system", word=ctx.spec.canonical)
        stat_canonical = pack.resolve_skill(loss_spec.stat) or loss_spec.stat
        parsed = _parse_check_args(ctx.args or "0/1", pack, default_name=stat_canonical, split_loss=True)
        loss_text = parsed.remaining or ctx.args or "0/1"
        success_loss, failure_loss = _parse_sanity_loss(loss_text)
        san = sheet_value(character, pack, stat_canonical)
        variant = await _get_rule_variant(ctx)
        resolver = pack.resolver
        rolled = ctx.services.dice.roll_for_check(
            resolver, modifiers={"bonus": parsed.bonus, "penalty": parsed.penalty}
        )
        outcome = resolver.interpret(rolled, san, variant=variant, difficulty=parsed.difficulty)
        label = pack.rank_label(outcome.rank.id, ctx.locale)
        loss_expr = success_loss if outcome.rank.success else failure_loss
        # A non-numeric SAN-loss expression (e.g. `.sc 侦查/侦查`) must not crash the turn.
        try:
            loss = _roll_loss(ctx.services, loss_expr)
        except ValueError:
            return ctx.i18n.t("commands.roll.invalid", expr=loss_expr)
        set_sheet_value(character, pack, stat_canonical, max(0, san - loss))
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        ctx.dice(
            "subsystem",
            subsystem=loss_spec.id,
            expr=pack.display_name(parsed.canonical, ctx.locale),
            rolls=[rolled.total],
            total=rolled.total,
            target=san,
            outcome=outcome_wire(outcome, label),
            detail={
                **dict(rolled.modifiers),
                "loss_expr": loss_expr,
                "loss": loss,
                "remaining": max(0, san - loss),
            },
        )
        await record_check(
            ctx.services.battles,
            ctx.chat_key,
            ctx.user_id,
            character.name,
            "SAN",
            outcome,
            label=label,
            loss_expr=loss_expr,
            loss=loss,
            stat_before=san,
            stat_after=max(0, san - loss),
            **({"variant": variant} if variant else {}),
            **({"difficulty": parsed.difficulty} if parsed.difficulty else {}),
        )
        return ctx.i18n.t(
            "commands.sanity.result",
            roll=rolled.total,
            rank=label,
            loss=loss,
            san=max(0, san - loss),
        )

    async def cmd_initiative(self, ctx: CommandCtx) -> str:
        action = ctx.args.strip().casefold()
        if action in {"", "show", "list"}:
            return await InitiativeTools(ctx.services).initiative_tracker(ctx.raw_ctx, action="list")
        if action in {"next", "clear"}:
            return await InitiativeTools(ctx.services).initiative_tracker(ctx.raw_ctx, action=action)

        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        result = roll_initiative(ctx.services, character)
        ctx.dice("init", name=character.name, **_dice_result_fields(result))
        return ctx.i18n.t("commands.init.result", name=character.name, result=_format_roll(result, ctx.i18n))

    async def cmd_jrrp(self, ctx: CommandCtx) -> str:
        luck = await ctx.services.characters.get_daily_luck(ctx.user_id)
        return ctx.i18n.t("commands.jrrp.result", luck=luck)

    async def cmd_draw(self, ctx: CommandCtx) -> str:
        deck = [
            ctx.i18n.t("commands.draw.card_1"),
            ctx.i18n.t("commands.draw.card_2"),
            ctx.i18n.t("commands.draw.card_3"),
            ctx.i18n.t("commands.draw.card_4"),
        ]
        card = deck[random.randrange(len(deck))]
        return ctx.i18n.t("commands.draw.result", card=card)

    async def _cmd_check_generic(self, ctx: CommandCtx, character: CharacterSheet) -> str:
        """One check command for every system, shaped entirely by the pack:
        ``target_kind`` picks whether the sheet value IS the target (roll-under
        family) or folds into the roll as a modifier against an explicit target
        (d20 family; a bare command shows the roll ungraded), and the parsed
        favorable/unfavorable counts route to the pack's declared modifiers."""
        pack = await _pack_for_character(ctx, character)
        resolver = pack.resolver
        if resolver is None:
            return ctx.i18n.t("commands.pack_word.not_in_system", word=ctx.spec.canonical)
        check = resolver.check
        args = ctx.args or check.default_skill
        times, rest = _split_multi(args)
        parsed = _parse_check_args(rest, pack, default_name=check.default_skill)
        variant = await _get_rule_variant(ctx)

        modifiers: dict[str, int] = {}
        favor_net = parsed.bonus - parsed.penalty
        if favor_net > 0 and check.favorable:
            modifiers[check.favorable] = favor_net
        elif favor_net < 0 and check.unfavorable:
            modifiers[check.unfavorable] = -favor_net

        if resolver.target_kind == "dc":
            target_value = parsed.temp_value  # explicit target; None = ungraded roll
            modifier = check_value(character, pack, parsed.canonical)
            if parsed.proficient and check.proficiency:
                modifier += sheet_value(character, pack, check.proficiency)
        else:
            target_value = _target_value(character, pack, parsed.canonical, parsed.temp_value)
            modifier = 0

        effective_target = (
            resolver.effective_target(target_value, difficulty=parsed.difficulty)
            if target_value is not None
            else None
        )
        display_name = pack.display_name(parsed.canonical, ctx.locale)
        lines = []
        for _ in range(min(times, 20)):
            rolled = ctx.services.dice.roll_for_check(resolver, modifiers=modifiers or None)
            total = rolled.total + modifier
            if target_value is None:
                # No target declared for a modifier-style system: show the roll.
                ctx.dice(
                    "check",
                    skill=parsed.canonical,
                    expr=display_name,
                    rolls=list(rolled.modifiers.get("dice_all", rolled.dice)) or [rolled.total],
                    total=total,
                    detail={"modifier": modifier, **dict(rolled.modifiers)},
                )
                lines.append(
                    ctx.i18n.t(
                        "commands.check.roll",
                        name=display_name,
                        modifier=_signed(modifier),
                        roll=rolled.total,
                        total=total,
                    )
                )
                continue
            outcome = resolver.interpret(
                rolled, target_value, variant=variant, difficulty=parsed.difficulty, modifier=modifier
            )
            label = pack.rank_label(outcome.rank.id, ctx.locale)
            ctx.dice(
                "check",
                expr=display_name,
                skill=parsed.canonical,
                rolls=[rolled.total],
                total=total,
                target=target_value,
                effective_target=effective_target,
                outcome=outcome_wire(outcome, label),
                detail={"modifier": modifier, **dict(rolled.modifiers)},
            )
            await record_check(
                ctx.services.battles,
                ctx.chat_key,
                ctx.user_id,
                character.name,
                parsed.canonical,
                outcome,
                label=label,
                bonus=parsed.bonus,
                penalty=parsed.penalty,
                **({"modifier": modifier} if modifier else {}),
                **({"variant": variant} if variant else {}),
                **({"difficulty": parsed.difficulty} if parsed.difficulty else {}),
            )
            lines.append(
                ctx.i18n.t(
                    "commands.check.result",
                    name=display_name,
                    target=target_value,
                    effective=effective_target,
                    roll=total,
                    rank=label,
                )
            )
        return "\n".join(lines)

    def _render_inline_rolls(self, text: str, locale: str) -> str | None:
        matches = _INLINE_RE.findall(text)
        if not matches:
            return None
        i18n = get_i18n(locale)
        lines = []
        for expression in matches:
            # `[[...]]` is reached for ANY ordinary (non-command) message, so a bad expression
            # (e.g. a skill name typed as `[[侦查]]`) must degrade to a localized notice, never
            # crash the dispatch of a plain chat message.
            try:
                result = _roll_expression(self.services, expression)
            except ValueError:
                lines.append(i18n.t("commands.roll.invalid", expr=expression.strip()))
                continue
            lines.append(i18n.t("commands.inline.result", expression=expression.strip(), result=_format_roll(result, i18n)))
        return "\n".join(lines)
