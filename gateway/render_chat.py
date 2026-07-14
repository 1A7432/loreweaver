"""Chat-transport renderer: a normalized room event -> structured chat message.

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
from gateway.chat import ChatEmbed, ChatField, ChatMessage

if TYPE_CHECKING:
    from gateway.hub import Event
    from infra.i18n import I18n


def render_chat_event(event: Event, i18n: I18n) -> ChatMessage | None:
    """Render ``event`` into a portable message, or ``None`` to stay quiet."""
    if event.kind == "narrative":
        return _render_narrative(event, i18n)
    if event.kind == "player_action":
        return ChatMessage(
            text=i18n.t("rooms.chat.player_line", name=event.name, text=event.text),
            markdown=True,
        )
    if event.kind == "dice":
        return _render_dice(event, i18n)
    if event.kind == "system":
        return ChatMessage(text=event.text, markdown=False)
    if event.kind == "panel":
        return _render_panel(event, i18n)
    if event.kind == "media":
        return ChatMessage(
            text=i18n.t("rooms.chat.media", name=event.data.get("name", "")),
            markdown=False,
        )
    if event.kind == "audio" and event.data.get("type") == "audio_library_item":
        return ChatMessage(
            text=i18n.t("rooms.chat.audio", name=event.data.get("title") or event.data.get("name", "")),
            markdown=False,
        )
    # State is consumed by persistent platform panels; presence stays transport-local.
    return None


def _render_narrative(event: Event, i18n: I18n) -> ChatMessage | None:
    if event.speaker == "kp" or event.speaker == "system":
        return ChatMessage(text=event.text, markdown=event.fmt == "markdown") if event.text else None
    if event.speaker == "npc":
        name = event.name or i18n.t("rooms.chat.npc_unknown")
        return ChatMessage(text=i18n.t("rooms.chat.npc_line", name=name, text=event.text), markdown=True)
    # speaker == "player": the channel already shows it (see module docstring).
    return None


def _render_dice(event: Event, i18n: I18n) -> ChatMessage | None:
    """One public dice line — actor / expr / total, plus a rank-derived level
    when the roll carried a COC success rank. Never touches keeper data."""
    data = event.data
    actor = str(data.get("actor", "")).strip()
    expr = str(data.get("expr", "")).strip()
    total = data.get("total", "")
    rank = data.get("rank")
    if rank is not None:
        level = coc_rank_label(int(rank), i18n)
        text = i18n.t("rooms.chat.dice_line", actor=actor, expr=expr, level=level, total=total)
    else:
        level = ""
        text = i18n.t("rooms.chat.dice_line_plain", actor=actor, expr=expr, total=total)
    fields = [ChatField(i18n.t("rooms.chat.dice.expression"), expr, True)]
    if level:
        fields.append(ChatField(i18n.t("rooms.chat.dice.level"), level, True))
    if data.get("critical_success") is True:
        fields.append(
            ChatField(
                i18n.t("rooms.chat.dice.critical"),
                i18n.t("rooms.chat.dice.critical_success"),
                True,
            )
        )
    elif data.get("critical_failure") is True:
        fields.append(
            ChatField(
                i18n.t("rooms.chat.dice.critical"),
                i18n.t("rooms.chat.dice.critical_failure"),
                True,
            )
        )
    fields.append(ChatField(i18n.t("rooms.chat.dice.total"), str(total), True))

    right = data.get("right")
    if isinstance(right, dict):
        parts = [str(right["name"])] if right.get("name") else []
        if right.get("total") is not None:
            roll = str(right["total"])
            if right.get("target") is not None:
                roll = f"{roll}/{right['target']}"
            parts.append(roll)
        if right.get("rank") is not None:
            parts.append(coc_rank_label(int(right["rank"]), i18n))
        if parts:
            fields.append(
                ChatField(i18n.t("rooms.chat.dice.opposed_right"), " · ".join(parts), False)
            )

    winner = data.get("winner")
    if winner in {"left", "right", "tie"}:
        fields.append(
            ChatField(
                i18n.t("rooms.chat.dice.winner"),
                i18n.t(f"rooms.chat.dice.winner.{winner}"),
                True,
            )
        )

    if data.get("loss") is not None:
        fields.append(ChatField(i18n.t("rooms.chat.dice.san_loss"), str(data["loss"]), True))
    if data.get("remaining") is not None:
        fields.append(
            ChatField(i18n.t("rooms.chat.dice.san_remaining"), str(data["remaining"]), True)
        )
    return ChatMessage(
        text=text,
        markdown=False,
        embeds=[ChatEmbed(title=i18n.t("rooms.chat.dice.title", actor=actor), fields=tuple(fields), color=0x5865F2)],
    )


def _render_panel(event: Event, i18n: I18n) -> ChatMessage:
    data = event.data
    fields: list[ChatField] = []
    character = data.get("character")
    if isinstance(character, dict):
        fields.append(
            ChatField(
                i18n.t("rooms.chat.panel.character"),
                _with_vitals(str(character.get("name") or "-"), character),
                False,
            )
        )
    party = data.get("party") or []
    if party:
        fields.append(
            ChatField(
                i18n.t("rooms.chat.panel.party"),
                "\n".join(
                    _with_vitals(str(item.get("name") or "-"), item)
                    for item in party
                    if isinstance(item, dict)
                ),
                False,
            )
        )
    initiative = data.get("initiative") or []
    if initiative:
        fields.append(
            ChatField(
                i18n.t("rooms.chat.panel.initiative"),
                "\n".join(
                    f"{item.get('name', '-')} · {item.get('value', 0)}"
                    for item in initiative
                    if isinstance(item, dict)
                ),
                False,
            )
        )
    scene = data.get("scene")
    if scene:
        if isinstance(scene, dict):
            scene_text = "\n".join(
                str(value) for value in (scene.get("name"), scene.get("focus")) if value
            )
        else:
            scene_text = str(scene)
        fields.append(ChatField(i18n.t("rooms.chat.panel.scene"), scene_text or "-", False))
    clock = data.get("clock")
    if clock:
        clock_text = str(clock.get("time") or "-") if isinstance(clock, dict) else str(clock)
        fields.append(ChatField(i18n.t("rooms.chat.panel.clock"), clock_text, True))
    usage = data.get("usage")
    if isinstance(usage, dict):
        fields.append(
            ChatField(
                i18n.t("rooms.chat.panel.usage"),
                f"{usage.get('context_tokens', 0)}/{usage.get('context_window', 0)} · "
                f"{usage.get('input_tokens', 0)}+{usage.get('output_tokens', 0)}",
                True,
            )
        )
    return ChatMessage(
        text=i18n.t("rooms.chat.panel.fallback", online=data.get("online", 0)),
        markdown=True,
        embeds=[ChatEmbed(title=i18n.t("rooms.chat.panel.title"), fields=tuple(fields), color=0x2B2D31)],
        private=event.private,
        coalesce_key="panel",
    )


def _with_vitals(name: str, data: dict) -> str:
    vitals = []
    for label, value_key, max_key in (
        ("HP", "hp", "hpmax"),
        ("MP", "mp", "mpmax"),
        ("SAN", "san", "sanmax"),
    ):
        value = data.get(value_key)
        maximum = data.get(max_key) if max_key in data else data.get(f"{value_key}Max")
        if value is not None and maximum is not None:
            vitals.append(f"{label} {value}/{maximum}")
    return f"{name} · {' · '.join(vitals)}" if vitals else name
