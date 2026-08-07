"""The chronicle KP tools (M18) — `record_chronicle` / `update_thread`.

The chronicle recorder is its own provider (spec: no scribe changes — a later
design may unify them). `record_chronicle` appends a PAST-only narrative record
(events, decisions, consequences — what the table DID, never what it will do);
its public text is player-facing, its `keeper_notes` margin never crosses
`project()`. `update_thread` maintains the open-loops tracker (structured
`status` only — the one field the engine nags about; everything else stays
free-form per the kp_note doctrine).
"""

from __future__ import annotations

from agent.chronicle import record_entry
from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from core.chronicle import THREAD_DOC_TYPE, THREAD_STATUSES, thread_id_for
from core.documents import DocumentValidationError


class ChronicleTools:
    """Provider for the M18 campaign-chronicle tools (wired into `build_kp_toolset`)."""

    def __init__(self, services: Services) -> None:
        self._services = services

    @tool
    async def record_chronicle(
        self,
        ctx: AgentCtx,
        text: str,
        keeper_notes: str = "",
        pcs: str = "",
        scene: str = "",
    ) -> str:
        """Record one campaign-chronicle entry: what the table just DID — a decision, consequence, discovery, or scene beat worth remembering across sessions.

        Past-only: the engine stamps the entry with the current turn index —
        record only what has ALREADY happened at the table, never plans or
        expected outcomes. The main text is player-facing (it may surface in the
        players' recap); `keeper_notes` is the keeper-only margin (what the
        players MISSED, which secret consequence is now armed) and is never
        shown to players.

        Args:
            text: the public narrative record of the beat, terse (one stretch of play)
            keeper_notes: optional keeper-only annotations (spoilers allowed here)
            pcs: optional comma-separated character names whose personal arcs this beat belongs to
            scene: optional scene/location label
        """
        i18n = self._services.i18n.with_locale(ctx.locale)
        try:
            doc = await record_entry(
                self._services,
                ctx.chat_key,
                text=text,
                keeper=keeper_notes,
                pcs=[part for part in pcs.split(",")],
                scene=scene,
            )
        except DocumentValidationError as exc:
            return i18n.t("kp_tools.chronicle.record_failed", error="; ".join(exc.violations))
        return i18n.t("kp_tools.chronicle.recorded", id=doc.id, turn=doc.data["turn"])

    @tool
    async def update_thread(self, ctx: AgentCtx, label: str, status: str = "open", notes: str = "") -> str:
        """Open, update, or resolve a campaign thread — an open loop the table must not forget (planted foreshadowing, an unresolved hook, an armed consequence).

        Re-stating an existing label updates that thread (the label is the
        upsert key). Threads are keeper-only; only `status` is structured so the
        engine can nag about stale open loops.

        Args:
            label: the loop's short name
            status: open | resolved
            notes: optional keeper-only detail (omitted keeps the previous notes)
        """
        i18n = self._services.i18n.with_locale(ctx.locale)
        status = status.strip().casefold()
        if status not in THREAD_STATUSES:
            return i18n.t(
                "kp_tools.chronicle.thread_invalid", status=status, vocab=", ".join(sorted(THREAD_STATUSES))
            )
        doc_id = thread_id_for(label)
        existing = await self._services.documents.get(ctx.chat_key, THREAD_DOC_TYPE, doc_id)
        previous_notes = str(existing.data.get("notes", "")) if existing is not None else ""
        try:
            await self._services.documents.put(
                ctx.chat_key,
                THREAD_DOC_TYPE,
                doc_id,
                {"label": label.strip(), "status": status, "notes": notes.strip() or previous_notes},
            )
        except DocumentValidationError as exc:
            return i18n.t("kp_tools.chronicle.thread_invalid", status="; ".join(exc.violations), vocab="")
        return i18n.t("kp_tools.chronicle.thread_updated", label=label.strip(), status=status)
