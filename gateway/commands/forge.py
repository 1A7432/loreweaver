"""Keeper command `.forge`: author + install a skill / rulepack / module from a description.

The chat-side twin of `admin_generate`. It runs the same `agent.forge` generators the
admin frame uses; a module installs into the caller's room. Generation is a slow
authoring-lane model call and runs IN-LINE under the per-room turn lock the command
already holds — the same shape as `.module` import. Authorization is checked and the
effect is applied in that one locked scope, so `.reset` / `.undo` / import / delete
cannot race a leftover task (defensive-patterns §7).
"""

from __future__ import annotations

from typing import Any

from agent.context import AgentCtx
from agent.forge import (
    ForgeResult,
    format_forge_result,
    generate_and_install_module,
    generate_and_install_rulepack,
    generate_and_install_skill,
)
from agent.tool_phase import PLAY_PHASE, room_phase
from gateway.commands.rooms import _is_keeper, _keeper_still_authorized
from gateway.commands.types import CommandCtx

# User-facing kind tokens (EN + CN) -> the generator `agent.forge` uses.
_FORGE_KIND_WORDS: dict[str, str] = {
    "skill": "skill",
    "rule": "rule",
    "rulepack": "rule",
    "module": "module",
    "技能": "skill",
    "规则": "rule",
    "規則": "rule",
    "规则包": "rule",
    "規則包": "rule",
    "模组": "module",
    "模組": "module",
}


async def _run_forge(
    services: Any,
    kind: str,
    description: str,
    *,
    chat_key: str,
    user_id: str,
    platform: str,
    locale: str,
    fs: Any,
    extra: Any,
) -> ForgeResult:
    """Dispatch to the same `agent.forge` generators `admin_generate` runs."""
    if kind == "skill":
        return await generate_and_install_skill(services, description, chat_key=chat_key)
    if kind == "rule":
        return await generate_and_install_rulepack(services, description, chat_key=chat_key)
    extra_dict = dict(extra) if isinstance(extra, dict) else {}
    extra_dict.setdefault("role", "keeper")
    ctx = AgentCtx(
        chat_key=chat_key,
        user_id=user_id,
        platform=platform,
        locale=locale,
        fs=fs,
        extra=extra_dict,
    )
    return await generate_and_install_module(services, ctx, description)


class ForgeCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_forge(self, ctx: CommandCtx) -> str:
        """`.forge <skill|rulepack|module> <description>` — author and install an artifact.

        Keeper-gated like `.model`. Prep-phase like the `generate_*` tools (`prep_only`):
        a play-phase room is refused so this command cannot lengthen a live turn with an
        authoring call. The forge skills themselves are NOT required — this is the admin
        surface, already keeper-gated.

        Runs to completion inside this handler, under the per-room turn lock the
        transport already holds. Authorization (`_is_keeper` /
        `_keeper_still_authorized`) and the install share that one locked scope;
        nothing is scheduled after the reply, so a later `.reset` / `.undo` /
        import / delete cannot be overwritten by a leftover forge.
        """
        if ctx.raw_ctx.platform != "cli" and not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.forge.denied"))
        if not await _keeper_still_authorized(ctx.raw_ctx, ctx.chat_key, ctx.services.store):
            return ctx.fail(ctx.i18n.t("commands.forge.denied"))
        parts = ctx.args.split(maxsplit=1)
        kind_token = parts[0].casefold() if parts else ""
        description = parts[1].strip() if len(parts) > 1 else ""
        kind = _FORGE_KIND_WORDS.get(kind_token)
        if kind is None or not description:
            return ctx.i18n.t("commands.forge.usage")
        if await room_phase(ctx.services.store, ctx.chat_key) == PLAY_PHASE:
            return ctx.fail(ctx.i18n.t("commands.forge.play_phase"))

        result = await _run_forge(
            ctx.services,
            kind,
            description,
            chat_key=ctx.chat_key,
            user_id=ctx.user_id,
            platform=str(getattr(ctx.raw_ctx, "platform", "cli") or "cli"),
            locale=ctx.locale,
            fs=getattr(ctx.raw_ctx, "fs", None),
            extra=getattr(ctx.raw_ctx, "extra", {}) or {},
        )
        return format_forge_result(ctx.i18n, kind, result)
