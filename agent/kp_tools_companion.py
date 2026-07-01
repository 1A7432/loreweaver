"""AI-KP tools for AI *player companions* (`docs/specs/M10-companions.md` §5).

`CompanionTools` is the function-calling surface for creating and steering AI party members. A
companion is a PLAYER-side character: `add_companion` creates a `player_companion`
`agent.npc.NpcRecord` AND a real `core.character_manager.CharacterSheet` under the virtual user_key
`companion:{id}`, so the KP's normal `skill_check`/character tools resolve REAL dice on the
companion's own sheet when it takes a turn.

The heavy lifting -- generating a companion's action under strict information isolation, then running
it through the normal turn pipeline so the KP resolves real dice -- lives in
`agent.companion_actor` + `gateway.director`. These tools are the thin CRUD/steering layer over
`agent.npc.NpcManager`; every user-visible string is looked up via `services.i18n` under
`companion.tools.*` (`locales/{en,zh}/companion.json`). Companion persona/knowledge/names are game
DATA supplied at runtime, not literals here, so they need no i18n of their own (same convention as
`agent.kp_tools_npc`).

`companion_act` is the one tool that can drive a live turn: when the KP toolset was built WITH a hub
(the shared-room path), it delegates to `gateway.director.request_companion`; otherwise it degrades
to declaring the companion's action for the KP to weave and adjudicate. A companion turn never
re-enters this tool (the director builds companion turns a hub-less toolset), and the tool itself
refuses to run while already inside a companion turn.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from agent.companion_actor import companion_action
from agent.context import AgentCtx
from agent.npc import NpcManager
from agent.services import Services
from agent.tools import tool
from core.character_manager import CharacterSheet
from infra.i18n import I18n

if TYPE_CHECKING:
    from gateway.commands import CommandRouter
    from gateway.hub import RoomHub

_SYSTEM_MAP = {"coc7": "coc7", "dnd5e": "dnd5e", "CoC": "coc7", "DnD5e": "dnd5e"}
_TRUTHY = {"on", "1", "true", "yes", "y", "开", "开启", "啟用", "開"}
_FALSY = {"off", "0", "false", "no", "n", "关", "关闭", "關閉"}


def _companion_uid(companion_id: str) -> str:
    """The virtual per-player user_key a companion's CharacterSheet is stored under."""
    return f"companion:{companion_id}"


class CompanionTools:
    """AI-KP tools for adding/steering AI player companions (party members the AI fills seats with)."""

    def __init__(
        self,
        services: Services,
        *,
        hub: RoomHub | None = None,
        command_router: CommandRouter | None = None,
    ) -> None:
        self._services = services
        self._npcs = NpcManager(services.store)
        # Present only on the shared-room (hub) path; when set, `companion_act` can drive a live
        # companion turn via the director. Absent everywhere else, where it degrades gracefully.
        self._hub = hub
        self._command_router = command_router

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool
    async def add_companion(
        self,
        ctx: AgentCtx,
        name: str,
        persona: str = "",
        system: str = "coc7",
        playstyle: str = "",
        generate: bool = True,
    ) -> str:
        """Add an AI player companion: a party-side character the AI plays to fill an empty seat.
        Creates its record AND a real character sheet, so it takes real, KP-resolved dice turns.

        Args:
            name: The companion's name (also its character-sheet name).
            persona: Who they are -- voice, goals, mannerisms (full roleplay).
            system: Game system for the sheet (coc7/dnd5e).
            playstyle: Tactical/roleplay leaning, e.g. "cautious support" or "aggressive brawler".
            generate: Whether to auto-roll the sheet's attributes per the system's rules.

        Returns:
            Confirmation naming the created companion and its resolved id.
        """
        i18n = self._i18n(ctx)
        try:
            template_key = _SYSTEM_MAP.get(system, "coc7")
            system_name = "CoC" if template_key == "coc7" else "DnD5e"

            record = await self._npcs.create_companion(
                ctx.chat_key, name, persona=persona, playstyle=playstyle, stat_char=name
            )

            if generate:
                sheet = self._services.characters.generate_character(template_key, name)
                sheet.system = system_name
            else:
                sheet = CharacterSheet(name=name, system=system_name)
            await self._services.characters.save_character(_companion_uid(record.id), ctx.chat_key, sheet)

            return i18n.t("companion.tools.add.done", name=record.name, id=record.id, system=system_name)
        except Exception as exc:
            return i18n.t("companion.tools.add.failed", error=str(exc))

    @tool
    async def companion_act(self, ctx: AgentCtx, name: str, situation: str = "") -> str:
        """Have a companion take a turn NOW: it declares an in-character action and the KP resolves
        it with real dice on the companion's own sheet. Use in exploration to spotlight a companion.

        Args:
            name: The companion's name or id.
            situation: What is happening right now, for the companion to react to.

        Returns:
            Confirmation that the companion acted, or the companion's declared action for you to
            adjudicate, or a not-found message.
        """
        i18n = self._i18n(ctx)
        # Anti-runaway: a companion turn must never spawn another companion turn.
        if ctx.platform == "companion":
            return i18n.t("companion.tools.act.nested")
        try:
            companion = await self._npcs.get_npc(ctx.chat_key, name)
            if companion is None or companion.role != "player_companion":
                return i18n.t("companion.tools.not_found", name=name)

            if self._hub is not None and self._command_router is not None:
                from gateway.director import companion_turn_toolset, request_companion

                await request_companion(
                    self._hub,
                    self._services,
                    companion.id,
                    chat_key=ctx.chat_key,
                    command_router=self._command_router,
                    toolset=companion_turn_toolset(self._services),
                    hint=situation,
                    locale=ctx.locale,
                )
                return i18n.t("companion.tools.act.done", name=companion.name)

            # No hub wired in (standalone/tool-only path): declare the action for you to weave and
            # adjudicate -- still fully info-isolated, still never rolls its own dice.
            sheet = await self._services.characters.get_character(_companion_uid(companion.id), ctx.chat_key)
            out = await companion_action(self._services, companion, sheet, situation)
            action = out.get("action", "")
            dialogue = out.get("dialogue", "")
            line = i18n.t(
                "companion.tools.act.line",
                name=companion.name,
                dialogue=dialogue or i18n.t("companion.tools.act.no_dialogue"),
                action=action or i18n.t("companion.tools.act.no_action"),
            )
            await self._log_event(ctx.chat_key, i18n.t("companion.tools.act.log_event", name=companion.name, action=action))
            return line
        except Exception as exc:
            return i18n.t("companion.tools.act.failed", error=str(exc))

    @tool
    async def party_auto(self, ctx: AgentCtx, action: str = "") -> str:
        """Turn on/off automatic companion turns during combat (each companion acts on its initiative).

        Args:
            action: "on" to enable auto companion combat turns, "off" to disable, empty to report.

        Returns:
            The new (or current) auto-turn state.
        """
        i18n = self._i18n(ctx)
        store_key = f"party_auto.{ctx.chat_key}"
        value = action.strip().casefold()
        try:
            if value in _TRUTHY:
                await self._services.store.set(user_key="", store_key=store_key, value="1")
                return i18n.t("companion.tools.auto.on")
            if value in _FALSY:
                await self._services.store.set(user_key="", store_key=store_key, value="0")
                return i18n.t("companion.tools.auto.off")
            current = await self._services.store.get(user_key="", store_key=store_key)
            return i18n.t("companion.tools.auto.on" if current == "1" else "companion.tools.auto.off")
        except Exception as exc:
            return i18n.t("companion.tools.auto.failed", error=str(exc))

    @tool
    async def list_companions(self, ctx: AgentCtx) -> str:
        """List this room's AI player companions (name, id, playstyle).

        Returns:
            A roster of the party's AI companions, or an empty-roster notice.
        """
        i18n = self._i18n(ctx)
        try:
            companions = await self._npcs.list_companions(ctx.chat_key)
            if not companions:
                return i18n.t("companion.tools.list.empty")
            lines = [i18n.t("companion.tools.list.header", count=len(companions))]
            for companion in companions:
                lines.append(
                    i18n.t(
                        "companion.tools.list.item",
                        name=companion.name,
                        id=companion.id,
                        playstyle=companion.playstyle or i18n.t("common.none"),
                    )
                )
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("companion.tools.list.failed", error=str(exc))

    @tool
    async def remove_companion(self, ctx: AgentCtx, name: str) -> str:
        """Remove an AI companion from the party (deletes its record; its sheet is left in place).

        Args:
            name: The companion's name or id.

        Returns:
            Confirmation, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            companion = await self._npcs.get_npc(ctx.chat_key, name)
            if companion is None or companion.role != "player_companion":
                return i18n.t("companion.tools.not_found", name=name)
            await self._npcs.delete_npc(ctx.chat_key, companion.id)
            return i18n.t("companion.tools.remove.done", name=companion.name)
        except Exception as exc:
            return i18n.t("companion.tools.remove.failed", error=str(exc))

    @tool
    async def set_companion_playstyle(self, ctx: AgentCtx, name: str, playstyle: str) -> str:
        """Set a companion's tactical/roleplay leaning (how it approaches encounters).

        Args:
            name: The companion's name or id.
            playstyle: The new playstyle, e.g. "cautious support" or "reckless front-liner".

        Returns:
            Confirmation, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            companion = await self._npcs.get_npc(ctx.chat_key, name)
            if companion is None or companion.role != "player_companion":
                return i18n.t("companion.tools.not_found", name=name)
            record = await self._npcs.update_npc(ctx.chat_key, companion.id, playstyle=playstyle)
            return i18n.t("companion.tools.playstyle.done", name=record.name, playstyle=record.playstyle)
        except Exception as exc:
            return i18n.t("companion.tools.playstyle.failed", error=str(exc))

    @tool
    async def companion_learns(self, ctx: AgentCtx, name: str, fact: str) -> str:
        """Have a companion learn one new fact (its player-scoped knowledge grows as the party
        discovers things, so it stays current but never gets ahead of what the party knows).

        Args:
            name: The companion's name or id.
            fact: The single fact the companion just learned.

        Returns:
            Confirmation, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            companion = await self._npcs.get_npc(ctx.chat_key, name)
            if companion is None or companion.role != "player_companion":
                return i18n.t("companion.tools.not_found", name=name)
            record = await self._npcs.npc_learns(ctx.chat_key, companion.id, fact)
            return i18n.t("companion.tools.learns.done", name=record.name, fact=fact)
        except Exception as exc:
            return i18n.t("companion.tools.learns.failed", error=str(exc))

    async def _log_event(self, chat_key: str, description: str) -> None:
        """Best-effort session-log entry; never lets a logging failure break the tool."""
        try:
            await self._services.battles.add_key_event(chat_key, description, "companion_action")
        except Exception:
            pass


async def witness(services: Services, chat_key: str, fact: str) -> None:
    """Append ``fact`` to EVERY companion's player-scoped knowledge (best-effort).

    The party-discovery hook (`docs/specs/M10-companions.md` §5): when the group learns something,
    each companion learns it too, so companions stay current with -- but never ahead of -- the
    party. Silently no-ops on any error and never raises into the caller.
    """
    try:
        npcs = NpcManager(services.store)
        for companion in await npcs.list_companions(chat_key):
            await npcs.npc_learns(chat_key, companion.id, fact)
    except Exception:
        pass
