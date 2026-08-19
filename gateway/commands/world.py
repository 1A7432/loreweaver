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
        """`.lore [add <title> | <content> | list [scope] | query <text> | import <file>]` — manage
        world lore (M11). `list` is open; authoring/secret-revealing ops (add/query/import) are
        keeper-gated via the shared privilege check."""
        from agent.kp_tools_worldbook import WorldbookTools

        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""
        agent_ctx = self._agent_ctx(ctx)
        tools = WorldbookTools(ctx.services)
        keeper = _is_keeper(ctx.raw_ctx)

        if sub in _LORE_LIST_WORDS:
            # A player's `.lore list` must never reveal that a secret entry even exists; only a
            # keeper sees secret titles (mirrors `query_lore` being keeper-gated).
            return await tools.list_lore(agent_ctx, scope=rest, _keeper=keeper)
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
        """`.var [list|expose <prefix|*>|hide <prefix>|set <id> <value>|add <id> <delta>]` —
        the keeper's variable lever, both halves of the variable surface.

        expose/hide curate which imported-card variables (the MVU tree) appear on the party's
        state panel: an imported tree is opaque module state, so it starts fully hidden (iron
        rule #3, fail-closed) and this command is the deterministic lever that puts chosen paths
        on the players' panel. set/add write ENGINE-NATIVE module variables through
        `core.modvars` validation (kind check, bounds clamp, enum match) — the keeper's direct
        hand on a tracker without spending a model turn; the variable must already be defined
        (definition stays a prep-phase Keeper tool). Keeper-only on every subcommand — even
        `list`, since the listing shows the hidden remainder."""
        from core.documents import KEEPER_VIEWER, MVU_ID
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
        if sub in set_words or sub in add_words:
            parts = rest.split(None, 1)
            if len(parts) < 2:
                return ctx.i18n.t("vars.commands.usage")
            raw_id, payload = parts[0], parts[1].strip()
            slug = normalize_id(raw_id)
            state = await load_modvars(documents, ctx.chat_key)
            if slug is None or slug not in state["specs"]:
                if not state["specs"]:
                    return ctx.i18n.t("vars.commands.none_defined")
                return ctx.i18n.t("vars.commands.unknown_var", id=raw_id, known=", ".join(state["specs"]))
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
