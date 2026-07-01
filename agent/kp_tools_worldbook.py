"""AI-KP tools for the world lore / worldbook layer (`docs/specs/M11-worldbook.md` §3).

`WorldbookTools` is the function-calling surface over `core.worldbook.WorldbookManager`: the
structured, secret-aware WORLD setting (factions, history, geography, cosmology, world-rules,
recurring people/places) that grounds ALL AI generation and persists across sessions/modules --
deeper than any single adventure's module pool.

`query_lore` is `keeper_only` (its keeper view may surface `secret=True` entries -- matching the
`agent.kp_tools_npc`/`agent.kp_tools_knowledge` convention of prefixing keeper-only bodies with a
localized banner so the model is reminded, at the exact point it reads secret material, never to
quote it raw to players). Every other tool returns player-safe confirmations. All user-visible text
is looked up via `services.i18n` under `worldbook.tools.*` (`locales/{en,zh}/worldbook.json`); lore
titles/content/keys are game DATA supplied at runtime, not string literals here (same convention as
the other tool modules).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from agent.context import AgentCtx
from agent.services import Services
from agent.tools import tool
from core.worldbook import LoreEntry
from infra.i18n import I18n

# `update_lore`'s allowed field names and how each caller-supplied string value is coerced onto the
# `core.worldbook.LoreEntry` field. `id` is identity (never mutated); `keys` splits a list, the
# flags coerce to bool, `priority` to int, everything else stays a plain string.
_UPDATABLE_FIELDS = {"title", "content", "keys", "category", "scope", "secret", "constant", "priority", "enabled"}
_BOOL_FIELDS = {"secret", "constant", "enabled"}
_TRUTHY_STRINGS = {"true", "1", "yes", "y", "on", "开", "开启", "啟用", "開"}


def _split_keys(text: str) -> list[str]:
    """Split a comma/newline-separated trigger-keys string into a cleaned list."""
    if not text:
        return []
    return [part.strip() for part in re.split(r"[,\n]+", text) if part.strip()]


def _coerce_field_value(field: str, value: str) -> Any:
    if field == "keys":
        return _split_keys(value)
    if field in _BOOL_FIELDS:
        return value.strip().lower() in _TRUTHY_STRINGS
    if field == "priority":
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return value


class WorldbookTools:
    """AI-KP tools for authoring/retrieving structured world lore (the reusable, persistent world)."""

    def __init__(self, services: Services) -> None:
        self._services = services

    def _i18n(self, ctx: AgentCtx) -> I18n:
        return self._services.i18n.with_locale(ctx.locale)

    @tool
    async def add_lore(
        self,
        ctx: AgentCtx,
        title: str,
        content: str,
        keys: str = "",
        category: str = "lore",
        scope: str = "world",
        secret: bool = False,
        constant: bool = False,
    ) -> str:
        """Add a world-lore entry -- a durable fact about the WORLD (a faction, place, history,
        cosmology, world-rule, recurring person/item) that should ground future generation.

        Args:
            title: Short title / unique-ish name for the entry.
            content: The lore text itself (the authoritative fact).
            keys: Comma- or newline-separated trigger keywords that surface this entry when they
                appear in the scene; leave empty for a constant/always-on entry.
            category: One of faction/location/history/cosmology/rule/person/item/event/lore.
            scope: "world" (persists across sessions/modules), "module", or "session" (this chat only).
            secret: True = keeper-only; players/companions/NPC actors will NEVER see it.
            constant: True = always injected (core premise/world-rules), ignoring keys.

        Returns:
            Confirmation naming the stored entry and its scope.
        """
        i18n = self._i18n(ctx)
        try:
            entry = LoreEntry(
                id="",
                title=title,
                content=content,
                keys=_split_keys(keys),
                category=category or "lore",
                scope=scope or "world",
                secret=secret,
                constant=constant,
            )
            saved = await self._services.worldbook.add(ctx.chat_key, entry)
            secret_note = i18n.t("worldbook.tools.add.secret_suffix") if saved.secret else ""
            return i18n.t("worldbook.tools.add.done", title=saved.title, scope=saved.scope, secret=secret_note)
        except Exception as exc:
            return i18n.t("worldbook.tools.add.failed", error=str(exc))

    @tool(keeper_only=True)
    async def query_lore(self, ctx: AgentCtx, query: str) -> str:
        """Retrieve world lore relevant to `query` (KEEPER view -- may include secret entries; for
        your own reasoning, never quote secret lore to players). Matches by keyword + meaning.

        Args:
            query: What you are looking for (a place, name, theme, or the current scene text).

        Returns:
            The matching lore entries, each tagged with its category (and a secret marker if secret).
        """
        i18n = self._i18n(ctx)
        try:
            entries = await self._services.worldbook.match(ctx.chat_key, query, role="keeper")
            if not entries:
                return i18n.t("worldbook.tools.query.empty", query=query)
            secret_tag = i18n.t("worldbook.tools.query.secret_tag")
            lines = [i18n.t("worldbook.tools.query.banner"), i18n.t("worldbook.tools.query.header", query=query, count=len(entries))]
            for entry in entries:
                lines.append(
                    i18n.t(
                        "worldbook.tools.query.item",
                        category=entry.category,
                        title=entry.title,
                        secret=secret_tag if entry.secret else "",
                        content=entry.content,
                    )
                )
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("worldbook.tools.query.failed", error=str(exc))

    @tool
    async def list_lore(self, ctx: AgentCtx, scope: str = "") -> str:
        """List world-lore entries (titles + scope/category only -- no secret content is revealed).

        Args:
            scope: Optionally restrict to "world", "module", or "session"; empty lists all scopes.

        Returns:
            A roster of lore entries, or an empty-book notice.
        """
        i18n = self._i18n(ctx)
        try:
            entries = await self._services.worldbook.list(ctx.chat_key, scope=scope.strip() or None)
            if not entries:
                return i18n.t("worldbook.tools.list.empty")
            lines = [i18n.t("worldbook.tools.list.header", count=len(entries))]
            for entry in entries:
                lines.append(i18n.t("worldbook.tools.list.item", scope=entry.scope, category=entry.category, title=entry.title))
            return "\n".join(lines)
        except Exception as exc:
            return i18n.t("worldbook.tools.list.failed", error=str(exc))

    @tool
    async def update_lore(self, ctx: AgentCtx, title: str, field: str, value: str) -> str:
        """Update a single field on a lore entry: title/content/keys/category/scope/secret/constant/
        priority/enabled.

        Args:
            title: The entry's title or id.
            field: Which field to update.
            value: The new value (keys: comma-separated; secret/constant/enabled: true/false; priority: integer).

        Returns:
            Confirmation, or a not-found/unsupported-field message.
        """
        i18n = self._i18n(ctx)
        if field not in _UPDATABLE_FIELDS:
            return i18n.t("worldbook.tools.update.bad_field", field=field, allowed=", ".join(sorted(_UPDATABLE_FIELDS)))
        try:
            record = await self._services.worldbook.update(ctx.chat_key, title, **{field: _coerce_field_value(field, value)})
            if record is None:
                return i18n.t("worldbook.tools.update.not_found", title=title)
            return i18n.t("worldbook.tools.update.done", title=record.title, field=field, value=value)
        except Exception as exc:
            return i18n.t("worldbook.tools.update.failed", error=str(exc))

    @tool
    async def remove_lore(self, ctx: AgentCtx, title: str) -> str:
        """Remove a lore entry from the world.

        Args:
            title: The entry's title or id.

        Returns:
            Confirmation, or a not-found message.
        """
        i18n = self._i18n(ctx)
        try:
            removed = await self._services.worldbook.remove(ctx.chat_key, title)
            if not removed:
                return i18n.t("worldbook.tools.remove.not_found", title=title)
            return i18n.t("worldbook.tools.remove.done", title=title)
        except Exception as exc:
            return i18n.t("worldbook.tools.remove.failed", error=str(exc))

    @tool
    async def import_lorebook(self, ctx: AgentCtx, file_path: str) -> str:
        """Import a lorebook file into the world: a SillyTavern `character_book` JSON, a bare
        `{"entries": [...]}` object, or a plain list of entries. Entries default to non-secret,
        world-scope unless flagged.

        Args:
            file_path: The sandbox/logical path to the lorebook JSON (resolved to a host path via ctx.fs).

        Returns:
            Confirmation with how many entries were imported.
        """
        i18n = self._i18n(ctx)
        if ctx.fs is None:
            return i18n.t("worldbook.tools.import.no_fs")
        try:
            host_path = Path(ctx.fs.get_file(file_path))
            if not host_path.exists():
                return i18n.t("worldbook.tools.import.no_file", path=file_path)
            data: Any = json.loads(host_path.read_text(encoding="utf-8-sig"))
            # A full character card (or a card's `data` block) -> use its embedded character_book.
            if isinstance(data, dict) and "entries" not in data:
                book = data.get("character_book") or (data.get("data") or {}).get("character_book")
                if isinstance(book, dict):
                    data = book
            source = host_path.name
            count = await self._services.worldbook.import_entries(ctx.chat_key, data, source=source)
            if not count:
                return i18n.t("worldbook.tools.import.none", source=source)
            return i18n.t("worldbook.tools.import.done", count=count, source=source)
        except Exception as exc:
            return i18n.t("worldbook.tools.import.failed", error=str(exc))
