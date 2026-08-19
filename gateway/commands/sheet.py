"""Character sheets: the `.st` assignment DSL, creation (`.coc` / `.dnd` / `.genchar`),
`.growth`, `.rename`, and pregen claiming (`.pc`)."""

from __future__ import annotations

import re
from dataclasses import dataclass

from agent.char_from_persona import build_sheet_from_description
from agent.services import Services
from core.character_manager import (
    CharacterNameTakenError,
    CharacterSheet,
)
from core.character_rules import render_validation_notice, validate_sheet
from core.rulepacks import RulePack, load_rulepack
from core.sheets import canonical_values as sheet_canonical_values
from core.sheets import set_sheet_value, sheet_value
from gateway.commands.checks import _pack_for_character
from gateway.commands.rooms import _is_keeper
from gateway.commands.types import CommandCtx
from gateway.turn import publish_state

# Matches only the VALUE half of a `.st` assignment (a signed number or dice
# expression). `_parse_sheet_assignments` scans for these and takes the text before
# each value as the attribute name. Anchoring on the value (which has no unbounded
# lazy prefix) makes parsing strictly linear, so no argument can trigger the
# quadratic backtracking the old `(.+?)(value)` pattern suffered.
_SHEET_VALUE_RE = re.compile(r"[+-]?(?:\d+d\d+(?:[+\-*/]\d+)?|\d+)", re.I)
# The EXPLICIT `.st NAME=VALUE` / `NAME+=VALUE` / `NAME-=VALUE` form. The operator is
# glued to the value half, so this scan is anchored the same way `_SHEET_VALUE_RE` is
# (no unbounded lazy name prefix) and stays strictly linear. The attribute NAME is
# whatever precedes the operator, so it may hold digits, spaces or CJK.
_SHEET_ASSIGN_RE = re.compile(rf"(\+=|-=|=)\s*({_SHEET_VALUE_RE.pattern})", re.I)
# Assignment operators -> how `_apply_value_expr` folds the value into the current one.
_SHEET_OPS = {"=": "set", "+=": "add", "-=": "sub"}
_SHEET_SIGN_OPS = {"+": "add", "-": "sub"}

# `.st`/`.sheet` finalize word: re-derive current HP/MP/SAN to their maxima for
# the sheet's CURRENT characteristics (CREATION semantics -- see `cmd_sheet`).
# Deliberately locale-agnostic (checked regardless of `ctx.locale`), matching the
# other reserved `.st` subcommand words above (`clr`/`del`/...).
_SHEET_FINALIZE_WORDS = {"finalize", "定稿", "初始化"}


@dataclass(frozen=True)
class GenCharRequest:
    system: str
    name: str
    description: str


def _resolve_system_token(token: str) -> str | None:
    """Resolve a command token to a canonical rule-system id via the pack
    registry's declared names (None when it names no installed system)."""
    word = token.strip()
    if not word:
        return None
    try:
        return load_rulepack(word).system
    except Exception:
        return None


def _parse_genchar_args(args: str) -> GenCharRequest | None:
    """Parse `.genchar [system] [name] | <description>`. A leading token naming
    an installed rule system selects it; ``system=""`` means the caller should
    fall back to the room's active system."""
    raw = args.strip()
    if not raw:
        return None

    head, sep, body = raw.partition("|")
    if sep:
        tokens = head.split()
        system = ""
        name = head.strip()
        if tokens:
            resolved = _resolve_system_token(tokens[0])
            if resolved:
                system = resolved
                name = " ".join(tokens[1:]).strip()
        description = body.strip()
    else:
        tokens = raw.split(maxsplit=1)
        system = ""
        description = raw
        name = ""
        if tokens:
            resolved = _resolve_system_token(tokens[0])
            if resolved:
                system = resolved
                description = tokens[1].strip() if len(tokens) > 1 else ""

    if not description:
        return None
    return GenCharRequest(system=system, name=name, description=description)


def _migrate_legacy_luck(character: CharacterSheet, pack: RulePack) -> None:
    """Move values written by the old `.st LUC` bug (skill slot instead of the
    declared attribute slot) into the real slot, per the pack's key bridge."""
    spec = pack.sheet_spec
    if spec is None:
        return
    canonical = pack.resolve_skill("luc")
    attr_key = spec.attr_keys.get(canonical or "")
    if not attr_key:
        return
    legacy_keys = [key for key in character.skills if str(key).casefold() == "luc"]
    for key in legacy_keys:
        try:
            value = int(character.skills[key])
        except (TypeError, ValueError):
            continue
        character.attributes[attr_key] = value
        character.skills.pop(key, None)


def _clean_assignment_name(raw: str) -> str:
    """Trim the whitespace and `,`/`，` separators around a parsed attribute name."""
    return raw.strip().strip(",，").strip()


def _parse_sheet_assignments(text: str) -> list[tuple[str, str, str]]:
    """Parse ``.st`` assignments into ``(name, op, value)`` triples, ``op`` in set/add/sub.

    Two forms; one command uses one form, never a mix:

    * EXPLICIT — ``STR=16``, ``HP+=1d6``, ``HP-=4``. ``=`` assigns ABSOLUTELY, so the
      sign belongs to the number (``mod=-3`` stores minus three) and ``+=``/``-=`` are
      the spelled-out relative forms. The name is everything left of the operator, so
      it may hold digits, spaces or CJK (``skill2=30``, ``spot hidden=70``).
    * LEGACY — ``STR16 DEX14``, ``力量50，敏捷60``, ``HP-4``. A bare leading ``+``/``-``
      on the value reads as relative, which leaves no spelling for an absolute negative
      and mis-splits a digit-bearing name (``skill2 30`` -> ``skill``/``2``). That is
      why the explicit form exists: clients build ``.st <wire-key> <n>`` out of whatever
      storage keys a pack declares.

    The explicit form wins whenever the argument holds one valid ``NAME<op>VALUE``;
    otherwise the legacy scan runs, unchanged.

    Both scans anchor on the VALUE half (`_SHEET_VALUE_RE`, with the operator glued in
    front for the explicit form) and take the text that precedes it as the name, which
    is strictly LINEAR: the original ``(.+?)(value)`` pattern backtracked quadratically,
    so a ~20k-char argument stalled the event loop for seconds. The name is everything
    since the prior value, so glued (``STR16``), spaced (``STR 16``) and multi-word
    (``spot hidden=70``) forms all parse without splitting a name.
    """
    explicit = _SHEET_ASSIGN_RE.search(text) is not None
    assignments: list[tuple[str, str, str]] = []
    last = 0
    for match in (_SHEET_ASSIGN_RE if explicit else _SHEET_VALUE_RE).finditer(text):
        name = _clean_assignment_name(text[last : match.start()])
        last = match.end()
        if explicit:
            op = _SHEET_OPS[match.group(1)]
            value = match.group(2).strip()
            # `x==5` / `a=b=5`: a name holding an operator is a garbled command, not a
            # skill called `x=`. Refuse the whole thing (the caller answers bad_args).
            if "=" in name:
                return []
        else:
            raw = match.group(0).strip()
            sign = raw[0] if raw[:1] in _SHEET_SIGN_OPS else ""
            op = _SHEET_SIGN_OPS.get(sign, "set")
            value = raw[len(sign) :]
        if name and value:
            assignments.append((name, op, value))
    # A mix of the two forms (`STR=16 DEX14`) used to apply the explicit half and drop
    # the glued one without a word. Anything left after the last explicit assignment is
    # exactly that dropped half — refuse the whole command instead of half-doing it.
    if explicit and _clean_assignment_name(text[last:]):
        return []
    return assignments


def _apply_value_expr(services: Services, current: int, op: str, raw_value: str) -> int:
    """Fold a parsed assignment value into the current one: set / add / sub."""
    expression = raw_value.strip()
    sign = expression[0] if expression[:1] in {"+", "-"} else ""
    expression = expression[len(sign) :]
    if "d" in expression.casefold():
        rolled = services.dice.roll_expression(expression).total
    else:
        rolled = int(expression)
    if sign == "-":
        rolled = -rolled
    if op == "add":
        return current + rolled
    if op == "sub":
        return current - rolled
    return rolled


def _render_sheet(ctx: CommandCtx, character: CharacterSheet, pack: RulePack) -> str:
    values = dict(pack.defaults)
    values.update(sheet_canonical_values(character, pack))
    values.update(pack.compute_derived(values))
    top = pack.st_show.get("top") or list(values.keys())[:12]
    items = []
    for name in top:
        value = values.get(name)
        if value is None:
            value = sheet_value(character, pack, str(name))
        items.append(ctx.i18n.t("commands.sheet.item", name=name, value=value))
    return ctx.i18n.t("commands.sheet.show", name=character.name, items=", ".join(items))


class SheetCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_sheet(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = await _pack_for_character(ctx, character)
        args = ctx.args.strip()
        if not args or args.casefold() == "show":
            return _render_sheet(ctx, character, pack)
        if args.casefold() in {"clr", "clear", "del", "delete"}:
            await ctx.services.characters.delete_character(ctx.user_id, ctx.chat_key, character.name)
            return ctx.i18n.t("commands.sheet.deleted", name=character.name)
        _migrate_legacy_luck(character, pack)
        if args.casefold() in _SHEET_FINALIZE_WORDS:
            # A manual build (a make-char word with DEFAULT characteristics, then one or
            # more `.st` edits to the chosen ones) never re-derives current HP/MP/SAN:
            # `.st` validates with `initialize_vitals=False` (in-play EDIT semantics —
            # preserve, never heal) by design (see `core.character_rules.validate_sheet`).
            # This finalize word is the CREATION-side re-derive: it forces the current
            # vitals back to their maxima for the sheet's final characteristics, same as
            # the make-char/`.genchar` commands do at birth. Safe to reuse mid-play too (a player
            # who wants to top off HP/MP/SAN to the current max after e.g. levelling can
            # invoke it deliberately) since it is the same explicit, opt-in verb.
            character, violations = validate_sheet(character, character.system, initialize_vitals=True)
            await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
            result = ctx.i18n.t("commands.sheet.finalized", name=character.name)
            notice = render_validation_notice(ctx.i18n, violations)
            return f"{result}\n{notice}" if notice else result

        assignments = _parse_sheet_assignments(args)
        if not assignments:
            return ctx.i18n.t("commands.error.bad_args")

        changed = []
        changed_names = []
        explicit_values: list[tuple[str, int]] = []
        for raw_name, op, raw_value in assignments:
            canonical = pack.resolve_skill(raw_name) or raw_name.strip()
            current = sheet_value(character, pack, canonical)
            # A malformed value expression (bad int, or an over-large dice term like
            # `力量+9999d6` that trips d20's roll cap) must not crash the turn.
            try:
                value = _apply_value_expr(ctx.services, current, op, raw_value)
            except ValueError:
                return ctx.i18n.t("commands.roll.invalid", expr=raw_value)
            set_sheet_value(character, pack, canonical, value)
            changed_names.append(canonical)
            explicit_values.append((canonical, value))
        # Derived slots refresh inside validate_sheet/save; an explicit override
        # written in the SAME command (``.st AC18 DEX14``) survives through the
        # trained-value semantics of the derived pipeline (a stored value that
        # differs from its derivation is a manual override and is preserved).
        character, violations = validate_sheet(character, pack.system)
        for canonical in changed_names:
            changed.append(
                ctx.i18n.t("commands.sheet.changed_item", name=canonical, value=sheet_value(character, pack, canonical))
            )
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        result = ctx.i18n.t("commands.sheet.changed", items=", ".join(changed))
        notice = render_validation_notice(ctx.i18n, violations)
        return f"{result}\n{notice}" if notice else result

    async def cmd_growth(self, ctx: CommandCtx) -> str:
        """The pack-declared improvement check (`improvement_check` template):
        roll above the current value (or above the auto-success line) to grow
        the stat by the declared improvement roll."""
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = await _pack_for_character(ctx, character)
        spec = next((entry for entry in pack.subsystems.values() if entry.template == "improvement_check"), None)
        if spec is None:
            return ctx.i18n.t("commands.pack_word.not_in_system", word=ctx.spec.canonical)
        default_skill = pack.resolver.check.default_skill if pack.resolver else ""
        name = ctx.args or default_skill
        canonical = pack.resolve_skill(name) or name
        current = sheet_value(character, pack, canonical)
        roll = ctx.services.dice.roll_expression(spec.roll).total
        grows = roll > current or (spec.auto_success_above is not None and roll > spec.auto_success_above)
        gain = ctx.services.dice.roll_expression(spec.improve).total if grows else 0
        new_value = min(spec.cap, current + gain)
        if gain:
            set_sheet_value(character, pack, canonical, new_value)
            await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        return ctx.i18n.t("commands.growth.result", name=canonical, roll=roll, gain=gain, value=new_value)

    async def cmd_make_char(self, ctx: CommandCtx, pack: RulePack | None = None) -> str:
        """Create a sheet for `pack`'s system (the pack whose `make_char`
        command word routed here — the word set itself is pack data), falling
        back to the room's active system."""
        if pack is None:

            pack = await ctx.services.room_rulepack(ctx.raw_ctx)
        name = ctx.args.strip() or ctx.i18n.t("commands.character.default_name")
        character = ctx.services.characters.generate_character(pack.system, name)
        character, violations = validate_sheet(
            character,
            pack.system,
            initialize_vitals=True,
            creation_method="rolled",
        )
        try:
            await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        except CharacterNameTakenError:
            # The bare make-char word falls back to the pack's localized default
            # name, so two players typing it collide with no attacker involved —
            # and sheets are keyed by NAME room-wide. Refusing (rather than
            # silently de-duplicating to "Adventurer 2") is the live-table
            # behaviour: it costs one re-typed command, names the conflict out
            # loud, and never saddles a 20-session character with a machine name.
            return ctx.fail(
                ctx.i18n.t("commands.character.name_taken", name=character.name, command=ctx.command)
            )
        result = ctx.i18n.t("commands.character.created", name=character.name, system=character.system)
        notice = render_validation_notice(ctx.i18n, violations)
        return f"{result}\n{notice}" if notice else result

    async def cmd_genchar(self, ctx: CommandCtx) -> str:
        request = _parse_genchar_args(ctx.args)
        if request is None:
            return ctx.i18n.t("charcard.commands.genchar.usage")
        system = request.system
        if not system:

            system = (await ctx.services.room_rulepack(ctx.raw_ctx)).system

        character = await build_sheet_from_description(
            ctx.services,
            request.description,
            system,
            name=request.name,
        )
        character, violations = validate_sheet(character, system, initialize_vitals=True)
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        result = ctx.i18n.t("charcard.commands.genchar.done", name=character.name, system=character.system)
        notice = render_validation_notice(ctx.i18n, violations)
        return f"{result}\n{notice}" if notice else result

    async def cmd_rename(self, ctx: CommandCtx) -> str:
        new_name = ctx.args.strip()
        if not new_name:
            return ctx.i18n.t("commands.error.bad_args")
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        old_name = character.name
        character.name = new_name
        try:
            await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        except CharacterNameTakenError:
            # Sheets are keyed by NAME room-wide: renaming onto someone else's
            # character would overwrite their sheet and steal it. Refuse instead.
            return ctx.fail(ctx.i18n.t("commands.rename.name_taken", name=new_name))
        if old_name and old_name != new_name:
            await ctx.services.characters.delete_character(ctx.user_id, ctx.chat_key, old_name)
        return ctx.i18n.t("commands.rename.changed", old=old_name, new=new_name)

    async def cmd_pc(self, ctx: CommandCtx) -> str:
        """`.pc [list]|claim <name>|release [name]` — the room's pre-generated character
        roster (`core.pregen_roster`): the cast a keeper's world imports ship. Listing and
        claiming are PLAYER actions (claiming is the whole point); releasing someone
        else's claim is keeper-only."""
        from core.pregen_roster import pregen_claim, pregen_entries, pregen_release

        tokens = ctx.args.split()
        sub = tokens[0].casefold() if tokens else "list"
        rest = " ".join(tokens[1:]).strip()
        documents = ctx.services.documents
        chat_key = ctx.chat_key
        if sub in {"claim", "认领", "認領"}:
            if not rest:
                return ctx.i18n.t("pregen.commands.claim_usage")
            status, sheet = await pregen_claim(documents, chat_key, rest, ctx.user_id, ctx.services.characters)
            if status in {"ok", "yours"} and sheet is not None:
                if ctx.router.hub is not None:
                    await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
                key = "pregen.commands.claimed" if status == "ok" else "pregen.commands.reclaimed"
                return ctx.i18n.t(key, name=sheet.name, system=sheet.system)
            return ctx.i18n.t(f"pregen.commands.claim_{status}", name=rest)
        if sub in {"release", "放弃", "放棄", "释放", "釋放"}:
            if not rest:
                return ctx.i18n.t("pregen.commands.release_usage")
            status = await pregen_release(
                documents, chat_key, rest, ctx.user_id, ctx.services.characters, force=_is_keeper(ctx.raw_ctx)
            )
            if status == "ok":
                if ctx.router.hub is not None:
                    await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
                return ctx.i18n.t("pregen.commands.released", name=rest)
            return ctx.i18n.t(f"pregen.commands.release_{status}", name=rest)
        if sub not in {"list", "列表"}:
            return ctx.i18n.t("pregen.commands.usage")
        entries = await pregen_entries(documents, chat_key)
        if not entries:
            return ctx.i18n.t("pregen.commands.empty")
        lines = [ctx.i18n.t("pregen.commands.list_header", count=len(entries))]
        for entry in entries:
            key = "pregen.commands.line_claimed" if entry.get("claimed_by") else "pregen.commands.line_free"
            line = ctx.i18n.t(key, name=entry.get("name", ""), system=entry.get("system", ""))
            blurb = str(entry.get("blurb", "")).strip()
            if blurb:
                line += ctx.i18n.t("pregen.commands.blurb_suffix", blurb=blurb)
            lines.append(line)
        return "\n".join(lines)
