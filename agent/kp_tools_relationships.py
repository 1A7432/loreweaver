"""AI-KP tools for deterministic relationship tracks (好感/情欲) between named entities.

`RelationshipTools` is the function-calling surface over `core.relationships.RelationshipManager`:
directional numeric tracks (affection/desire) between any two named entities (PCs, NPCs,
companions) that the KP nudges with `adjust_relationship`/`set_relationship` after a meaningful
beat, and reads back on demand with `get_relationships`. Per iron rule #1 (deterministic vs
generative split), the VALUES themselves are real code -- clamped and persisted here -- the model
only narrates around them; `agent.prompt_builder` separately folds the CURRENT state into the main
KP prompt every turn (the always-on path), so `get_relationships` is only the read-on-demand path.

All three tools are `gated=True` (Layer B.2 -- see `agent.tools.tool` and `docs/plugins.md` "Layer
B"): hidden from the model's toolset and refused on dispatch until a room enables a skill whose
`allowed-tools` names them (e.g. `skills/romance-relationships`). None are `keeper_only` -- these
tracks are not secret keeper material, they're mechanical state like a character sheet. All
user-visible text is looked up via `services.i18n` under `relationships.tools.*`
(`locales/{en,zh}/relationships.json`).
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from core.relationships import TRACKS, RelationshipManager, coerce_int, describe, known_track
from infra.i18n import I18n


class RelationshipTools:
    """AI-KP tools for adjusting/reading deterministic relationship tracks between entities."""

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool(gated=True)
    async def adjust_relationship(
        self, ctx: AgentCtx, subject: str, target: str, track: str, delta: int, reason: str = ""
    ) -> str:
        """Nudge a deterministic relationship track `subject` feels toward `target` by a signed
        delta. Two tracks exist: "affection" (好感, clamps to -100..100) and "desire" (情欲, clamps
        to 0..100). Call this after a meaningful romantic/social beat actually happens in play (a
        kind gesture, a betrayal, a shared danger survived, a flirtation that lands) -- the number
        should inform your narration's tone, never the other way around; dice/checks still resolve
        what actually happens.

        Args:
            subject: The entity whose feeling is being adjusted (a PC/NPC/companion's name).
            target: The entity the feeling is directed toward.
            track: Which track to adjust: "affection" or "desire".
            delta: Signed integer change to apply (e.g. 5, -10).
            reason: Optional free-text note on why, for your own bookkeeping; not required.

        Returns:
            Confirmation with the old and new values, or a validation error naming the problem.
        """
        i18n = self._i18n(ctx)
        if not known_track(track):
            return i18n.t("relationships.tools.bad_track", allowed=", ".join(sorted(TRACKS)))
        parsed_delta = coerce_int(delta)
        if parsed_delta is None:
            return i18n.t("relationships.tools.bad_delta")
        try:
            manager = RelationshipManager(self._services.store)
            old, new = await manager.adjust(ctx.chat_key, subject, target, track, parsed_delta)
            return i18n.t(
                "relationships.tools.adjust.done",
                subject=subject,
                target=target,
                track=i18n.t(TRACKS[track].label_key),
                old=old,
                new=new,
                delta=parsed_delta,
            )
        except Exception as exc:
            return i18n.t("relationships.tools.failed", error=str(exc))

    @tool(gated=True)
    async def set_relationship(self, ctx: AgentCtx, subject: str, target: str, track: str, value: int) -> str:
        """Set a deterministic relationship track to an exact value (rather than nudging it by a
        delta). Two tracks exist: "affection" (好感, clamps to -100..100) and "desire" (情欲,
        clamps to 0..100).

        Args:
            subject: The entity whose feeling is being set (a PC/NPC/companion's name).
            target: The entity the feeling is directed toward.
            track: Which track to set: "affection" or "desire".
            value: The exact value to store (clamped to the track's valid range).

        Returns:
            Confirmation with the clamped value that was stored, or a validation error.
        """
        i18n = self._i18n(ctx)
        if not known_track(track):
            return i18n.t("relationships.tools.bad_track", allowed=", ".join(sorted(TRACKS)))
        parsed_value = coerce_int(value)
        if parsed_value is None:
            return i18n.t("relationships.tools.bad_delta")
        try:
            manager = RelationshipManager(self._services.store)
            clamped = await manager.set(ctx.chat_key, subject, target, track, parsed_value)
            return i18n.t(
                "relationships.tools.set.done",
                subject=subject,
                target=target,
                track=i18n.t(TRACKS[track].label_key),
                value=clamped,
            )
        except Exception as exc:
            return i18n.t("relationships.tools.failed", error=str(exc))

    @tool(gated=True)
    async def get_relationships(self, ctx: AgentCtx, entity: str = "") -> str:
        """Read back current deterministic relationship tracks, optionally filtered to one entity.
        This is the read-on-demand path (the KP's system prompt already shows the current state
        every turn -- see `agent.prompt_builder` -- so this is for double-checking a specific
        entity or the full picture mid-conversation).

        Args:
            entity: Optional entity name; when given, only pairs where it appears (case-
                insensitively, substring match) as subject or target are returned. Empty returns
                every tracked pair.

        Returns:
            A header followed by one line per subject-target pair with non-default tracks, or an
            empty-state notice when nothing matches.
        """
        i18n = self._i18n(ctx)
        try:
            manager = RelationshipManager(self._services.store)
            state = await manager.load(ctx.chat_key)
            needle = entity.strip().lower()
            if needle:
                filtered: dict = {}
                for subject, targets in state.items():
                    subject_matches = needle in subject.lower()
                    kept = {
                        target: tracks
                        for target, tracks in targets.items()
                        if subject_matches or needle in target.lower()
                    }
                    if kept:
                        filtered[subject] = kept
                state = filtered

            lines = describe(state, i18n)
            if not lines:
                return i18n.t("relationships.tools.get.empty")
            header = i18n.t("relationships.tools.get.header")
            items = [i18n.t("relationships.tools.get.item", line=line) for line in lines]
            return "\n".join([header, *items])
        except Exception as exc:
            return i18n.t("relationships.tools.failed", error=str(exc))
