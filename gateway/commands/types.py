"""The command layer's data shapes: `CommandSpec`, `CommandCtx`, `CommandReply`."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from agent.services import Services
from gateway.hub import Event
from infra.i18n import I18n

if TYPE_CHECKING:
    from gateway.commands.router import CommandRouter


Handler = Callable[["CommandCtx"], Awaitable[str]]


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
    # Operator surfaces that `.help` hides from players (dev rooms, model, reset,
    # variable curation, …). `required_level > 0` is treated the same way. A
    # player still sees verbs they can usefully type (rolls, claim, recap);
    # a keeper sees that list plus a second "Keeper:" line.
    keeper_help: bool = False


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
    events: list[Event] = field(default_factory=list)
    # Set by `fail()`: this reply reports that nothing happened, so it is unicast to
    # the caller rather than broadcast to the room (F16).
    failed: bool = False

    @property
    def chat_key(self) -> str:
        value = getattr(self.raw_ctx, "chat_key", "")
        return value() if callable(value) else str(value)

    @property
    def user_id(self) -> str:
        if hasattr(self.raw_ctx, "uid") and callable(self.raw_ctx.uid):
            return str(self.raw_ctx.uid())
        return str(getattr(self.raw_ctx, "user_id", ""))

    def dice(self, kind: str, **fields: Any) -> None:
        """Attach one already-rolled public dice result to this command reply."""
        self.events.append(Event.dice(actor=self.user_id, kind=kind, **fields))

    def fail(self, text: str) -> str:
        """Return `text` as a FAILED command reply — unicast to whoever typed it (F16).

        A reply that says the command did not work is feedback for its author, never
        table content. Broadcasting one also advertises the command's existence, its
        arguments and its privilege gate to everyone in the room: a 2026-08-07 session
        had a player read the keeper's `.rule` error and start probing the console.

        Use this for every "didn't happen" answer — bad usage, unknown target, denied,
        broken input. A reply that reports something that DID happen stays broadcast."""
        self.failed = True
        return text


@dataclass(frozen=True)
class CommandReply:
    text: str
    events: tuple[Event, ...] = ()
    # F16: a reply that reports the command did NOT happen. `gateway.turn` unicasts
    # these to the invoking connection; success replies broadcast exactly as before.
    error: bool = False
