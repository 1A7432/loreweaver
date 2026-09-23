"""World knowledge and memory: `.lore`, `.import`, `.var`, `.module`, `.report`, `.recap`,
`.chronicle`."""

from __future__ import annotations

from typing import Any

from gateway.commands.rooms import _is_keeper
from gateway.commands.sheet import _resolve_system_token
from gateway.commands.types import CommandCtx
from gateway.hub import Event
from gateway.turn import publish_state

# `.lore` subcommand vocabularies (EN + a couple of CN synonyms) -- world lore (M11).
_LORE_ADD_WORDS = {"add", "new", "添加", "新增"}
_LORE_LIST_WORDS = {"", "list", "ls", "列表", "查看"}
_LORE_QUERY_WORDS = {"query", "search", "find", "查询", "查詢", "搜索"}
_LORE_IMPORT_WORDS = {"import", "load", "导入", "導入"}
# M26 — the overlay switches. They write the room's keeper-only `lore_overlay` document,
# never the stored entry: faithful import survives every one of them.
_LORE_ENABLE_WORDS = {"enable", "on", "启用", "啟用", "开启", "開啟"}
_LORE_DISABLE_WORDS = {"disable", "off", "禁用", "关闭", "關閉"}
_LORE_BIND_WORDS = {"bind", "绑定", "綁定"}
_LORE_UNBIND_WORDS = {"unbind", "解绑", "解綁"}
_LORE_RESTORE_WORDS = {"restore", "还原", "還原", "复原", "復原"}
_LORE_SHOW_WORDS = {"show", "详情", "詳情"}
_LORE_OVERLAY_WORDS = {"overlay", "覆盖层", "覆蓋層"}
# `.lore list` filters that are not scopes: the keeper view's "show me what is off".
_LORE_DISABLED_FILTERS = {"disabled", "off", "已关", "已關", "关闭", "關閉"}

# `.chronicle` subcommand vocabularies (EN + a couple of CN synonyms) -- campaign chronicle (M18).
_CHRONICLE_LIST_WORDS = {"", "list", "ls", "列表", "记录", "記錄"}
_CHRONICLE_SUMMARY_WORDS = {"summary", "总述", "總述", "概述"}
_CHRONICLE_THREADS_WORDS = {"threads", "loops", "线索", "線索"}
_CHRONICLE_FOLD_WORDS = {"fold", "折叠", "折疊", "折页", "折頁"}
_CHRONICLE_EDIT_WORDS = {"edit", "set", "编辑", "編輯", "修订", "修訂"}
_CHRONICLE_NOTE_WORDS = {"note", "margin", "批注", "边注", "邊注"}

# `.report` detailed-log toggle words (EN + a couple of CN synonyms) -- session report export ("团报").
_REPORT_DETAILED_WORDS = {"detailed", "full", "log", "详细", "詳細", "完整", "全部"}


def _first_attachment_name(ctx: Any) -> str:
    extra = getattr(ctx, "extra", None)
    names = extra.get("attachment_names") if isinstance(extra, dict) else None
    return str(names[0]) if isinstance(names, list) and names else ""


# `.lore bind <title> | <expr>`'s separator: a pipe with a space on BOTH sides. A bare `|`
# cannot be it — `配置.难度 == "残酷" || 配置.难度 == "困难"` is an ordinary condition, and
# splitting on its first pipe would bind half an expression and refuse it as a parse error.
_BIND_SEPARATOR = " | "


def _split_bind_argument(rest: str) -> tuple[str, str]:
    """`.lore bind <title> <expr>` — and `<title> | <expr>` for a title with spaces.

    An entry title is game DATA an author chose; most carry no space, but some do, and a
    positional split alone would silently bind the wrong thing. This is the ONLY `.lore`
    subcommand that splits its argument: for every other one the whole rest IS the title,
    because `.lore enable the deep water` must not go looking for an entry called "the".
    """
    if _BIND_SEPARATOR in rest:
        title, _, expression = rest.partition(_BIND_SEPARATOR)
        return title.strip(), expression.strip()
    title, _, expression = rest.partition(" ")
    return title.strip(), expression.strip()


def _yes_no(i18n: Any, value: bool) -> str:
    return i18n.t("common.yes") if value else i18n.t("common.no")


async def _variable_resolver(ctx: CommandCtx):
    """A resolver over this room's variables, the same one the keeper turn builds."""
    return (await _variable_context(ctx))[0]


async def _variable_context(ctx: CommandCtx):
    """``(resolver, ejs_engine)`` over this room's variables — one state load, both halves.

    The pair the real keeper turn works from. The engine is `None` when the room has no
    full-EJS sandbox (the `ejs` extra missing, or the setting off), which is a verdict the
    caller must report rather than paper over."""
    from core.ejs_full import build_room_engine
    from core.modvars import load_modvars
    from core.mvu_compat import load_mvu
    from core.varspace import build_resolver

    documents = ctx.services.documents
    state = await load_modvars(documents, ctx.chat_key)
    tree = await load_mvu(documents, ctx.chat_key)
    engine = None
    try:
        engine = await build_room_engine(
            ctx.services.worldbook,
            ctx.chat_key,
            enabled=ctx.services.settings.enable_full_ejs,
            flat_variables=state["values"],
            tree=tree,
        )
    except Exception:  # noqa: BLE001 — no sandbox is a reportable state, never a failed command
        engine = None
    return build_resolver(state["values"], tree), engine


async def _room_ejs_engine(ctx: CommandCtx):
    return (await _variable_context(ctx))[1]


async def _missing_condition_paths(ctx: CommandCtx, condition: str) -> list[str]:
    """Reference paths in `condition` that resolve to nothing in this room right now.

    Advisory: a condition over a missing path is not an error, it is a condition that
    fails closed forever — which is worth saying out loud at the moment it is typed."""
    from core.condexpr import CondExprError, referenced_paths

    try:
        paths = referenced_paths(condition)
    except CondExprError:
        return []
    resolve = await _variable_resolver(ctx)
    return [path for path in paths if resolve(path) is None]


async def _budget_lines(ctx: CommandCtx, title: str) -> list[str]:
    """The M26 §5.4 receipt: does the entry that was just switched on actually inject?

    Without it, "I chose and nothing happened" survives the deletion of the sole-active
    mechanism in a new form — the slot cut runs before the character cap, so a switched-on
    entry can be dropped silently by an entry that ranked above it.

    The dry run is given the SAME full-EJS engine the real turn builds when the room has
    one. Without it an arbitrary-JS `@@if` — which real imported cards carry — cannot be
    evaluated, and the receipt would confidently report "nothing selects it" about an
    entry that injects every turn; the probe flags that case and the reply says so."""
    from core.worldbook import KEEPER_TURN_BUDGET_CHARS, KEEPER_TURN_LIMIT, probe_turn_budget

    i18n = ctx.i18n
    resolve, engine = await _variable_context(ctx)
    probe = await probe_turn_budget(
        ctx.services.worldbook, ctx.chat_key, title, resolve=resolve, engine=engine
    )
    if not probe.found:
        return []
    caveat = [i18n.t("worldbook.commands.lore.budget_js_unevaluated")] if probe.js_unevaluated else []
    if probe.oversize:
        return [
            i18n.t(
                "worldbook.commands.lore.budget_oversize",
                size=probe.size,
                budget=KEEPER_TURN_BUDGET_CHARS,
            )
        ]
    if probe.fits:
        return [i18n.t("worldbook.commands.lore.budget_fits", size=probe.size), *caveat]
    if probe.crowded_out:
        return [
            i18n.t(
                "worldbook.commands.lore.budget_crowded",
                size=probe.size,
                limit=KEEPER_TURN_LIMIT,
                budget=KEEPER_TURN_BUDGET_CHARS,
                titles=i18n.t("common.list_separator").join(probe.ranked_above[:5]),
            ),
            *caveat,
        ]
    return [i18n.t("worldbook.commands.lore.budget_inactive", size=probe.size), *caveat]


def _installed_card_refs(ctx: CommandCtx) -> str:
    """`.import list` — every installed pack's card files as pack-relative refs."""
    from pathlib import Path

    from gateway.panels import installed_card_entries

    entries = installed_card_entries(Path(ctx.services.settings.data_dir))
    if not entries:
        return ctx.i18n.t("charcard.commands.import.list_empty")
    # A world card takes a DIFFERENT verb (`world`, keeper-only). The listing is what a
    # keeper reads the ref off, so it says which ones those are rather than letting the
    # header's `pc` example stand for every line.
    refs = [
        entry["ref"] + (ctx.i18n.t("charcard.commands.import.list_world") if entry.get("kind") == "world" else "")
        for entry in entries
    ]
    return ctx.i18n.t("charcard.commands.import.list", refs="\n".join(refs))


class WorldCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_lore(self, ctx: CommandCtx) -> str:
        """`.lore [add | list | query | import | enable | disable | bind | unbind | restore |
        show | overlay]` — manage world lore (M11) and the M26 keeper overlay over it.

        `list` is open; authoring/secret-revealing ops (add/query/import) and every overlay
        switch are keeper-gated via the shared privilege check. The switches never touch the
        stored entry — they write the room's keeper-only `lore_overlay` document, so a
        re-import of a revised card stays a clean replace and the switches survive it."""
        from agent.kp_tools_worldbook import WorldbookTools

        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        agent_ctx = self._agent_ctx(ctx)
        tools = WorldbookTools(ctx.services)
        keeper = _is_keeper(ctx.raw_ctx)

        if sub in _LORE_LIST_WORDS:
            # A player's `.lore list` must never reveal that a secret entry even exists; only a
            # keeper sees secret titles (mirrors `query_lore` being keeper-gated) — and only a
            # keeper's listing carries overlay markers, since the overlay is keeper-only.
            scope = "disabled" if rest.casefold() in _LORE_DISABLED_FILTERS else rest
            return await tools.list_lore(agent_ctx, scope=scope, _keeper=keeper)
        if sub in (
            _LORE_ENABLE_WORDS
            | _LORE_DISABLE_WORDS
            | _LORE_BIND_WORDS
            | _LORE_UNBIND_WORDS
            | _LORE_RESTORE_WORDS
            | _LORE_SHOW_WORDS
            | _LORE_OVERLAY_WORDS
        ):
            if not keeper:
                return ctx.fail(ctx.i18n.t("worldbook.commands.lore.denied"))
            return await self._lore_overlay_command(ctx, sub, rest)
        if sub in _LORE_ADD_WORDS:
            if not keeper:
                return ctx.fail(ctx.i18n.t("worldbook.commands.lore.denied"))
            title, _, content = rest.partition("|")
            title, content = title.strip(), content.strip()
            if not title or not content:
                return ctx.i18n.t("worldbook.commands.lore.add_usage")
            return await tools.add_lore(agent_ctx, title=title, content=content)
        if sub in _LORE_QUERY_WORDS:
            if not keeper:
                return ctx.fail(ctx.i18n.t("worldbook.commands.lore.denied"))
            if not rest:
                return ctx.i18n.t("worldbook.commands.lore.query_usage")
            return await tools.query_lore(agent_ctx, query=rest)
        if sub in _LORE_IMPORT_WORDS:
            if not keeper:
                return ctx.fail(ctx.i18n.t("worldbook.commands.lore.denied"))
            if not rest:
                return ctx.i18n.t("worldbook.commands.lore.import_usage")
            # Pack-relative convenience, same as `.import`: `<packId>/lorebooks/x.json`
            # resolves against the newest installed pack before the literal path.
            from core.pack import resolve_installed_path

            resolved = resolve_installed_path(ctx.services.settings.data_dir, rest)
            if resolved is not None:
                rest = str(resolved)
            # This branch is keeper-gated above, so the import may honor `secret` flags.
            return await tools.import_lorebook(agent_ctx, file_path=rest, _keeper=True)
        return ctx.i18n.t("worldbook.commands.lore.usage")

    async def _lore_overlay_command(self, ctx: CommandCtx, sub: str, rest: str) -> str:
        """The M26 switch family, keeper-only (gated by the caller). One place, because all
        seven share the same load-overlay / resolve-title / save-overlay spine."""
        from core.lore_overlay import (
            OverlayError,
            clear_entry,
            load_overlay,
            save_overlay,
            set_entry,
            stale_titles,
        )

        documents = ctx.services.documents
        worldbook = ctx.services.worldbook
        chat_key = ctx.chat_key
        i18n = ctx.i18n

        if sub in _LORE_OVERLAY_WORDS:
            return await self._lore_apply_overlay_file(ctx, rest)
        if not rest:
            return i18n.t("worldbook.commands.lore.overlay_usage")

        # Only `bind` takes two arguments. For every other switch the WHOLE rest is the
        # title — an entry called "the deep water" is not an entry called "the".
        if sub in _LORE_BIND_WORDS:
            title, expression = _split_bind_argument(rest)
        else:
            title, expression = rest.strip(), ""
        overlay = await load_overlay(documents, chat_key)

        if sub in _LORE_RESTORE_WORDS:
            overlay, removed = clear_entry(overlay, title)
            if not removed:
                return i18n.t("worldbook.commands.lore.restore_noop", title=title)
            await save_overlay(documents, chat_key, overlay)
            return i18n.t("worldbook.commands.lore.restored", title=title, count=removed)

        # Everything else addresses a real entry, so a typo must not create a silent
        # annotation of nothing. A title several entries share applies to all of them —
        # that is stated, never resolved by guessing which one was meant.
        matches = [entry for entry in await worldbook.list(chat_key) if entry.title == title]
        if not matches:
            return i18n.t("worldbook.commands.lore.not_found", title=title)
        shared = (
            i18n.t("worldbook.commands.lore.shared_title", count=len(matches)) if len(matches) > 1 else ""
        )

        if sub in _LORE_SHOW_WORDS:
            return await self._lore_show(ctx, matches[0], overlay, shared)

        try:
            if sub in _LORE_ENABLE_WORDS:
                overlay = set_entry(overlay, title, enabled=True)
            elif sub in _LORE_DISABLE_WORDS:
                overlay = set_entry(overlay, title, enabled=False)
            elif sub in _LORE_UNBIND_WORDS:
                overlay = set_entry(overlay, title, condition="")
            else:  # bind
                if not expression:
                    return i18n.t("worldbook.commands.lore.bind_usage")
                # A binding implies the switch: a condition on an entry that stayed
                # file-disabled would be an inert trap nothing ever fires.
                overlay = set_entry(overlay, title, enabled=True, condition=expression)
        except OverlayError as exc:
            return ctx.fail(i18n.t("worldbook.commands.lore.bad_expression", error=str(exc)))
        await save_overlay(documents, chat_key, overlay)

        if sub in _LORE_DISABLE_WORDS:
            lines = [i18n.t("worldbook.commands.lore.switched_off", title=title)]
        elif sub in _LORE_UNBIND_WORDS:
            lines = [i18n.t("worldbook.commands.lore.unbound", title=title)]
        elif sub in _LORE_BIND_WORDS:
            lines = [i18n.t("worldbook.commands.lore.bound", title=title, expression=expression)]
        else:
            lines = [i18n.t("worldbook.commands.lore.switched_on", title=title)]
        if shared:
            lines.append(shared)
        if sub not in _LORE_DISABLE_WORDS:
            # The receipt (§5.4): a switch that changes nothing must not read like success.
            lines.extend(await _budget_lines(ctx, title))
        stale = stale_titles(overlay, {entry.title for entry in await worldbook.list(chat_key)})
        if stale:
            lines.append(
                i18n.t(
                    "worldbook.commands.lore.stale_line",
                    count=len(stale),
                    titles=i18n.t("common.list_separator").join(stale[:5]),
                )
            )
        return "\n".join(lines)

    async def _lore_show(self, ctx: CommandCtx, entry, overlay, shared: str) -> str:
        """`.lore show <title>` — the file's own state beside the effective one."""
        from core.lore_overlay import apply as apply_overlay

        i18n = ctx.i18n
        effective = apply_overlay(entry, overlay)
        override = overlay.entry(entry.title)
        lines = [i18n.t("worldbook.commands.lore.show_header", title=entry.title)]
        if shared:
            lines.append(shared)
        lines.append(
            i18n.t(
                "worldbook.commands.lore.show_file",
                enabled=_yes_no(i18n, entry.enabled),
                constant=_yes_no(i18n, entry.constant),
                keys=i18n.t("common.list_separator").join(entry.keys) or i18n.t("worldbook.commands.lore.no_keys"),
                size=len(entry.content),
                condition=entry.condition or i18n.t("worldbook.commands.lore.no_condition"),
            )
        )
        if override is None:
            lines.append(i18n.t("worldbook.commands.lore.show_no_override"))
        else:
            lines.append(
                i18n.t(
                    "worldbook.commands.lore.show_effective",
                    enabled=_yes_no(i18n, effective.enabled),
                    condition=effective.condition or i18n.t("worldbook.commands.lore.no_condition"),
                )
            )
        if effective.condition:
            missing = await _missing_condition_paths(ctx, effective.condition)
            if missing:
                lines.append(
                    i18n.t(
                        "worldbook.commands.lore.show_path_missing",
                        paths=i18n.t("common.list_separator").join(missing),
                    )
                )
        lines.extend(await _budget_lines(ctx, entry.title))
        return "\n".join(lines)

    async def _lore_apply_overlay_file(self, ctx: CommandCtx, rest: str) -> str:
        """`.lore overlay <file>` — apply a pack-shaped overlay file by hand (§5.5)."""
        from pathlib import Path

        from core.lore_overlay import (
            OverlayError,
            load_overlay,
            merge_overlay_file,
            parse_overlay_file,
            room_entry_titles,
            save_overlay,
        )

        i18n = ctx.i18n
        path_text = rest or _first_attachment_name(ctx.raw_ctx)
        if not path_text:
            return i18n.t("worldbook.commands.lore.overlay_file_usage")
        agent_ctx = self._agent_ctx(ctx)
        if agent_ctx.fs is None:
            return i18n.t("worldbook.tools.import.no_fs")
        from core.pack import resolve_installed_path

        resolved = resolve_installed_path(ctx.services.settings.data_dir, path_text)
        if resolved is not None:
            path_text = str(resolved)
        try:
            host_path = Path(agent_ctx.fs.get_file(path_text))
            if not host_path.exists():
                return i18n.t("worldbook.tools.import.no_file", path=path_text)
            parsed = parse_overlay_file(host_path.read_bytes(), label=host_path.name)
        except OverlayError as exc:
            return ctx.fail(i18n.t("worldbook.commands.lore.overlay_failed", error=str(exc)))
        except Exception as exc:  # noqa: BLE001 — unreadable file, same shape as an import failure
            return ctx.fail(i18n.t("worldbook.commands.lore.overlay_failed", error=str(exc)))
        documents = ctx.services.documents
        merged, report = await merge_overlay_file(
            documents,
            ctx.chat_key,
            parsed,
            current=await load_overlay(documents, ctx.chat_key),
            known_titles=await room_entry_titles(ctx.services.worldbook, ctx.chat_key),
        )
        await save_overlay(documents, ctx.chat_key, merged)
        lines = [
            i18n.t(
                "worldbook.commands.lore.overlay_applied",
                entries=report["entries"],
                setup=report["setup"],
                unknown=report["unknown"],
            )
        ]
        if report["prefixes"]:
            # Naming them is the point: `expose:` publishes module variables to PLAYER
            # panels, and a count cannot be checked against what the table should see.
            lines.append(
                i18n.t(
                    "worldbook.commands.lore.overlay_exposed",
                    count=len(report["prefixes"]),
                    prefixes=i18n.t("common.list_separator").join(report["prefixes"]),
                )
            )
        return "\n".join(lines)

    async def cmd_import(self, ctx: CommandCtx) -> str:
        """`.import <card file> [system] [pc|companion|world]` — import a SillyTavern card.

        `pc`/`companion` take the card's CHARACTER half only (`core.card_split` strips hook
        scripts, variable declarations and EJS — module machinery is never player-importable).
        `world` imports that machinery half as the room's module content and is KEEPER-ONLY:
        it installs room hooks, seeds the variable tree, and honors secrecy flags (M12/拆卡).
        """
        from agent.kp_tools_charcard import CharcardTools

        def _is_option(word: str) -> bool:
            return word in {"pc", "companion", "world", "世界"} or _resolve_system_token(word) is not None

        tokens = ctx.args.split()
        if tokens and tokens[0].casefold() in {"list", "列表"}:
            # Discovery without path-typing: every installed pack's card files as the
            # pack-relative refs `.import` accepts. Filenames only (the install banner
            # already printed them to the operator) — player-open on purpose, so "the
            # module shipped a PC card" is claimable knowledge, not keeper folklore.
            return _installed_card_refs(ctx)
        attachment = _first_attachment_name(ctx.raw_ctx)
        if attachment and (not tokens or _is_option(tokens[0].casefold())):
            file_path = attachment
            options = tokens
            from_attachment = True
        elif tokens:
            file_path = tokens[0]
            options = tokens[1:]
            from_attachment = False
        else:
            return ctx.i18n.t("charcard.commands.import.usage")
        system = ""
        as_ = "pc"
        for token in options:
            low = token.casefold()
            if low in {"pc", "companion"}:
                as_ = low
            elif low in {"world", "世界"}:
                as_ = "world"
            else:
                resolved_system = _resolve_system_token(low)
                if not resolved_system:
                    # Never swallow it: a keeper naming a system that does not resolve (an
                    # uninstalled pack, a typo) used to have the token silently dropped and the
                    # card imported under the default system instead.
                    return ctx.fail(ctx.i18n.t("charcard.commands.import.unknown_option", option=token))
                system = resolved_system
        if not from_attachment:
            # Pack-relative refs (`.import <packId>/cards/x.png`) resolve against the
            # newest installed `data_dir/packs/<id>@<version>/` (or a `.dev mount` home,
            # whose cards the picker lists under the same ref shape) — CONFINED by
            # `gateway.panels.resolve_pack_ref`, never an arbitrary server read. A confined ref
            # stays open to players for the character half ("the module shipped a PC
            # card" must not be a keeper-only ceremony — card split still strips world
            # machinery structurally); `world`/`companion` keep their keeper gates below.
            # A RAW host path (not pack-shaped, or nothing installed) reads an arbitrary
            # file off the server, so it stays keeper-only.
            from gateway.panels import resolve_pack_ref

            resolved = resolve_pack_ref(ctx.services.settings.data_dir, file_path)
            if resolved is not None:
                file_path = str(resolved)
            elif not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("rooms.denied"))
        tools = CharcardTools(ctx.services)
        if as_ == "world":
            # The ONLY entrance to the world-import path (deliberately not a model tool):
            # this deterministic check is what makes "module machinery goes through the
            # keeper" structural rather than behavioral.
            if not _is_keeper(ctx.raw_ctx):
                return ctx.fail(ctx.i18n.t("charcard.commands.import.world_denied"))
            return await tools.import_world_card(self._agent_ctx(ctx), file_path=file_path, system=system)
        if as_ == "companion" and not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("charcard.commands.import.companion_denied"))
        return await tools.import_character(self._agent_ctx(ctx), file_path=file_path, system=system, as_=as_)

    async def cmd_var(self, ctx: CommandCtx) -> str:
        """`.var [list|setup|expose <prefix|*>|hide <prefix>|set <id-or-path> <value>|
        add <id-or-path> <delta>]` — the keeper's variable lever, both halves of the
        variable surface.

        expose/hide curate which imported-card variables (the MVU tree) appear on the party's
        state panel: an imported tree is opaque module state, so it starts fully hidden (iron
        rule #3, fail-closed) and this command is the deterministic lever that puts chosen paths
        on the players' panel. set/add write ENGINE-NATIVE module variables through
        `core.modvars` validation (kind check, bounds clamp, enum match) — the keeper's direct
        hand on a tracker without spending a model turn; the variable must already be defined
        (definition stays a prep-phase Keeper tool). An id that is not a typed tracker falls
        through to an EXISTING leaf of the imported card's tree (M26 §5.2, owner verdict
        2026-09-21: the human admin may change module state directly — the trust subject of
        the card split is the operator). The admin changes VALUES; creating a path stays the
        model tool's job. `setup` lists the module's "set before play" choices. Keeper-only on
        every subcommand — even `list`, since the listing shows the hidden remainder."""
        from core.documents import KEEPER_VIEWER, MVU_ID
        from core.lore_overlay import load_overlay, mark_setup_done
        from core.modvars import adjust_modvar, coerce_int, label_for, load_modvars, normalize_id, set_modvar
        from core.mvu_compat import mvu_expose, mvu_hide

        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("vars.commands.denied"))
        tokens = ctx.args.split()
        sub = tokens[0].casefold() if tokens else "list"
        rest = " ".join(tokens[1:]).strip()
        documents = ctx.services.documents
        set_words = {"set", "设置", "設置"}
        add_words = {"add", "调整", "調整"}
        if sub in {"setup", "开局", "開局"}:
            return await self._var_setup(ctx)
        if sub in set_words or sub in add_words:
            parts = rest.split(None, 1)
            if len(parts) < 2:
                return ctx.i18n.t("vars.commands.usage")
            raw_id, payload = parts[0], parts[1].strip()
            slug = normalize_id(raw_id)
            state = await load_modvars(documents, ctx.chat_key)
            if slug is None or slug not in state["specs"]:
                # M26 §5.2: fall through to the IMPORTED card's variable tree. The admin
                # changes VALUES there, never the tree's shape — creating a path stays the
                # model tool's job, so an unknown one is an error with the nearest names
                # rather than a new leaf nobody asked for.
                return await self._var_write_tree(ctx, raw_id, payload, adding=sub in add_words)
            label = label_for(state["specs"][slug], ctx.locale)
            try:
                if sub in set_words:
                    old, new = await set_modvar(documents, ctx.chat_key, slug, payload)
                else:
                    delta_value = coerce_int(payload)
                    if delta_value is None:
                        return ctx.i18n.t("vars.commands.bad_delta", delta=payload)
                    old, new = await adjust_modvar(documents, ctx.chat_key, slug, delta_value)
            except ValueError as exc:
                return ctx.i18n.t("vars.commands.write_failed", id=slug, error=str(exc))
            # A typed tracker can BE a setup item (a native lorecard's `setup: true`), and
            # the choice is made by whoever writes it — model or admin, one call site each.
            await mark_setup_done(documents, ctx.chat_key, slug)
            # A changed player-visible value belongs on the party panel right away; the
            # projection decides what players see, this only refreshes it (same pattern
            # as expose/hide below).
            if old != new and ctx.router.hub is not None:
                await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
            if sub in set_words:
                return ctx.i18n.t("vars.commands.set_done", label=label, id=slug, old=old, new=new)
            return ctx.i18n.t("vars.commands.add_done", label=label, id=slug, old=old, new=new, delta=payload)
        if sub in {"expose", "show", "公开", "公開"}:
            if not rest:
                return ctx.i18n.t("vars.commands.usage")
            changed = await mvu_expose(documents, ctx.chat_key, rest)
            if changed and ctx.router.hub is not None:
                await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
            return ctx.i18n.t("vars.commands.exposed" if changed else "vars.commands.expose_noop", prefix=rest)
        if sub in {"hide", "隐藏", "隱藏"}:
            if not rest:
                return ctx.i18n.t("vars.commands.usage")
            changed = await mvu_hide(documents, ctx.chat_key, rest)
            if changed and ctx.router.hub is not None:
                await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
            return ctx.i18n.t("vars.commands.hidden" if changed else "vars.commands.hide_noop", prefix=rest)
        if sub not in {"list", "列表"}:
            return ctx.i18n.t("vars.commands.usage")
        # This is the keeper's curation listing: consume the KEEPER projection,
        # whose leaves come pre-tagged with their exposure (the one filter lives
        # in the document projection, never re-applied here).
        view = await documents.get_view(ctx.chat_key, "mvu_tree", MVU_ID, KEEPER_VIEWER)
        leaves = (view or {}).get("leaves", [])
        exposed = (view or {}).get("exposed", [])
        # Typed module variables list here too (k3 playtest D9a): with no command
        # showing them, a keeper's only way to "see the trackers" was asking the
        # MODEL for a status report — which is how a keeper-only value ended up
        # recited into room-visible narration. Bookkeeping belongs to real code.
        state = await load_modvars(documents, ctx.chat_key)
        modvar_lines: list[str] = []
        # M26: the table's open opening choices lead the listing — they are the one thing
        # here that is waiting on a human rather than reporting on the game.
        pending = (await load_overlay(documents, ctx.chat_key)).pending()
        if pending:
            modvar_lines.append(
                ctx.i18n.t(
                    "vars.commands.setup_pending_line",
                    items=ctx.i18n.t("common.list_separator").join(
                        item.label_for(ctx.locale) for item in pending
                    ),
                )
            )
        if state["specs"]:
            modvar_lines.append(ctx.i18n.t("vars.commands.modvars_header", count=len(state["specs"])))
            for var_id, spec in state["specs"].items():
                tag = (
                    ctx.i18n.t("vars.commands.keeper_tag")
                    if spec.get("visibility") == "keeper"
                    else ctx.i18n.t("vars.commands.player_tag")
                )
                modvar_lines.append(f"· {label_for(spec, ctx.locale)} [{var_id}] = {state['values'].get(var_id)} {tag}")
        if not leaves and not exposed:
            if modvar_lines:
                return "\n".join(modvar_lines)
            return ctx.i18n.t("vars.commands.empty")
        lines = modvar_lines + ([""] if modvar_lines else [])
        lines += [ctx.i18n.t("vars.commands.list_header", count=len(leaves))]
        if exposed:
            lines.append(ctx.i18n.t("vars.commands.exposed_line", prefixes=", ".join(exposed)))
        max_lines = 40
        for leaf in leaves[:max_lines]:
            value = str(leaf["value"])
            if len(value) > 60:
                value = f"{value[:60]}…"
            tag = (
                ctx.i18n.t("vars.commands.visible_tag")
                if leaf.get("exposed")
                else ctx.i18n.t("vars.commands.hidden_tag")
            )
            lines.append(f"· {leaf['path']} = {value} {tag}")
        if len(leaves) > max_lines:
            lines.append(ctx.i18n.t("vars.commands.more", count=len(leaves) - max_lines))
        return "\n".join(lines)

    async def _var_setup(self, ctx: CommandCtx) -> str:
        """`.var setup` — the module's "set before play" choices, done and still open."""
        from core.lore_overlay import load_overlay

        overlay = await load_overlay(ctx.services.documents, ctx.chat_key)
        if not overlay.setup:
            return ctx.i18n.t("vars.commands.setup_empty")
        lines = [ctx.i18n.t("vars.commands.setup_header", count=len(overlay.pending()))]
        for item in overlay.setup:
            key = "vars.commands.setup_item_done" if item.done else "vars.commands.setup_item_pending"
            lines.append(
                ctx.i18n.t(
                    key,
                    label=item.label_for(ctx.locale),
                    path=item.path,
                    options="|".join(item.options) or ctx.i18n.t("common.none"),
                )
            )
        return "\n".join(lines)

    async def _var_write_tree(self, ctx: CommandCtx, path: str, payload: str, *, adding: bool) -> str:
        """`.var set|add` against an EXISTING leaf of the imported card's variable tree.

        Three refusals, three different sentences — they used to be one. "No such path"
        wants the nearest names; "that is a branch" wants the children under it; "that
        exists but this write is illegal" (a delta onto a string) wants the real reason.
        Collapsing them printed "neither a tracker nor a leaf" about a leaf, and then
        helpfully listed that very leaf as the nearest path.
        """
        from core.lore_overlay import mark_setup_done
        from core.modvars import load_modvars
        from core.mvu_compat import (
            MvuBranchTarget,
            MvuPathMissing,
            MvuShapeWrite,
            load_mvu,
            mvu_add_path,
            mvu_set_path,
            nearest_paths,
            parse_scalar,
        )

        documents = ctx.services.documents
        i18n = ctx.i18n
        separator = i18n.t("common.list_separator")
        try:
            if adding:
                delta = parse_scalar(payload)
                if not isinstance(delta, (int, float)) or isinstance(delta, bool):
                    return i18n.t("vars.commands.bad_delta", delta=payload)
                old, new = await mvu_add_path(documents, ctx.chat_key, path, delta)
            else:
                old, new = await mvu_set_path(documents, ctx.chat_key, path, parse_scalar(payload))
        except MvuBranchTarget as exc:
            return ctx.fail(
                i18n.t(
                    "vars.commands.branch_refused",
                    path=path,
                    children=separator.join(exc.children[:8]) or i18n.t("common.none"),
                )
            )
        except MvuShapeWrite:
            # The target is a leaf and the write is legal in form; what is refused is the
            # VALUE's shape. `.var set` changes values — a mapping or list typed as JSON
            # would turn the leaf into a subtree, the same reshaping the branch guard
            # refuses from the path side.
            return ctx.fail(i18n.t("vars.commands.shape_refused", path=path))
        except MvuPathMissing:
            tree = await load_mvu(documents, ctx.chat_key)
            state = await load_modvars(documents, ctx.chat_key)
            if not tree and not state["specs"]:
                return i18n.t("vars.commands.none_defined")
            return ctx.fail(
                i18n.t(
                    "vars.commands.unknown_target",
                    id=path,
                    known=separator.join(state["specs"]) or i18n.t("common.none"),
                    paths=separator.join(nearest_paths(tree, path)) or i18n.t("common.none"),
                )
            )
        except ValueError as exc:
            # The target IS there; the WRITE is what was refused (a delta onto a string,
            # a toggle onto a number). Say the real reason, and never offer nearest paths.
            return ctx.fail(i18n.t("vars.commands.write_refused", path=path, error=str(exc)))
        await mark_setup_done(documents, ctx.chat_key, path)
        # An exposed leaf is on the party panel; the projection decides what players see.
        if old != new and ctx.router.hub is not None:
            await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
        key = "vars.commands.tree_add_done" if adding else "vars.commands.tree_set_done"
        return i18n.t(key, path=path, old=old, new=new, delta=payload)

    async def cmd_module(self, ctx: CommandCtx) -> str:
        """`.module <module file>` — import a module document and run module analysis."""
        from agent.kp_tools_knowledge import DocumentTools

        tokens = ctx.args.split()
        file_path = tokens[0] if tokens else _first_attachment_name(ctx.raw_ctx)
        if not file_path:
            return ctx.i18n.t("commands.module.usage")
        tools = DocumentTools(ctx.services)
        agent_ctx = self._agent_ctx(ctx)
        return await tools.upload_document(
            agent_ctx,
            file_path=file_path,
            doc_type="module",
            progress=self._module_progress(ctx, agent_ctx.chat_key),
        )

    def _module_progress(self, ctx: CommandCtx, chat_key: str) -> Any:
        """Build a progress reporter that STREAMS import-stage frames to the issuer while a
        (deliberately slow) full-module analysis runs, so the keeper watches a live progress
        bar advance through read → embed → analyze → build → done instead of staring at a
        frozen spinner. Progress frames carry module identity (filename, chunk counts,
        knowledge-pool stages) — keeper-only material under the anti-metagaming red line —
        so they go ONLY to the issuing user's connections; everyone else gets a single
        spoiler-free notice. Returns None (a no-op import) when this router has no hub —
        e.g. the standalone CLI — so imports still work everywhere, just without the bar."""
        hub = self.hub
        if hub is None:
            return None
        i18n = ctx.i18n
        extra = getattr(ctx.raw_ctx, "extra", None)
        issuer = (
            str(extra.get("member_user_key"))
            if isinstance(extra, dict) and extra.get("member_user_key")
            else ctx.user_id
        )
        steps = {"read": 1, "embed": 2, "analyze": 3, "build": 4, "done": 5}
        total = len(steps)
        notified = False

        async def report(stage: str, detail: str = "") -> None:
            nonlocal notified
            step = steps.get(stage, 0)
            bar = "█" * step + "░" * (total - step)
            label_key = "commands.module.progress.done_fallback" if stage == "done" and detail == "ready_fallback" else f"commands.module.progress.{stage}"
            label = i18n.t(label_key)
            text = i18n.t("commands.module.progress.line", bar=bar, label=label)
            await hub.publish(
                chat_key,
                Event.narrative(speaker="system", text=text, fmt="plain"),
                only_user=issuer,
            )
            if not notified:
                notified = True
                await hub.publish(
                    chat_key,
                    Event.narrative(speaker="system", text=i18n.t("commands.module.progress.notice"), fmt="plain"),
                    exclude_user=issuer,
                )

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
        ctx.markdown = True
        # The saved file sits on the SERVER. Only a local operator can open it; over the
        # network the line just broadcast the host's absolute path to every player.
        if str(getattr(ctx.raw_ctx, "platform", "cli") or "cli") != "cli":
            saved_note = ""
        return f"{markdown}\n\n{saved_note}" if saved_note else markdown

    async def cmd_recap(self, ctx: CommandCtx) -> str:
        """`.recap` — the spoiler-free "previously on…" campaign recap (M18). Player-facing
        (any member; no keeper privilege): rendered purely from PLAYER projections of the
        campaign summary + the raw recent tail, so keeper annotations structurally cannot
        appear — safe to broadcast to the whole room."""
        from agent.chronicle import render_recap

        rendered = await render_recap(ctx.services, ctx.chat_key, ctx.i18n)
        if rendered is None:
            return ctx.i18n.t("commands.recap.empty")
        return rendered

    async def cmd_chronicle(self, ctx: CommandCtx) -> str:
        """`.chronicle [list | summary | threads | fold | edit <text> | note <text>]` — the
        keeper's campaign-chronicle console (M18). Keeper-gated in-handler (same posture as
        `.lore`, so a CLI/TUI keeper keeps working); replies may carry keeper annotations,
        which is why the spec marks the family `private_reply`."""
        from agent.chronicle import maybe_fold_chronicle
        from core.chronicle import CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, CHRONICLE_DOC_TYPE, THREAD_DOC_TYPE

        if not _is_keeper(ctx.raw_ctx):
            return ctx.i18n.t("commands.chronicle.denied")
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        documents = ctx.services.documents
        chat_key = ctx.chat_key

        if sub in _CHRONICLE_LIST_WORDS:
            entries = sorted(
                await documents.list(chat_key, CHRONICLE_DOC_TYPE),
                key=lambda doc: (int(doc.data.get("turn", 0)), doc.id),
            )
            if not entries:
                return ctx.i18n.t("commands.chronicle.empty")
            lines = [ctx.i18n.t("commands.chronicle.list_header", count=len(entries))]
            for doc in entries:
                folded_mark = ctx.i18n.t("commands.chronicle.folded_mark") if doc.data.get("folded") else ""
                lines.append(
                    ctx.i18n.t(
                        "commands.chronicle.entry_line",
                        id=doc.id,
                        turn=int(doc.data.get("turn", 0)),
                        folded_mark=folded_mark,
                        text=str(doc.data.get("text", "")).strip(),
                    )
                )
                margin = str(doc.data.get("keeper", "")).strip()
                if margin:
                    lines.append(ctx.i18n.t("commands.chronicle.margin_line", text=margin))
            return "\n".join(lines)

        if sub in _CHRONICLE_SUMMARY_WORDS:
            summary = await documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
            if summary is None:
                return ctx.i18n.t("commands.chronicle.no_summary")
            lines = [
                ctx.i18n.t(
                    "commands.chronicle.summary_header",
                    turn=int(summary.data.get("through_turn", 0)),
                    folds=int(summary.data.get("fold_count", 0)),
                ),
                str(summary.data.get("text", "")).strip(),
            ]
            margin = str(summary.data.get("keeper", "")).strip()
            if margin:
                lines.append(ctx.i18n.t("commands.chronicle.margin_label") + " " + margin)
            return "\n".join(lines)

        if sub in _CHRONICLE_THREADS_WORDS:
            threads = [
                doc
                for doc in await documents.list(chat_key, THREAD_DOC_TYPE)
                if doc.data.get("status") == "open"
            ]
            if not threads:
                return ctx.i18n.t("commands.chronicle.threads_empty")
            lines = [ctx.i18n.t("commands.chronicle.threads_header")]
            for doc in threads:
                line = f"- {doc.data.get('label', '')}"
                notes = str(doc.data.get("notes", "")).strip()
                if notes:
                    line += f" — {notes}"
                lines.append(line)
            return "\n".join(lines)

        if sub in _CHRONICLE_FOLD_WORDS:
            if not ctx.services.settings.chronicle.enabled:
                return ctx.i18n.t("commands.chronicle.disabled")
            # Manual fold (spec: automatic primary, manual available) — folds every
            # record past the lag window regardless of the meter.
            outcome = await maybe_fold_chronicle(self._agent_ctx(ctx), ctx.services, force=True)
            if outcome.entries_folded == 0:
                return ctx.i18n.t("commands.chronicle.fold_none")
            return ctx.i18n.t(
                "commands.chronicle.fold_done", count=outcome.entries_folded, turn=outcome.through_turn
            )

        if sub in _CHRONICLE_EDIT_WORDS or sub in _CHRONICLE_NOTE_WORDS:
            if not rest:
                return ctx.i18n.t("commands.chronicle.usage")
            summary = await documents.get(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID)
            if summary is None:
                return ctx.i18n.t("commands.chronicle.no_summary")
            data = dict(summary.data)
            if sub in _CHRONICLE_EDIT_WORDS:
                data["text"] = rest  # keeper edit round-trips straight into the players' .recap
                done_key = "commands.chronicle.edit_done"
            else:
                data["keeper"] = rest  # the keeper margin — never crosses project()
                done_key = "commands.chronicle.note_done"
            await documents.put(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, data)
            return ctx.i18n.t(done_key)

        return ctx.i18n.t("commands.chronicle.usage")
