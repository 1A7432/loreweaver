"""Platform-independent command router with EN slash and CN SealDice dialects."""

from __future__ import annotations

import random
import re
import shlex
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from agent.context import AgentCtx
from agent.services import Services
from core.char_from_persona import build_sheet_from_description
from core.character_manager import CharacterSheet
from core.character_rules import render_validation_notice, validate_sheet
from core.coc_rules import DEFAULT_COC_RULE
from core.dice_engine import DiceResult, coc_rank_label
from core.rulepacks import RulePack, load_rulepack
from core.skills import available_skills
from gateway.audio import build_audio_control, list_audio_items, resolve_audio_item, update_audio_item
from gateway.avatar import AvatarError, set_target_avatar, set_user_avatar
from gateway.hub import Event
from gateway.imagegen import allow_imagegen_request, image_name
from gateway.media import media_frame, publish_media
from gateway.ops import Botlist, PrivilegeLevel, get_enabled_skills, is_media_enabled, set_enabled_skills
from gateway.rooms import clear_binding, get_binding, mint_room_id, session_key_for_room, set_binding
from gateway.turn import publish_state
from infra.i18n import I18n, get_i18n
from infra.imagegen import ImageGenError
from infra.media_store import ALLOWED_IMAGE_MIMES, MediaStore
from infra.providers import (
    CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES,
    NATIVE_PROVIDER_NAMES,
    PRESETS,
    describe_settings,
    is_known_provider,
    mask_secret,
)

Handler = Callable[["CommandCtx"], Awaitable[str]]

_INLINE_RE = re.compile(r"\[\[([^\[\]]+)\]\]")
_COMMAND_TOKEN_RE = re.compile(r"([^\s]+)(?:\s+(.*))?$", re.S)
_MULTI_PREFIX_RE = re.compile(r"^\s*(\d{1,2})[#＃]\s*(.*)$", re.S)
_TRAILING_NUMBER_RE = re.compile(r"^(.+?)(\d{1,3})$")
_SHEET_ASSIGN_RE = re.compile(r"(.+?)([+-]?(?:\d+d\d+(?:[+\-*/]\d+)?|\d+))(?:\s*|$)", re.I)
_EXPLODE_BANG_RE = re.compile(r"(\d*d(\d+))!", re.I)

_SLASH_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")

_GENCHAR_SYSTEMS = {
    "coc": "coc7",
    "coc7": "coc7",
    "dnd": "dnd5e",
    "dnd5e": "dnd5e",
    "d&d5e": "dnd5e",
}

_COC_ATTR_TO_KEY = {
    "力量": "STR",
    "体质": "CON",
    "体型": "SIZ",
    "敏捷": "DEX",
    "外貌": "APP",
    "智力": "INT",
    "意志": "POW",
    "教育": "EDU",
    "幸运": "LUC",
    "理智": "SAN",
    "理智上限": "SANMAX",
    "生命值": "HP",
    "生命值上限": "HPMAX",
    "魔法值": "MP",
    "魔法值上限": "MPMAX",
    "DB": "DB",
    "体格": "BUILD",
    "移动力": "MOV",
    "护甲": "AR",
}
_COC_KEY_TO_ATTR = {value: key for key, value in _COC_ATTR_TO_KEY.items()}
_COC_SKILL_TO_MANAGER = {
    "信用评级": "信用",
    "图书馆": "图书馆",
    "博物": "博物",
    "骑乘": "骑乘",
    "驯兽": "驯兽",
}

_DND_ATTR_TO_KEY = {
    "力量": "STR",
    "敏捷": "DEX",
    "体质": "CON",
    "智力": "INT",
    "感知": "WIS",
    "魅力": "CHA",
}
_DND_KEY_TO_ATTR = {value: key for key, value in _DND_ATTR_TO_KEY.items()}
_DND_SECONDARY_TO_KEY = {
    "hp": "生命值",
    "hpmax": "生命值上限",
    "ac": "护甲等级",
    "dc": "难度等级",
    "pp": "被动感知",
    "熟练": "熟练加值",
}
_DND_SKILL_TO_MANAGER = {"求生": "生存"}
_DND_SKILLS = {
    "运动",
    "体操",
    "巧手",
    "隐匿",
    "调查",
    "奥秘",
    "历史",
    "自然",
    "宗教",
    "察觉",
    "洞悉",
    "驯兽",
    "医药",
    "求生",
    "游说",
    "欺瞒",
    "威吓",
    "表演",
}

_DIFFICULTY_PREFIXES = (
    ("大成功", 4),
    ("极难", 3),
    ("極難", 3),
    ("困难", 2),
    ("困難", 2),
)
_DIFFICULTY_WORDS = {
    "critical": 4,
    "crit": 4,
    "extreme": 3,
    "hard": 2,
    "regular": 1,
    "normal": 1,
}
_ADV_WORDS = {"adv", "advantage", "优势", "優勢"}
_DIS_WORDS = {"dis", "disadvantage", "劣势", "劣勢"}
_PROF_WORDS = {"prof", "proficient", "proficiency", "熟练", "熟練"}

# `.party` subcommand vocabularies (EN + a couple of CN synonyms) -- AI companion party (M10).
_PARTY_ADD_WORDS = {"add", "new", "recruit", "加入", "招募", "添加"}
_PARTY_ACT_WORDS = {"act", "go", "行动", "行動"}
_PARTY_AUTO_WORDS = {"auto", "自动", "自動"}
_PARTY_LIST_WORDS = {"", "list", "ls", "列表", "查看"}
_PARTY_REMOVE_WORDS = {"remove", "rm", "del", "delete", "移除", "删除", "刪除"}

# `.lore` subcommand vocabularies (EN + a couple of CN synonyms) -- world lore (M11).
_LORE_ADD_WORDS = {"add", "new", "添加", "新增"}
_LORE_LIST_WORDS = {"", "list", "ls", "列表", "查看"}
_LORE_QUERY_WORDS = {"query", "search", "find", "查询", "查詢", "搜索"}
_LORE_IMPORT_WORDS = {"import", "load", "导入", "導入"}

# `.room` subcommand vocabularies (EN + a couple of CN synonyms).
_ROOM_OPEN_WORDS = {"open", "new", "create", "开", "开房", "開", "開房"}
_ROOM_LINK_WORDS = {"link", "join", "bind", "连", "連", "加入"}
_ROOM_LEAVE_WORDS = {"leave", "unbind", "close", "离开", "離開", "解绑", "解綁"}
_ROOM_SHOW_WORDS = {"", "show", "status", "info", "查看"}

# `.report` detailed-log toggle words (EN + a couple of CN synonyms) -- session report export ("团报").
_REPORT_DETAILED_WORDS = {"detailed", "full", "log", "详细", "詳細", "完整", "全部"}

# `.model` subcommand vocabularies (EN + a couple of CN synonyms) -- runtime LLM config.
_MODEL_SHOW_WORDS = {"", "show", "status", "info", "查看", "状态", "狀態"}
_MODEL_LIST_WORDS = {"list", "ls", "providers", "列表", "列出"}
_MODEL_SET_WORDS = {"set", "use", "switch", "设置", "設置", "切换", "切換"}
_MODEL_KEY_WORDS = {"key", "apikey", "token", "密钥", "密鑰"}
_MODEL_RESET_WORDS = {"reset", "clear", "revert", "重置", "清除"}

# `.botlist` subcommand vocabularies (EN + a couple of CN synonyms) -- anti-loop
# bot-ignore list (`gateway.ops.Botlist`).
_BOTLIST_ADD_WORDS = {"add", "new", "添加", "新增"}
_BOTLIST_REMOVE_WORDS = {"remove", "rm", "del", "delete", "移除", "删除", "刪除"}
_BOTLIST_LIST_WORDS = {"", "list", "ls", "show", "列表", "查看"}

# `.skill` subcommand vocabularies (EN + a couple of CN synonyms) -- the per-room
# KP-skills layer (Layer B.1, `core.skills` + `gateway.ops.get/set_enabled_skills`).
_SKILL_STATUS_WORDS = {"status", "状态", "狀態"}
_SKILL_ENABLE_WORDS = {"enable", "on", "启用", "啟用"}
_SKILL_DISABLE_WORDS = {"disable", "off", "禁用", "关闭", "關閉"}

# `.audio` / `.bgm` / `.ambience` / `.sfx` subcommand vocabularies.
_AUDIO_LIST_WORDS = {"", "list", "ls", "show", "列表", "查看"}
_AUDIO_SET_WORDS = {"set", "meta", "metadata", "设置", "設置", "元数据", "元資料"}
_AUDIO_PLAY_WORDS = {"play", "start", "播放", "开始", "開始"}
_AUDIO_STOP_WORDS = {"stop", "停止"}
_AUDIO_PAUSE_WORDS = {"pause", "暂停", "暫停"}
_AUDIO_RESUME_WORDS = {"resume", "继续", "繼續"}
_AUDIO_VOLUME_WORDS = {"volume", "vol", "音量"}
_AVATAR_GEN_WORDS = {"gen", "generate", "生成"}
_AVATAR_CLEAR_WORDS = {"clear", "remove", "rm", "清除", "删除", "刪除"}

# `.st`/`.sheet` finalize word: re-derive current HP/MP/SAN to their maxima for
# the sheet's CURRENT characteristics (CREATION semantics -- see `cmd_sheet`).
# Deliberately locale-agnostic (checked regardless of `ctx.locale`), matching the
# other reserved `.st` subcommand words above (`clr`/`del`/...).
_SHEET_FINALIZE_WORDS = {"finalize", "定稿", "初始化"}

# Privilege inputs for `.room` gating. Chat platforms rarely surface a reliable
# admin flag through the generic InboundMessage.raw, so the gate treats the local
# CLI/terminal operator and private/DM sessions as owners of their own session,
# plus any explicit admin/owner marker the adapter happened to include in `raw`.
_ROOM_ADMIN_CHAT_TYPES = {"dm", "direct", "private"}
_ROOM_ADMIN_RAW_ROLES = {"admin", "administrator", "owner", "creator", "keeper", "master", "moderator"}
_ROOM_ADMIN_RAW_FLAGS = ("is_admin", "is_owner", "is_group_admin", "admin", "owner")

# TOPOLOGY, not privilege: platforms whose channel is inherently local/private rather
# than a public chat group (used e.g. by `_is_private_channel` to decide whether
# echoing a secret like an API key back inline is safe). Membership here does NOT by
# itself grant any privilege level — see `_AUTO_MASTER_PLATFORMS` / `_privilege_level`
# for who is actually authorized to run keeper-only commands on each platform.
_ROOM_LOCAL_PLATFORMS = {"cli", "tui"}

# PRIVILEGE: platforms that are a single, already-trusted local operator process with
# no keystore/role concept, so the caller is always the master. `tui` is deliberately
# excluded: it is a genuine multi-user network service (`net/tui_server.py`), so its
# privilege must instead be decided per-connection from the authenticated keystore role
# stamped into `ctx.extra["role"]` (see `_privilege_level`), never assumed from the
# platform name alone.
_AUTO_MASTER_PLATFORMS = {"cli"}
_TUI_KEEPER_ROLE = "keeper"


@dataclass
class CommandSpec:
    canonical: str
    handler: Handler
    aliases_en: list[str]
    aliases_zh: list[str]
    slash: dict | None
    help_key: str
    required_level: int = 0
    # A command whose reply can contain a keeper secret (masked API key, keeper-only
    # lore, a room join key that grants access) must never be broadcast to the whole
    # room via `hub.publish` -- see `gateway.turn.run_turn`, which delivers a
    # `private_reply` command's reply ONLY to the invoking connection (unicast via
    # `Member.deliver`), falling back to the normal broadcast only when there is no
    # `origin` member (e.g. a non-hub transport).
    private_reply: bool = False


@dataclass
class CommandCtx:
    services: Services
    router: CommandRouter
    raw_ctx: Any
    spec: CommandSpec
    command: str
    args: str
    locale: str
    i18n: I18n

    @property
    def chat_key(self) -> str:
        value = getattr(self.raw_ctx, "chat_key", "")
        return value() if callable(value) else str(value)

    @property
    def user_id(self) -> str:
        if hasattr(self.raw_ctx, "uid") and callable(self.raw_ctx.uid):
            return str(self.raw_ctx.uid())
        return str(getattr(self.raw_ctx, "user_id", ""))


@dataclass(frozen=True)
class GenCharRequest:
    system: str
    name: str
    description: str


class CommandRouter:
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
        locale = _ctx_locale(ctx)
        resolved = self.resolve(text, locale)
        if resolved is None:
            return self._render_inline_rolls(text, locale)

        spec, args = resolved
        if spec.required_level and _privilege_level(ctx) < spec.required_level:
            return get_i18n(locale).t("rooms.denied")
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
        return await spec.handler(command_ctx)

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

    async def cmd_roll(self, ctx: CommandCtx) -> str:
        args = ctx.args or "1d20"
        times, expression = _split_multi(args)
        times = min(times, 20)
        lines = []
        try:
            for _ in range(times):
                result = _roll_expression(ctx.services, expression)
                lines.append(ctx.i18n.t("commands.roll.result", result=_format_roll(result, ctx.i18n)))
        except ValueError:
            return ctx.i18n.t("commands.roll.invalid", expr=expression)
        return "\n".join(lines)

    async def cmd_hidden_roll(self, ctx: CommandCtx) -> str:
        expression = ctx.args or "1d20"
        try:
            result = _roll_expression(ctx.services, expression)
        except ValueError:
            return ctx.i18n.t("commands.roll.invalid", expr=expression)
        return ctx.i18n.t("commands.roll.hidden", result=_format_roll(result, ctx.i18n))

    async def cmd_check(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        if character.system == "DnD5e":
            return await self._cmd_check_dnd(ctx, character)
        return await self._cmd_check_coc(ctx, character)

    async def cmd_opposed(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = load_rulepack("coc7")
        args = ctx.args or "侦查"
        left_text, right_text = _split_two_args(args)
        left = _parse_coc_check_args(left_text or "侦查", pack)
        right = _parse_coc_check_args(right_text or left.name, pack)
        rule = await _get_coc_rule(ctx)
        left_value = _coc_check_value(character, pack, left.name, left.temp_value)
        right_value = _coc_check_value(character, pack, right.name, right.temp_value)
        left_roll = ctx.services.dice.roll_coc_check(left_value, rule=rule, difficulty=left.difficulty)
        right_roll = ctx.services.dice.roll_coc_check(right_value, rule=rule, difficulty=right.difficulty)
        if left_roll["rank"] > right_roll["rank"]:
            winner = ctx.i18n.t("commands.opposed.left")
        elif left_roll["rank"] < right_roll["rank"]:
            winner = ctx.i18n.t("commands.opposed.right")
        else:
            winner = ctx.i18n.t("commands.opposed.tie")
        return ctx.i18n.t(
            "commands.opposed.result",
            left=left.canonical,
            left_roll=left_roll["roll"],
            left_rank=coc_rank_label(left_roll["rank"], ctx.i18n),
            right=right.canonical,
            right_roll=right_roll["roll"],
            right_rank=coc_rank_label(right_roll["rank"], ctx.i18n),
            winner=winner,
        )

    async def cmd_sanity(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = load_rulepack("coc7")
        parsed = _parse_coc_check_args(ctx.args or "0/1", pack, default_name="理智")
        loss_text = parsed.remaining or ctx.args or "0/1"
        success_loss, failure_loss = _parse_sanity_loss(loss_text)
        san = _get_sheet_value(character, pack, "理智")
        rule = await _get_coc_rule(ctx)
        outcome = ctx.services.dice.roll_coc_check(san, rule=rule, bonus=parsed.bonus, penalty=parsed.penalty)
        loss_expr = success_loss if outcome["success"] else failure_loss
        # A non-numeric SAN-loss expression (e.g. `.sc 侦查/侦查`) must not crash the turn.
        try:
            loss = _roll_loss(ctx.services, loss_expr)
        except ValueError:
            return ctx.i18n.t("commands.roll.invalid", expr=loss_expr)
        _set_sheet_value(character, pack, "理智", max(0, san - loss))
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        return ctx.i18n.t(
            "commands.sanity.result",
            roll=outcome["roll"],
            rank=coc_rank_label(outcome["rank"], ctx.i18n),
            loss=loss,
            san=max(0, san - loss),
        )

    async def cmd_sheet(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = _pack_for_character(character)
        args = ctx.args.strip()
        if not args or args.casefold() == "show":
            return _render_sheet(ctx, character, pack)
        if args.casefold() in {"clr", "clear", "del", "delete"}:
            await ctx.services.characters.delete_character(ctx.user_id, ctx.chat_key, character.name)
            return ctx.i18n.t("commands.sheet.deleted", name=character.name)
        if args.casefold() in _SHEET_FINALIZE_WORDS:
            # A manual build (`.coc`/`.dnd` with DEFAULT characteristics, then one or
            # more `.st` edits to the chosen ones) never re-derives current HP/MP/SAN:
            # `.st` validates with `initialize_vitals=False` (in-play EDIT semantics —
            # preserve, never heal) by design (see `core.character_rules.validate_sheet`).
            # This finalize word is the CREATION-side re-derive: it forces the current
            # vitals back to their maxima for the sheet's final characteristics, same as
            # `.coc`/`.dnd`/`.genchar` do at birth. Safe to reuse mid-play too (a player
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
        for raw_name, raw_value in assignments:
            canonical = pack.resolve_skill(raw_name) or raw_name.strip()
            current = _get_sheet_value(character, pack, canonical)
            # A malformed value expression (bad int, or an over-large dice term like
            # `力量+9999d6` that trips d20's roll cap) must not crash the turn.
            try:
                value = _apply_value_expr(ctx.services, current, raw_value)
            except ValueError:
                return ctx.i18n.t("commands.roll.invalid", expr=raw_value)
            _set_sheet_value(character, pack, canonical, value)
            changed_names.append(canonical)
        character, violations = validate_sheet(character, character.system)
        for canonical in changed_names:
            changed.append(
                ctx.i18n.t("commands.sheet.changed_item", name=canonical, value=_get_sheet_value(character, pack, canonical))
            )
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        result = ctx.i18n.t("commands.sheet.changed", items=", ".join(changed))
        notice = render_validation_notice(ctx.i18n, violations)
        return f"{result}\n{notice}" if notice else result

    async def cmd_growth(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        pack = _pack_for_character(character)
        name = ctx.args or ("侦查" if character.system != "DnD5e" else "察觉")
        canonical = pack.resolve_skill(name) or name
        current = _get_sheet_value(character, pack, canonical)
        roll = ctx.services.dice.roll_expression("1d100").total
        gain = ctx.services.dice.roll_expression("1d10").total if roll > current else 0
        if gain:
            _set_sheet_value(character, pack, canonical, current + gain)
            await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        return ctx.i18n.t("commands.growth.result", name=canonical, roll=roll, gain=gain, value=current + gain)

    async def cmd_initiative(self, ctx: CommandCtx) -> str:
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        if character.system == "DnD5e":
            modifier = ctx.services.characters.get_dnd_ability_modifier(character, "DEX")
            expr = _d20_expr(modifier)
            result = ctx.services.dice.roll_expression(expr, is_check=True)
            return ctx.i18n.t("commands.init.result", name=character.name, result=_format_roll(result, ctx.i18n))
        try:
            dex = int(character.attributes.get("DEX", 50))
        except (ValueError, TypeError):
            dex = 50
        result = ctx.services.dice.roll_expression(f"1d100+{dex}", is_check=True)
        return ctx.i18n.t("commands.init.result", name=character.name, result=_format_roll(result, ctx.i18n))

    async def cmd_make_char(self, ctx: CommandCtx) -> str:
        template = "dnd5e" if ctx.spec.canonical == "dnd" else "coc7"
        default_name_key = "commands.character.dnd_name" if template == "dnd5e" else "commands.character.coc_name"
        name = ctx.args.strip() or ctx.i18n.t(default_name_key)
        character = ctx.services.characters.generate_character(template, name)
        character, violations = validate_sheet(character, template, initialize_vitals=True)
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        result = ctx.i18n.t("commands.character.created", name=character.name, system=character.system)
        notice = render_validation_notice(ctx.i18n, violations)
        return f"{result}\n{notice}" if notice else result

    async def cmd_genchar(self, ctx: CommandCtx) -> str:
        request = _parse_genchar_args(ctx.args)
        if request is None:
            return ctx.i18n.t("charcard.commands.genchar.usage")

        character = await build_sheet_from_description(
            ctx.services,
            request.description,
            request.system,
            name=request.name,
        )
        character, violations = validate_sheet(character, request.system, initialize_vitals=True)
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        result = ctx.i18n.t("charcard.commands.genchar.done", name=character.name, system=character.system)
        notice = render_validation_notice(ctx.i18n, violations)
        return f"{result}\n{notice}" if notice else result

    async def cmd_setcoc(self, ctx: CommandCtx) -> str:
        raw = ctx.args.strip().casefold()
        if raw == "dg":
            rule = 11
        elif raw.isdigit():
            rule = int(raw)
        else:
            rule = await _get_coc_rule(ctx)
            return ctx.i18n.t("commands.setcoc.current", rule=rule)

        if rule not in {0, 1, 2, 3, 4, 5, 11}:
            return ctx.i18n.t("commands.setcoc.invalid")
        await ctx.services.store.set(user_key="", store_key=f"coc_rule.{ctx.chat_key}", value=str(rule))
        return ctx.i18n.t("commands.setcoc.changed", rule=rule)

    async def cmd_rename(self, ctx: CommandCtx) -> str:
        new_name = ctx.args.strip()
        if not new_name:
            return ctx.i18n.t("commands.error.bad_args")
        character = await ctx.services.characters.get_character(ctx.user_id, ctx.chat_key)
        old_name = character.name
        character.name = new_name
        await ctx.services.characters.save_character(ctx.user_id, ctx.chat_key, character)
        if old_name and old_name != new_name:
            await ctx.services.characters.delete_character(ctx.user_id, ctx.chat_key, old_name)
        return ctx.i18n.t("commands.rename.changed", old=old_name, new=new_name)

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

    async def cmd_bot_toggle(self, ctx: CommandCtx) -> str:
        value = ctx.args.strip().casefold()
        if value in {"on", "1", "true", "开启", "啟用"}:
            await ctx.services.store.set(user_key="", store_key=f"bot_enabled.{ctx.chat_key}", value="1")
            return ctx.i18n.t("commands.bot.on")
        if value in {"off", "0", "false", "关闭", "關閉"}:
            await ctx.services.store.set(user_key="", store_key=f"bot_enabled.{ctx.chat_key}", value="0")
            return ctx.i18n.t("commands.bot.off")
        return ctx.i18n.t("commands.bot.status")

    async def cmd_botlist(self, ctx: CommandCtx) -> str:
        """`.botlist [add|remove|list] <bot_id>` — maintain the anti-loop bot-ignore
        list (`gateway.ops.Botlist`) that `GatewayRunner.on_inbound` consults on every
        inbound message. `<bot_id>` is a `SessionSource.user_key()` value, i.e.
        `"{platform}:{user_id}"` (e.g. `onebot:114514`) — the SAME identity string the
        runner derives from every inbound message, so an id copied from `.room`/a
        platform's own member list matches directly.

        Discord already marks a bot author via `SessionSource.is_bot` (the adapter
        reads the platform's own `author.bot` flag), so this command is mainly for
        platforms whose adapter does not set that flag (Telegram/Feishu/QQ-OneBot):
        without it, a second bot sharing one of those rooms looks like an ordinary
        player and the two can loop off each other's replies forever.
        """
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        if sub in _BOTLIST_ADD_WORDS:
            if not rest:
                return ctx.i18n.t("commands.botlist.usage")
            self.botlist.add(rest)
            return ctx.i18n.t("commands.botlist.added", id=rest)
        if sub in _BOTLIST_REMOVE_WORDS:
            if not rest:
                return ctx.i18n.t("commands.botlist.usage")
            self.botlist.remove(rest)
            return ctx.i18n.t("commands.botlist.removed", id=rest)
        if sub in _BOTLIST_LIST_WORDS:
            ids = self.botlist.list_ids()
            if not ids:
                return ctx.i18n.t("commands.botlist.empty")
            return ctx.i18n.t("commands.botlist.show", ids=", ".join(ids))
        return ctx.i18n.t("commands.botlist.usage")

    async def cmd_skill(self, ctx: CommandCtx) -> str:
        """`.skill [list | status | enable <id> | disable <id>]` — manage the
        per-room KP-skills layer (Layer B.1, ``docs/plugins.md`` "Layer B").
        Bare `.skill`/`.skill list` and `.skill status` are open to any player
        (viewing which skills exist / are on for this room); `enable`/`disable`
        mutate the room's play style — and, for a mature/explicit skill, lift the
        output censor (`gateway.ops.room_content_unfiltered`) — so those require
        keeper privilege.
        """
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""

        if sub in _SKILL_STATUS_WORDS:
            return await self._skill_status(ctx)
        if sub in _SKILL_ENABLE_WORDS:
            return await self._skill_set(ctx, rest, enable=True)
        if sub in _SKILL_DISABLE_WORDS:
            return await self._skill_set(ctx, rest, enable=False)
        return await self._skill_list(ctx)

    async def _skill_list(self, ctx: CommandCtx) -> str:
        enabled_ids = set(await get_enabled_skills(ctx.services.store, ctx.chat_key))
        lines = []
        for skill in available_skills():
            marker_key = "commands.skill.enabled_some" if skill.id in enabled_ids else "commands.skill.enabled_none"
            lines.append(f"[{ctx.i18n.t(marker_key)}] {skill.id} — {skill.name}")
        return ctx.i18n.t("commands.skill.list", items="\n".join(lines))

    async def _skill_status(self, ctx: CommandCtx) -> str:
        enabled_ids = await get_enabled_skills(ctx.services.store, ctx.chat_key)
        items = ", ".join(enabled_ids) if enabled_ids else ctx.i18n.t("commands.skill.enabled_none")
        return ctx.i18n.t("commands.skill.status", items=items)

    async def _skill_set(self, ctx: CommandCtx, skill_id: str, *, enable: bool) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.i18n.t("commands.skill.denied")
        skill_id = skill_id.strip()
        known_ids = {skill.id for skill in available_skills()}
        if not skill_id or skill_id not in known_ids:
            return ctx.i18n.t("commands.skill.unknown", id=skill_id)

        store = ctx.services.store
        enabled_ids = await get_enabled_skills(store, ctx.chat_key)
        if enable:
            if skill_id not in enabled_ids:
                enabled_ids = [*enabled_ids, skill_id]
            await set_enabled_skills(store, ctx.chat_key, enabled_ids)
            return ctx.i18n.t("commands.skill.enable_done", id=skill_id)

        enabled_ids = [item for item in enabled_ids if item != skill_id]
        await set_enabled_skills(store, ctx.chat_key, enabled_ids)
        return ctx.i18n.t("commands.skill.disable_done", id=skill_id)

    async def cmd_audio(self, ctx: CommandCtx) -> str:
        tokens = _shell_words(ctx.args)
        sub = tokens[0].casefold() if tokens else ""
        rest = tokens[1:] if tokens else []
        if sub in _AUDIO_LIST_WORDS:
            return await self._audio_list(ctx)
        if sub in _AUDIO_SET_WORDS:
            return await self._audio_set(ctx, rest)
        return ctx.i18n.t("commands.audio.usage")

    async def cmd_bgm(self, ctx: CommandCtx) -> str:
        return await self._audio_layer(ctx, "bgm", default_loop=True)

    async def cmd_ambience(self, ctx: CommandCtx) -> str:
        return await self._audio_layer(ctx, "ambience", default_loop=True)

    async def cmd_sfx(self, ctx: CommandCtx) -> str:
        return await self._audio_layer(ctx, "sfx", default_loop=False)

    async def cmd_avatar(self, ctx: CommandCtx) -> str:
        tokens = _shell_words(ctx.args)
        sub = tokens[0].casefold() if tokens else ""
        rest = tokens[1:] if tokens else []
        if sub in _AVATAR_CLEAR_WORDS:
            return await self._avatar_clear(ctx)
        if sub in _AVATAR_GEN_WORDS:
            return await self._avatar_generate(ctx, rest)
        return ctx.i18n.t("commands.avatar.usage")

    async def _avatar_clear(self, ctx: CommandCtx) -> str:
        try:
            sheet = await set_user_avatar(ctx.services, user_id=ctx.user_id, chat_key=ctx.chat_key, avatar=None)
        except AvatarError as exc:
            return ctx.i18n.t(f"commands.avatar.error.{exc.code}")
        if ctx.router.hub is not None:
            await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
        return ctx.i18n.t("commands.avatar.cleared", name=sheet.name)

    async def _avatar_generate(self, ctx: CommandCtx, tokens: list[str]) -> str:
        if not tokens:
            return ctx.i18n.t("commands.avatar.usage")
        if not await is_media_enabled(ctx.services.store, ctx.chat_key):
            return ctx.i18n.t("commands.avatar.media_disabled")
        if ctx.services.imagegen is None:
            return ctx.i18n.t("commands.avatar.not_configured")
        if not allow_imagegen_request(ctx.services, ctx.chat_key):
            return ctx.i18n.t("commands.avatar.rate_limited")

        target_name = ""
        prompt_tokens = tokens
        if len(tokens) >= 2:
            maybe_target = tokens[0]
            target_record = await _resolve_avatar_target(ctx, maybe_target)
            if target_record is not None:
                if not _is_keeper(ctx.raw_ctx):
                    return ctx.i18n.t("commands.avatar.denied")
                target_name = maybe_target
                prompt_tokens = tokens[1:]
        prompt = " ".join(prompt_tokens).strip()
        if not prompt:
            return ctx.i18n.t("commands.avatar.usage")

        if ctx.router.hub is not None:
            await ctx.router.hub.publish(
                ctx.chat_key,
                Event(kind="system", text=ctx.i18n.t("commands.avatar.generating"), data={"level": "info", "spinner": True}),
            )
        try:
            data, mime = await ctx.services.imagegen.generate(prompt, size=ctx.services.settings.imagegen.size)
            settings = ctx.services.settings.tui
            store = MediaStore(
                ctx.services.store,
                ctx.services.settings.data_dir,
                max_file_bytes=settings.media_max_file_bytes,
                room_quota_bytes=settings.media_room_quota_bytes,
                allowed_mimes=ALLOWED_IMAGE_MIMES,
            )
            record = await store.register_blob(
                room=ctx.chat_key,
                data=data,
                mime=mime,
                name=image_name("avatar", prompt),
                uploader=ctx.user_id,
            )
            if target_name:
                sheet = await set_target_avatar(ctx.services, chat_key=ctx.chat_key, target=target_name, avatar=record.ref())
            else:
                sheet = await set_user_avatar(ctx.services, user_id=ctx.user_id, chat_key=ctx.chat_key, avatar=record.ref())
            await publish_media(ctx.router.hub, ctx.services.store, ctx.chat_key, media_frame(record, from_name=sheet.name))
            if ctx.router.hub is not None:
                await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
            return ctx.i18n.t("commands.avatar.generated", name=sheet.name, file=record.name, hash=record.hash[:12])
        except AvatarError as exc:
            return ctx.i18n.t(f"commands.avatar.error.{exc.code}")
        except ImageGenError as exc:
            return ctx.i18n.t(f"commands.avatar.error.{exc.code}")
        except Exception as exc:
            return ctx.i18n.t("commands.avatar.failed", error=str(exc))

    async def _audio_list(self, ctx: CommandCtx) -> str:
        items = await list_audio_items(ctx.services.store, ctx.chat_key)
        if not items:
            return ctx.i18n.t("commands.audio.empty")
        lines = [_audio_item_line(item) for item in items[-25:]]
        return ctx.i18n.t("commands.audio.list", items="\n".join(lines))

    async def _audio_set(self, ctx: CommandCtx, tokens: list[str]) -> str:
        query, metadata = _split_audio_metadata(tokens)
        if not query or not metadata:
            return ctx.i18n.t("commands.audio.set_usage")
        resolved = await update_audio_item(ctx.services.store, ctx.chat_key, query, metadata)
        if resolved.status == "not_found":
            return ctx.i18n.t("commands.audio.not_found", query=query)
        if resolved.status == "ambiguous":
            return ctx.i18n.t("commands.audio.ambiguous", matches=_audio_matches(resolved.matches))
        assert resolved.item is not None
        await self._publish_audio(ctx, resolved.item)
        return ctx.i18n.t("commands.audio.updated", item=_audio_item_label(resolved.item))

    async def _audio_layer(self, ctx: CommandCtx, layer: str, *, default_loop: bool) -> str:
        tokens = _shell_words(ctx.args)
        if not tokens:
            return ctx.i18n.t(f"commands.audio.{layer}.usage")

        sub = tokens[0].casefold()
        if sub in _AUDIO_STOP_WORDS:
            return await self._audio_control(ctx, layer, "stop")
        if sub in _AUDIO_PAUSE_WORDS:
            return await self._audio_control(ctx, layer, "pause")
        if sub in _AUDIO_RESUME_WORDS:
            return await self._audio_control(ctx, layer, "resume")
        if sub in _AUDIO_VOLUME_WORDS:
            volume = _parse_audio_volume(tokens[1:])
            if volume is None:
                return ctx.i18n.t("commands.audio.volume_usage")
            return await self._audio_control(ctx, layer, "volume", volume=volume)

        play_tokens = tokens[1:] if sub in _AUDIO_PLAY_WORDS else tokens
        query, options = _split_audio_play(play_tokens, default_loop=default_loop)
        if not query:
            return ctx.i18n.t(f"commands.audio.{layer}.usage")
        resolved = await resolve_audio_item(ctx.services.store, ctx.chat_key, query)
        if resolved.status == "not_found":
            return ctx.i18n.t("commands.audio.not_found", query=query)
        if resolved.status == "ambiguous":
            return ctx.i18n.t("commands.audio.ambiguous", matches=_audio_matches(resolved.matches))
        assert resolved.item is not None
        return await self._audio_control(
            ctx,
            layer,
            "play",
            item=resolved.item,
            volume=options.get("volume"),
            loop=bool(options.get("loop")),
            fade_ms=options.get("fade_ms"),
        )

    async def _audio_control(
        self,
        ctx: CommandCtx,
        layer: str,
        action: str,
        *,
        item: dict[str, Any] | None = None,
        volume: float | None = None,
        loop: bool | None = None,
        fade_ms: int | None = None,
    ) -> str:
        control, state = await build_audio_control(
            ctx.services.store,
            ctx.chat_key,
            layer=layer,
            action=action,
            item=item,
            volume=volume,
            loop=loop,
            fade_ms=fade_ms,
        )
        await self._publish_audio(ctx, control)
        if state is not None:
            await self._publish_audio(ctx, state)
        if action == "play" and item is not None:
            return ctx.i18n.t("commands.audio.played", layer=ctx.i18n.t(f"commands.audio.layer.{layer}"), item=_audio_item_label(item))
        if action == "volume":
            return ctx.i18n.t("commands.audio.volume_done", layer=ctx.i18n.t(f"commands.audio.layer.{layer}"), volume=f"{(volume or 0) * 100:.0f}%")
        return ctx.i18n.t("commands.audio.control_done", layer=ctx.i18n.t(f"commands.audio.layer.{layer}"), action=ctx.i18n.t(f"commands.audio.action.{action}"))

    async def _publish_audio(self, ctx: CommandCtx, frame: dict[str, Any]) -> None:
        if ctx.router.hub is not None:
            await ctx.router.hub.publish(ctx.chat_key, Event.audio(frame))

    async def cmd_help(self, ctx: CommandCtx) -> str:
        names = []
        for spec in self._specs:
            aliases = spec.aliases_zh if _is_zh(ctx.locale) else spec.aliases_en
            names.append(f"{ctx.router.prefixes[0]}{aliases[0]}")
        return ctx.i18n.t("commands.help.result", commands=", ".join(names))

    async def cmd_room(self, ctx: CommandCtx) -> str:
        """`.room [open|link <key>|leave]` — bind/inspect this channel's shared
        session (M7 §4). Bindings are keyed by the ORIGIN channel's chat_key, not
        the (already-resolved) `ctx.chat_key`, so `resolve_session_key` finds
        them on the next inbound message."""
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        channel_key = _channel_chat_key(ctx.raw_ctx)
        store = ctx.services.store
        if sub in _ROOM_OPEN_WORDS:
            return await self._room_open(ctx, store, channel_key)
        if sub in _ROOM_LINK_WORDS:
            return await self._room_link(ctx, store, channel_key, rest)
        if sub in _ROOM_LEAVE_WORDS:
            return await self._room_leave(ctx, store, channel_key)
        if sub in _ROOM_SHOW_WORDS:
            return await self._room_show(ctx, store, channel_key)
        return ctx.i18n.t("rooms.usage")

    async def _room_open(self, ctx: CommandCtx, store: Any, channel_key: str) -> str:
        if self.keystore is None:
            return ctx.i18n.t("rooms.open.no_keystore")
        room_id = mint_room_id()
        session_key = session_key_for_room(room_id)
        join_key = self.keystore.add(room=room_id)
        await set_binding(store, channel_key, session_key)
        return ctx.i18n.t("rooms.open.result", key=join_key, session=session_key)

    async def _room_link(self, ctx: CommandCtx, store: Any, channel_key: str, rest: str) -> str:
        if not rest:
            return ctx.i18n.t("rooms.link.usage")
        session_key = self._room_link_target(rest)
        if session_key is None:
            # A token that is not a known keystore join key is refused outright: no
            # binding, no leak. (Accepting a literal session id here would let a caller
            # bind their channel to an arbitrary FOREIGN session and read/eavesdrop it.)
            return ctx.i18n.t("rooms.link.invalid_key")
        await set_binding(store, channel_key, session_key)
        return ctx.i18n.t("rooms.link.result", session=session_key)

    def _room_link_target(self, token: str) -> str | None:
        """Resolve a keystore join KEY to its terminal session, or ``None`` if
        ``token`` is not a known join key.

        Only a real join key (minted by ``.room open`` and handed to invitees) may
        bind a channel to a shared session — there is deliberately NO literal
        session-id fallback, which would otherwise let anyone bind to (and read /
        eavesdrop) an arbitrary foreign session by guessing its id."""
        if self.keystore is not None:
            entry = self.keystore.get(token)
            if entry is not None:
                return session_key_for_room(entry.room)
        return None

    async def _room_leave(self, ctx: CommandCtx, store: Any, channel_key: str) -> str:
        binding = await get_binding(store, channel_key)
        if not binding:
            return ctx.i18n.t("rooms.leave.none")
        await clear_binding(store, channel_key)
        return ctx.i18n.t("rooms.leave.result", session=binding)

    async def _room_show(self, ctx: CommandCtx, store: Any, channel_key: str) -> str:
        binding = await get_binding(store, channel_key)
        if not binding:
            return ctx.i18n.t("rooms.show.none")
        online = 0
        members_text = ctx.i18n.t("rooms.show.empty")
        if self.hub is not None:
            members = self.hub.members(binding)
            online = len(members)
            names = sorted(n for n in (_member_label(member) for member in members) if n)
            if names:
                members_text = ", ".join(names)
        return ctx.i18n.t("rooms.show.result", session=binding, online=online, members=members_text)

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

    async def cmd_lore(self, ctx: CommandCtx) -> str:
        """`.lore [add <title> | <content> | list [scope] | query <text> | import <file>]` — manage
        world lore (M11). `list` is open; authoring/secret-revealing ops (add/query/import) are
        keeper-gated via the shared privilege check."""
        from agent.kp_tools_worldbook import WorldbookTools

        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        agent_ctx = self._agent_ctx(ctx)
        tools = WorldbookTools(ctx.services)
        keeper = _privilege_level(ctx.raw_ctx) >= int(PrivilegeLevel.GROUP_ADMIN)

        if sub in _LORE_LIST_WORDS:
            # A player's `.lore list` must never reveal that a secret entry even exists; only a
            # keeper sees secret titles (mirrors `query_lore` being keeper-gated).
            return await tools.list_lore(agent_ctx, scope=rest, _keeper=keeper)
        if sub in _LORE_ADD_WORDS:
            if not keeper:
                return ctx.i18n.t("worldbook.commands.lore.denied")
            title, _, content = rest.partition("|")
            title, content = title.strip(), content.strip()
            if not title or not content:
                return ctx.i18n.t("worldbook.commands.lore.add_usage")
            return await tools.add_lore(agent_ctx, title=title, content=content)
        if sub in _LORE_QUERY_WORDS:
            if not keeper:
                return ctx.i18n.t("worldbook.commands.lore.denied")
            if not rest:
                return ctx.i18n.t("worldbook.commands.lore.query_usage")
            return await tools.query_lore(agent_ctx, query=rest)
        if sub in _LORE_IMPORT_WORDS:
            if not keeper:
                return ctx.i18n.t("worldbook.commands.lore.denied")
            if not rest:
                return ctx.i18n.t("worldbook.commands.lore.import_usage")
            return await tools.import_lorebook(agent_ctx, file_path=rest)
        return ctx.i18n.t("worldbook.commands.lore.usage")

    async def cmd_import(self, ctx: CommandCtx) -> str:
        """`.import <card file> [coc7|dnd5e] [pc|companion]` — import a SillyTavern card as the
        acting player's PC or an AI companion (M12)."""
        from agent.kp_tools_charcard import CharcardTools

        tokens = ctx.args.split()
        if not tokens:
            return ctx.i18n.t("charcard.commands.import.usage")
        file_path = tokens[0]
        system = "coc7"
        as_ = "pc"
        for token in tokens[1:]:
            low = token.casefold()
            if low in {"coc7", "coc", "dnd5e", "dnd"}:
                system = low
            elif low in {"pc", "companion"}:
                as_ = low
        tools = CharcardTools(ctx.services)
        return await tools.import_character(self._agent_ctx(ctx), file_path=file_path, system=system, as_=as_)

    async def cmd_module(self, ctx: CommandCtx) -> str:
        """`.module <module file>` — import a module document and run module analysis."""
        from agent.kp_tools_knowledge import DocumentTools

        tokens = ctx.args.split()
        if not tokens:
            return ctx.i18n.t("commands.module.usage")
        file_path = tokens[0]
        tools = DocumentTools(ctx.services)
        agent_ctx = self._agent_ctx(ctx)
        return await tools.upload_document(
            agent_ctx,
            file_path=file_path,
            doc_type="module",
            progress=self._module_progress(ctx, agent_ctx.chat_key),
        )

    def _module_progress(self, ctx: CommandCtx, chat_key: str) -> Any:
        """Build a progress reporter that STREAMS import-stage frames to the room while a
        (deliberately slow) full-module analysis runs, so the keeper watches a live progress
        bar advance through read → embed → analyze → build → done instead of staring at a
        frozen spinner. Returns None (a no-op import) when this router has no hub — e.g. the
        standalone CLI — so imports still work everywhere, just without the live bar."""
        hub = self.hub
        if hub is None:
            return None
        i18n = ctx.i18n
        steps = {"read": 1, "embed": 2, "analyze": 3, "build": 4, "done": 5}
        total = len(steps)

        async def report(stage: str, detail: str = "") -> None:
            step = steps.get(stage, 0)
            bar = "█" * step + "░" * (total - step)
            label = i18n.t(f"commands.module.progress.{stage}")
            text = i18n.t("commands.module.progress.line", bar=bar, label=label)
            await hub.publish(chat_key, Event.narrative(speaker="system", text=text, fmt="plain"))

        return report

    async def cmd_report(self, ctx: CommandCtx) -> str:
        """`.report [detailed|full]` — export the session report ("团报") for players to keep and review.
        Bare `.report` renders the summary; `.report detailed`/`.report full` renders the full
        chronological log. Player-facing (any member; no keeper privilege). Reuses the KP tool's shared
        render/save helper, so the report is also saved to the shared reports path and its path noted."""
        from agent.kp_tools_knowledge import render_session_report

        detailed = ctx.args.strip().casefold() in _REPORT_DETAILED_WORDS
        rendered = await render_session_report(ctx.services, self._agent_ctx(ctx), ctx.i18n, detailed=detailed)
        if rendered is None:
            return ctx.i18n.t("commands.report.no_session")
        markdown, saved_note = rendered
        return f"{markdown}\n\n{saved_note}" if saved_note else markdown

    async def cmd_model(self, ctx: CommandCtx) -> str:
        """`.model [list | set <provider> [chat_model] | key <api_key> | reset]` — inspect or
        switch the Keeper's LLM provider/model at runtime. Viewing is open; mutations are
        keeper-gated via the shared privilege check. The override persists (see
        `infra.runtime_config`) and hot-reconfigures the live `MutableLLM`, so every LLM
        consumer sees the switch without a restart."""
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        runtime_config = ctx.services.runtime_config
        if sub in _MODEL_LIST_WORDS:
            return self._model_list(ctx)
        if sub in _MODEL_SET_WORDS:
            return await self._model_set(ctx, runtime_config, rest)
        if sub in _MODEL_KEY_WORDS:
            return await self._model_key(ctx, runtime_config, rest)
        if sub in _MODEL_RESET_WORDS:
            return await self._model_reset(ctx, runtime_config)
        if sub in _MODEL_SHOW_WORDS:
            return await self._model_show(ctx, runtime_config)
        return ctx.i18n.t("commands.model.usage")

    async def _model_show(self, ctx: CommandCtx, runtime_config: Any) -> str:
        info = _describe_llm(ctx.services)
        overrides = await runtime_config.get()
        override = ctx.i18n.t("commands.model.override_on") if overrides else ctx.i18n.t("commands.model.override_off")
        return ctx.i18n.t(
            "commands.model.show",
            provider=info["provider"],
            chat_model=info["chat_model"],
            base_url=info["base_url"] or ctx.i18n.t("commands.model.base_default"),
            api_key=info["api_key"] or ctx.i18n.t("commands.model.key_none"),
            override=override,
        )

    def _model_list(self, ctx: CommandCtx) -> str:
        compatible = ", ".join([*sorted(PRESETS), *CHATGPT_SUBSCRIPTION_PROXY_PROVIDER_NAMES])
        native = ", ".join(NATIVE_PROVIDER_NAMES)
        return ctx.i18n.t("commands.model.list", compatible=compatible, native=native)

    async def _model_set(self, ctx: CommandCtx, runtime_config: Any, rest: str) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.i18n.t("commands.model.denied")
        tokens = rest.split()
        if not tokens:
            return ctx.i18n.t("commands.model.set_usage")
        provider = tokens[0].casefold()
        if not is_known_provider(provider):
            return ctx.i18n.t("commands.model.unknown_provider", provider=provider)
        overrides: dict[str, str] = {"provider": provider}
        if len(tokens) > 1:
            overrides["chat_model"] = tokens[1]
        # Validate by reconfiguring the LIVE LLM FIRST, then persist only on success. Building a
        # native provider whose optional SDK/key is missing raises; if we persisted before that, the
        # bad override would also brick the next `build_services()` boot. On failure we roll the live
        # LLM back to the last-good config and persist nothing.
        current = await runtime_config.get()
        candidate = {**current, **overrides}
        try:
            reconfigured = _reconfigure_llm(ctx.services, candidate)
        except Exception:
            _reconfigure_llm(ctx.services, current)  # restore the previously-good live config
            return ctx.i18n.t("commands.model.set_failed", provider=provider)
        await runtime_config.set(**overrides)
        info = _describe_llm(ctx.services)
        key = "commands.model.set_done" if reconfigured else "commands.model.set_saved"
        return ctx.i18n.t(key, provider=info["provider"], chat_model=info["chat_model"])

    async def _model_key(self, ctx: CommandCtx, runtime_config: Any, rest: str) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.i18n.t("commands.model.denied")
        if not _is_private_channel(ctx.raw_ctx):
            return ctx.i18n.t("commands.model.key_public")
        api_key = rest.strip()
        if not api_key:
            return ctx.i18n.t("commands.model.key_usage")
        merged = await runtime_config.set(api_key=api_key)
        _reconfigure_llm(ctx.services, merged)
        return ctx.i18n.t("commands.model.key_done", api_key=mask_secret(api_key))

    async def _model_reset(self, ctx: CommandCtx, runtime_config: Any) -> str:
        if not _is_keeper(ctx.raw_ctx):
            return ctx.i18n.t("commands.model.denied")
        await runtime_config.clear()
        _reconfigure_llm(ctx.services, {})
        info = _describe_llm(ctx.services)
        return ctx.i18n.t("commands.model.reset_done", provider=info["provider"], chat_model=info["chat_model"])

    def _build_specs(self) -> list[CommandSpec]:
        return [
            CommandSpec("roll", self.cmd_roll, ["roll", "r"], ["r", "rd"], {"name": "roll"}, "commands.help.roll"),
            CommandSpec("hidden_roll", self.cmd_hidden_roll, ["rh", "hroll"], ["rh"], None, "commands.help.hidden_roll"),
            CommandSpec(
                "check",
                self.cmd_check,
                ["check", "save", "attack", "cast", "ra", "rc"],
                ["ra", "rc"],
                {"name": "check"},
                "commands.help.check",
            ),
            CommandSpec("opposed", self.cmd_opposed, ["opposed", "rav", "rcv"], ["rav", "rcv"], None, "commands.help.opposed"),
            CommandSpec("sc", self.cmd_sanity, ["sc", "sanity"], ["sc"], {"name": "sc"}, "commands.help.sc"),
            CommandSpec("sheet", self.cmd_sheet, ["sheet", "st"], ["st"], {"name": "sheet"}, "commands.help.sheet"),
            CommandSpec("growth", self.cmd_growth, ["growth", "en"], ["en"], None, "commands.help.growth"),
            CommandSpec("init", self.cmd_initiative, ["init", "initiative", "ri"], ["ri", "init"], {"name": "init"}, "commands.help.init"),
            CommandSpec("coc", self.cmd_make_char, ["coc", "coc7"], ["coc", "coc7"], {"name": "coc"}, "commands.help.coc"),
            CommandSpec("dnd", self.cmd_make_char, ["dnd", "dnd5e"], ["dnd", "dnd5e"], {"name": "dnd"}, "commands.help.dnd"),
            CommandSpec(
                "genchar",
                self.cmd_genchar,
                ["genchar"],
                ["genchar", "生卡", "生成角色"],
                None,
                "charcard.commands.genchar.help",
            ),
            CommandSpec("setcoc", self.cmd_setcoc, ["setcoc"], ["setcoc"], {"name": "setcoc"}, "commands.help.setcoc"),
            CommandSpec("rename", self.cmd_rename, ["rename", "nn"], ["nn"], None, "commands.help.rename"),
            CommandSpec("jrrp", self.cmd_jrrp, ["jrrp", "luck"], ["jrrp"], None, "commands.help.jrrp"),
            CommandSpec("draw", self.cmd_draw, ["draw"], ["draw", "抽牌"], None, "commands.help.draw"),
            CommandSpec("bot", self.cmd_bot_toggle, ["bot"], ["bot"], None, "commands.help.bot"),
            CommandSpec("skill", self.cmd_skill, ["skill"], ["skill"], None, "commands.help.skill"),
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
            ),
            CommandSpec(
                "import",
                self.cmd_import,
                ["import"],
                ["import", "导入", "導入"],
                None,
                "charcard.commands.import.help",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
            ),
            CommandSpec(
                "module",
                self.cmd_module,
                ["module"],
                ["module", "模组", "導入模組"],
                None,
                "commands.module.help",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
            ),
            CommandSpec(
                "room",
                self.cmd_room,
                ["room"],
                ["room", "房间", "房間"],
                None,
                "commands.help.room",
                required_level=int(PrivilegeLevel.GROUP_ADMIN),
                # `.room open`/`.room link` replies carry a literal join key / session id
                # that GRANTS room access -- broadcasting it would let every current member
                # hand the room away. (`gateway.runner.GatewayRunner` already special-cases
                # `.room` before it ever reaches `run_turn` on the chat-adapter path; this
                # flag is what protects the direct `net.tui_server` path, which dispatches
                # `.room` through `run_turn` like any other command.)
                private_reply=True,
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
            ),
            CommandSpec("help", self.cmd_help, ["help", "h"], ["help", "帮助"], {"name": "help"}, "commands.help.help"),
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

    async def _cmd_check_coc(self, ctx: CommandCtx, character: CharacterSheet) -> str:
        pack = load_rulepack("coc7")
        args = ctx.args or "侦查"
        times, rest = _split_multi(args)
        parsed = _parse_coc_check_args(rest, pack)
        target_value = _coc_check_value(character, pack, parsed.name, parsed.temp_value)
        effective_target = _effective_coc_target(target_value, parsed.difficulty)
        rule = await _get_coc_rule(ctx)
        lines = []
        for _ in range(min(times, 20)):
            outcome = ctx.services.dice.roll_coc_check(
                target_value,
                rule=rule,
                difficulty=parsed.difficulty,
                bonus=parsed.bonus,
                penalty=parsed.penalty,
            )
            lines.append(
                ctx.i18n.t(
                    "commands.check.coc",
                    name=parsed.canonical,
                    target=target_value,
                    effective=effective_target,
                    roll=outcome["roll"],
                    rank=coc_rank_label(outcome["rank"], ctx.i18n),
                )
            )
        return "\n".join(lines)

    async def _cmd_check_dnd(self, ctx: CommandCtx, character: CharacterSheet) -> str:
        pack = load_rulepack("dnd5e")
        parsed = _parse_dnd_check_args(ctx.args or "perception", pack)
        canonical = parsed["canonical"]
        modifier = _dnd_modifier(ctx.services, character, canonical, parsed["proficient"])
        expr = _d20_expr(modifier)
        if parsed["mode"] == "adv":
            result = ctx.services.dice.roll_advantage(expr, is_check=True)
        elif parsed["mode"] == "dis":
            result = ctx.services.dice.roll_disadvantage(expr, is_check=True)
        else:
            result = ctx.services.dice.roll_expression(expr, is_check=True)
        return ctx.i18n.t(
            "commands.check.dnd",
            name=canonical,
            modifier=_signed(modifier),
            result=_format_roll(result, ctx.i18n),
        )

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


@dataclass
class _CocParsedCheck:
    name: str
    canonical: str
    difficulty: int = 1
    bonus: int = 0
    penalty: int = 0
    temp_value: int | None = None
    remaining: str = ""


def _parse_genchar_args(args: str) -> GenCharRequest | None:
    raw = args.strip()
    if not raw:
        return None

    head, sep, body = raw.partition("|")
    if sep:
        tokens = head.split()
        system = "coc7"
        name = head.strip()
        if tokens and tokens[0].casefold() in _GENCHAR_SYSTEMS:
            system = _GENCHAR_SYSTEMS[tokens[0].casefold()]
            name = " ".join(tokens[1:]).strip()
        description = body.strip()
    else:
        tokens = raw.split(maxsplit=1)
        system = "coc7"
        description = raw
        name = ""
        if tokens and tokens[0].casefold() in _GENCHAR_SYSTEMS:
            system = _GENCHAR_SYSTEMS[tokens[0].casefold()]
            description = tokens[1].strip() if len(tokens) > 1 else ""

    if not description:
        return None
    return GenCharRequest(system=system, name=name, description=description)


def _ctx_locale(ctx: AgentCtx | Any) -> str:
    return str(getattr(ctx, "locale", "en") or "en")


def _is_zh(locale: str) -> bool:
    return locale.casefold().startswith("zh")


def _format_roll(result: DiceResult, i18n: I18n) -> str:
    return result.format_result(i18n=i18n)


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
    if first in _ADV_WORDS:
        return "adv", " ".join(tokens[1:]) or "1d20"
    if first in _DIS_WORDS:
        return "dis", " ".join(tokens[1:]) or "1d20"
    if last in _ADV_WORDS:
        return "adv", " ".join(tokens[:-1]) or "1d20"
    if last in _DIS_WORDS:
        return "dis", " ".join(tokens[:-1]) or "1d20"
    return "", expression


def _split_multi(args: str) -> tuple[int, str]:
    match = _MULTI_PREFIX_RE.match(args)
    if not match:
        return 1, args.strip() or "1d20"
    return max(1, int(match.group(1))), match.group(2).strip() or "1d20"


def _parse_coc_check_args(text: str, pack: RulePack, default_name: str = "侦查") -> _CocParsedCheck:
    rest = text.strip() or default_name
    bonus = 0
    penalty = 0
    rest, bonus, penalty = _consume_bonus_penalty(rest, bonus, penalty)
    difficulty, rest = _consume_difficulty(rest)
    rest, bonus, penalty = _consume_bonus_penalty(rest, bonus, penalty)

    name_text = rest.strip() or default_name
    remaining = ""
    if "/" in name_text and default_name == "理智":
        name_text, remaining = default_name, name_text

    temp_value = None
    if remaining == "":
        match = _TRAILING_NUMBER_RE.match(name_text)
        if match and not match.group(1).strip().isdigit():
            name_text = match.group(1).strip()
            temp_value = int(match.group(2))

    canonical = pack.resolve_skill(name_text) or name_text
    return _CocParsedCheck(
        name=canonical,
        canonical=canonical,
        difficulty=difficulty,
        bonus=bonus,
        penalty=penalty,
        temp_value=temp_value,
        remaining=remaining,
    )


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


def _consume_difficulty(text: str) -> tuple[int, str]:
    rest = text.strip()
    for prefix, difficulty in _DIFFICULTY_PREFIXES:
        if rest.startswith(prefix):
            return difficulty, rest[len(prefix) :].strip()
    parts = rest.split(maxsplit=1)
    if parts:
        word = parts[0].casefold()
        if word in _DIFFICULTY_WORDS:
            return _DIFFICULTY_WORDS[word], parts[1].strip() if len(parts) > 1 else ""
    return 1, rest


def _coc_check_value(character: CharacterSheet, pack: RulePack, canonical: str, temp_value: int | None) -> int:
    if temp_value is not None:
        return temp_value
    return _get_sheet_value(character, pack, canonical)


def _effective_coc_target(value: int, difficulty: int) -> int:
    if difficulty == 2:
        return value // 2
    if difficulty == 3:
        return value // 5
    if difficulty == 4:
        return 1
    return value


def _parse_dnd_check_args(text: str, pack: RulePack) -> dict[str, Any]:
    tokens = text.split()
    mode = ""
    proficient = False
    kept = []
    for token in tokens:
        word = token.casefold()
        if word in _ADV_WORDS:
            mode = "adv"
        elif word in _DIS_WORDS:
            mode = "dis"
        elif word in _PROF_WORDS:
            proficient = True
        else:
            kept.append(token)
    name = " ".join(kept) or "perception"
    canonical = pack.resolve_skill(name) or name
    return {"canonical": canonical, "mode": mode, "proficient": proficient}


def _dnd_modifier(services: Services, character: CharacterSheet, canonical: str, proficient: bool) -> int:
    if canonical in _DND_ATTR_TO_KEY:
        return services.characters.get_dnd_ability_modifier(character, _DND_ATTR_TO_KEY[canonical])
    manager_name = _DND_SKILL_TO_MANAGER.get(canonical, canonical)
    return services.characters.get_dnd_skill_modifier(character, manager_name, proficient=proficient)


def _d20_expr(modifier: int) -> str:
    if modifier == 0:
        return "1d20"
    return f"1d20{_signed(modifier)}"


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


async def _get_coc_rule(ctx: CommandCtx) -> int:
    raw = await ctx.services.store.get(user_key="", store_key=f"coc_rule.{ctx.chat_key}")
    if raw is None:
        return DEFAULT_COC_RULE
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_COC_RULE


def _pack_for_character(character: CharacterSheet) -> RulePack:
    return load_rulepack("dnd5e" if character.system == "DnD5e" else "coc7")


def _canonical_values(character: CharacterSheet, pack: RulePack) -> dict[str, Any]:
    values = dict(pack.defaults)
    if character.system == "DnD5e":
        for key, value in character.attributes.items():
            values[_DND_KEY_TO_ATTR.get(key, key)] = value
        for key, value in character.secondary_attributes.items():
            canonical = pack.resolve_skill(key) or key
            values[canonical] = value
        for key, value in character.skills.items():
            canonical = pack.resolve_skill(key) or key
            values[canonical] = value
    else:
        for key, value in character.attributes.items():
            values[_COC_KEY_TO_ATTR.get(key, key)] = value
        for key, value in character.skills.items():
            canonical = pack.resolve_skill(key) or key
            values[canonical] = value
    return values


def _get_sheet_value(character: CharacterSheet, pack: RulePack, canonical: str) -> int:
    if character.system == "DnD5e":
        if canonical in _DND_ATTR_TO_KEY:
            return int(character.attributes.get(_DND_ATTR_TO_KEY[canonical], pack.defaults.get(canonical, 10)))
        secondary_key = _DND_SECONDARY_TO_KEY.get(canonical)
        if secondary_key:
            return int(character.secondary_attributes.get(secondary_key, pack.defaults.get(canonical, 0)))
        if canonical in character.skills:
            return int(character.skills[canonical])
        if canonical in _DND_SKILLS:
            return _dnd_modifier_for_values(_canonical_values(character, pack), canonical)
    else:
        attr_key = _COC_ATTR_TO_KEY.get(canonical)
        if attr_key and attr_key in character.attributes:
            return int(character.attributes[attr_key])
        skill_key = _COC_SKILL_TO_MANAGER.get(canonical, canonical)
        if skill_key in character.skills:
            return int(character.skills[skill_key])

    values = _canonical_values(character, pack)
    derived = pack.compute_derived(values)
    if canonical in derived:
        return int(derived[canonical]) if isinstance(derived[canonical], int) else 0
    return int(pack.defaults.get(canonical, 0))


def _dnd_modifier_for_values(values: dict[str, Any], canonical: str) -> int:
    ability = {
        "运动": "力量",
        "体操": "敏捷",
        "巧手": "敏捷",
        "隐匿": "敏捷",
        "调查": "智力",
        "奥秘": "智力",
        "历史": "智力",
        "自然": "智力",
        "宗教": "智力",
        "察觉": "感知",
        "洞悉": "感知",
        "驯兽": "感知",
        "医药": "感知",
        "求生": "感知",
        "游说": "魅力",
        "欺瞒": "魅力",
        "威吓": "魅力",
        "表演": "魅力",
    }.get(canonical, "力量")
    return (int(values.get(ability, 10)) - 10) // 2


def _set_sheet_value(character: CharacterSheet, pack: RulePack, canonical: str, value: int) -> None:
    if character.system == "DnD5e":
        attr_key = _DND_ATTR_TO_KEY.get(canonical)
        if attr_key:
            character.attributes[attr_key] = value
            return
        secondary_key = _DND_SECONDARY_TO_KEY.get(canonical)
        if secondary_key:
            character.secondary_attributes[secondary_key] = value
            return
        character.skills[canonical] = value
        return

    attr_key = _COC_ATTR_TO_KEY.get(canonical)
    if attr_key:
        character.attributes[attr_key] = value
        if attr_key in {"DEX", "EDU"}:
            character._calc_coc_derived_skills()
        return
    character.skills[_COC_SKILL_TO_MANAGER.get(canonical, canonical)] = value


def _parse_sheet_assignments(text: str) -> list[tuple[str, str]]:
    assignments = []
    for match in _SHEET_ASSIGN_RE.finditer(text.strip()):
        name = match.group(1).strip(" ,，")
        value = match.group(2).strip()
        if name and value:
            assignments.append((name, value))
    return assignments


def _apply_value_expr(services: Services, current: int, raw_value: str) -> int:
    text = raw_value.strip()
    sign = text[0] if text[:1] in {"+", "-"} else ""
    expression = text[1:] if sign else text
    if "d" in expression.casefold():
        rolled = services.dice.roll_expression(expression).total
    else:
        rolled = int(expression)
    if sign == "+":
        return current + rolled
    if sign == "-":
        return current - rolled
    return rolled


def _render_sheet(ctx: CommandCtx, character: CharacterSheet, pack: RulePack) -> str:
    values = _canonical_values(character, pack)
    values.update(pack.compute_derived(values))
    top = pack.st_show.get("top") or list(values.keys())[:12]
    items = []
    for name in top:
        value = values.get(name)
        if value is None:
            value = _get_sheet_value(character, pack, str(name))
        items.append(ctx.i18n.t("commands.sheet.item", name=name, value=value))
    return ctx.i18n.t("commands.sheet.show", name=character.name, items=", ".join(items))


def _shell_words(text: str) -> list[str]:
    try:
        return shlex.split(text)
    except ValueError:
        return text.split()


async def _resolve_avatar_target(ctx: CommandCtx, target: str) -> Any | None:
    try:
        from agent.npc import NpcManager

        return await NpcManager(ctx.services.store).get_npc(ctx.chat_key, target)
    except Exception:
        return None


def _split_audio_metadata(tokens: list[str]) -> tuple[str, dict[str, Any]]:
    query_tokens: list[str] = []
    metadata: dict[str, Any] = {}
    seen_metadata = False
    for token in tokens:
        key, sep, value = token.partition("=")
        normalized = key.casefold().replace("-", "_")
        if sep and normalized in {"title", "license", "source", "tags"}:
            seen_metadata = True
            if normalized == "tags":
                metadata[normalized] = [item.strip() for item in value.split(",")]
            else:
                metadata[normalized] = value.strip()
        elif seen_metadata:
            continue
        else:
            query_tokens.append(token)
    return " ".join(query_tokens).strip(), metadata


def _split_audio_play(tokens: list[str], *, default_loop: bool) -> tuple[str, dict[str, Any]]:
    query_tokens: list[str] = []
    options: dict[str, Any] = {"loop": default_loop}
    index = 0
    while index < len(tokens):
        token = tokens[index]
        lowered = token.casefold()
        if lowered in {"--loop", "loop"}:
            options["loop"] = True
            index += 1
            continue
        if lowered in {"--no-loop", "noloop", "once"}:
            options["loop"] = False
            index += 1
            continue
        if lowered in {"--volume", "volume", "vol"}:
            if index + 1 < len(tokens):
                volume = _parse_audio_volume([tokens[index + 1]])
                if volume is not None:
                    options["volume"] = volume
            index += 2
            continue
        if lowered.startswith("--volume=") or lowered.startswith("volume=") or lowered.startswith("vol="):
            volume = _parse_audio_volume([token.split("=", 1)[1]])
            if volume is not None:
                options["volume"] = volume
            index += 1
            continue
        if lowered in {"--fade", "fade", "fade_ms"}:
            if index + 1 < len(tokens):
                options["fade_ms"] = _parse_int(tokens[index + 1], default=0)
            index += 2
            continue
        if lowered.startswith("--fade=") or lowered.startswith("fade=") or lowered.startswith("fade_ms="):
            options["fade_ms"] = _parse_int(token.split("=", 1)[1], default=0)
            index += 1
            continue
        query_tokens.append(token)
        index += 1
    return " ".join(query_tokens).strip(), options


def _parse_audio_volume(tokens: list[str]) -> float | None:
    if not tokens:
        return None
    token = str(tokens[0]).strip().rstrip("%")
    try:
        value = float(token)
    except ValueError:
        return None
    if value > 1:
        value = value / 100.0
    return max(0.0, min(1.0, value))


def _parse_int(value: Any, *, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _audio_item_label(item: dict[str, Any]) -> str:
    title = str(item.get("title") or "").strip()
    name = str(item.get("name") or item.get("hash") or "").strip()
    return title or name or str(item.get("hash", ""))[:12]


def _audio_item_line(item: dict[str, Any]) -> str:
    label = _audio_item_label(item)
    short_hash = str(item.get("hash") or "")[:12]
    details = [short_hash]
    if item.get("license"):
        details.append(str(item["license"]))
    if item.get("tags"):
        details.append(",".join(str(tag) for tag in item["tags"]))
    return f"{label} ({' · '.join(details)})"


def _audio_matches(matches: tuple[dict[str, Any], ...]) -> str:
    return ", ".join(_audio_item_label(item) for item in matches[:5])


def _channel_chat_key(ctx: Any) -> str:
    """The ORIGIN channel's chat_key (for room bindings), even when `ctx.chat_key`
    has already been resolved to a shared session by the runner."""
    extra = getattr(ctx, "extra", None)
    source = extra.get("source") if isinstance(extra, dict) else None
    if source is not None and hasattr(source, "chat_key"):
        return str(source.chat_key())
    chat_key = getattr(ctx, "chat_key", "")
    return chat_key() if callable(chat_key) else str(chat_key)


def _privilege_level(ctx: Any) -> int:
    """The caller's privilege for command gating (see `_ROOM_*` constants).

    `cli` is a single local operator (no keystore/role concept) and is always the
    master. `tui` is a multi-user network service, so its level is decided by the
    AUTHENTICATED keystore role the server stamped into `ctx.extra["role"]`
    (`net.tui_server._ctx_for`): `keeper` -> master, anything else -> everyone. Every
    other platform falls through to the generic chat-admin heuristics below."""
    platform = str(getattr(ctx, "platform", "") or "").casefold()
    if platform in _AUTO_MASTER_PLATFORMS:
        return int(PrivilegeLevel.MASTER)
    extra = getattr(ctx, "extra", None)
    if platform == "tui":
        role = extra.get("role") if isinstance(extra, dict) else None
        return int(PrivilegeLevel.MASTER) if role == _TUI_KEEPER_ROLE else int(PrivilegeLevel.EVERYONE)
    raw = extra.get("raw") if isinstance(extra, dict) else None
    source = extra.get("source") if isinstance(extra, dict) else None
    chat_type = str(getattr(source, "chat_type", "") or "").casefold()
    if chat_type in _ROOM_ADMIN_CHAT_TYPES:
        return int(PrivilegeLevel.GROUP_ADMIN)
    if _raw_indicates_admin(raw):
        return int(PrivilegeLevel.GROUP_ADMIN)
    return int(PrivilegeLevel.EVERYONE)


def _is_keeper(ctx: Any) -> bool:
    """True if the caller may perform keeper/admin mutations (CLI/DM/group-admin)."""
    return _privilege_level(ctx) >= int(PrivilegeLevel.GROUP_ADMIN)


def _is_private_channel(ctx: Any) -> bool:
    """True for the local CLI/TUI operator or a private/DM channel — where echoing
    a secret (e.g. an API key) back is acceptable."""
    platform = str(getattr(ctx, "platform", "") or "").casefold()
    if platform in _ROOM_LOCAL_PLATFORMS:
        return True
    extra = getattr(ctx, "extra", None)
    source = extra.get("source") if isinstance(extra, dict) else None
    chat_type = str(getattr(source, "chat_type", "") or "").casefold()
    return chat_type in _ROOM_ADMIN_CHAT_TYPES


def _describe_llm(services: Services) -> dict[str, str]:
    """The live LLM's display snapshot — from the `MutableLLM` if present, else
    from the (possibly injected) settings so `.model` still shows something."""
    describe = getattr(services.llm, "describe", None)
    if callable(describe):
        return describe()
    return describe_settings(services.settings.llm)


def _reconfigure_llm(services: Services, overrides: dict) -> bool:
    """Hot-reconfigure the `MutableLLM` if present. Returns False when the LLM is
    not swappable (e.g. an injected FakeLLM / offline demo); the override is still
    persisted and takes effect on the next restart."""
    apply = getattr(services.llm, "apply", None)
    if callable(apply):
        apply(overrides)
        return True
    return False


def _raw_indicates_admin(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    for key in ("role", "sender_role", "member_role", "author_role", "user_role"):
        if str(raw.get(key, "")).casefold() in _ROOM_ADMIN_RAW_ROLES:
            return True
    return any(raw.get(flag) is True for flag in _ROOM_ADMIN_RAW_FLAGS)


def _member_label(member: Any) -> str:
    return str(getattr(member, "name", "") or getattr(member, "id", "") or "")
