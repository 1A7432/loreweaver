"""Keeper command `.forge`: author + install a skill / rulepack / module from a description.

The chat-side twin of `admin_generate`. It runs the same `agent.forge` generators the
admin frame uses; a module installs into the caller's room. Generation is a slow
authoring-lane model call, so a hub-backed router replies that it started and posts
the result as a follow-up system line; a standalone router (CLI / unit tests) waits
and returns the result in-line.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from agent.context import AgentCtx
from agent.forge import (
    ForgeResult,
    generate_and_install_module,
    generate_and_install_rulepack,
    generate_and_install_skill,
)
from agent.tool_phase import PLAY_PHASE, room_phase
from gateway.commands.rooms import _is_keeper, _keeper_still_authorized
from gateway.commands.types import CommandCtx
from gateway.hub import Event
from infra.i18n import I18n

logger = logging.getLogger(__name__)

# User-facing kind tokens (EN + CN) -> the generator `_generate` / `agent.forge` uses.
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


def _forge_tasks(services: Any) -> list[asyncio.Task[None]]:
    """In-flight `.forge` follow-ups, hung on the Services object so they are not GC'd."""
    tasks = getattr(services, "_forge_command_tasks", None)
    if tasks is None:
        tasks = []
        services._forge_command_tasks = tasks  # type: ignore[attr-defined]
    live = [task for task in tasks if not task.done()]
    services._forge_command_tasks = live  # type: ignore[attr-defined]
    return live


def _issuer_user_key(ctx: CommandCtx) -> str:
    extra = getattr(ctx.raw_ctx, "extra", None)
    if isinstance(extra, dict) and extra.get("member_user_key"):
        return str(extra["member_user_key"])
    return ctx.user_id


def _format_forge_result(i18n: I18n, kind: str, result: ForgeResult) -> str:
    """Map a `ForgeResult` to the same localized strings the forge KP tools use."""
    if kind == "skill":
        if result.ok:
            return i18n.t("agent.forge.installed", name=result.name, skill_id=result.skill_id, path=result.path)
        if result.error == "no_data_dir":
            return i18n.t("agent.forge.no_data_dir")
        if result.error.startswith("bad_id"):
            return i18n.t("agent.forge.bad_id", error=result.error.removeprefix("bad_id: "))
        return i18n.t("agent.forge.invalid", error=result.error)
    if kind == "rule":
        if result.ok:
            return i18n.t(
                "agent.forge.rulepack_installed",
                name=result.name,
                rulepack_id=result.skill_id,
                path=result.path,
            )
        if result.error == "no_data_dir":
            return i18n.t("agent.forge.rulepack_no_data_dir")
        if result.error.startswith("bad_id"):
            return i18n.t("agent.forge.rulepack_bad_id", error=result.error.removeprefix("bad_id: "))
        return i18n.t("agent.forge.rulepack_invalid", error=result.error)
    if result.ok:
        if result.reused:
            return i18n.t("agent.forge.module_reused", name=result.name, path=result.path)
        return i18n.t("agent.forge.module_installed", name=result.name, path=result.path, detail=result.detail)
    if result.error == "no_data_dir":
        return i18n.t("agent.forge.module_no_data_dir")
    if result.error.startswith("bad_id"):
        return i18n.t("agent.forge.module_bad_id", error=result.error.removeprefix("bad_id: "))
    return i18n.t("agent.forge.module_invalid", error=result.error)


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
        """
        if ctx.raw_ctx.platform != "cli" and not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.forge.denied"))
        if not await _keeper_still_authorized(ctx.raw_ctx, ctx.chat_key, ctx.services.store):
            return ctx.fail(ctx.i18n.t("commands.forge.denied"))
        parts = ctx.args.split(maxsplit=1)
        kind_token = parts[0].casefold() if parts else ""
        description = parts[1].strip() if len(parts) > 1 else ""
        kind = _FORGE_KIND_WORDS.get(kind_token) or _FORGE_KIND_WORDS.get(parts[0] if parts else "")
        if kind is None or not description:
            return ctx.i18n.t("commands.forge.usage")
        if await room_phase(ctx.services.store, ctx.chat_key) == PLAY_PHASE:
            return ctx.fail(ctx.i18n.t("commands.forge.play_phase"))

        kind_label = ctx.i18n.t(f"commands.forge.kind.{kind}")
        started = ctx.i18n.t("commands.forge.started", kind=kind_label)
        hub = ctx.router.hub
        run_kwargs = {
            "chat_key": ctx.chat_key,
            "user_id": ctx.user_id,
            "platform": str(getattr(ctx.raw_ctx, "platform", "cli") or "cli"),
            "locale": ctx.locale,
            "fs": getattr(ctx.raw_ctx, "fs", None),
            "extra": getattr(ctx.raw_ctx, "extra", {}) or {},
        }
        if hub is None:
            result = await _run_forge(ctx.services, kind, description, **run_kwargs)
            return _format_forge_result(ctx.i18n, kind, result)

        issuer = _issuer_user_key(ctx)
        i18n = ctx.i18n
        services = ctx.services
        chat_key = ctx.chat_key

        async def _followup() -> None:
            try:
                result = await _run_forge(services, kind, description, **run_kwargs)
                text = _format_forge_result(i18n, kind, result)
            except Exception:
                logger.exception("forge follow-up failed (kind=%s)", kind)
                text = i18n.t("commands.forge.failed")
            await hub.publish(
                chat_key,
                Event.narrative(speaker="system", text=text, fmt="plain", private=True),
                only_user=issuer,
            )

        task = asyncio.create_task(_followup(), name=f"forge-{kind}")
        _forge_tasks(services).append(task)
        return started
