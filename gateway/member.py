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

from typing import TYPE_CHECKING

from gateway.render_chat import render_chat_event
from infra.i18n import get_i18n

if TYPE_CHECKING:
    from gateway.base_adapter import BaseAdapter
    from gateway.hub import Event
    from gateway.session import SessionSource


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
    ) -> None:
        self.adapter = adapter
        self.source = source
        self.session_key = session_key
        self.locale = locale
        self.transport = adapter.platform

    @property
    def id(self) -> str:
        return f"{self.adapter.platform}:{self.source.chat_id}"

    @property
    def user_key(self) -> str:
        return self.source.user_key()

    @property
    def name(self) -> str:
        return self.source.user_name or self.source.user_key()

    def supports_proactive(self) -> bool:
        """Whether the channel accepts unprompted sends (delegated to the adapter)."""
        return self.adapter.supports_proactive(self.source)

    async def deliver(self, event: Event) -> None:
        """Render ``event`` for chat and send it; skip when it renders to nothing.

        If the channel does not currently ``supports_proactive`` we still call
        ``send`` (adapters degrade gracefully — e.g. the QQ adapter queues); a
        proper proactive queue is Phase 3.
        """
        text = render_chat_event(event, get_i18n(self.locale))
        if not text:
            return
        await self.adapter.send(self.source, text, reply_to=self.source.message_id)
