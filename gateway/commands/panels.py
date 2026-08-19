"""Module panels: `.panel` (a panel as text, per viewer) and `.panels` (pack enablement)."""

from __future__ import annotations

import logging
from typing import Any

from gateway.commands.rooms import _TUI_KEEPER_ROLE, _is_keeper
from gateway.commands.rules import _SKILL_DISABLE_WORDS, _SKILL_ENABLE_WORDS
from gateway.commands.types import CommandCtx
from gateway.hub import Event
from gateway.ops import (
    get_enabled_panel_packs,
    toggle_enabled_panel_pack,
)
from gateway.turn import state_for_ctx

logger = logging.getLogger(__name__)


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
