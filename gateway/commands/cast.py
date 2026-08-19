"""The room's cast: `.party` (AI companions) and the keeper's `.npc` / `.companion`."""

from __future__ import annotations

from agent import npc as npc_records
from agent.context import AgentCtx
from gateway.commands.rooms import _is_keeper
from gateway.commands.types import CommandCtx

# `.party` subcommand vocabularies (EN + a couple of CN synonyms) -- AI companion party (M10).
_PARTY_ADD_WORDS = {"add", "new", "recruit", "加入", "招募", "添加"}
_PARTY_ACT_WORDS = {"act", "go", "行动", "行動"}
_PARTY_AUTO_WORDS = {"auto", "自动", "自動"}
_PARTY_LIST_WORDS = {"", "list", "ls", "列表", "查看"}
_PARTY_REMOVE_WORDS = {"remove", "rm", "del", "delete", "移除", "删除", "刪除"}


class CastCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_party(self, ctx: CommandCtx) -> str:
        """`.party [add <name> [| persona] | act <name> [hint] | auto on|off | remove <name>]`
        — manage the AI companion party (M10). Bare `.party` lists the party's AI companions."""
        from agent.kp_tools_companion import CompanionTools

        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        agent_ctx = AgentCtx(
            chat_key=ctx.chat_key,
            user_id=ctx.user_id,
            platform=str(getattr(ctx.raw_ctx, "platform", "cli") or "cli"),
            locale=ctx.locale,
        )
        tools = CompanionTools(ctx.services)

        # Bare `.party` (list) is open to any player, but the mutating subcommands
        # (add/remove/auto/act) change the companion roster and drive LLM spend, so
        # they are keeper-gated. Gated in-handler (not via `required_level`) so a
        # CLI/TUI keeper keeps working.
        if (
            sub in _PARTY_ADD_WORDS | _PARTY_REMOVE_WORDS | _PARTY_AUTO_WORDS | _PARTY_ACT_WORDS
            and not _is_keeper(ctx.raw_ctx)
        ):
            return ctx.fail(ctx.i18n.t("rooms.denied"))

        if sub in _PARTY_ADD_WORDS:
            if not rest:
                return ctx.i18n.t("companion.commands.party.add_usage")
            name, persona = (piece.strip() for piece in rest.split("|", 1)) if "|" in rest else (rest, "")
            return await tools.add_companion(agent_ctx, name=name, persona=persona)
        if sub in _PARTY_ACT_WORDS:
            return await self._party_act(ctx, rest)
        if sub in _PARTY_AUTO_WORDS:
            return await tools.party_auto(agent_ctx, action=rest)
        if sub in _PARTY_REMOVE_WORDS:
            if not rest:
                return ctx.i18n.t("companion.commands.party.remove_usage")
            return await tools.remove_companion(agent_ctx, name=rest)
        if sub in _PARTY_LIST_WORDS:
            return await tools.list_companions(agent_ctx)
        return ctx.i18n.t("companion.commands.party.usage")

    async def _party_act(self, ctx: CommandCtx, rest: str) -> str:
        """`.party act <name> [hint]` — run one companion's turn now, fanned out to the room."""
        if not rest:
            return ctx.i18n.t("companion.commands.party.act_usage")
        if self.hub is None:
            return ctx.i18n.t("companion.commands.party.no_hub")

        name, _, hint = rest.partition(" ")
        from agent.kp_tools import build_kp_toolset
        from gateway.director import request_companion

        result = await request_companion(
            self.hub,
            ctx.services,
            name.strip(),
            chat_key=ctx.chat_key,
            command_router=self,
            toolset=build_kp_toolset(ctx.services),
            hint=hint.strip(),
            locale=ctx.locale,
        )
        if result is None:
            return ctx.i18n.t("companion.commands.party.act_none", name=name.strip())
        return ctx.i18n.t("companion.commands.party.act_done", name=name.strip())

    def _agent_ctx(self, ctx: CommandCtx) -> AgentCtx:
        """Build the `AgentCtx` a delegated tool needs, carrying the origin ctx's fs/extra so
        file-based tools (`.lore import`, `.import`) can resolve sandbox paths."""
        return AgentCtx(
            chat_key=ctx.chat_key,
            user_id=ctx.user_id,
            platform=str(getattr(ctx.raw_ctx, "platform", "cli") or "cli"),
            locale=ctx.locale,
            fs=getattr(ctx.raw_ctx, "fs", None),
            extra=getattr(ctx.raw_ctx, "extra", {}) or {},
        )

    async def cmd_cast(self, ctx: CommandCtx) -> str:
        """`.npc [list|show <name>|delete <name>]` / `.companion [list|delete <name>]` — the
        keeper's hand on the room's CAST, deterministic and without spending a model turn.

        There was none: a 2026-08-18 play-test had the Keeper mistakenly register a real
        player as an AI companion, and the operator's only lever was to ask the Keeper, in
        narration, to please call `remove_companion` itself. Records are keeper-grade (a
        `secret_agenda` and an NPC's private knowledge live in them), so every subcommand is
        keeper-only and the reply is private — `show` prints the full record, listings do not.
        """
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("rooms.denied"))
        companions_only = ctx.spec.canonical == "companion"
        tokens = ctx.args.split()
        sub = tokens[0].casefold() if tokens else "list"
        rest = " ".join(tokens[1:]).strip()
        documents = ctx.services.documents

        def _is_companion(record) -> bool:
            return record.role == "player_companion"

        if sub in {"list", "列表"} and not rest:
            records = (
                await npc_records.list_companions(documents, ctx.chat_key)
                if companions_only
                else await npc_records.list_npcs(documents, ctx.chat_key)
            )
            if not records:
                # `.companion` asked a narrower question than `.npc` did, so "no cast
                # records" answered something the keeper did not ask: a room full of NPCs
                # and no companions read as an empty room.
                return ctx.i18n.t(
                    "commands.cast.empty_companions" if companions_only else "commands.cast.empty"
                )
            lines = [ctx.i18n.t("commands.cast.header", count=len(records))]
            for record in records:
                lines.append(
                    ctx.i18n.t(
                        "commands.cast.item",
                        name=record.name,
                        id=record.id,
                        kind=ctx.i18n.t(
                            "commands.cast.kind.companion" if _is_companion(record) else "commands.cast.kind.npc"
                        ),
                        location=record.location or "-",
                    )
                )
            return "\n".join(lines)

        name = rest
        if not name:
            return ctx.fail(ctx.i18n.t("commands.cast.usage"))
        record = await npc_records.get_npc(documents, ctx.chat_key, name)
        if record is None or (companions_only and not _is_companion(record)):
            return ctx.fail(ctx.i18n.t("commands.cast.not_found", name=name))

        if sub in {"show", "查看"}:
            lines = [
                ctx.i18n.t("commands.cast.show.title", name=record.name, id=record.id),
                ctx.i18n.t(
                    "commands.cast.show.kind",
                    kind=ctx.i18n.t(
                        "commands.cast.kind.companion" if _is_companion(record) else "commands.cast.kind.npc"
                    ),
                    disposition=record.disposition or "-",
                    location=record.location or "-",
                ),
            ]
            if record.stat_char:
                lines.append(ctx.i18n.t("commands.cast.show.sheet", name=record.stat_char))
            if record.persona:
                lines.append(ctx.i18n.t("commands.cast.show.persona", persona=record.persona))
            if record.secret_agenda:
                lines.append(ctx.i18n.t("commands.cast.show.agenda", agenda=record.secret_agenda))
            if record.knowledge:
                lines.append(ctx.i18n.t("commands.cast.show.knowledge", count=len(record.knowledge)))
                lines.extend(f"  · {fact}" for fact in record.knowledge[:20])
            return "\n".join(lines)

        if sub in {"delete", "del", "remove", "删除"}:
            if _is_companion(record):
                # A companion is record + sheet: `.companion delete` (or `.npc delete` on
                # a companion) takes both, or the sheet stays on the table as a ghost
                # party member no command can reach (`agent.kp_tools_companion.retire_companion`).
                from agent.kp_tools_companion import retire_companion

                await retire_companion(ctx.services, ctx.chat_key, record)
            else:
                await npc_records.delete_npc(documents, ctx.chat_key, record.id)
            return ctx.i18n.t("commands.cast.deleted", name=record.name, id=record.id)

        return ctx.fail(ctx.i18n.t("commands.cast.usage"))
