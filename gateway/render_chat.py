"""Chat-transport renderer: a normalized :class:`~gateway.hub.Event` -> chat text.

This is the chat-platform analogue of ``net.tui_server._render_frame`` (which
renders the same events into terminal WS JSON frames). An
:class:`~gateway.member.AdapterMember` calls this to turn each hub event into the
one plain-text line it will ``adapter.send`` to a Discord / QQ / Telegram /
Feishu channel — or ``None`` when that event should not surface on chat at all.

The rendering policy (M7 §3) keeps chat channels quiet and leak-free:

* ``narrative`` from the KP -> its text (markdown is fine on Discord).
* ``narrative`` from an NPC -> a localized bold-name line (``rooms.chat.npc_line``).
* ``narrative`` from a player (and the raw ``player_action`` echo) -> ``None``:
  the origin channel already shows the player's own message, and other chat
  channels do not need every keystroke echoed (the KP narration carries the
  story). Terminals still render player lines via their own renderer.
* ``narrative`` from the system -> its text.
* ``dice`` -> a localized one-liner (``rooms.chat.dice_line``) built ONLY from
  the public roll fields (actor / expr / total / rank-derived level); it never
  reads keeper-only data, matching the wire protocol's dice-secrecy guarantee.
* ``state`` / ``presence`` -> ``None``: a per-turn panel is too heavy for chat
  (a compact status is Phase 3 / on ``.st``), and chat platforms do not need
  join/leave spam.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from core.dice_engine import coc_rank_label

if TYPE_CHECKING:
    from gateway.hub import Event
    from infra.i18n import I18n


def render_chat_event(event: Event, i18n: I18n) -> str | None:
    """Render ``event`` into one chat line, or ``None`` to send nothing."""
    if event.kind == "narrative":
        return _render_narrative(event, i18n)
    if event.kind == "dice":
        return _render_dice(event, i18n)
    # player_action / state / presence never surface on chat (see module docstring).
    return None


def _render_narrative(event: Event, i18n: I18n) -> str | None:
    if event.speaker == "kp" or event.speaker == "system":
        return event.text or None
    if event.speaker == "npc":
        name = event.name or i18n.t("rooms.chat.npc_unknown")
        return i18n.t("rooms.chat.npc_line", name=name, text=event.text)
    # speaker == "player": the channel already shows it (see module docstring).
    return None


def _render_dice(event: Event, i18n: I18n) -> str | None:
    """One public dice line — actor / expr / total, plus a rank-derived level
    when the roll carried a COC success rank. Never touches keeper data."""
    data = event.data
    actor = str(data.get("actor", "")).strip()
    expr = str(data.get("expr", "")).strip()
    total = data.get("total", "")
    rank = data.get("rank")
    if rank is not None:
        level = coc_rank_label(int(rank), i18n)
        return i18n.t("rooms.chat.dice_line", actor=actor, expr=expr, level=level, total=total)
    return i18n.t("rooms.chat.dice_line_plain", actor=actor, expr=expr, total=total)
