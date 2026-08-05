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
import random
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from core.card_split import is_variable_declaration_entry
from core.condexpr import MAX_EXPR_LEN, CondExprError, evaluate_bool
from core.ejs_lite import render as render_template
from core.ejs_lite import split_decorators, substitute_macros
from core.mvu_compat import MvuManager, parse_initvar

WORLD_SCOPE = "world"
WORLDBOOK_COLLECTION = "worldbook"

_SELECTIVE_LOGICS = ("and_any", "and_all", "not_any", "not_all")
_POSITION_RANK = {"before": 0, "": 1, "after": 2}
# Probability rolls and inclusion-group picks on the injection path use real code randomness
# (iron rule #1). Tests inject a seeded random.Random via `match(rng=...)`.
_RNG = random.Random()


def _coerce_entry_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

# Untrusted imports (uploaded lorebooks / SillyTavern cards) are pinned to this scope so a file
# can never claim the cross-module "world" scope for itself; see `_normalize_import_entry`.
IMPORT_SCOPE = "session"

# Trust caps for a single import call, bounding prompt-injection surface and storage growth
# from an adversarial lorebook. Exceeding the ENTRY COUNT fails the whole import closed; an
# oversized single entry is skipped (and reported) instead — real module cards routinely mix
# ordinary lore with 10-13KB protocol/teaching blocks (the 2026-08-05 play-test card carried
# seven above the old 4000 cap, which used to fail the entire card). Injection-time prompt
# pressure is bounded separately by `match(budget_chars=...)`, so this cap is a storage bound:
# 200 × 16000 ≈ 3.2 MB worst case.
MAX_IMPORT_ENTRIES = 200
MAX_IMPORT_CONTENT_CHARS = 16000


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
    # --- SillyTavern trigger semantics (all optional; defaults reproduce pre-existing behavior)
    secondary_keys: list[str] = field(default_factory=list)
    selective_logic: str = "and_any"  # and_any | and_all | not_any | not_all (over secondary_keys)
    probability: int = 100  # % chance once triggered; rolled by real code (injection-path rng)
    case_sensitive: bool = False
    match_whole_words: bool = False  # ASCII-word keys only; CJK keys are unaffected
    scan_depth: int = 0  # 0 = whole provided context; N = last N non-empty lines
    position: str = ""  # ordering bucket within the lore section: "before" | "" | "after"
    sticky: int = 0  # stays active this many turns after firing
    cooldown: int = 0  # cannot re-fire this many turns after (sticky expires first)
    delay: int = 0  # not eligible until the room's turn counter reaches this
    group: str = ""  # inclusion group: at most ONE member of a group injects per turn
    group_weight: int = 100

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
            "secondary_keys": list(self.secondary_keys),
            "selective_logic": self.selective_logic,
            "probability": self.probability,
            "case_sensitive": self.case_sensitive,
            "match_whole_words": self.match_whole_words,
            "scan_depth": self.scan_depth,
            "position": self.position,
            "sticky": self.sticky,
            "cooldown": self.cooldown,
            "delay": self.delay,
            "group": self.group,
            "group_weight": self.group_weight,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LoreEntry:
        keys = data.get("keys", [])
        if isinstance(keys, str):
            keys = [keys]
        secondary = data.get("secondary_keys", [])
        if isinstance(secondary, str):
            secondary = [secondary]
        logic = str(data.get("selective_logic") or "and_any")
        return cls(
            id=str(data.get("id") or _new_id()),
            title=str(data.get("title") or data.get("name") or data.get("comment") or "Untitled Lore"),
            content=str(data.get("content") or ""),
            keys=[str(key) for key in keys if str(key).strip()],
            category=str(data.get("category") or "lore"),
            scope=str(data.get("scope") or WORLD_SCOPE),
            secret=bool(data.get("secret", False)),
            constant=bool(data.get("constant", False)),
            priority=_coerce_entry_int(data.get("priority"), 0),
            enabled=bool(data.get("enabled", True)),
            condition=str(data.get("condition") or "")[:MAX_EXPR_LEN],
            secondary_keys=[str(key) for key in secondary if str(key).strip()],
            selective_logic=logic if logic in _SELECTIVE_LOGICS else "and_any",
            probability=min(100, max(0, _coerce_entry_int(data.get("probability"), 100))),
            case_sensitive=bool(data.get("case_sensitive", False)),
            match_whole_words=bool(data.get("match_whole_words", False)),
            scan_depth=min(200, max(0, _coerce_entry_int(data.get("scan_depth"), 0))),
            position=data.get("position") if data.get("position") in ("before", "after") else "",
            sticky=min(999, max(0, _coerce_entry_int(data.get("sticky"), 0))),
            cooldown=min(999, max(0, _coerce_entry_int(data.get("cooldown"), 0))),
            delay=min(9999, max(0, _coerce_entry_int(data.get("delay"), 0))),
            group=str(data.get("group") or ""),
            group_weight=max(1, _coerce_entry_int(data.get("group_weight"), 100)),
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
        char_name: str = "",
        skipped_titles: list[str] | None = None,
    ) -> int:
        """Import lorebook entries into this room.

        Uploaded lorebooks / character cards are UNTRUSTED by default: every entry is forced to
        the room-local import scope, and a non-keeper upload additionally gets ``constant``
        forced off and secret-flagged entries dropped, so a crafted file cannot inject always-on
        or keeper-only text. Callers that have verified the importer is the room's keeper pass
        ``is_keeper=True`` to retain both flags (module cards ship their rules as constant
        entries); scope is still forced regardless of trust.

        An entry whose content exceeds ``MAX_IMPORT_CONTENT_CHARS`` is SKIPPED (never a
        whole-import failure — real module cards mix ordinary lore with a few oversized
        protocol/teaching blocks); its title is appended to the caller-supplied
        ``skipped_titles`` accumulator so command surfaces can itemize what was left out.
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
            # KEEPER-ONLY: the tree is shared room state, so only the keeper's world import may
            # seed it — a player upload's declaration entries are dropped without effect (the
            # card splitter already removed them upstream; this is the structural backstop).
            parsed_initvar = _consume_initvar(raw)
            if parsed_initvar is not None:
                if parsed_initvar and is_keeper:
                    await MvuManager(self.store).init_from_initvar(chat_key, parsed_initvar)
                continue
            entry = _normalize_import_entry(raw, source=source, index=index, is_keeper=is_keeper)
            if entry is None:
                continue
            if char_name:
                # A card's own lorebook writes {{char}} for its character's name — that binding
                # never changes for imported entries, so substitute it STATICALLY at import
                # ({{user}} stays dynamic and resolves at render time).
                entry = _bind_char_name(entry, char_name)
            if len(entry.content) > MAX_IMPORT_CONTENT_CHARS:
                if skipped_titles is not None:
                    skipped_titles.append(entry.title)
                continue
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
        rng: random.Random | None = None,
        advance_timers: bool = False,
        active_variants: Any = None,
    ) -> list[LoreEntry]:
        """Select the entries to inject for `context_text`.

        `active_variants` (an optional collection of the room's current STRING variable
        values) drives the sole-active filter for mutually-exclusive constant families —
        see `_filter_sole_active_constants`.

        `resolve` is a `core.condexpr` resolver over the room's variables; a conditioned entry
        fires only when its condition evaluates true, and FAILS CLOSED (broken expression, or no
        resolver supplied → not injected). `engine` is an optional `core.ejs_full.FullEjsEngine`:
        a condition the closed grammar cannot parse (arbitrary-JS `@@if`) is then evaluated by
        the sandbox before failing closed. `ignore_conditions=True` is the explicit-browse path
        (e.g. the keeper's `query_lore` search) where hiding entries would be misleading.

        ST trigger semantics ride on top of the base keyword/semantic selection: secondary-key
        logic and scan windows live in `_keyword_hit`; `probability` is rolled here with `rng`
        (real code randomness — pass a seeded `random.Random` in tests); inclusion groups pick
        ONE member per group by weight; `position` buckets order the final list. Timed effects
        (sticky/cooldown/delay) track against a per-room turn counter that ONLY advances when
        `advance_timers=True` — the once-per-turn injection path (the prompt builder) passes it;
        browse/search paths leave the counter and effect windows untouched.
        """
        context = context_text or ""
        rng = rng or _RNG
        entries = [entry for entry in await self.list(chat_key) if entry.enabled]
        timers = await self._load_timers(chat_key)
        turn = int(timers.get("turn", 0)) + (1 if advance_timers else 0)
        timer_entries = timers.get("entries", {})

        def _timer_state(entry: LoreEntry) -> dict[str, Any]:
            state = timer_entries.get(entry.id)
            return state if isinstance(state, dict) else {}

        def _sticky_active(entry: LoreEntry) -> bool:
            return entry.sticky > 0 and _coerce_entry_int(_timer_state(entry).get("sticky_until"), -1) >= turn

        def _timer_eligible(entry: LoreEntry) -> bool:
            if entry.delay and turn < entry.delay:
                return False
            return _coerce_entry_int(_timer_state(entry).get("cooldown_until"), -1) < turn

        selected: dict[str, LoreEntry] = {}
        sticky_ids: set[str] = set()
        for entry in entries:
            if _sticky_active(entry):
                selected[entry.id] = entry
                sticky_ids.add(entry.id)
                continue
            if not _timer_eligible(entry):
                continue
            if entry.constant or _keyword_hit(entry, context):
                selected[entry.id] = entry

        if active_variants:
            _filter_sole_active_constants(selected, entries, active_variants, sticky_ids)

        for entry in await self._semantic_hits(chat_key, context, limit=limit):
            if entry.id in selected:
                continue
            if _sticky_active(entry) or _timer_eligible(entry):
                selected[entry.id] = entry

        # Probability gate (sticky-active entries already "paid" their roll when they fired).
        survivors = []
        for entry in selected.values():
            if entry.id in sticky_ids or entry.probability >= 100:
                survivors.append(entry)
            elif entry.probability > 0 and rng.randint(1, 100) <= entry.probability:
                survivors.append(entry)

        visible = [entry for entry in survivors if role == "keeper" or not entry.secret]
        if not ignore_conditions:
            visible = [entry for entry in visible if _condition_holds(entry.condition, resolve, engine)]
        visible = _resolve_inclusion_groups(visible, rng, sticky_ids)
        visible.sort(key=lambda entry: (_POSITION_RANK.get(entry.position, 1), -entry.priority))
        chosen = _cap_entries(visible[:limit], budget_chars)

        if advance_timers:
            live_ids = {entry.id for entry in entries}
            kept = {
                entry_id: state
                for entry_id, state in timer_entries.items()
                if entry_id in live_ids and isinstance(state, dict)
            }
            for entry in chosen:
                if entry.id in sticky_ids or (not entry.sticky and not entry.cooldown):
                    continue
                state = kept.setdefault(entry.id, {})
                if entry.sticky:
                    state["sticky_until"] = turn + entry.sticky
                if entry.cooldown:
                    # ST semantics: the cooldown window starts once any sticky window ends.
                    state["cooldown_until"] = turn + entry.sticky + entry.cooldown
            await self._save_timers(chat_key, {"turn": turn, "entries": kept})
        return chosen

    async def _load_timers(self, chat_key: str) -> dict[str, Any]:
        raw = await self.store.get(user_key="", store_key=_timers_store_key(chat_key))
        if not raw:
            return {"turn": 0, "entries": {}}
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {"turn": 0, "entries": {}}
        if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
            return {"turn": 0, "entries": {}}
        return {"turn": _coerce_entry_int(data.get("turn"), 0), "entries": data["entries"]}

    async def _save_timers(self, chat_key: str, timers: dict[str, Any]) -> None:
        await self.store.set(
            user_key="", store_key=_timers_store_key(chat_key), value=json.dumps(timers, ensure_ascii=False)
        )

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
    macros: Any = None,
    rng: random.Random | None = None,
    advance_timers: bool = False,
    limit: int = 8,
    budget_chars: int = 4000,
    active_variants: Any = None,
) -> str:
    entries = await worldbook.match(
        ctx.chat_key,
        recent_context,
        role=role,
        limit=limit,
        budget_chars=budget_chars,
        resolve=resolve,
        engine=engine,
        rng=rng,
        advance_timers=advance_timers,
        active_variants=active_variants,
    )
    rendered = [render_entry_content(entry, resolve, engine, macros=macros) for entry in entries]

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
                rendered.append(render_entry_content(extra, resolve, engine, macros=macros))

    rendered = [text for text in rendered if text]
    if not rendered:
        return ""
    lines = [i18n.t("worldbook.section.title"), i18n.t("worldbook.section.instruction")]
    lines.extend(rendered)
    return "\n".join(lines)


# ST frontend-template residue: status-bar macros a prompt must never carry
# ({{format_message_variable::…}} / {{get_message_variable::…}}) and the <status_*>-style
# wrapper tags they live in. They are FRONTEND render directives — in a prompt they are
# noise at best and a copyable leak surface at worst (one model quote puts raw template
# text into player-visible narration). Scrubbed at render time; wrapper pairs left empty
# by the scrub collapse away entirely, and an entry that is NOTHING BUT template residue
# imports disabled (same "kept, not silently vanished" stance as the render-only
# decorators above).
_FRONTEND_MACRO_RE = re.compile(r"\{\{(?:format|get)_message_variable::[^{}]*\}\}")
_EMPTY_WRAPPER_RE = re.compile(r"<([A-Za-z_][\w-]*)>\s*</\1>")


def scrub_frontend_templates(text: str) -> str:
    """Remove ST status-bar macros and any wrapper tags left empty by that removal."""
    cleaned = _FRONTEND_MACRO_RE.sub("", text)
    if cleaned == text and not _EMPTY_WRAPPER_RE.search(cleaned):
        return text
    previous = None
    while previous != cleaned:
        previous = cleaned
        cleaned = _EMPTY_WRAPPER_RE.sub("", cleaned)
    return cleaned.strip()


def render_entry_content(entry: LoreEntry, resolve: Any = None, engine: Any = None, macros: Any = None) -> str:
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
            return scrub_frontend_templates(entry.content)
        text = render_template(entry.content, resolve).text
    rendered = substitute_macros(text, resolve, macros=macros) if resolve is not None else text
    return scrub_frontend_templates(rendered)


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


def _timers_store_key(chat_key: str) -> str:
    return f"worldbook_timers.{chat_key}"


def _scan_window(context: str, scan_depth: int) -> str:
    """ST `scan_depth` approximation: our context is a text blob, not a message list, so depth N
    scans the last N non-empty LINES. 0 = the whole provided context (the historic behavior)."""
    if scan_depth <= 0:
        return context
    lines = [line for line in context.splitlines() if line.strip()]
    return "\n".join(lines[-scan_depth:])


def _key_match(key: str, haystack_raw: str, haystack_lower: str, case_sensitive: bool, whole_words: bool) -> bool:
    needle = key.strip()
    if not needle:
        return False
    haystack = haystack_raw if case_sensitive else haystack_lower
    if not case_sensitive:
        needle = needle.lower()
    if whole_words and re.fullmatch(r"\w+", needle, re.ASCII):
        return re.search(rf"\b{re.escape(needle)}\b", haystack) is not None
    return needle in haystack


def _keyword_hit(entry: LoreEntry, context: str) -> bool:
    scan = _scan_window(context, entry.scan_depth)
    lowered = scan.lower()
    if not any(_key_match(key, scan, lowered, entry.case_sensitive, entry.match_whole_words) for key in entry.keys):
        return False
    if not entry.secondary_keys:
        return True
    hits = [
        _key_match(key, scan, lowered, entry.case_sensitive, entry.match_whole_words)
        for key in entry.secondary_keys
    ]
    if entry.selective_logic == "and_all":
        return all(hits)
    if entry.selective_logic == "not_any":
        return not any(hits)
    if entry.selective_logic == "not_all":
        return not all(hits)
    return any(hits)  # and_any


def _resolve_inclusion_groups(
    entries: list[LoreEntry], rng: random.Random, sticky_ids: set[str]
) -> list[LoreEntry]:
    """ST inclusion groups: of the triggered members sharing a non-empty `group`, exactly ONE
    injects — a sticky-active member wins outright, else a `group_weight`-weighted pick."""
    chosen: list[LoreEntry] = []
    groups: dict[str, list[LoreEntry]] = {}
    for entry in entries:
        if not entry.group:
            chosen.append(entry)
        else:
            groups.setdefault(entry.group, []).append(entry)
    for members in groups.values():
        sticky_members = [entry for entry in members if entry.id in sticky_ids]
        if sticky_members:
            chosen.extend(sticky_members)
        elif len(members) == 1:
            chosen.append(members[0])
        else:
            weights = [max(1, entry.group_weight) for entry in members]
            chosen.append(rng.choices(members, weights=weights, k=1)[0])
    return chosen


# The community's sole-active family convention: `前缀·变体` titles (难度·标准, 路线·主线,
# 色度·浓). ST module cards toggle exactly one member per family from their frontend panel;
# imported flat, every member is constant and PRIORITY (not module state) used to decide
# which injected — the 2026-08-05 rerun shipped 路线·大侦探线 into a 主线 run that way.
_VARIANT_SEPARATOR = "·"


def _filter_sole_active_constants(
    selected: dict[str, LoreEntry],
    all_entries: list[LoreEntry],
    active_variants: Any,
    sticky_ids: set[str],
) -> None:
    """Keep only the variant the room's variables name, per mutually-exclusive family.

    A family = ≥2 CONSTANT entries whose titles share a ``前缀·`` prefix. When any of the
    room's string variable values equals one member's variant name (配置.路线 = "主线" →
    路线·主线), the other members drop from `selected`. FAIL-OPEN by family: no value
    matching any member's variant → that family keeps all members (modules without a
    matching tracker keep the old priority behavior). Sticky-active members never drop —
    they already earned their slot."""
    values = {str(value).strip() for value in active_variants if str(value).strip()}
    if not values:
        return
    families: dict[str, list[LoreEntry]] = {}
    for entry in all_entries:
        if not entry.constant:
            continue
        prefix, sep, variant = entry.title.partition(_VARIANT_SEPARATOR)
        if sep and prefix.strip() and variant.strip():
            families.setdefault(prefix.strip(), []).append(entry)
    for members in families.values():
        if len(members) < 2:
            continue
        matched_ids = {
            entry.id
            for entry in members
            if entry.title.partition(_VARIANT_SEPARATOR)[2].strip() in values
        }
        if not matched_ids:
            continue
        for entry in members:
            if entry.id not in matched_ids and entry.id not in sticky_ids:
                selected.pop(entry.id, None)


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


_CHAR_MACRO_RE = re.compile(r"\{\{\s*char\s*\}\}|<char>|<BOT>", re.IGNORECASE)

# ST world-info selectiveLogic integers → our named logics.
_SELECTIVE_LOGIC_INTS = {0: "and_any", 1: "not_all", 2: "not_any", 3: "and_all"}


def _bind_char_name(entry: LoreEntry, char_name: str) -> LoreEntry:
    data = entry.to_dict()
    for field_name in ("title", "content"):
        data[field_name] = _CHAR_MACRO_RE.sub(char_name, data[field_name])
    for field_name in ("keys", "secondary_keys"):
        data[field_name] = [_CHAR_MACRO_RE.sub(char_name, key) for key in data[field_name]]
    return LoreEntry.from_dict(data)


_RENDER_ONLY_TITLE_RE = re.compile(r"^\s*\[RENDER:", re.IGNORECASE)
_GENERATE_TITLE_RE = re.compile(r"^\s*\[GENERATE:[^\]]*\]\s*", re.IGNORECASE)
_RENDER_ONLY_DECORATORS = {"render_before", "render_after", "iframe", "message_formatting"}


def _entry_title(raw: dict[str, Any]) -> str:
    return str(raw.get("title") or raw.get("comment") or raw.get("name") or "")


def _consume_initvar(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Return the parsed initial-variable dict when `raw` is a variable-declaration entry
    (MVU `[InitVar]` name, ST `[InitialVariables]` name, or an `@@initial_variables` decorator);
    `{}` when it is one but unparseable; `None` for an ordinary lore entry. Detection is
    `core.card_split.is_variable_declaration_entry` — the SAME predicate the card splitter
    uses, so the split and the import can never disagree about what counts as machinery."""
    if not is_variable_declaration_entry(raw):
        return None
    body = split_decorators(str(raw.get("content") or ""))[1]
    return parse_initvar(body) or {}


def _normalize_import_entry(raw: dict[str, Any], *, source: str, index: int, is_keeper: bool) -> LoreEntry | None:
    extensions = raw.get("extensions") if isinstance(raw.get("extensions"), dict) else {}
    # Fail closed on secrecy BEFORE anything else: a secret-flagged entry on a NON-keeper
    # import is dropped outright (`None`), never imported. Honoring the flag would let an
    # untrusted card mint keeper-only lore; importing it as public (the pre-M14 behavior,
    # harmless while no importable format carried the flag) would launder keeper-only
    # content into player-visible room state now that native bundles ship real `secret`s.
    if bool(raw.get("secret", extensions.get("secret", False))) and not is_keeper:
        return None
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
    # Pure frontend-template entries (e.g. `<status_current_variables>{{format_message_
    # variable::stat_data}}</status_current_variables>`) have no prompt meaning at all —
    # import them disabled so they never occupy an injection slot; mixed content stays
    # enabled and gets scrubbed at render instead.
    if content and not scrub_frontend_templates(content):
        enabled = False
    title = _GENERATE_TITLE_RE.sub("", title) or f"{source or 'Lore'} {index}"

    # ST trigger semantics: accept both the V2 character_book field names and SillyTavern's
    # native world-info names. Secondary keys apply only when `selective` isn't explicitly off
    # (V2's gate flag); an int selectiveLogic maps through `_SELECTIVE_LOGIC_INTS`.
    raw_secondary = raw.get("secondary_keys", raw.get("keysecondary", []))
    if isinstance(raw_secondary, str):
        raw_secondary = [raw_secondary]
    secondary_keys = list(raw_secondary) if raw.get("selective", True) else []
    raw_logic = raw.get("selective_logic", raw.get("selectiveLogic", "and_any"))
    selective_logic = _SELECTIVE_LOGIC_INTS.get(raw_logic, raw_logic if isinstance(raw_logic, str) else "and_any")
    probability = raw.get("probability", 100) if raw.get("useProbability", raw.get("use_probability", True)) else 100
    raw_position = raw.get("position", "")
    position = {"before_char": "before", "after_char": "after", 0: "before", 1: "after"}.get(raw_position, "")

    # Trust boundary: the uploaded file does NOT get to choose its own scope/constant/secret.
    # Scope is pinned room-local. `constant` and `secret` are honored only for a KEEPER
    # importer: a player upload gets `constant` forced off (an always-on entry would inject
    # itself into every prompt regardless of keywords; an imported `@@activate` is ignored for
    # the same reason), while a keeper world import keeps it — ST module cards carry their
    # rules/timelines as constant entries and stripping the flag left every imported module
    # rule keyword-gated (2026-08-05 play-test finding). A non-keeper import of a
    # secret-flagged entry already returned `None` at the top of this function. The `id` is
    # always regenerated so a card cannot address (and thus
    # shadow) an existing entry. A `condition` is safe to honor: it can only NARROW injection,
    # and it is evaluated by the closed `core.condexpr` grammar, never executed. The trigger
    # semantics above can likewise only narrow/reorder — never widen — what injects.
    return LoreEntry.from_dict(
        {
            "id": _new_id(),
            "title": title,
            "content": content,
            "keys": keys,
            "category": raw.get("category", extensions.get("category", "lore")),
            "scope": IMPORT_SCOPE,
            "secret": bool(raw.get("secret", extensions.get("secret", False))),
            "constant": bool(raw.get("constant", False)) if is_keeper else False,
            "priority": priority,
            "enabled": enabled,
            "condition": condition,
            "secondary_keys": secondary_keys,
            "selective_logic": selective_logic,
            "probability": probability,
            "case_sensitive": raw.get("case_sensitive", raw.get("caseSensitive", False)) or False,
            "match_whole_words": raw.get("match_whole_words", raw.get("matchWholeWords", False)) or False,
            "scan_depth": raw.get("scan_depth", raw.get("scanDepth", 0)) or 0,
            "sticky": raw.get("sticky", 0) or 0,
            "cooldown": raw.get("cooldown", 0) or 0,
            "delay": raw.get("delay", 0) or 0,
            "group": raw.get("group", "") or "",
            "group_weight": raw.get("groupWeight", raw.get("group_weight", 100)) or 100,
            "position": position,
        }
    )
