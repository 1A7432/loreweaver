"""Content packs: `.panel` (a panel as text, per viewer), `.panels` (pack enablement for
this room) and `.pack install` (landing a pack on this server in the first place)."""

from __future__ import annotations

import logging
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from gateway.commands.rooms import _TUI_KEEPER_ROLE, _is_keeper
from gateway.commands.rules import _SKILL_DISABLE_WORDS, _SKILL_ENABLE_WORDS
from gateway.commands.types import CommandCtx
from gateway.hub import Event
from gateway.ops import (
    get_enabled_panel_packs,
    toggle_enabled_panel_pack,
)
from gateway.turn import state_for_ctx

if TYPE_CHECKING:
    from core.pack import PackManifest

logger = logging.getLogger(__name__)

# `.pack <sub>` — one subcommand for now, spelled in both dialects.
_PACK_INSTALL_WORDS = {"install", "add", "安装", "安裝"}


class PanelsCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def _viewer_snapshot(self, ctx: CommandCtx) -> dict[str, Any]:
        """This caller's room snapshot: with the hub's presence overlaid when there is a
        hub (`gateway.turn.state_for_ctx`), the bare `net.state.build_room_state` otherwise.
        Never raises — a panel with no live values still renders its static text."""
        from net.state import build_room_state

        try:
            if self.hub is not None:
                return await state_for_ctx(self.hub, ctx.services, ctx.raw_ctx)
            return await build_room_state(ctx.services, ctx.raw_ctx)
        except Exception:  # noqa: BLE001 — see docstring
            logger.debug("room snapshot unavailable for .panel", exc_info=True)
            return {}

    async def cmd_panel(self, ctx: CommandCtx) -> str:
        """`.panel [<id>]` — the module's panels as TEXT, for a client that cannot draw them.

        A tier-2 panel's `fallback` exists to be read by exactly such a client, and until
        this rendered it nothing could: `.panel` produced no frame at all (its reply was
        swallowed by the state refresh in `gateway.turn`), so a module's look-at-the-chart
        layer was unreachable from a terminal. Bare, it lists what THIS viewer may open
        (audience filtered server-side, same as the manifest); with an id it renders that
        panel against this viewer's own variables — `$var` absent means hidden, and
        `visible_when` runs through `core.condexpr`, the evaluator every client implements.
        The caller's HUD refresh rides along as an `Event.panel` on the reply (private, like
        the text) — the one snapshot serves both, and the turn pipeline needs no special
        knowledge of this command.
        """
        from core.panels import panel_title_text, render_panel_text
        from gateway.panels import enabled_panels, panel_wire_blocks

        snapshot = await self._viewer_snapshot(ctx)
        if snapshot:
            ctx.events.append(Event.panel(snapshot, private=True))

        role = _TUI_KEEPER_ROLE if _is_keeper(ctx.raw_ctx) else "player"
        panels = await enabled_panels(ctx.services, ctx.chat_key, role)
        if not panels:
            return ctx.i18n.t("commands.panel.none")

        wanted = ctx.args.strip()
        if not wanted:
            lines = [ctx.i18n.t("commands.panel.list_header", count=len(panels))]
            for wire_id, panel in panels:
                lines.append(
                    ctx.i18n.t(
                        "commands.panel.list_item",
                        id=wire_id,
                        title=panel_title_text(panel, ctx.locale),
                    )
                )
            lines.append(ctx.i18n.t("commands.panel.list_hint"))
            return "\n".join(lines)

        matches = [
            (wire_id, panel)
            for wire_id, panel in panels
            if wanted in (wire_id, panel.id) or wanted.casefold() == panel_title_text(panel, ctx.locale).casefold()
        ]
        if not matches:
            return ctx.fail(
                ctx.i18n.t("commands.panel.unknown", name=wanted, ids=", ".join(wire_id for wire_id, _ in panels))
            )
        wire_id, panel = matches[0]
        # The WIRE blocks, not the authored ones: `.panel` renders exactly what a client
        # would draw (`src` paths already resolved to content hashes), through the same
        # `resolve_panel_blocks` contract the reference client implements.
        blocks = panel_wire_blocks(ctx.services, wire_id.partition("/")[0], panel)
        body = render_panel_text(blocks, snapshot.get("variables") or [], ctx.locale)
        title = ctx.i18n.t("commands.panel.title", title=panel_title_text(panel, ctx.locale), id=wire_id)
        if not body:
            return f"{title}\n{ctx.i18n.t('commands.panel.rich_only')}"
        return "\n".join([title, *body])

    async def cmd_panels(self, ctx: CommandCtx) -> str:
        """`.panels [list | enable <packId> | disable <packId>]` — admit an installed
        pack's module UI panels (M15) to this room, `.skill`-style: bare `.panels` /
        `.panels list` is open viewing, enable/disable is keeper-gated. Panels reach a
        room ONLY through this command (the 拆卡 rule extended to UI); a change pushes
        fresh per-viewer `ui_manifest` frames to every connected member immediately.
        """
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        rest = parts[1].strip() if len(parts) > 1 else ""

        if sub in _SKILL_ENABLE_WORDS:
            return await self._panels_set(ctx, rest, enable=True)
        if sub in _SKILL_DISABLE_WORDS:
            return await self._panels_set(ctx, rest, enable=False)
        return await self._panels_list(ctx)

    async def _panels_list(self, ctx: CommandCtx) -> str:
        from gateway.panels import list_installed_panel_packs

        enabled_ids = set(await get_enabled_panel_packs(ctx.services.store, ctx.chat_key))
        installed = list_installed_panel_packs(ctx.services)
        if not installed:
            return ctx.i18n.t("commands.panels.none_installed")
        lines = []
        for pack_id, count in installed:
            marker_key = "commands.skill.enabled_some" if pack_id in enabled_ids else "commands.skill.enabled_none"
            lines.append(f"[{ctx.i18n.t(marker_key)}] {pack_id} — {ctx.i18n.t('commands.panels.count', count=count)}")
        return ctx.i18n.t("commands.panels.list", items="\n".join(lines))

    async def cmd_pack(self, ctx: CommandCtx) -> str:
        """`.pack install <ref>` — install a content pack onto THIS server and enable it here.

        `ref` is what `--install` accepts: a server-local path, an `https://` link, or
        `gh:owner/repo[@tag]` (Git releases ARE the registry). Keeper-only, because it
        writes to the server's data dir and because what it installs then RUNS here.

        Owner verdict 2026-08-19, sharpened 2026-08-20: on a remote table, install IS
        enable, and it means PLAYABLE — one command, not a command plus a checklist.
        Convenience outranks ceremony here (the same stance `docs/notes` records for ST
        content and full EJS): a keeper who typed the ref has made the trust decision, and
        the CLI's per-item confirmation cannot be reproduced across the wire honestly, so
        the reply carries the terminal's disclosure card and one plain risk line instead.

        So this throws every switch the pack ships: its panels and presentation kit
        (`.panels enable`), its KP skills (`.skill enable`), and — when the pack ships
        exactly ONE world card — that card
        as the room's module (`.import <ref> world`, which also pins the pack's character
        system). The only thing not thrown automatically is the choice between SEVERAL
        world cards in one pack — which module this table is playing is a fork, not a
        confirmation — and the reply names those as the command that would load one.
        """
        import asyncio

        from core.pack import PackError, inspect_pack
        from gateway.pack_install import install_pack_here, trust_card_lines
        from gateway.panels import publish_ui_manifests
        from infra.pack_source import PackRefError, resolve_pack_ref

        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("rooms.denied"))
        parts = ctx.args.split(maxsplit=1)
        sub = parts[0].casefold() if parts else ""
        ref = parts[1].strip() if len(parts) > 1 else ""
        if sub not in _PACK_INSTALL_WORDS or not ref:
            return ctx.i18n.t("commands.pack.usage")

        data_dir = Path(ctx.services.settings.data_dir)
        # Every step below is blocking (network, zip verification, extraction) and this
        # runs under the room's turn lock, so it goes to a worker thread — an install
        # must not park the whole server's event loop.
        try:
            pack_path = await asyncio.to_thread(
                resolve_pack_ref, ref, cache_dir=data_dir / "packs" / "_cache"
            )
        except PackRefError as exc:
            return ctx.fail(ctx.i18n.t("pack.ref.failed", error=str(exc)))
        try:
            manifest = await asyncio.to_thread(inspect_pack, pack_path)
            report = await asyncio.to_thread(install_pack_here, data_dir, pack_path)
        except PackError as exc:
            # `install_pack` verifies before it writes, so a failure here changed nothing.
            return ctx.fail(ctx.i18n.t("pack.install.failed", error=str(exc)))

        pack_id = report.manifest.id
        # A bundled rulepack's dot-command words (its `make_char` word, its subsystem
        # words) are a SNAPSHOT in the router's spec table, so they route nowhere until it
        # is rebuilt. Dispatch self-heals on a miss too — the out-of-process door has no
        # other way in — but this door knows a pack just landed, so it skips the throttle.
        self.refresh_pack_words(force=True)
        await toggle_enabled_panel_pack(ctx.services.store, ctx.chat_key, pack_id, on=True)
        live, leftover = await _switch_everything_on(ctx, report.manifest, pack_id)
        if self.hub is not None:
            await publish_ui_manifests(self.hub, ctx.services, ctx.chat_key)

        lines = [
            ctx.i18n.t("commands.pack.installed", id=pack_id, version=report.manifest.version),
            *trust_card_lines(ctx.i18n, manifest, ctx.locale),
            *live,
            ctx.i18n.t("commands.pack.risk"),
            *leftover,
        ]
        return "\n".join(lines)

    async def _panels_set(self, ctx: CommandCtx, pack_id: str, *, enable: bool) -> str:
        from gateway.panels import installed_panel_count, installed_presentation_count, publish_ui_manifests

        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("commands.panels.denied"))
        pack_id = pack_id.strip()
        # Panels OR a presentation kit both count: `.panels enable` is the one switch
        # admitting a pack's table dressing, and a kit-only module (the Stage Director's
        # brief, no panels) could otherwise never wake its Director (k3 playtest D4).
        if not pack_id or (
            enable
            and installed_panel_count(ctx.services, pack_id) <= 0
            and installed_presentation_count(ctx.services, pack_id) <= 0
        ):
            return ctx.i18n.t("commands.panels.unknown", id=pack_id)

        await toggle_enabled_panel_pack(ctx.services.store, ctx.chat_key, pack_id, on=enable)
        if self.hub is not None:
            await publish_ui_manifests(self.hub, ctx.services, ctx.chat_key)
        if enable:
            return ctx.i18n.t("commands.panels.enable_done", id=pack_id)
        return ctx.i18n.t("commands.panels.disable_done", id=pack_id)


async def _switch_everything_on(
    ctx: CommandCtx, manifest: PackManifest, pack_id: str
) -> tuple[list[str], list[str]]:
    """Throw the rest of the pack's switches; return (what went live, what is left over).

    Panels are already on when this runs. Here: every KP skill the pack ships, and its
    world card whenever the pack ships exactly one. Nothing waits for a confirmation —
    the keeper typed the ref, the reply states the risk, and the table is playable. The
    single leftover case is a pack with SEVERAL world cards, where "which module is this
    table playing" is a fork no installer can read off a manifest.
    """
    from gateway.ops import toggle_enabled_skill

    live: list[str] = []
    leftover: list[str] = []

    for skill_path in manifest.contents.get("skills", ()):
        skill_id = PurePosixPath(str(skill_path)).name
        if not skill_id:
            continue
        await toggle_enabled_skill(ctx.services.store, ctx.chat_key, skill_id, on=True)
        live.append(ctx.i18n.t("commands.pack.live_skill", id=skill_id))

    world_refs = [
        f"{pack_id}/{card_path}"
        for index, card_path in enumerate(manifest.contents.get("cards", ()))
        if index < len(manifest.card_entries) and manifest.card_entries[index].kind == "world"
    ]
    if len(world_refs) > 1:
        # The ONE thing left for a human: a pack shipping several world cards ships
        # several modules, and which one this table is playing is not a fact an installer
        # can read off a manifest. Not a confirmation step — a fork.
        leftover.extend(ctx.i18n.t("commands.pack.next_card", ref=ref) for ref in world_refs)
    elif world_refs:
        loaded, pinned = await _import_world_card(ctx, world_refs[0])
        if not loaded:
            leftover.append(ctx.i18n.t("commands.pack.next_card", ref=world_refs[0]))
        elif pinned:
            live.append(ctx.i18n.t("commands.pack.live_card_pinned", ref=world_refs[0], system=pinned))
        else:
            live.append(ctx.i18n.t("commands.pack.live_card", ref=world_refs[0]))
    if leftover:
        leftover.insert(0, ctx.i18n.t("commands.pack.next_header"))
    return live, leftover


async def _import_world_card(ctx: CommandCtx, ref: str) -> tuple[bool, str]:
    """Load one world card as this room's module. Returns (landed, pinned system).

    Both halves are OBSERVED, never assumed. `import_world_card` normally reports every
    refusal as prose and writes its `world_import` marker partway through its own work, so
    neither the return value nor that marker can tell a caller whether this call did
    anything — a room that already ran a module carries a truthy marker regardless. Hence
    `raise_on_failure`, and hence reading the room's rule system back afterwards rather
    than repeating the pin the pack asked for: the summary claims a pinned system only
    when the room is actually on it.
    """
    from agent.context import AgentCtx, LocalFs
    from agent.kp_tools_charcard import CharcardTools
    from core.pack import installed_pack_character_system
    from gateway.panels import resolve_pack_ref as resolve_room_pack_ref

    data_dir = ctx.services.settings.data_dir
    resolved = resolve_room_pack_ref(data_dir, ref)
    if resolved is None:
        return False, ""
    # The importer reads through an `FsAdapter`, and a transport that carries none would
    # otherwise turn a perfectly resolved pack path into "no filesystem". The path is
    # already confined under the pack home, so a reader rooted at the data dir adds a
    # second boundary rather than opening one.
    agent_ctx = AgentCtx(
        chat_key=ctx.chat_key,
        user_id=ctx.user_id,
        platform=str(getattr(ctx.raw_ctx, "platform", "cli") or "cli"),
        locale=ctx.locale,
        fs=getattr(ctx.raw_ctx, "fs", None) or LocalFs(data_dir),
        extra=getattr(ctx.raw_ctx, "extra", {}) or {},
    )
    try:
        await CharcardTools(ctx.services).import_world_card(agent_ctx, file_path=str(resolved), raise_on_failure=True)
    except Exception:  # noqa: BLE001 — CardImportRefused included; a bad card must not lose the install
        logger.info("pack install: could not import the world card %r", ref, exc_info=True)
        return False, ""

    wanted = installed_pack_character_system(data_dir, resolved) or ""
    on_now = str(await ctx.services.store.state_get(ctx.chat_key, "room_system") or "")
    return True, wanted if wanted and wanted == on_now else ""
