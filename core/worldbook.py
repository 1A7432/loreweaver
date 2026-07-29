"""Worldbook lore entries and retrieval.

This module is intentionally self-contained for the M11 leaf pass: it owns the
entry model, persistence/indexing, keyword/vector matching, import
normalization, and the prompt section renderer.

Conditional injection (the EJS-compat pass): an entry may carry a `condition` —
a safe `core.condexpr` expression over the room's deterministic variables
(`core.varspace` unifies modvars + the imported MVU tree). At match time a
conditioned entry only fires when its expression is true; FAIL-CLOSED both ways
(a broken condition, or no resolver supplied, means "don't inject"). At
injection time entry content is rendered through `core.ejs_lite` (the EJS
subset + `{{getvar::}}`/`{{var:}}` macros) with NO setter — prompt assembly is
read-only and idempotent by design, so template `setvar(...)` statements are
deliberate no-ops there. SillyTavern imports map `@@if` decorators onto
`condition`, consume `[InitVar]`/`@@initial_variables` entries into the MVU
variable tree instead of storing them as lore, and disable render-time-only
entries (`[RENDER:*]` / `@@render_*` / `@@iframe` — frontend status-bar UI that
must never reach a prompt).
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from core.condexpr import MAX_EXPR_LEN, CondExprError, evaluate_bool
from core.ejs_lite import render as render_template
from core.ejs_lite import split_decorators, substitute_macros
from core.mvu_compat import MvuManager, is_initvar_entry, parse_initvar

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
    condition: str = ""  # safe condexpr expression; empty = unconditional

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
            "condition": self.condition,
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
            condition=str(data.get("condition") or "")[:MAX_EXPR_LEN],
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
            # MVU/ST variable-declaration entries ([InitVar], @@initial_variables,
            # [InitialVariables]) are DATA, not lore: consume them into the room's MVU variable
            # tree (existing values win — a re-import never resets play progress) and store no
            # entry. Checked before the content-length cap: a large InitVar block is legitimate.
            parsed_initvar = _consume_initvar(raw)
            if parsed_initvar is not None:
                if parsed_initvar:
                    await MvuManager(self.store).init_from_initvar(chat_key, parsed_initvar)
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
        resolve: Any = None,
        engine: Any = None,
        ignore_conditions: bool = False,
    ) -> list[LoreEntry]:
        """Select the entries to inject for `context_text`.

        `resolve` is a `core.condexpr` resolver over the room's variables; a conditioned entry
        fires only when its condition evaluates true, and FAILS CLOSED (broken expression, or no
        resolver supplied → not injected). `engine` is an optional `core.ejs_full.FullEjsEngine`:
        a condition the closed grammar cannot parse (arbitrary-JS `@@if`) is then evaluated by
        the sandbox before failing closed. `ignore_conditions=True` is the explicit-browse path
        (e.g. the keeper's `query_lore` search) where hiding entries would be misleading.
        """
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
        if not ignore_conditions:
            visible = [entry for entry in visible if _condition_holds(entry.condition, resolve, engine)]
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


def _condition_holds(condition: str, resolve: Any, engine: Any) -> bool:
    """One entry's condition verdict: unconditional → True; else the closed grammar first,
    the JS sandbox (when provided) for expressions the grammar can't parse, and FAIL CLOSED
    on everything else (no resolver/engine, broken expression, hostile resolver)."""
    if not condition:
        return True
    if resolve is not None:
        try:
            return evaluate_bool(condition, resolve)
        except CondExprError:
            pass
        except Exception:
            return False
    if engine is not None:
        verdict = engine.eval_condition(condition)
        if verdict is not None:
            return verdict
    return False


async def inject_world_lore_prompt(
    ctx: Any,
    worldbook: WorldbookManager,
    i18n: Any,
    *,
    role: str,
    recent_context: str,
    resolve: Any = None,
    engine: Any = None,
) -> str:
    entries = await worldbook.match(ctx.chat_key, recent_context, role=role, resolve=resolve, engine=engine)
    rendered = [render_entry_content(entry, resolve, engine) for entry in entries]

    # ST-Prompt-Template's activewi(): a template rendered above may force-activate further
    # entries by name. One additive pass (no recursion — an activation chain stops here),
    # honoring the same role/secrecy visibility as match().
    if engine is not None:
        seen = {entry.title for entry in entries} | {entry.id for entry in entries}
        for name in engine.activated:
            if name in seen:
                continue
            seen.add(name)
            extra = await worldbook.get(ctx.chat_key, name)
            if extra is not None and extra.enabled and (role == "keeper" or not extra.secret):
                rendered.append(render_entry_content(extra, resolve, engine))

    rendered = [text for text in rendered if text]
    if not rendered:
        return ""
    lines = [i18n.t("worldbook.section.title"), i18n.t("worldbook.section.instruction")]
    lines.extend(rendered)
    return "\n".join(lines)


def render_entry_content(entry: LoreEntry, resolve: Any = None, engine: Any = None) -> str:
    """Render one entry's content for prompt injection.

    With a `core.ejs_full.FullEjsEngine` the content runs as real EJS (template `setvar`
    writes land in the engine's buffer — the caller flushes them); on a template error, or
    without the engine, the `core.ejs_lite` subset renders instead (READ-ONLY — see module
    docstring). ST macros substitute after either path. Without a resolver the content passes
    through verbatim (legacy callers, plain entries)."""
    if "<%" not in entry.content and "{{" not in entry.content:
        return entry.content
    text = None
    if engine is not None and "<%" in entry.content:
        try:
            text = engine.render(entry.content).text
        except Exception:
            text = None  # template error → subset fallback below (never raw syntax out)
    if text is None:
        if resolve is None:
            return entry.content
        text = render_template(entry.content, resolve).text
    return substitute_macros(text, resolve) if resolve is not None else text


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


_RENDER_ONLY_TITLE_RE = re.compile(r"^\s*\[RENDER:", re.IGNORECASE)
_GENERATE_TITLE_RE = re.compile(r"^\s*\[GENERATE:[^\]]*\]\s*", re.IGNORECASE)
_RENDER_ONLY_DECORATORS = {"render_before", "render_after", "iframe", "message_formatting"}


def _entry_title(raw: dict[str, Any]) -> str:
    return str(raw.get("title") or raw.get("comment") or raw.get("name") or "")


def _consume_initvar(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Return the parsed initial-variable dict when `raw` is a variable-declaration entry
    (MVU `[InitVar]` name, ST `[InitialVariables]` name, or an `@@initial_variables` decorator);
    `{}` when it is one but unparseable; `None` for an ordinary lore entry."""
    title = _entry_title(raw)
    content = str(raw.get("content") or "")
    decorators, body = split_decorators(content)
    is_declaration = (
        is_initvar_entry(title)
        or "[initialvariables]" in title.replace(" ", "").lower()
        or "initial_variables" in decorators
    )
    if not is_declaration:
        return None
    return parse_initvar(body) or {}


def _normalize_import_entry(raw: dict[str, Any], *, source: str, index: int, is_keeper: bool) -> LoreEntry:
    extensions = raw.get("extensions") if isinstance(raw.get("extensions"), dict) else {}
    keys = raw.get("keys", raw.get("key", []))
    if isinstance(keys, str):
        keys = [keys]
    title = _entry_title(raw) or f"{source or 'Lore'} {index}"
    priority = raw.get("priority", raw.get("insertion_order", 0))
    enabled = bool(raw.get("enabled", True))

    # ST-Prompt-Template compatibility: leading @@decorators peel off the content. `@@if` becomes
    # the entry's condition; render-time-only decorators mark frontend status-bar UI that must
    # never reach a prompt, so those entries import disabled (kept, so nothing silently vanishes).
    content = str(raw.get("content") or "")
    decorators, content = split_decorators(content)
    condition = decorators.get("if") if isinstance(decorators.get("if"), str) else ""
    if "dont_activate" in decorators or _RENDER_ONLY_DECORATORS & decorators.keys():
        enabled = False
    if _RENDER_ONLY_TITLE_RE.match(title):
        enabled = False
    title = _GENERATE_TITLE_RE.sub("", title) or f"{source or 'Lore'} {index}"

    # Trust boundary: the uploaded file does NOT get to choose its own scope/constant/secret.
    # Scope is pinned room-local and `constant` is forced off (an always-on entry would inject
    # itself into every prompt regardless of keywords; an imported `@@activate` is ignored for
    # the same reason). `secret` is honored only for a keeper importer; an untrusted card cannot
    # mint keeper-only lore. The `id` is always regenerated so a card cannot address (and thus
    # shadow) an existing entry. A `condition` is safe to honor: it can only NARROW injection,
    # and it is evaluated by the closed `core.condexpr` grammar, never executed.
    return LoreEntry.from_dict(
        {
            "id": _new_id(),
            "title": title,
            "content": content,
            "keys": keys,
            "category": raw.get("category", extensions.get("category", "lore")),
            "scope": IMPORT_SCOPE,
            "secret": bool(raw.get("secret", extensions.get("secret", False))) if is_keeper else False,
            "constant": False,
            "priority": priority,
            "enabled": enabled,
            "condition": condition,
        }
    )
