"""``AdapterMember`` — a chat channel as a :class:`~gateway.hub.Member` (M7 §2).

Where ``net.tui_server.WsMember`` makes one terminal WebSocket a room member,
``AdapterMember`` makes one chat channel (a ``(platform, chat_id)`` pair on some
:class:`~gateway.base_adapter.BaseAdapter`) a room member on the SAME hub. Its
``deliver`` renders each normalized :class:`~gateway.hub.Event` into a chat line
via :func:`gateway.render_chat.render_chat_event` and ``adapter.send``s it to the
channel — so a turn published to the shared room reaches Discord/QQ/Telegram/
Feishu players and terminal players alike, each rendered natively.

Identity is by object (default ``__hash__``/``__eq__``), so the hub can hold it
in a ``set[Member]``; ``id`` is stable per channel (``f"{platform}:{chat_id}"``)
so the runner can keep a per-channel registry and reuse one member across the
channel's repeated messages.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from gateway.base_adapter import BaseAdapter
    from gateway.hub import Event
    from gateway.session import SessionSource
    from infra.media_store import MediaStore

logger = logging.getLogger(__name__)


class AdapterMember:
    """A chat channel bound to a shared session, as a hub ``Member``.

    Wraps ``(adapter, source, session_key)``. ``source`` is refreshed by the
    runner on each inbound message from the channel (so ``reply_to`` and the
    acting player's display name track the latest message); the channel identity
    (``id``) stays stable because it keys off ``adapter.platform`` + ``chat_id``.
    """

    transport: str

    def __init__(
        self,
        adapter: BaseAdapter,
        source: SessionSource,
        session_key: str,
        *,
        locale: str = "en",
        media_store: MediaStore | None = None,
    ) -> None:
        self.adapter = adapter
        self.source = source
        self.session_key = session_key
        self.locale = locale
        self.transport = adapter.platform
        self.media_store = media_store
        self._identities: dict[str, str] = {}
        self.observe(source)

    def observe(self, source: SessionSource) -> None:
        """Refresh the reply target and remember who has spoken in a group channel."""
        self.source = source
        self._identities[source.user_key()] = source.user_name or source.user_key()

    @property
    def id(self) -> str:
        return f"{self.adapter.platform}:{self.source.chat_id}"

    @property
    def user_key(self) -> str:
        return self.source.user_key()

    @property
    def state_user_id(self) -> str:
        if self.source.chat_type.casefold() in {"dm", "direct", "private", "c2c"}:
            return self.source.user_key()
        return self.id

    @property
    def state_identities(self) -> tuple[tuple[str, str], ...]:
        return tuple(self._identities.items())

    @property
    def name(self) -> str:
        return self.source.user_name or self.source.user_key()

    async def deliver(self, event: Event) -> None:
        """Render ``event`` for chat and send it."""
        result = await self.adapter.deliver_event(
            self.source,
            self.session_key,
            event,
            locale=self.locale,
            media_store=self.media_store,
        )
        if result is not None and not result.ok:
            logger.warning(
                "adapter.delivery_failed platform=%s error=%s",
                self.adapter.platform,
                result.error or "send_failed",
            )
