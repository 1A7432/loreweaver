"""The HTML session report ("团报") export: gather, render, store, announce (protocol 2.4).

`.report html` (any member) and `.report html reveal` (a keeper-key connection only) both
end up here. Zero model calls: the page is `core.report_html` over engine records.

What each edition reads, and through which door:

- **player** — the session's dice ledgers (`core.battle_report`, hidden `.rh` rolls
  filtered by the renderer) and the room's conversation (`agent.history.load_chain`).
  No document is read at all, so there is nothing keeper-grade it could pick up.
- **reveal** — the player edition plus keeper-grade views, every one of them obtained
  through `core.documents.project` with `KEEPER_VIEWER` (`get_view`/`list_views`). Where
  "what was hidden" has to be decided — keeper-only variables, unexposed card leaves,
  NPC fields, clues never unlocked — it is decided by DIFFING the keeper projection
  against the player projection of the same document, never by reading a secrecy flag
  off a raw document. The hidden rolls are the one non-document input: they are the
  `hidden` entries of the same session ledger the player edition filters.

Delivery: the page is stored as an UNLISTED room blob (`infra.media_store`, audience
`members` for the player edition, `keeper` for the reveal) and announced by a `report`
frame attached as a PRIVATE command event — so it reaches the issuing connection only,
is never broadcast, never lands in the media history a join replays, and a reveal hash
fetched by a player connection is `media_not_found`. The local CLI has no byte channel:
the page is written to the shared reports path instead.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, load_chain
from agent.kp_tools_knowledge import resolve_report_record
from agent.services import Services
from core.chronicle import CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, CHRONICLE_DOC_TYPE
from core.documents import KEEPER_VIEWER, MODULE_POOL_ID, MODVARS_ID, MVU_ID, PLAYER_VIEWER
from core.modvars import wire_entries
from core.report_html import EDITION_PLAYER, EDITION_REVEAL, ReportHeader, RevealSections, render_report_html
from infra.i18n import I18n
from infra.media_store import (
    ALLOWED_IMAGE_MIMES,
    AUDIENCE_KEEPER,
    AUDIENCE_MEMBERS,
    REPORT_MIME,
    MediaStore,
)

REPORT_FRAME_TYPE = "report"
# NPC record fields that are keeper-grade when — and only when — the player projection
# of the same record does not carry them (`core.documents._project_npc`).
_NPC_SECRET_FIELDS = ("secret_agenda", "knowledge")


@dataclass(frozen=True)
class BuiltReport:
    html: str
    name: str
    variant: str


def _room_label(chat_key: str) -> str:
    """The human part of a room key (``tui:group:<room>`` → ``<room>``)."""
    return chat_key.split(":", 2)[-1] if chat_key.count(":") >= 2 else chat_key


def _system_label(pack: Any) -> str:
    names = [str(name) for name in getattr(pack, "names", []) or [] if str(name).strip()]
    if names:
        return max(names, key=len)
    return str(getattr(pack, "system", "") or "")


def _file_name(room: str, variant: str, moment: datetime) -> str:
    slug = re.sub(r"[^\w-]+", "-", room, flags=re.UNICODE).strip("-_")[:40] or "room"
    suffix = "-reveal" if variant == EDITION_REVEAL else ""
    return f"loreweaver-report-{slug}-{moment.strftime('%Y%m%d-%H%M%S')}{suffix}.html"


async def _reveal_sections(services: Services, chat_key: str, record: Any, locale: str) -> RevealSections:
    """The keeper-grade material, every document read through a KEEPER projection."""
    documents = services.documents

    margins = [
        {"turn": view.get("turn", 0), "text": view.get("text", ""), "keeper": view.get("keeper", "")}
        for _doc, view in await documents.list_views(chat_key, CHRONICLE_DOC_TYPE, KEEPER_VIEWER)
    ]
    summary = await documents.get_view(chat_key, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, KEEPER_VIEWER)
    summary_margin = str((summary or {}).get("keeper", "") or "")

    module: dict[str, list[dict[str, Any]]] | None = None
    pool = await documents.get_view(chat_key, "module_pool", MODULE_POOL_ID, KEEPER_VIEWER)
    if pool is not None:
        keeper_half = pool.get("keeper") if isinstance(pool.get("keeper"), dict) else {}
        player_half = await documents.get_view(chat_key, "module_pool", MODULE_POOL_ID, PLAYER_VIEWER) or {}
        unlocked = {
            str(clue.get("name", "")).casefold()
            for clue in player_half.get("clues") or []
            if isinstance(clue, dict)
        }

        def items(key: str) -> list[dict[str, Any]]:
            return [item for item in keeper_half.get(key) or [] if isinstance(item, dict)]

        module = {
            "truths": items("truths"),
            "threats": items("threats"),
            "clues": [clue for clue in items("clues") if str(clue.get("name", "")).casefold() not in unlocked],
            "npcs": [
                {"name": npc.get("name", ""), "secret": npc.get("secret", "")}
                for npc in items("npcs")
                if str(npc.get("secret", "") or "").strip()
            ],
        }

    player_npcs = {doc.id: view for doc, view in await documents.list_views(chat_key, "npc", PLAYER_VIEWER)}
    npc_secrets: list[dict[str, Any]] = []
    for doc, view in await documents.list_views(chat_key, "npc", KEEPER_VIEWER):
        public = player_npcs.get(doc.id, {})
        hidden = {key: view.get(key) for key in _NPC_SECRET_FIELDS if key in view and key not in public}
        knowledge = hidden.get("knowledge")
        npc_secrets.append(
            {
                "name": view.get("name", doc.id),
                "secret": str(hidden.get("secret_agenda", "") or ""),
                "knowledge": [str(fact) for fact in knowledge] if isinstance(knowledge, list) else [],
            }
        )

    keeper_vars: list[dict[str, Any]] = []
    keeper_modvars = await documents.get_view(chat_key, "modvars", MODVARS_ID, KEEPER_VIEWER)
    if keeper_modvars is not None:
        player_modvars = await documents.get_view(chat_key, "modvars", MODVARS_ID, PLAYER_VIEWER) or {}
        public_ids = set((player_modvars.get("specs") or {}).keys())
        keeper_vars = [
            {"label": entry["label"], "value": entry["value"]}
            for entry in wire_entries(keeper_modvars, locale)
            if entry["id"] not in public_ids
        ]

    hidden_leaves: list[dict[str, Any]] = []
    keeper_mvu = await documents.get_view(chat_key, "mvu_tree", MVU_ID, KEEPER_VIEWER)
    if keeper_mvu is not None:
        player_mvu = await documents.get_view(chat_key, "mvu_tree", MVU_ID, PLAYER_VIEWER) or {}
        public_paths = {leaf.get("path") for leaf in player_mvu.get("leaves") or [] if isinstance(leaf, dict)}
        hidden_leaves = [
            {"path": leaf.get("path", ""), "value": leaf.get("value")}
            for leaf in keeper_mvu.get("leaves") or []
            if isinstance(leaf, dict) and leaf.get("path") not in public_paths
        ]

    return RevealSections(
        hidden_rolls=[roll for roll in record.dice_rolls if roll.get("hidden")],
        chronicle_margins=margins,
        summary_margin=summary_margin,
        module=module,
        npc_secrets=npc_secrets,
        keeper_vars=keeper_vars,
        hidden_leaves=hidden_leaves,
    )


async def build_report_html(
    services: Services, ctx: AgentCtx, i18n: I18n, *, reveal: bool
) -> BuiltReport | None:
    """Render one edition, or ``None`` when the room has no session to report.

    ``reveal`` is NOT an authorization: the caller (`.report html reveal`) gates it on the
    connection's keeper role BEFORE calling."""
    resolved = await resolve_report_record(services, ctx.chat_key, i18n)
    if resolved is None:
        return None
    record, name = resolved
    transcript = await load_chain(services, ctx.chat_key, DEFAULT_HISTORY_KEY)
    pack = await services.room_rulepack(ctx)
    now = time.time()
    room = _room_label(ctx.chat_key)
    header = ReportHeader(
        session_name=name,
        room=room,
        system=_system_label(pack),
        start_time=record.start_time,
        end_time=record.end_time,
        generated_at=now,
    )
    sections = await _reveal_sections(services, ctx.chat_key, record, i18n.locale) if reveal else None
    html = render_report_html(
        record,
        services.battles.generator,
        header=header,
        transcript=transcript,
        i18n=i18n,
        reveal=sections,
    )
    variant = EDITION_REVEAL if reveal else EDITION_PLAYER
    return BuiltReport(html=html, name=_file_name(room, variant, datetime.fromtimestamp(now)), variant=variant)


def report_media_store(services: Services) -> MediaStore:
    tui = services.settings.tui
    return MediaStore(
        services.store,
        services.settings.data_dir,
        max_file_bytes=tui.media_max_file_bytes,
        room_quota_bytes=tui.media_room_quota_bytes,
        allowed_mimes=ALLOWED_IMAGE_MIMES,
    )


async def store_report(services: Services, chat_key: str, built: BuiltReport, *, uploader: str) -> dict[str, Any]:
    """Index the page as an UNLISTED blob of `chat_key` and return its `report` frame.

    Raises `infra.media_store.MediaError` (``media_too_large`` /
    ``media_quota_exceeded`` …) when the room's media limits refuse it: a report
    counts against the image quota like every other server-made picture."""
    tui = services.settings.tui
    data = built.html.encode("utf-8")
    record = await report_media_store(services).register_server_blob(
        room=chat_key,
        data=data,
        mime=REPORT_MIME,
        name=built.name,
        uploader=uploader,
        audience=AUDIENCE_KEEPER if built.variant == EDITION_REVEAL else AUDIENCE_MEMBERS,
        max_file_bytes=tui.media_max_file_bytes,
        room_quota_bytes=tui.media_room_quota_bytes,
    )
    return {
        "type": REPORT_FRAME_TYPE,
        "hash": record.hash,
        "name": record.name,
        "size": record.size,
        "mime": REPORT_MIME,
        "variant": built.variant,
    }
