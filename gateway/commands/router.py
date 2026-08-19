"""The command router core: the spec table, alias resolution, dispatch, and `.help`.

Handlers live in per-domain mixins (`checks`, `sheet`, `rules`, `rooms`, `cast`, `world`,
`panels`, `media`, `llm`) that `CommandRouter` composes — the same shape `agent.kp_tools`
uses to compose tool providers. A new command lands in its domain module; this file
only learns its spec row."""

from __future__ import annotations

import logging
import re
from typing import Any

from agent.context import AgentCtx
from agent.services import Services
from core.character_manager import (
    CharacterDataError,
)
from core.resolution import ResolutionError
from core.rulepacks import all_command_words
from gateway.commands.cast import CastCommands
from gateway.commands.checks import ChecksCommands, _resolution_notice
from gateway.commands.llm import LlmCommands
from gateway.commands.media import MediaCommands
from gateway.commands.panels import PanelsCommands
from gateway.commands.rooms import RoomsCommands, _is_keeper, _privilege_level
from gateway.commands.rules import RulesCommands
from gateway.commands.sheet import SheetCommands
from gateway.commands.types import CommandCtx, CommandReply, CommandSpec
from gateway.commands.world import WorldCommands
from gateway.ops import (
    Botlist,
    PrivilegeLevel,
)
from infra.i18n import get_i18n

logger = logging.getLogger(__name__)
_COMMAND_TOKEN_RE = re.compile(r"([^\s]+)(?:\s+(.*))?$", re.S)

_SLASH_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")

# Hard cap on a command's argument-string length (router-level). Legitimate command
# arguments are far shorter; the cap defends the whole command surface against an
# oversized argument being fed into a parser/regex (e.g. `.st`'s quadratic-backtracking
# assignment regex) and stalling the event loop.
_MAX_COMMAND_ARG_LEN = 4000


def _ctx_locale(ctx: AgentCtx | Any) -> str:
    return str(getattr(ctx, "locale", "en") or "en")


def _is_zh(locale: str) -> bool:
    return locale.casefold().startswith("zh")


class CommandRouter(
    ChecksCommands,
    SheetCommands,
    RulesCommands,
    RoomsCommands,
    CastCommands,
    WorldCommands,
    PanelsCommands,
    MediaCommands,
    LlmCommands,
):
    def __init__(
        self,
        services: Services,
        prefixes: tuple[str, ...] = (".", "。", "/"),
        *,
        keystore: Any = None,
        hub: Any = None,
        botlist: Botlist | None = None,
    ) -> None:
        self.services = services
        self.prefixes = prefixes
        # Optional cross-transport deps for the `.room` family: `keystore` mints
        # terminal join keys (`.room open`); `hub` reports online members
        # (`.room` show). Both default to None so a standalone router still works
        # (those subcommands then degrade to a localized notice).
        self.keystore = keystore
        self.hub = hub
        # The anti-loop ignore list `.botlist` mutates (see `gateway.ops.Botlist`).
        # `GatewayRunner` reads THIS SAME instance (`self.command_router.botlist`)
        # for its per-message pre-LLM gate, so there is exactly one Botlist per
        # router/runner pair -- never two independently-mutated copies. A caller
        # may inject a pre-built list (e.g. seeded in tests); default is empty.
        self.botlist = botlist if botlist is not None else Botlist()
        self._specs = self._build_specs()
        self._alias_maps = {
            "en": self._build_alias_map("en"),
            "zh": self._build_alias_map("zh"),
        }

    def resolve(self, text: str, locale: str) -> tuple[CommandSpec, str] | None:
        stripped = text.strip()
        prefix = next((item for item in self.prefixes if stripped.startswith(item)), "")
        if not prefix:
            return None

        rest = stripped[len(prefix) :].lstrip()
        match = _COMMAND_TOKEN_RE.match(rest)
        if not match:
            return None

        token = match.group(1).casefold()
        args = (match.group(2) or "").strip()
        for dialect in self._locale_order(locale):
            spec = self._alias_maps[dialect].get(token)
            if spec is not None:
                return spec, args
        return None

    async def dispatch(self, ctx: AgentCtx | Any, text: str) -> str | None:
        """Run a command and return its localized text for non-hub callers."""
        reply = await self.dispatch_reply(ctx, text)
        return reply.text if reply is not None else None

    async def dispatch_reply(self, ctx: AgentCtx | Any, text: str) -> CommandReply | None:
        """Run a command once, preserving any structured events produced by it."""
        locale = _ctx_locale(ctx)
        resolved = self.resolve(text, locale)
        if resolved is None:
            rendered = self._render_inline_rolls(text, locale)
            return CommandReply(rendered) if rendered is not None else None

        spec, args = resolved
        # Router-level argument cap: bound the untrusted argument string before any
        # handler (or its parsers/regexes) touches it, so a single oversized argument
        # cannot stall the event loop (e.g. quadratic backtracking in `.st` parsing).
        if len(args) > _MAX_COMMAND_ARG_LEN:
            return CommandReply(get_i18n(locale).t("commands.error.too_long", limit=_MAX_COMMAND_ARG_LEN), error=True)
        if spec.required_level and _privilege_level(ctx) < spec.required_level:
            # Broadcasting "you may not do that" tells the whole room the command
            # exists AND that it is privileged — the exact F16 probe vector.
            return CommandReply(get_i18n(locale).t("rooms.denied"), error=True)
        command = text.strip()[1:].split(maxsplit=1)[0] if text.strip() else spec.canonical
        command_ctx = CommandCtx(
            services=self.services,
            router=self,
            raw_ctx=ctx,
            spec=spec,
            command=command,
            args=args,
            locale=locale,
            i18n=get_i18n(locale),
        )
        try:
            rendered = await spec.handler(command_ctx)
        except CharacterDataError:
            # A present-but-unreadable character row must abort the command rather than
            # let any handler proceed against a blank sheet (the silent-wipe bug class).
            logger.exception("character row unreadable during command %s", spec.canonical)
            return CommandReply(get_i18n(locale).t("kp_tools.character.data_error"), error=True)
        except ResolutionError as exc:
            # THE choke for the whole command lane: every check/opposed/subsystem
            # word rolls through one compiled resolver, and a resolver that cannot
            # roll (a `{slot}` the pack never defaulted, a ladder handed no target)
            # used to escape as a bare `server_error` and drop the turn (audit F07).
            # A pack that genuinely cannot be defaulted still fails — loudly, in the
            # room's language, NAMING what it needs.
            logger.warning("resolution failed during command %s: %s", spec.canonical, exc)
            return CommandReply(_resolution_notice(get_i18n(locale), exc), error=True)
        return CommandReply(rendered, tuple(command_ctx.events), error=command_ctx.failed)

    def slash_definitions(self, locale: str = "en") -> list[dict]:
        i18n = get_i18n(locale)
        definitions = []
        for spec in self._specs:
            if spec.slash is None:
                continue
            name = str(spec.slash.get("name") or spec.canonical).casefold()
            if not _SLASH_NAME_RE.fullmatch(name):
                continue
            definition = {
                "name": name,
                "description": i18n.t(spec.help_key),
            }
            if spec.slash.get("options"):
                definition["options"] = spec.slash["options"]
            definitions.append(definition)
        return definitions

    async def cmd_help(self, ctx: CommandCtx) -> str:
        prefix = ctx.router.prefixes[0]
        player_names: list[str] = []
        keeper_names: list[str] = []
        for spec in self._specs:
            aliases = spec.aliases_zh if _is_zh(ctx.locale) else spec.aliases_en
            name = f"{prefix}{aliases[0]}"
            if spec.keeper_help or spec.required_level:
                keeper_names.append(name)
            else:
                player_names.append(name)
        lines = [ctx.i18n.t("commands.help.result", commands=", ".join(player_names))]
        if _is_keeper(ctx.raw_ctx):
            if keeper_names:
                lines.append(ctx.i18n.t("commands.help.keeper_section", commands=", ".join(keeper_names)))
        else:
            lines.append(ctx.i18n.t("commands.help.player_hint"))
        return "\n".join(lines)

    def _build_specs(self) -> list[CommandSpec]:
        specs = self._static_specs()
        # Pack-declared dot-command dialect words (stage D): every word ANY
        # discovered pack declares gets one spec routed through cmd_pack_word,
        # which resolves it against the ROOM's pack at dispatch (a word the
        # room's system doesn't declare is refused there). Words a static spec
        # already claims (ra/rc on `check`) stay with that spec.
        claimed = {word for spec in specs for word in (*spec.aliases_en, *spec.aliases_zh)}
        for word in sorted(all_command_words()):
            if word in claimed:
                continue
            specs.append(
                CommandSpec(word, self.cmd_pack_word, [word], [word], None, "commands.help.pack_word")
            )
        return specs

    def _static_specs(self) -> list[CommandSpec]:
        return [
            CommandSpec("roll", self.cmd_roll, ["roll", "r"], ["r", "rd"], {"name": "roll"}, "commands.help.roll"),
            CommandSpec(
                "hidden_roll",
                self.cmd_hidden_roll,
                ["rh", "hroll"],
                ["rh"],
                None,
                "commands.help.hidden_roll",
                private_reply=True,
            ),
            CommandSpec(
                "check",
                self.cmd_check,
                ["check", "save", "attack", "cast", "ra", "rc"],
                ["ra", "rc"],
                {"name": "check"},
                "commands.help.check",
            ),
            CommandSpec("opposed", self.cmd_opposed, ["opposed", "rav", "rcv"], ["rav", "rcv"], None, "commands.help.opposed"),

            CommandSpec("sheet", self.cmd_sheet, ["sheet", "st"], ["st"], {"name": "sheet"}, "commands.help.sheet"),
            CommandSpec(
                "npc",
                self.cmd_cast,
                ["npc"],
                ["npc", "角色"],
                None,
                "commands.help.npc",
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "companion",
                self.cmd_cast,
                ["companion"],
                ["companion", "同伴"],
                None,
                "commands.help.companion",
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "panel",
                self.cmd_panel,
                ["panel"],
                ["panel", "面板"],
                {"name": "panel"},
                "commands.help.panel",
                # Per-viewer content by construction (audience filter + this member's own
                # variables), so the answer goes to the caller alone, never the room.
                private_reply=True,
            ),
            CommandSpec(
                "language",
                self.cmd_language,
                ["language"],
                ["language"],
                {"name": "language"},
                "commands.help.language",
                keeper_help=True,
            ),
            CommandSpec(
                "bind",
                self.cmd_bind,
                ["bind"],
                ["bind", "绑定", "綁定"],
                None,
                "commands.help.bind",
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "unbind",
                self.cmd_unbind,
                ["unbind"],
                ["unbind", "解绑", "解綁"],
                None,
                "commands.help.unbind",
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec("init", self.cmd_initiative, ["init", "initiative", "ri"], ["ri", "init"], {"name": "init"}, "commands.help.init"),
            CommandSpec(
                "genchar",
                self.cmd_genchar,
                ["genchar"],
                ["genchar", "生卡", "生成角色"],
                None,
                "charcard.commands.genchar.help",
            ),
            CommandSpec("rule", self.cmd_rule, ["rule"], ["rule", "规则"], {"name": "rule"}, "commands.help.rule", keeper_help=True),
            CommandSpec("rename", self.cmd_rename, ["rename", "nn"], ["nn"], None, "commands.help.rename"),
            CommandSpec("jrrp", self.cmd_jrrp, ["jrrp", "luck"], ["jrrp"], None, "commands.help.jrrp"),
            CommandSpec("draw", self.cmd_draw, ["draw"], ["draw", "抽牌"], None, "commands.help.draw"),
            CommandSpec("bot", self.cmd_bot_toggle, ["bot"], ["bot"], None, "commands.help.bot", keeper_help=True),
            CommandSpec("skill", self.cmd_skill, ["skill"], ["skill"], None, "commands.help.skill"),
            CommandSpec("phase", self.cmd_phase, ["phase"], ["phase", "阶段", "階段"], None, "commands.help.phase"),
            CommandSpec("dev", self.cmd_dev, ["dev"], ["dev"], None, "commands.help.dev", keeper_help=True),
            CommandSpec("undo", self.cmd_undo, ["undo"], ["undo", "撤销", "撤銷"], None, "commands.help.undo", keeper_help=True),
            CommandSpec("save", self.cmd_save, ["save"], ["save", "存档", "存檔"], None, "commands.help.save", keeper_help=True),
            CommandSpec(
                "habits",
                self.cmd_habits,
                ["habits"],
                ["habits", "习惯", "習慣"],
                None,
                "commands.help.habits",
                # Every line judges the PLAYERS ("they lose patience with long combats") —
                # broadcast would hand the table the notes written about it. Unicast only.
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec("panels", self.cmd_panels, ["panels"], ["panels", "模组面板"], None, "commands.help.panels"),
            CommandSpec("avatar", self.cmd_avatar, ["avatar"], ["avatar", "头像"], None, "commands.help.avatar"),
            CommandSpec(
                "audio",
                self.cmd_audio,
                ["audio"],
                ["audio", "音频", "音訊"],
                None,
                "commands.help.audio",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
            ),
            CommandSpec(
                "bgm",
                self.cmd_bgm,
                ["bgm"],
                ["bgm", "背景音乐", "背景音樂"],
                None,
                "commands.help.bgm",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
            ),
            CommandSpec(
                "ambience",
                self.cmd_ambience,
                ["ambience", "amb"],
                ["ambience", "amb", "环境音", "環境音"],
                None,
                "commands.help.ambience",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
            ),
            CommandSpec(
                "sfx",
                self.cmd_sfx,
                ["sfx"],
                ["sfx", "音效"],
                None,
                "commands.help.sfx",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
            ),
            CommandSpec(
                "botlist",
                self.cmd_botlist,
                ["botlist"],
                ["botlist", "机器人名单", "機器人名單"],
                None,
                "commands.help.botlist",
                # Same admin tier as `.room`/`.import`/`.module`: mutating the anti-loop
                # ignore list is an operational control, not a player action.
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
            ),
            CommandSpec(
                "report",
                self.cmd_report,
                ["report"],
                ["report", "团报", "跑团记录"],
                {"name": "report"},
                "commands.help.report",
            ),
            CommandSpec(
                "recap",
                self.cmd_recap,
                ["recap"],
                ["recap", "前情提要", "前情"],
                {"name": "recap"},
                "commands.help.recap",
            ),
            CommandSpec(
                "chronicle",
                self.cmd_chronicle,
                ["chronicle"],
                ["chronicle", "编年史", "年史"],
                {"name": "chronicle"},
                "commands.help.chronicle",
                # Replies can carry keeper annotations (list/summary) — unicast only.
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "party",
                self.cmd_party,
                ["party"],
                ["party", "队伍", "隊伍"],
                None,
                "companion.commands.party.help",
            ),
            CommandSpec(
                "lore",
                self.cmd_lore,
                ["lore"],
                ["lore", "设定", "設定"],
                None,
                "worldbook.commands.lore.help",
                # `.lore query`/`.lore add`/`.lore import` read or write keeper-only secret
                # lore (see `cmd_lore`'s `_keeper` gate); a keeper's reply must not be
                # broadcast to the whole room.
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "import",
                self.cmd_import,
                ["import"],
                ["import", "导入", "導入"],
                None,
                "charcard.commands.import.help",
            ),
            CommandSpec(
                "var",
                self.cmd_var,
                ["var", "vars"],
                ["var", "变量", "變量"],
                None,
                "vars.commands.help",
                # Keeper-only curation of the imported variable tree's player visibility;
                # `list` prints the hidden remainder, so replies stay on the caller.
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "pc",
                self.cmd_pc,
                ["pc", "roster"],
                ["pc", "角色池", "预设角色"],
                None,
                "pregen.commands.help",
            ),
            CommandSpec(
                "preset",
                self.cmd_preset,
                ["preset"],
                ["preset", "预设", "預設"],
                None,
                "preset.commands.help",
                # `import` echoes server-side paths and parse errors; keep replies off
                # the room bus.
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "module",
                self.cmd_module,
                ["module"],
                ["module", "模组", "導入模組"],
                None,
                "commands.module.help",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
                # Import results include the source filename, document counts, and
                # initializer diagnostics. Keep both progress and the final reply
                # on the invoking Keeper's connection.
                private_reply=True,
            ),
            CommandSpec(
                "room",
                self.cmd_room,
                ["room"],
                ["room", "房间", "房間"],
                None,
                "commands.help.room",
                keeper_help=True,
                # A `.room open` reply carries the join key: the caller alone sees it.
                private_reply=True,
            ),
            CommandSpec(
                "reset",
                self.cmd_reset,
                ["reset"],
                ["reset", "重置", "重开", "重開"],
                None,
                "commands.help.reset",
                keeper_help=True,
            ),
            CommandSpec(
                "model",
                self.cmd_model,
                ["model"],
                ["model", "模型"],
                None,
                "commands.help.model",
                # `.model key` echoes a masked API key; `.model show`/`set`/`reset` also
                # surface provider/base_url/key config. None of that belongs on the room bus.
                private_reply=True,
                keeper_help=True,
            ),
            CommandSpec(
                "help",
                self.cmd_help,
                ["help", "h"],
                ["help", "帮助"],
                {"name": "help"},
                "commands.help.help",
                # Player and keeper lists differ; broadcasting a keeper's list
                # would undo the split.
                private_reply=True,
            ),
        ]

    def _build_alias_map(self, locale: str) -> dict[str, CommandSpec]:
        alias_map = {}
        for spec in self._specs:
            aliases = spec.aliases_zh if locale == "zh" else spec.aliases_en
            for alias in aliases:
                alias_map[alias.casefold()] = spec
        return alias_map

    def _locale_order(self, locale: str) -> tuple[str, str]:
        return ("zh", "en") if _is_zh(locale) else ("en", "zh")
