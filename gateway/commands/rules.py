"""Rule-system and table-policy knobs: `.rule`, the pack-select words, `.skill`, `.phase`,
`.preset`, `.habits`, `.language`."""

from __future__ import annotations

from agent.kp_tools_subsystems import dispatch_subsystem
from agent.services import set_room_rule_variant
from agent.tool_phase import PHASES, is_pinned, room_phase, set_room_phase
from core.skills import available_skills, load_skill
from core.table_habits import HABITS_DOC_TYPE, HABITS_ID, normalize
from gateway.commands.checks import _get_rule_variant, _variant_display
from gateway.commands.rooms import _is_keeper
from gateway.commands.types import CommandCtx
from gateway.commands.world import _LORE_IMPORT_WORDS
from gateway.ops import (
    get_enabled_preset,
    get_enabled_skills,
    set_enabled_preset,
    toggle_enabled_skill,
)
from infra.i18n import get_i18n

# `.skill` subcommand vocabularies (EN + a couple of CN synonyms) -- the per-room
# KP-skills layer (Layer B.1, `core.skills` + `gateway.ops.get/set_enabled_skills`).
_PHASE_AUTO_WORDS = {"auto", "自动", "自動"}
_HABIT_FORGET_WORDS = {"forget", "drop", "忘掉", "删除", "刪除"}
_SKILL_STATUS_WORDS = {"status", "状态", "狀態"}
_SKILL_ENABLE_WORDS = {"enable", "on", "启用", "啟用"}
_SKILL_DISABLE_WORDS = {"disable", "off", "禁用", "关闭", "關閉"}


class RulesCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_language(self, ctx: CommandCtx) -> str:
        """`.language <en|zh>` — set the room-wide display locale. ``chat_locale`` is
        room-scoped (``user_key=""``), so this changes the language for EVERY member;
        the write is keeper-gated in-handler like ``.rule``/``.bot`` so a networked
        player cannot flip the whole table's language."""
        locale = ctx.args.strip().casefold()
        if locale not in {"en", "zh"}:
            return ctx.i18n.t("commands.language.usage")
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("rooms.denied"))
        await ctx.services.store.state_set(ctx.chat_key, "chat_locale", locale)
        ctx.raw_ctx.locale = locale
        return get_i18n(locale).t("commands.language.done")

    async def cmd_rule(self, ctx: CommandCtx) -> str:
        """`.rule [<variant>|0|off]` — select the room rule system's house-rule
        ladder (a rulepack `variants:` id; a bare digit maps onto the community
        ``rule<N>`` naming, 0/off = the pack's default ladder). The bare query
        is open to anyone and lists the pack's variants — including a warning
        when the STORED variant no longer exists (e.g. a pack update dropped
        it; checks then grade under the default ladder). Changing the ladder
        regrades EVERY member's checks (a house rule), so the write is
        keeper-gated in-handler — matching ``.bot``."""

        pack = await ctx.services.room_rulepack(ctx.raw_ctx)
        resolver = pack.resolver
        known = set(resolver.variant_ids()) if resolver is not None else set()
        raw = ctx.args.strip().casefold()
        if not raw or raw in {"list", "列表"}:
            current = await _get_rule_variant(ctx)
            lines = [ctx.i18n.t("commands.rule.current", rule=_variant_display(current))]
            if current and current not in known:
                lines.append(ctx.i18n.t("commands.rule.stored_invalid"))
            if known:
                lines.append(ctx.i18n.t("commands.rule.available", rules=", ".join(sorted(known))))
            return "\n".join(lines)

        if raw in {"0", "off", "default"}:
            variant = None
        elif raw.isdigit() and f"rule{raw}" in known:
            variant = f"rule{raw}"
        elif raw in known:
            variant = raw
        else:
            return ctx.fail(ctx.i18n.t("commands.rule.invalid", rules=", ".join(sorted(known)) or "-"))
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("rooms.denied"))
        await set_room_rule_variant(ctx.services.store, ctx.chat_key, variant)
        return ctx.i18n.t("commands.rule.changed", rule=_variant_display(variant))

    async def cmd_pack_word(self, ctx: CommandCtx) -> str:
        """A pack-declared dot-command dialect word (`.sc`, `.en`, `.ti`, …):
        resolved through the ROOM's rule system — a word the room's pack does
        not declare is refused, so a system without the mechanic simply does
        not have the command (stage D materialization at the command layer).
        Exception: a make-char word is the ENTRY POINT into the pack that
        declares it, so it resolves across all installed packs."""
        from core.rulepacks import pack_declaring_command

        maker = pack_declaring_command(ctx.spec.canonical, "make_char")
        if maker is not None:
            return await self.cmd_make_char(ctx, maker)

        pack = await ctx.services.room_rulepack(ctx.raw_ctx)
        binding = pack.commands.get(ctx.spec.canonical)
        if binding is None:
            return ctx.i18n.t("commands.pack_word.not_in_system", word=ctx.spec.canonical)
        if binding.action == "check":
            return await self.cmd_check(ctx)
        spec = pack.subsystems.get(binding.tool)
        if spec is None:
            return ctx.i18n.t("commands.pack_word.not_in_system", word=ctx.spec.canonical)
        if spec.template == "check_with_loss":
            return await self.cmd_sanity(ctx)
        if spec.template == "improvement_check":
            return await self.cmd_growth(ctx)
        arguments = dict(binding.args)
        if ctx.args.strip():
            arguments.setdefault("table", ctx.args.strip())
        result = await dispatch_subsystem(ctx.services, ctx.raw_ctx, pack, binding.tool, arguments)
        return result if result is not None else ctx.i18n.t("commands.pack_word.not_in_system", word=ctx.spec.canonical)

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
            return ctx.fail(ctx.i18n.t("commands.skill.denied"))
        skill_id = skill_id.strip()
        # RESOLVE, don't scan: `load_skill` forces a discovery re-check when the id misses,
        # so a skill another process just installed enables immediately. The listing's own
        # check is throttled (a stale listing is cosmetic), and enabling straight after an
        # install is exactly the moment that throttle would answer "unknown skill".
        if not skill_id or load_skill(skill_id) is None:
            return ctx.i18n.t("commands.skill.unknown", id=skill_id)

        await toggle_enabled_skill(ctx.services.store, ctx.chat_key, skill_id, on=enable)
        if enable:
            return ctx.i18n.t("commands.skill.enable_done", id=skill_id)
        return ctx.i18n.t("commands.skill.disable_done", id=skill_id)

    async def cmd_phase(self, ctx: CommandCtx) -> str:
        """`.phase [prep | play | auto]` — which half of the Keeper's toolset this room carries.

        `play` drops the bulk/low-frequency tools (module-grade NPC authoring, imports,
        exports, variable definition) so the model's attention stays on the per-turn set;
        `prep` carries everything. Improvisation never needs the switch — `sketch_npc` and
        the rest of the improvisational set live in both. Bare `.phase` reports; `auto`
        clears the pin and lets the room's own lifecycle decide again. Reporting is open;
        pinning reshapes what the Keeper can do, so it is keeper-only.
        """
        wanted = ctx.args.strip().casefold()
        if not wanted:
            phase = await room_phase(ctx.services.store, ctx.chat_key)
            pinned = await is_pinned(ctx.services.store, ctx.chat_key)
            return ctx.i18n.t(
                "commands.phase.status",
                phase=ctx.i18n.t(f"commands.phase.name.{phase}"),
                source=ctx.i18n.t("commands.phase.pinned" if pinned else "commands.phase.automatic"),
            )
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.phase.denied"))
        if wanted in _PHASE_AUTO_WORDS:
            await set_room_phase(ctx.services.store, ctx.chat_key, None)
            phase = await room_phase(ctx.services.store, ctx.chat_key)
            return ctx.i18n.t("commands.phase.auto_done", phase=ctx.i18n.t(f"commands.phase.name.{phase}"))
        if wanted not in PHASES:
            return ctx.i18n.t("commands.phase.usage")
        await set_room_phase(ctx.services.store, ctx.chat_key, wanted)
        return ctx.i18n.t("commands.phase.set_done", phase=ctx.i18n.t(f"commands.phase.name.{wanted}"))

    async def cmd_habits(self, ctx: CommandCtx) -> str:
        """`.habits [forget <text>]` — what the Scribe has learned about how this table plays.

        Keeper-only, like the document itself: every line describes the players, so handing
        it back to them would be both a metagaming leak and simply rude. Only the one-line
        summaries stay resident in the Keeper's prompt; this is where the detail behind
        each one lives, and where a wrong one gets deleted.
        """
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.habits.denied"))
        document = await ctx.services.documents.get(ctx.chat_key, HABITS_DOC_TYPE, HABITS_ID)
        data = normalize(document.data if document else {})
        parts = ctx.args.split(maxsplit=1)
        if parts and parts[0].casefold() in _HABIT_FORGET_WORDS:
            needle = (parts[1] if len(parts) > 1 else "").strip().casefold()
            if not needle:
                return ctx.i18n.t("commands.habits.usage")
            kept = [entry for entry in data["habits"] if needle not in entry["summary"].casefold()]
            dropped = [entry for entry in data["pending"] if needle not in entry["summary"].casefold()]
            if len(kept) == len(data["habits"]) and len(dropped) == len(data["pending"]):
                return ctx.i18n.t("commands.habits.forget_missing")
            await ctx.services.documents.put(
                ctx.chat_key, HABITS_DOC_TYPE, HABITS_ID, {"habits": kept, "pending": dropped}
            )
            return ctx.i18n.t("commands.habits.forget_done")
        if not data["habits"] and not data["pending"]:
            return ctx.i18n.t("commands.habits.empty")
        lines = [
            f"- {entry['summary']}" + (f"\n  {entry['detail']}" if entry["detail"] else "")
            for entry in data["habits"]
        ]
        reply = ctx.i18n.t("commands.habits.show", items="\n".join(lines) or ctx.i18n.t("common.none"))
        if data["pending"]:
            watching = "\n".join(f"- {entry['summary']} ({entry['seen']}x)" for entry in data["pending"])
            reply += ctx.i18n.t("commands.habits.pending", items=watching)
        return reply

    async def cmd_preset(self, ctx: CommandCtx) -> str:
        """`.preset [list | import <path> | enable <id> | disable | show <id>]` — imported
        SillyTavern completion presets as a per-room STYLE layer.

        Listing/showing is open; `import` (reads a server-side file, same trust as a raw
        `.import` path) and `enable`/`disable` (reshape the room's prompt) are keeper-only.
        One preset per room: the prompt builder folds the enabled preset's effective
        system prompts as a single bounded section (`core.preset.style_segments`); its
        sampling params are REPORTED (`show`), not applied — engine sampling stays on the
        operator's `.model` surface.
        """
        from pathlib import Path

        from core.preset import effective_prompts, macro_report
        from core.preset_store import (
            list_preset_ids,
            load_preset,
            sanitize_preset_id,
            save_preset_text,
        )

        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        store = ctx.services.store
        data_dir = ctx.services.settings.data_dir

        if sub in _LORE_IMPORT_WORDS:
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("preset.commands.denied"))
            if not rest:
                return ctx.i18n.t("preset.commands.usage")
            # Pack-relative convenience, same as `.import`: `.preset import <packId>/presets/x.json`
            # resolves against the newest installed pack (confined; falls through to the literal
            # server path when it isn't pack-shaped or nothing is installed).
            from core.pack import resolve_installed_path

            resolved = resolve_installed_path(data_dir, rest)
            path = resolved if resolved is not None else Path(rest).expanduser()
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError, ValueError):
                return ctx.i18n.t("preset.commands.no_file", path=rest)
            preset_id = sanitize_preset_id(path.name)
            if not preset_id:
                return ctx.i18n.t("preset.commands.usage")
            try:
                from core.preset import parse_st_preset

                preset = parse_st_preset(text, preset_id)
                save_preset_text(data_dir, preset_id, text)
            except (ValueError, OSError) as exc:
                return ctx.i18n.t("preset.commands.import_failed", error=str(exc))
            return ctx.i18n.t(
                "preset.commands.imported",
                id=preset_id,
                prompts=len(preset.prompts),
                effective=len(effective_prompts(preset)),
                warnings=len(preset.warnings),
            )
        if sub in _SKILL_ENABLE_WORDS:
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("preset.commands.denied"))
            preset_id = rest.strip()
            if load_preset(data_dir, preset_id) is None:
                return ctx.i18n.t("preset.commands.unknown", id=preset_id)
            await set_enabled_preset(store, ctx.chat_key, preset_id)
            return ctx.i18n.t("preset.commands.enabled", id=preset_id)
        if sub in _SKILL_DISABLE_WORDS:
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("preset.commands.denied"))
            await set_enabled_preset(store, ctx.chat_key, "")
            return ctx.i18n.t("preset.commands.disabled")
        if sub in {"show", "查看"}:
            preset = load_preset(data_dir, rest)
            if preset is None:
                return ctx.i18n.t("preset.commands.unknown", id=rest)
            sampling = ", ".join(f"{key}={value}" for key, value in sorted(preset.sampling.items())) or "-"
            macros = ", ".join(f"{name}×{count}" for name, count in list(macro_report(preset).items())[:8]) or "-"
            return ctx.i18n.t(
                "preset.commands.show",
                id=rest,
                name=preset.name,
                prompts=len(preset.prompts),
                effective=len(effective_prompts(preset)),
                sampling=sampling,
                macros=macros,
                warnings=len(preset.warnings),
            )
        # list (default)
        installed = list_preset_ids(data_dir)
        if not installed:
            return ctx.i18n.t("preset.commands.list_empty")
        enabled_id = await get_enabled_preset(store, ctx.chat_key)
        lines = [f"- {preset_id}" + (" ✓" if preset_id == enabled_id else "") for preset_id in installed]
        status = enabled_id or ctx.i18n.t("preset.commands.none")
        return ctx.i18n.t("preset.commands.list", items="\n".join(lines), enabled=status)
