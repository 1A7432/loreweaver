"""AI-KP tools for generated image handouts."""

from __future__ import annotations

from typing import TYPE_CHECKING

from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from gateway.imagegen import allow_imagegen_request, image_name
from gateway.media import media_frame, publish_media
from infra.i18n import I18n
from infra.imagegen import ImageGenError
from infra.media_store import ALLOWED_IMAGE_MIMES, MediaStore

if TYPE_CHECKING:
    from gateway.hub import RoomHub


class ImageTools:
    """Gated tools for generated player-visible image handouts."""

    def __init__(self, services: Services, *, hub: RoomHub | None = None) -> None:
        self._services = services
        self._hub = hub

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool(gated=True)
    async def generate_image(self, ctx: AgentCtx, prompt: str, kind: str = "scene", caption: str = "") -> str:
        """Generate one player-visible image handout and send it to the room.

        Each call may spend real API money. Use at most one image per scene and do not chain
        repeated generations. The prompt and resulting image must contain only information the
        players already know.

        Args:
            prompt: Player-safe image prompt sent to the external image provider.
            kind: scene, portrait, or item. Used only for the generated file name and reply text.
            caption: Optional player-visible caption for the Keeper to narrate after sending.

        Returns:
            Confirmation with the generated file name and media hash, or a localized reason it was skipped.
        """
        i18n = self._i18n(ctx)
        if self._services.imagegen is None:
            return i18n.t("kp_tools.image.generate.not_configured")
        if not allow_imagegen_request(self._services, ctx.chat_key):
            return i18n.t("kp_tools.image.generate.rate_limited")

        try:
            data, mime = await self._services.imagegen.generate(prompt, size=self._services.settings.imagegen.size)
            settings = self._services.settings.tui
            store = MediaStore(
                self._services.store,
                self._services.settings.data_dir,
                max_file_bytes=settings.media_max_file_bytes,
                room_quota_bytes=settings.media_room_quota_bytes,
                allowed_mimes=ALLOWED_IMAGE_MIMES,
            )
            record = await store.register_blob(
                room=ctx.chat_key,
                data=data,
                mime=mime,
                name=image_name(kind if kind in {"scene", "portrait", "item"} else "image", prompt),
                uploader=ctx.uid(),
            )
            frame = media_frame(record, from_name="KP")
            await publish_media(self._hub, self._services.store, ctx.chat_key, frame)
            return i18n.t(
                "kp_tools.image.generate.done",
                name=record.name,
                hash=record.hash[:12],
                caption=caption.strip(),
            )
        except ImageGenError as exc:
            return i18n.t(f"kp_tools.image.generate.error.{exc.code}")
        except Exception as exc:
            return i18n.t("kp_tools.image.generate.failed", error=str(exc))
