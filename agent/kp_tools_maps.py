"""AI-KP tools for deterministic SVG handout maps."""

from __future__ import annotations

import json
import uuid
from typing import TYPE_CHECKING, Any

from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from core.svg_map import build_svg_map
from gateway.hub import Event
from infra.i18n import I18n
from infra.media_store import ALLOWED_MEDIA_MIMES, MediaStore
from infra.svg import SVG_MIME

if TYPE_CHECKING:
    from gateway.hub import RoomHub

_MEDIA_HISTORY_REPLAY_CAP = 30


class SvgMapTools:
    """Gated tools for drawing player-visible SVG maps and room diagrams."""

    def __init__(self, services: Services, *, hub: RoomHub | None = None) -> None:
        self._services = services
        self._hub = hub

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool(gated=True)
    async def draw_svg_map(self, ctx: AgentCtx, title: str, areas_json: str, layout: str = "hierarchy") -> str:
        """Draw a player-visible SVG map/room diagram and send it as a media handout.

        Args:
            title: Map title shown at the top, e.g. "Old Chapel Basement".
            areas_json: JSON list of areas. Each item may include id, name, parent, description, and links.
            layout: "hierarchy" for nested/flow maps, or "grid" for room/floor layouts.

        Returns:
            Confirmation with the generated file name and media hash.
        """
        i18n = self._i18n(ctx)
        try:
            filename, svg = build_svg_map(title, areas_json, layout=layout)
            data = svg.encode("utf-8")
            settings = self._services.settings.tui
            store = MediaStore(
                self._services.store,
                self._services.settings.data_dir,
                max_file_bytes=max(settings.media_max_file_bytes, settings.audio_max_file_bytes),
                room_quota_bytes=max(settings.media_room_quota_bytes, settings.audio_room_quota_bytes),
                allowed_mimes=ALLOWED_MEDIA_MIMES,
            )
            record = await store.register_blob(
                room=ctx.chat_key,
                data=data,
                mime=SVG_MIME,
                name=filename,
                uploader=ctx.uid(),
            )
            frame = {
                "type": "media",
                "id": uuid.uuid4().hex,
                "hash": record.hash,
                "mime": record.mime,
                "size": record.size,
                "name": record.name,
                "from": "KP",
                "ts": record.created_at,
            }
            await self._record_media_history(ctx.chat_key, frame)
            if self._hub is not None:
                await self._hub.publish(ctx.chat_key, Event.media(frame))
            return i18n.t("kp_tools.map.draw.done", name=record.name, hash=record.hash[:12])
        except Exception as exc:
            return i18n.t("kp_tools.map.draw.failed", error=str(exc))

    async def _record_media_history(self, chat_key: str, frame: dict[str, Any]) -> None:
        store_key = f"media_history.{chat_key}"
        try:
            raw = await self._services.store.get(user_key="", store_key=store_key)
            history = json.loads(raw) if raw else []
        except Exception:
            history = []
        if not isinstance(history, list):
            history = []
        history.append(dict(frame))
        await self._services.store.set(
            user_key="",
            store_key=store_key,
            value=json.dumps(history[-_MEDIA_HISTORY_REPLAY_CAP:], ensure_ascii=False),
        )
