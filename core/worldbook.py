"""Worldbook lore entries and retrieval.

This module is intentionally self-contained for the M11 leaf pass: it owns the
entry model, persistence/indexing, keyword/vector matching, import
normalization, and the prompt section renderer.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

WORLD_SCOPE = "world"
WORLDBOOK_COLLECTION = "worldbook"

# Untrusted imports (uploaded lorebooks / SillyTavern cards) are pinned to this scope so a file
# can never claim the cross-module "world" scope for itself; see `_normalize_import_entry`.
IMPORT_SCOPE = "session"

# Trust caps for a single import call. These bound both prompt-injection surface and storage
# growth from an adversarial lorebook; exceeding them fails the whole import closed.
MAX_IMPORT_ENTRIES = 200
MAX_IMPORT_CONTENT_CHARS = 4000


@dataclass
class LoreEntry:
    id: str
    title: str
    content: str
    keys: list[str] = field(default_factory=list)
    category: str = "lore"
    scope: str = WORLD_SCOPE
    secret: bool = False
    constant: bool = False
    priority: int = 0
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "keys": list(self.keys),
            "category": self.category,
            "scope": self.scope,
            "secret": self.secret,
            "constant": self.constant,
            "priority": self.priority,
            "enabled": self.enabled,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LoreEntry:
        keys = data.get("keys", [])
        if isinstance(keys, str):
            keys = [keys]
        return cls(
            id=str(data.get("id") or _new_id()),
            title=str(data.get("title") or data.get("name") or data.get("comment") or "Untitled Lore"),
            content=str(data.get("content") or ""),
            keys=[str(key) for key in keys if str(key).strip()],
            category=str(data.get("category") or "lore"),
            scope=str(data.get("scope") or WORLD_SCOPE),
            secret=bool(data.get("secret", False)),
            constant=bool(data.get("constant", False)),
            priority=int(data.get("priority", 0) or 0),
            enabled=bool(data.get("enabled", True)),
        )


class WorldbookManager:
    def __init__(self, store: Any, vector_db: Any = None, embeddings: Any = None) -> None:
        self.store = store
        self.vector_db = vector_db
        self.embeddings = embeddings

    async def add(self, chat_key: str, entry: LoreEntry) -> LoreEntry:
        entry = LoreEntry.from_dict(entry.to_dict())
        if not entry.id:
            entry.id = _new_id()
        namespace = _namespace(chat_key, entry.scope)
        existing = await self.get(chat_key, entry.id)
        if existing is not None:
            entry.id = _new_id()
        await self.store.set(user_key="", store_key=_entry_store_key(namespace, entry.id), value=json.dumps(entry.to_dict()))
        index = await self._load_index(namespace)
        if entry.id not in index:
            index.append(entry.id)
            await self._save_index(namespace, index)
        await self._upsert_vector(chat_key, entry)
        return entry

    async def get(self, chat_key: str, id_or_title: str) -> LoreEntry | None:
        needle = str(id_or_title)
        for entry in await self.list(chat_key):
            if entry.id == needle or entry.title == needle:
                return entry
        return None

    async def list(self, chat_key: str, *, scope: str | None = None) -> list[LoreEntry]:
        namespaces = [_namespace(chat_key, WORLD_SCOPE)] if scope in {None, WORLD_SCOPE} else []
        if scope is None or scope in {"module", "session"}:
            namespaces.append(_namespace(chat_key, "session"))
        if scope not in {None, WORLD_SCOPE, "module", "session"}:
            namespaces.append(_namespace(chat_key, scope))

        entries: list[LoreEntry] = []
        seen: set[tuple[str, str]] = set()
        for namespace in namespaces:
            for entry_id in await self._load_index(namespace):
                key = (namespace, entry_id)
                if key in seen:
                    continue
                seen.add(key)
                raw = await self.store.get(user_key="", store_key=_entry_store_key(namespace, entry_id))
                if raw is None:
                    continue
                # A single corrupt row (bad JSON / wrong shape) must never break every lore
                # lookup for the whole book — skip it, mirroring `_load_index`'s tolerant decode.
                try:
                    data = json.loads(raw)
                except (json.JSONDecodeError, TypeError, ValueError):
                    continue
                if not isinstance(data, dict):
                    continue
                try:
                    entries.append(LoreEntry.from_dict(data))
                except (TypeError, ValueError):
                    continue
        if scope in {"module", "session"}:
            return [entry for entry in entries if entry.scope == scope]
        return entries

    async def update(self, chat_key: str, id_or_title: str, **fields: Any) -> LoreEntry | None:
        current = await self.get(chat_key, id_or_title)
        if current is None:
            return None
        data = current.to_dict()
        for key, value in fields.items():
            if key in data and key != "id":
                data[key] = value
        updated = LoreEntry.from_dict(data)
        old_namespace = _namespace(chat_key, current.scope)
        new_namespace = _namespace(chat_key, updated.scope)
        if old_namespace != new_namespace:
            await self.store.delete(user_key="", store_key=_entry_store_key(old_namespace, current.id))
            old_index = [entry_id for entry_id in await self._load_index(old_namespace) if entry_id != current.id]
            await self._save_index(old_namespace, old_index)
            new_index = await self._load_index(new_namespace)
            if updated.id not in new_index:
                new_index.append(updated.id)
                await self._save_index(new_namespace, new_index)
        await self.store.set(user_key="", store_key=_entry_store_key(new_namespace, updated.id), value=json.dumps(updated.to_dict()))
        await self._upsert_vector(chat_key, updated)
        return updated

    async def remove(self, chat_key: str, id_or_title: str) -> bool:
        entry = await self.get(chat_key, id_or_title)
        if entry is None:
            return False
        namespace = _namespace(chat_key, entry.scope)
        await self.store.delete(user_key="", store_key=_entry_store_key(namespace, entry.id))
        index = [entry_id for entry_id in await self._load_index(namespace) if entry_id != entry.id]
        await self._save_index(namespace, index)
        if self.vector_db is not None:
            await self.vector_db.delete([_vector_id(namespace, entry.id)])
        return True

    async def import_entries(
        self,
        chat_key: str,
        entries: list[dict[str, Any]] | dict[str, Any],
        *,
        source: str = "",
        is_keeper: bool = False,
    ) -> int:
        """Import lorebook entries into this room.

        Uploaded lorebooks / character cards are UNTRUSTED by default: every entry is forced to
        the room-local import scope with ``constant=False`` and (unless ``is_keeper``) ``secret``
        stripped, so a crafted file cannot inject always-on or keeper-only text. Callers that have
        verified the importer is the room's keeper pass ``is_keeper=True`` to retain secrecy flags;
        scope/constant are still forced regardless of trust.
        """
        raw_entries: Any = entries.get("entries", []) if isinstance(entries, dict) else entries
        if not isinstance(raw_entries, list):
            return 0
        if len(raw_entries) > MAX_IMPORT_ENTRIES:
            raise ValueError("worldbook import exceeds the maximum entry count")  # i18n-exempt: surfaced via localized import failure
        count = 0
        for index, raw in enumerate(raw_entries, start=1):
            if not isinstance(raw, dict):
                continue
            entry = _normalize_import_entry(raw, source=source, index=index, is_keeper=is_keeper)
            if len(entry.content) > MAX_IMPORT_CONTENT_CHARS:
                raise ValueError("worldbook import entry content exceeds the maximum length")  # i18n-exempt: surfaced via localized import failure
            if entry.content:
                await self.add(chat_key, entry)
                count += 1
        return count

    async def match(
        self,
        chat_key: str,
        context_text: str,
        *,
        role: str,
        limit: int = 8,
        budget_chars: int = 4000,
    ) -> list[LoreEntry]:
        context = context_text or ""
        entries = [entry for entry in await self.list(chat_key) if entry.enabled]
        selected: dict[str, LoreEntry] = {}
        for entry in entries:
            if entry.constant or _keyword_hit(entry, context):
                selected[entry.id] = entry

        for entry in await self._semantic_hits(chat_key, context, limit=limit):
            selected.setdefault(entry.id, entry)

        visible = [
            entry
            for entry in selected.values()
            if entry.enabled and (role == "keeper" or not entry.secret)
        ]
        visible.sort(key=lambda entry: entry.priority, reverse=True)
        return _cap_entries(visible[:limit], budget_chars)

    async def _load_index(self, namespace: str) -> list[str]:
        raw = await self.store.get(user_key="", store_key=_index_store_key(namespace))
        if raw is None:
            return []
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return []
        if not isinstance(data, list):
            return []
        return [str(entry_id) for entry_id in data]

    async def _save_index(self, namespace: str, ids: list[str]) -> None:
        await self.store.set(user_key="", store_key=_index_store_key(namespace), value=json.dumps(ids))

    async def _upsert_vector(self, chat_key: str, entry: LoreEntry) -> None:
        if self.vector_db is None or self.embeddings is None:
            return
        namespace = _namespace(chat_key, entry.scope)
        [vector] = await self.embeddings.embed([entry.content])
        await self.vector_db.upsert(
            [
                (
                    _vector_id(namespace, entry.id),
                    vector,
                    {
                        "collection": WORLDBOOK_COLLECTION,
                        "namespace": namespace,
                        "entry_id": entry.id,
                        "scope": entry.scope,
                    },
                )
            ]
        )

    async def _semantic_hits(self, chat_key: str, context: str, *, limit: int) -> list[LoreEntry]:
        if self.vector_db is None or self.embeddings is None or not context.strip():
            return []
        [vector] = await self.embeddings.embed([context])
        hits = []
        for namespace in (_namespace(chat_key, WORLD_SCOPE), _namespace(chat_key, "session")):
            hits.extend(
                await self.vector_db.search(
                    vector,
                    limit=limit,
                    filter={"collection": WORLDBOOK_COLLECTION, "namespace": namespace},
                )
            )
        hits.sort(key=lambda hit: hit.score, reverse=True)
        entries: list[LoreEntry] = []
        for hit in hits[:limit]:
            if hit.score <= 0:
                continue
            entry = await self.get(chat_key, str(hit.payload.get("entry_id") or ""))
            if entry is not None and entry.enabled:
                entries.append(entry)
        return entries


async def inject_world_lore_prompt(ctx: Any, worldbook: WorldbookManager, i18n: Any, *, role: str, recent_context: str) -> str:
    entries = await worldbook.match(ctx.chat_key, recent_context, role=role)
    if not entries:
        return ""
    lines = [i18n.t("worldbook.section.title"), i18n.t("worldbook.section.instruction")]
    lines.extend(entry.content for entry in entries)
    return "\n".join(lines)


def _new_id() -> str:
    return uuid.uuid4().hex


def _namespace(chat_key: str, scope: str) -> str:
    # Every scope — including "world" — is namespaced by the room's chat_key so lore never leaks
    # across rooms sharing one host. (Historically "world" scope returned the literal global
    # namespace "world", making worldbook.world.* shared by every room on the host.) Legacy
    # globally-namespaced worldbook.world.* rows are intentionally NOT read anymore; re-reading
    # them would re-open that cross-room leak. The `scope` argument is retained for call-site
    # clarity but no longer changes the physical namespace.
    return str(chat_key)


def _entry_store_key(namespace: str, entry_id: str) -> str:
    return f"worldbook.{namespace}.{entry_id}"


def _index_store_key(namespace: str) -> str:
    return f"worldbook_index.{namespace}"


def _vector_id(namespace: str, entry_id: str) -> str:
    return f"{namespace}:{entry_id}"


def _keyword_hit(entry: LoreEntry, context: str) -> bool:
    lowered = context.lower()
    for key in entry.keys:
        normalized = key.strip().lower()
        if normalized and re.search(re.escape(normalized), lowered):
            return True
    return False


def _cap_entries(entries: list[LoreEntry], budget_chars: int) -> list[LoreEntry]:
    if budget_chars <= 0:
        return []
    capped: list[LoreEntry] = []
    used = 0
    for entry in entries:
        size = len(entry.content)
        if used + size > budget_chars:
            continue
        capped.append(entry)
        used += size
    return capped


def _normalize_import_entry(raw: dict[str, Any], *, source: str, index: int, is_keeper: bool) -> LoreEntry:
    extensions = raw.get("extensions") if isinstance(raw.get("extensions"), dict) else {}
    keys = raw.get("keys", raw.get("key", []))
    if isinstance(keys, str):
        keys = [keys]
    title = raw.get("title") or raw.get("comment") or raw.get("name") or f"{source or 'Lore'} {index}"
    priority = raw.get("priority", raw.get("insertion_order", 0))
    # Trust boundary: the uploaded file does NOT get to choose its own scope/constant/secret.
    # Scope is pinned room-local and `constant` is forced off (an always-on entry would inject
    # itself into every prompt regardless of keywords). `secret` is honored only for a keeper
    # importer; an untrusted card cannot mint keeper-only lore. The `id` is always regenerated so
    # a card cannot address (and thus shadow) an existing entry.
    return LoreEntry.from_dict(
        {
            "id": _new_id(),
            "title": title,
            "content": raw.get("content", ""),
            "keys": keys,
            "category": raw.get("category", extensions.get("category", "lore")),
            "scope": IMPORT_SCOPE,
            "secret": bool(raw.get("secret", extensions.get("secret", False))) if is_keeper else False,
            "constant": False,
            "priority": priority,
            "enabled": raw.get("enabled", True),
        }
    )
