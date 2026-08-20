"""AI-KP tools for AI-played, knowledge-scoped NPC sub-actors (`docs/specs/M5.md` §4).

`NpcTools` is the function-calling surface over `agent.npc` (document-backed CRUD) and
`agent.npc_actor.voice_npc` (the actual in-character sub-actor call). The tool bodies here never
build an NPC's prompt themselves -- `speak_as_npc` resolves the `agent.npc.NpcRecord` and hands it
straight to `voice_npc`, which is the ONLY place that record's fields get woven into an LLM call (see
that module's docstring for the information-isolation contract this whole feature rests on).

Iron rule (repeated at the tool level so the model sees it at the exact point it might reach for
`speak_as_npc`): the NPC actor only performs (dialogue + action intent + mood). It never rolls dice or
invents world facts -- the KP narrates the returned line and adjudicates any resulting mechanics
itself via the existing dice/check tools, exactly as `docs/specs/M5.md` §5 describes.

Channel split (`speak_as_npc`): the line the room reads is what the tool EMITS through
`AgentCtx.emit_npc_line` on its success path -- `gateway.turn._npc_events` builds the `npc` narrative
frame from that structural record, never from the tool's return string (so a refusal or an error
can never be spoken as the NPC) -- and it carries the performance only (name + mood + dialogue). The
sub-actor's `action_intent` is its private plan, usually the very thing the dialogue conceals; it is
parked on the keeper-only `note` surface instead (`_park_action_intent`), never on the quotable line.

`get_npc`/`list_npcs` are `keeper_only` (they surface `secret_agenda` and full `knowledge`, matching
`agent.kp_tools_knowledge`'s convention of prefixing keeper-only bodies with a localized banner so the
model is reminded at the exact point it reads secret material). Every other tool here returns
player-safe confirmations only. Every user-visible string is looked up via `services.i18n` under the
`npc.tools.*` sub-namespace (`locales/{en,zh}/npc.json`); NPC persona/knowledge/names are game DATA
supplied by the caller at runtime, not string literals in this module, so they need no i18n treatment
of their own (same convention `core.character_manager`/`agent.kp_tools_knowledge` already use).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from agent import npc as npc_records
from agent.context import AgentCtx
from agent.npc import NpcRecord
from agent.npc_actor import voice_npc
from agent.services import Services
from agent.tools import tool
from core.documents import KEEPER_VIEWER, MODULE_POOL_ID
from infra.i18n import I18n

# `update_npc`'s allowed field names: plain string/optional-string/bool fields only -- `knowledge`
# and `relationships` are structured and have their own dedicated tools (`set_npc_knowledge`,
# `npc_learns`); `name`/`id` are identity and never mutated in place.
_UPDATABLE_FIELDS = {
    "persona",
    "style",
    "public_description",
    "secret_agenda",
    "disposition",
    "location",
    "status",
    "stat_char",
    "major",
}
_TRUTHY_STRINGS = {"true", "1", "yes", "y", "on"}

# Where `speak_as_npc` parks a sub-actor's private `action_intent`: its own keeper-only
# `note` category (see `NpcTools._park_action_intent`), capped so an always-on per-line
# write cannot grow one document without bound over a long campaign.
_INTENT_NOTE_CATEGORY = "npc_intents"
_INTENT_NOTE_KEEP = 20


def _split_knowledge(text: str) -> list[str]:
    """Split a comma/newline-separated facts string into a cleaned list of discrete facts."""
    if not text:
        return []
    return [part.strip() for part in re.split(r"[,\n]+", text) if part.strip()]


def _coerce_field_value(field: str, value: str) -> Any:
    if field == "major":
        return value.strip().lower() in _TRUTHY_STRINGS
    return value


def _render_npc_detail(i18n: I18n, record: NpcRecord) -> str:
    lines = [
        i18n.t("npc.tools.detail.header", name=record.name, id=record.id),
        i18n.t("npc.tools.detail.persona_line", persona=record.persona or i18n.t("common.none")),
        i18n.t("npc.tools.detail.style_line", style=record.style or i18n.t("common.none")),
        i18n.t(
            "npc.tools.detail.public_description_line",
            description=record.public_description or i18n.t("common.none"),
        ),
        i18n.t("npc.tools.detail.secret_agenda_line", secret_agenda=record.secret_agenda or i18n.t("common.none")),
        i18n.t("npc.tools.detail.disposition_line", disposition=record.disposition),
        i18n.t("npc.tools.detail.location_line", location=record.location or i18n.t("common.unknown")),
        i18n.t("npc.tools.detail.status_line", status=record.status or i18n.t("common.none")),
        i18n.t(
            "npc.tools.detail.major_line",
            major=i18n.t("common.yes") if record.major else i18n.t("common.no"),
        ),
    ]
    if record.stat_char:
        lines.append(i18n.t("npc.tools.detail.stat_char_line", stat_char=record.stat_char))
    if record.knowledge:
        lines.append(i18n.t("npc.tools.detail.knowledge_header", count=len(record.knowledge)))
        lines.extend(f"  - {fact}" for fact in record.knowledge)
    else:
        lines.append(i18n.t("npc.tools.detail.knowledge_empty"))
    return "\n".join(lines)


def player_name_refusal(i18n: I18n, exc: npc_records.PlayerNameReservedError) -> str:
    """The localized answer to `agent.npc.PlayerNameReservedError` — one text for every
    entry point that can hit it (NPC tools, `add_companion`, a card imported as companion)."""
    return i18n.t("npc.tools.create.name_is_player", name=exc.name)


def keeper_npc_refusal(i18n: I18n, exc: npc_records.KeeperNpcNameTakenError) -> str:
    """The localized answer to `agent.npc.KeeperNpcNameTakenError` — one text for every
    door that can create a companion (`add_companion`, `.party add`, a card imported as
    companion)."""
    return i18n.t("npc.tools.create.name_is_npc", name=exc.name)


class NpcTools:
    """AI-KP tools for creating/updating AI-played NPCs and delegating their in-character turns."""

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool(prep_only=True)
    async def create_npc(
        self,
        ctx: AgentCtx,
        name: str,
        persona: str = "",
        description: str = "",
        secret_agenda: str = "",
        knowledge: str = "",
        disposition: str = "neutral",
        location: str = "",
        major: bool = True,
    ) -> str:
        """Create a new AI-played NPC, scoped to this room, seeding the WHOLE record in this one
        call -- pass persona, secret_agenda, knowledge, disposition and location together here
        rather than chaining update_npc/set_npc_knowledge afterwards. Re-creating an existing name
        returns that record untouched (never a duplicate). Only major NPCs need this + speak_as_npc;
        voice trivial/one-line NPCs yourself inline instead of creating a record for every extra.

        Args:
            name: The NPC's name (their id is derived from it, deduplicated per room).
            persona: Who they are -- voice, mannerisms, goals.
            description: What players can openly see/know about them.
            secret_agenda: The NPC's own private goal/secret (never auto-shown to players).
            knowledge: Comma- or newline-separated discrete facts this NPC currently knows -- their
                whole epistemic world; they will never be able to reveal anything outside this list.
            disposition: Attitude toward the party.
            location: Where the NPC currently is.
            major: Whether this NPC gets the AI actor (True) vs. is voiced inline by you (False).

        Returns:
            Confirmation naming the created NPC and its resolved id.
        """
        i18n = self._i18n(ctx)
        try:
            npc = await npc_records.create_npc(
                self._services.documents,
                ctx.chat_key,
                name,
                persona=persona,
                public_description=description,
                secret_agenda=secret_agenda,
                knowledge=_split_knowledge(knowledge),
                disposition=disposition,
                location=location,
                major=major,
            )
            return i18n.t("npc.tools.create.done", name=npc.name, id=npc.id)
        except npc_records.PlayerNameReservedError as exc:
            return player_name_refusal(i18n, exc)
        except Exception as exc:
            return i18n.t("npc.tools.create.failed", error=str(exc))

    @tool
    async def sketch_npc(self, ctx: AgentCtx, name: str, one_line: str) -> str:
        """Improvise an NPC on the spot in one line, so you can immediately speak_as_npc them.
        For the shopkeeper the players just walked up to. Use create_npc instead when you are
        writing a module-grade character with secrets and knowledge.

        Args:
            name: The NPC's name.
            one_line: Who they are in one line -- voice, manner, what they want.

        Returns:
            Confirmation naming the sketched NPC and its resolved id.
        """
        # The light counterpart to `create_npc` (M20 B). It is not a convenience: without a
        # record `speak_as_npc` returns not_found, and no record means no knowledge-scoped
        # actor -- so an improvised NPC's private knowledge would have no structural home
        # at all (iron rule #3). Facts they learn later arrive through `npc_learns`.
        i18n = self._i18n(ctx)
        try:
            npc = await npc_records.create_npc(
                self._services.documents, ctx.chat_key, name, persona=one_line, major=True
            )
            return i18n.t("npc.tools.create.done", name=npc.name, id=npc.id)
        except npc_records.PlayerNameReservedError as exc:
            return player_name_refusal(i18n, exc)
        except Exception as exc:
            return i18n.t("npc.tools.create.failed", error=str(exc))

    @tool(prep_only=True)
    async def import_module_npcs(self, ctx: AgentCtx) -> str:
        """Seed NPC sub-actors from the module's already-analyzed keeper pool (one per npcs[] entry).
        NPCs whose name already exists in this room are left untouched.

        Returns:
            Confirmation summarizing how many NPCs were imported vs. already present.
        """
        i18n = self._i18n(ctx)
        try:
            pools = await self._services.documents.get_view(
                ctx.chat_key, "module_pool", MODULE_POOL_ID, KEEPER_VIEWER
            )
            keeper_pool = (pools or {}).get("keeper")
            if not keeper_pool:
                return i18n.t("npc.tools.import.no_pool")

            entries = keeper_pool.get("npcs") or []
            if not entries:
                return i18n.t("npc.tools.import.empty")

            existing_names = {record.name.strip().lower() for record in await npc_records.list_npcs(self._services.documents, ctx.chat_key)}
            imported: list[str] = []
            skipped: list[str] = []
            refused: list[str] = []
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name", "")).strip()
                if not name:
                    continue
                if name.lower() in existing_names:
                    skipped.append(name)
                    continue

                try:
                    await npc_records.create_npc(self._services.documents,
                        ctx.chat_key,
                        name,
                        public_description=str(entry.get("description", "")),
                        secret_agenda=str(entry.get("secret", "")),
                        role=str(entry.get("role", "")),
                    )
                except npc_records.PlayerNameReservedError as exc:
                    # A module NPC who is also one of its claimable pregens (or already
                    # a player's PC) is a player, not an NPC: skipped, and said so.
                    refused.append(player_name_refusal(i18n, exc))
                    continue
                existing_names.add(name.lower())
                imported.append(name)

            summary = i18n.t(
                "npc.tools.import.done",
                count=len(imported),
                names=", ".join(imported) if imported else i18n.t("common.none"),
                skipped=len(skipped),
            )
            return "\n".join([summary, *refused])
        except Exception as exc:
            return i18n.t("npc.tools.import.failed", error=str(exc))

    @tool(prep_only=True)
    async def set_npc_knowledge(self, ctx: AgentCtx, npc: str, facts: str, mode: str = "add") -> str:
        """Set or append what an NPC currently knows -- their whole epistemic world; they cannot
        reveal or act on anything outside this list.

        Args:
            npc: The NPC's name or id.
            facts: Comma- or newline-separated discrete facts.
            mode: "add" appends to their existing knowledge; "replace" overwrites it entirely.

        Returns:
            Confirmation with the NPC's new fact count, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            record = await npc_records.add_knowledge(self._services.documents, ctx.chat_key, npc, _split_knowledge(facts), mode=mode)
            if record is None:
                return i18n.t("npc.tools.not_found", npc=npc)
            return i18n.t("npc.tools.knowledge.done", name=record.name, count=len(record.knowledge))
        except Exception as exc:
            return i18n.t("npc.tools.knowledge.failed", error=str(exc))

    @tool
    async def npc_learns(self, ctx: AgentCtx, npc: str, fact: str) -> str:
        """Have an NPC learn exactly one new fact during play (appended to their knowledge).

        Args:
            npc: The NPC's name or id.
            fact: The single fact they just learned.

        Returns:
            Confirmation, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            record = await npc_records.npc_learns(self._services.documents, ctx.chat_key, npc, fact)
            if record is None:
                return i18n.t("npc.tools.not_found", npc=npc)
            return i18n.t("npc.tools.learns.done", name=record.name, fact=fact)
        except Exception as exc:
            return i18n.t("npc.tools.learns.failed", error=str(exc))

    @tool
    async def set_npc_disposition(self, ctx: AgentCtx, npc: str, disposition: str) -> str:
        """Set an NPC's attitude toward the party.

        Args:
            npc: The NPC's name or id.
            disposition: The new disposition (free text, e.g. "hostile", "friendly but wary").

        Returns:
            Confirmation, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            record = await npc_records.set_disposition(self._services.documents, ctx.chat_key, npc, disposition)
            if record is None:
                return i18n.t("npc.tools.not_found", npc=npc)
            return i18n.t("npc.tools.disposition.done", name=record.name, disposition=record.disposition)
        except Exception as exc:
            return i18n.t("npc.tools.disposition.failed", error=str(exc))

    @tool
    async def move_npc(self, ctx: AgentCtx, npc: str, location: str) -> str:
        """Move an NPC to a new location.

        Args:
            npc: The NPC's name or id.
            location: The NPC's new location.

        Returns:
            Confirmation, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            record = await npc_records.move_npc(self._services.documents, ctx.chat_key, npc, location)
            if record is None:
                return i18n.t("npc.tools.not_found", npc=npc)
            return i18n.t("npc.tools.move.done", name=record.name, location=record.location)
        except Exception as exc:
            return i18n.t("npc.tools.move.failed", error=str(exc))

    @tool(prep_only=True)
    async def update_npc(self, ctx: AgentCtx, npc: str, field: str, value: str) -> str:
        """Update a single field on an NPC record: persona/style/public_description/secret_agenda/
        disposition/location/status/stat_char/major. For knowledge, use set_npc_knowledge/npc_learns
        instead.

        Args:
            npc: The NPC's name or id.
            field: Which field to update.
            value: The new value (for major, any of true/false/yes/no/1/0).

        Returns:
            Confirmation, or a not-found/unsupported-field message.
        """
        i18n = self._i18n(ctx)
        if field not in _UPDATABLE_FIELDS:
            return i18n.t("npc.tools.update.bad_field", field=field, allowed=", ".join(sorted(_UPDATABLE_FIELDS)))
        try:
            record = await npc_records.update_npc(self._services.documents, ctx.chat_key, npc, **{field: _coerce_field_value(field, value)})
            if record is None:
                return i18n.t("npc.tools.not_found", npc=npc)
            return i18n.t("npc.tools.update.done", name=record.name, field=field, value=value)
        except Exception as exc:
            return i18n.t("npc.tools.update.failed", error=str(exc))

    async def _park_action_intent(self, i18n: I18n, chat_key: str, name: str, action_intent: str) -> None:
        """Record one NPC's private `action_intent` on the keeper-only note surface.

        `note` documents project to `None` for every non-keeper viewer
        (`core.documents._project_note`), which makes this the one place the staging
        information can be kept without it becoming quotable. The session key-event log is
        deliberately NOT used: `.report` renders every key event and is a level-0,
        room-broadcast command, so an intent parked there would leak on the next export.

        Written under its own `_INTENT_NOTE_CATEGORY` rather than the model's `npc_status`
        notebook so an automatic per-line write never crowds the keeper's own curated
        entries out of the prompt's game-state block; the KP reads them back on demand with
        `kp_note('list', ...)`. Best-effort: the NPC's line already succeeded, and losing a
        staging note must never turn into a failed performance.
        """
        try:
            documents = self._services.documents
            doc = await documents.get(chat_key, "note", _INTENT_NOTE_CATEGORY)
            stored = doc.data.get("content") if doc is not None else None
            entries = list(stored) if isinstance(stored, list) else []
            entries.append(
                {
                    "time": datetime.now().strftime("%Y-%m-%d %H:%M"),
                    "content": i18n.t("npc.tools.speak.intent_note", name=name, action_intent=action_intent),
                }
            )
            await documents.put(
                chat_key,
                "note",
                _INTENT_NOTE_CATEGORY,
                {"category": _INTENT_NOTE_CATEGORY, "content": entries[-_INTENT_NOTE_KEEP:]},
            )
        except Exception:
            pass  # best-effort keeper-side staging note only -- see the docstring above

    @tool
    async def speak_as_npc(
        self,
        ctx: AgentCtx,
        npc: str,
        situation: str,
        allowed_actions: str = "",
        tone: str = "",
        target: str = "",
        effort: str = "medium",
    ) -> str:
        """Delegate one NPC's in-character line to their knowledge-scoped AI sub-actor. The sub-actor
        sees ONLY this NPC's own persona/knowledge -- never the keeper pool or other NPCs' secrets --
        so it structurally cannot leak or act on information this NPC doesn't have. Weave the returned
        line into your narration yourself; the actor never rolls dice or invents world facts, so
        adjudicate any resulting mechanics via the normal dice/check tools.

        Args:
            npc: The NPC's name or id.
            situation: What is happening right now, from this NPC's point of view.
            allowed_actions: Optional constraint on what the NPC may do right now.
            tone: Optional tone hint (e.g. "nervous", "defiant").
            target: Optional name of who the NPC is speaking/reacting to.
            effort: The line's dramatic weight, which sets the sub-actor's thinking depth --
                "low" for routine/filler lines, "medium" (default) for normal beats, "high"
                for confessions, climaxes, and lines that must thread a secret.

        Returns:
            The NPC's spoken line and mood, for you to weave into the scene. Their private
            action intent is NOT in it -- it goes to your `npc_intents` notes, since the
            players read this line as-is; pull it with kp_note('list', 'npc_intents') when
            you need to adjudicate what the NPC does next.
        """
        i18n = self._i18n(ctx)
        try:
            record = await npc_records.get_npc(self._services.documents, ctx.chat_key, npc)
            if record is None:
                return i18n.t("npc.tools.not_found", npc=npc)

            voiced = await voice_npc(
                self._services,
                record,
                situation,
                allowed_actions=allowed_actions,
                tone=tone,
                target=target,
                locale=ctx.locale,
                # M12 card compatibility: card-derived record prose renders at consumption time
                # against the PLAYER view of this room's variables ({{user}} = the acting
                # player's active character). See agent.card_text.
                chat_key=ctx.chat_key,
                user_uid=ctx.uid(),
                effort=effort,
            )
            dialogue = voiced.get("dialogue", "")
            mood = voiced.get("mood", "")
            action_intent = voiced.get("action_intent", "")

            # This line IS what the room hears: it is EMITTED through the structural channel
            # (`ctx.emit_npc_line`) and `gateway.turn._npc_events` builds the `npc` narrative
            # frame from that -- never from this tool's return string, so a failure path
            # (the `not_found` / `failed` returns above and below) can never be spoken as
            # the NPC. Only PERFORMED material belongs in it -- the words spoken and the
            # affect they were spoken with. The sub-actor's `action_intent` is the opposite:
            # what the NPC privately means to do NEXT, routinely the very thing the dialogue
            # is concealing. It goes to the keeper-only note surface instead
            # (`_park_action_intent`).
            line = i18n.t(
                "npc.tools.speak.line",
                name=record.name,
                mood=mood or i18n.t("npc.tools.speak.mood_unset"),
                dialogue=dialogue,
            )
            ctx.emit_npc_line(record.name, line)
            if action_intent:
                await self._park_action_intent(i18n, ctx.chat_key, record.name, action_intent)

            return line
        except Exception as exc:
            return i18n.t("npc.tools.speak.failed", error=str(exc))

    @tool(keeper_only=True, read_only=True)
    async def get_npc(self, ctx: AgentCtx, npc: str) -> str:
        """Get an NPC's full record, INCLUDING secret_agenda and knowledge (KEEPER-ONLY -- for your
        own reasoning, never quote raw to players).

        Args:
            npc: The NPC's name or id.

        Returns:
            The NPC's full field-by-field detail.
        """
        i18n = self._i18n(ctx)
        try:
            record = await npc_records.get_npc(self._services.documents, ctx.chat_key, npc)
            if record is None:
                return i18n.t("npc.tools.not_found", npc=npc)
            return f"{i18n.t('npc.tools.keeper_banner')}\n\n{_render_npc_detail(i18n, record)}"
        except Exception as exc:
            return i18n.t("npc.tools.get.failed", error=str(exc))

    @tool(keeper_only=True, read_only=True)
    async def list_npcs(self, ctx: AgentCtx) -> str:
        """List every NPC in this room, INCLUDING secrets (KEEPER-ONLY -- for your own reasoning,
        never quote raw to players).

        Returns:
            A roster with each NPC's name/location/disposition/major flag.
        """
        i18n = self._i18n(ctx)
        try:
            records = await npc_records.list_npcs(self._services.documents, ctx.chat_key)
            banner = i18n.t("npc.tools.keeper_banner")
            if not records:
                return f"{banner}\n\n{i18n.t('npc.tools.list.empty')}"

            lines = [i18n.t("npc.tools.list.header", count=len(records))]
            for record in records:
                lines.append(
                    i18n.t(
                        "npc.tools.list.item",
                        name=record.name,
                        id=record.id,
                        location=record.location or i18n.t("common.unknown"),
                        disposition=record.disposition,
                        major=i18n.t("common.yes") if record.major else i18n.t("common.no"),
                    )
                )
            return f"{banner}\n\n" + "\n".join(lines)
        except Exception as exc:
            return i18n.t("npc.tools.list.failed", error=str(exc))
