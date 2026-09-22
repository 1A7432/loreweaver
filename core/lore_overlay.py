"""M26 — the lore overlay: the room admin's switch over imported lore, as a separate document.

An imported lorebook is stored FAITHFULLY: a file that says `enabled: false` stays
`enabled: false` in the room's `lore` documents forever, because re-importing a revised
card has to be a clean replace rather than a merge with somebody's edits. That left the
human at the table with no lever at all — the only way to flip an entry on was to ask the
AI Keeper to rewrite the stored copy (`update_lore`), which is both a model turn and a
destructive edit of the author's file.

This module is the missing layer, and it is modelled on the one the engine already has for
imported VARIABLES (`core.mvu_compat`'s exposure list): a per-room, KEEPER-ONLY document
that says, per entry TITLE, what the effective `enabled` and `condition` are. The stored
entry is never touched, so:

- faithful import survives (the file's own flags are still there to re-read);
- a re-import replaces the lore and leaves the overlay alone, the same promise the
  variable tree already makes ("re-import never resets progress");
- a pack that ADOPTS a foreign card can ship the annotations as data (`§ the overlay
  file` below) without the engine learning one card's vocabulary.

Keyed by title, not id: ids regenerate on every import, titles are what an admin types and
what a pack author knows. Two entries sharing a title share an overlay entry — surfaced by
`.lore show`, not resolved by guessing.

**One effective-state function.** `apply(entry, overlay)` is the ONLY place the effective
`enabled`/`condition` of an entry is computed, and all three activation paths consume it
(`core.worldbook.Worldbook.match`, its `_semantic_hits` half, and the `activewi` extra pass
in `inject_world_lore_prompt`). That is deliberate: the 2026-08-06 reversal of the
sole-active mechanism was partly because semantic recall bypassed the filter that keyword
matching honored. There is no second notion of "enabled" to bypass.

**No inference.** Nothing here reads a title for structure, groups entries into families or
suggests a choice — `docs/notes/rejected/sole-active-card-mechanism.md` is binding. An
overlay entry exists because an admin typed it or because a pack the admin installed
shipped it.

**Setup variables** ("set before play") ride the same document: an author marks a variable
`setup: true` (native lorecard) or an overlay file declares one for an imported tree path,
and the item stays PENDING until the table writes that path. Defaults do not count as
done — the whole point of the flag is that the author's default is not the table's choice.

Expressions are the CLOSED `core.condexpr` grammar, validated at write time; the full-EJS
JS fallback is never offered to a typed binding, so an overlay cannot smuggle code into the
sandbox. Evaluation stays fail-closed exactly as it is for a file's own condition.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any

from core.condexpr import MAX_EXPR_LEN, CondExprError, compile_expression
from core.yaml_safety import safe_load_no_aliases
from infra.room_facets import STORAGE_DOCUMENTS, RoomStateFacet

if TYPE_CHECKING:  # pragma: no cover - typing only; a runtime import would cycle
    from core.worldbook import LoreEntry

OVERLAY_DOC_TYPE = "lore_overlay"
OVERLAY_DOC_ID = "overlay"

#: The overlay FILE's format marker (`§5.5`). Bumping it is a breaking change for packs,
#: so it is stated in the file rather than inferred from shape.
OVERLAY_FORMAT = "loreweaver.lore-overlay/1"

# Storage bounds. An overlay is annotation, not content: these are far above any real
# card's entry count and exist so a hostile file cannot grow a room's state without limit.
MAX_OVERLAY_ENTRIES = 200
MAX_SETUP_ITEMS = 64
MAX_SETUP_OPTIONS = 20
MAX_OVERLAY_FILE_BYTES = 256_000
MAX_EXPOSE_PREFIXES = 32


class OverlayError(ValueError):
    """An overlay file (or a typed binding) the engine refuses. Carries a concise reason."""


@dataclass(frozen=True)
class OverlayEntry:
    """What the overlay says about ONE entry title.

    ``enabled`` is a tri-state: ``True``/``False`` override the file, ``None`` means "the
    file decides". ``condition`` REPLACES the file's condition when non-empty — widening is
    allowed here, unlike an untrusted import, because the writer is the room admin or a
    pack the admin chose to install.
    """

    enabled: bool | None = None
    condition: str = ""

    @property
    def is_empty(self) -> bool:
        return self.enabled is None and not self.condition

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {}
        if self.enabled is not None:
            data["enabled"] = self.enabled
        if self.condition:
            data["condition"] = self.condition
        return data


@dataclass(frozen=True)
class SetupItem:
    """One "set before play" choice the table still owes the module.

    ``path`` is a modvar id (a native lorecard's `setup: true` variable) or a dot-separated
    path into the imported MVU tree (an overlay file's declaration) — the same two spaces
    `core.varspace` unifies, so `.var set` reaches both with one command.
    """

    path: str
    options: tuple[str, ...] = ()
    labels: dict[str, str] = field(default_factory=dict)
    done: bool = False

    def label_for(self, locale: str) -> str:
        """The display label for `locale`: exact language → English → any → the path."""
        language = (locale or "en").split("-")[0].lower()
        for candidate in (self.labels.get(language), self.labels.get("en")):
            if candidate:
                return candidate
        for candidate in self.labels.values():
            if candidate:
                return candidate
        return self.path

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "options": list(self.options),
            "labels": dict(self.labels),
            "done": self.done,
        }


@dataclass(frozen=True)
class Overlay:
    """A room's whole overlay: per-title annotations plus the pending setup choices.

    ``expose`` is carried by a parsed FILE only (the prefixes it asks `.var expose` to
    publish at import time) and is deliberately NOT persisted: exposure state belongs to
    the MVU document that owns it, and storing a second copy here would be the "two truths"
    shape this design exists to avoid.
    """

    entries: dict[str, OverlayEntry] = field(default_factory=dict)
    setup: tuple[SetupItem, ...] = ()
    expose: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.entries and not self.setup

    def entry(self, title: str) -> OverlayEntry | None:
        return self.entries.get(title)

    def pending(self) -> tuple[SetupItem, ...]:
        return tuple(item for item in self.setup if not item.done)

    def to_dict(self) -> dict[str, Any]:
        return {
            "entries": {title: entry.to_dict() for title, entry in self.entries.items()},
            "setup": [item.to_dict() for item in self.setup],
        }


EMPTY_OVERLAY = Overlay()


# ---------------------------------------------------------------------------
# The one effective-state function
# ---------------------------------------------------------------------------


def apply(entry: LoreEntry, overlay: Overlay | None) -> LoreEntry:
    """`entry` as the room actually sees it — THE single definition of effective state.

    Returns the entry UNCHANGED (the same object) when the overlay says nothing about it,
    so a room with no overlay is byte-identical to a pre-M26 room on every path.
    """
    if overlay is None or not overlay.entries:
        return entry
    override = overlay.entries.get(entry.title)
    if override is None or override.is_empty:
        return entry
    changes: dict[str, Any] = {}
    if override.enabled is not None and override.enabled != entry.enabled:
        changes["enabled"] = override.enabled
    if override.condition and override.condition != entry.condition:
        changes["condition"] = override.condition
    return replace(entry, **changes) if changes else entry


def differs(entry: LoreEntry, overlay: Overlay | None) -> bool:
    """Whether the overlay actually changes this entry (the `*` marker in `.lore list`)."""
    return apply(entry, overlay) is not entry


def stale_titles(overlay: Overlay | None, titles: set[str]) -> tuple[str, ...]:
    """Overlay titles no entry carries any more — a card revision renamed or dropped them.

    Kept rather than pruned (a keeper may be mid-re-import), reported everywhere the
    overlay is shown, and removed by `.lore restore <title>`.
    """
    if overlay is None:
        return ()
    return tuple(title for title in overlay.entries if title not in titles)


# ---------------------------------------------------------------------------
# Pure transitions (never mutate their input)
# ---------------------------------------------------------------------------


def set_entry(
    overlay: Overlay,
    title: str,
    *,
    enabled: bool | None = None,
    condition: str | None = None,
) -> Overlay:
    """Write one title's override. ``enabled=None``/``condition=None`` leave that half alone.

    Raises `OverlayError` when `condition` does not parse in the closed grammar, or when a
    new title would exceed `MAX_OVERLAY_ENTRIES`.
    """
    title = str(title).strip()
    if not title:
        raise OverlayError("an overlay entry needs a title")  # i18n-exempt: command layer wraps it
    current = overlay.entries.get(title, OverlayEntry())
    new_condition = current.condition if condition is None else validate_expression(condition)
    new_enabled = current.enabled if enabled is None else enabled
    entries = dict(overlay.entries)
    if title not in entries and len(entries) >= MAX_OVERLAY_ENTRIES:
        raise OverlayError(f"the overlay already holds {MAX_OVERLAY_ENTRIES} entries")  # i18n-exempt: command layer wraps it
    entries[title] = OverlayEntry(enabled=new_enabled, condition=new_condition)
    return replace(overlay, entries=entries)


def clear_entry(overlay: Overlay, title: str) -> tuple[Overlay, int]:
    """Drop one title's override (back to the file's own state); ``"*"`` drops every one.

    Returns ``(overlay, removed_count)``; the setup items are untouched — they are the
    table's open choices, not an annotation of any single entry.
    """
    title = str(title).strip()
    if title == "*":
        return replace(overlay, entries={}), len(overlay.entries)
    if title not in overlay.entries:
        return overlay, 0
    entries = {key: value for key, value in overlay.entries.items() if key != title}
    return replace(overlay, entries=entries), 1


def set_setup_items(overlay: Overlay, items: list[SetupItem]) -> Overlay:
    """Merge declared setup items in, keeping the `done` state of paths already tracked.

    Called at import: a re-import of the same module must not re-open a choice the table
    already made, for the same reason a re-import never resets the variable tree.
    """
    by_path = {item.path: item for item in overlay.setup}
    merged: list[SetupItem] = list(overlay.setup)
    for item in items:
        existing = by_path.get(item.path)
        if existing is not None:
            merged[merged.index(existing)] = replace(item, done=existing.done)
            continue
        if len(merged) >= MAX_SETUP_ITEMS:
            break
        merged.append(item)
    return replace(overlay, setup=tuple(merged))


def mark_done(overlay: Overlay, path: str) -> tuple[Overlay, bool]:
    """Flip the setup item at `path` to done. Returns ``(overlay, changed)``."""
    path = str(path).strip()
    changed = False
    items: list[SetupItem] = []
    for item in overlay.setup:
        if item.path == path and not item.done:
            items.append(replace(item, done=True))
            changed = True
        else:
            items.append(item)
    return (replace(overlay, setup=tuple(items)), True) if changed else (overlay, False)


# ---------------------------------------------------------------------------
# Expression validation (closed grammar only)
# ---------------------------------------------------------------------------


def validate_expression(expression: str) -> str:
    """Return `expression` cleaned, or raise `OverlayError` naming what the parser refused.

    The grammar is `core.condexpr`'s CLOSED one — no function calls beyond `getvar`, no
    assignment, nothing executed. A `probe` of ``"1"`` is used for the compile-time dry run
    because a card's variables are routinely strings (``配置.难度 == "残酷"``), and a numeric
    probe would reject a perfectly good string comparison at write time.
    """
    text = " ".join(str(expression or "").split())
    if not text:
        return ""
    if len(text) > MAX_EXPR_LEN:
        raise OverlayError(f"expression too long ({len(text)} > {MAX_EXPR_LEN})")  # i18n-exempt: command layer wraps it
    try:
        compile_expression(text, probe="1")
    except CondExprError as exc:
        raise OverlayError(str(exc)) from exc
    return text


# ---------------------------------------------------------------------------
# The overlay FILE (pack-shipped annotations for foreign cards)
# ---------------------------------------------------------------------------


def parse_overlay_file(data: bytes | str, *, label: str = "") -> Overlay:
    """Parse an overlay YAML file (`§5.5`) into an `Overlay`, raising `OverlayError`.

    Strict by design: an author's annotation file that silently half-loads would leave the
    module half-alive in a way nothing reports. The one non-fatal case is an entry title
    the card no longer carries, which `validate_overlay` reports as a WARNING — cards get
    revised, and refusing the build for it would make an overlay a liability.
    """
    where = f"{label}: " if label else ""
    if isinstance(data, bytes):
        if len(data) > MAX_OVERLAY_FILE_BYTES:
            raise OverlayError(f"{where}overlay file exceeds the {MAX_OVERLAY_FILE_BYTES}-byte cap")  # i18n-exempt: author diagnostic
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise OverlayError(f"{where}overlay file is not UTF-8 text") from exc  # i18n-exempt: author diagnostic
    else:
        text = data
    try:
        raw = safe_load_no_aliases(text)
    except Exception as exc:
        raise OverlayError(f"{where}invalid overlay YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise OverlayError(f"{where}overlay root must be a mapping")  # i18n-exempt: author diagnostic
    declared = raw.get("format")
    if declared != OVERLAY_FORMAT:
        raise OverlayError(f"{where}unknown overlay format {declared!r} (want {OVERLAY_FORMAT!r})")  # i18n-exempt: author diagnostic
    unknown = set(raw) - {"format", "entries", "setup", "expose"}
    if unknown:
        raise OverlayError(f"{where}unknown overlay keys: {sorted(unknown)}")  # i18n-exempt: author diagnostic

    entries = _parse_file_entries(raw.get("entries"), where)
    setup = _parse_file_setup(raw.get("setup"), where)
    expose = _parse_file_expose(raw.get("expose"), where)
    return Overlay(entries=entries, setup=setup, expose=expose)


def _parse_file_entries(raw: Any, where: str) -> dict[str, OverlayEntry]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise OverlayError(f"{where}overlay entries must be a mapping of title -> override")  # i18n-exempt: author diagnostic
    if len(raw) > MAX_OVERLAY_ENTRIES:
        raise OverlayError(f"{where}overlay declares {len(raw)} entries; at most {MAX_OVERLAY_ENTRIES}")  # i18n-exempt: author diagnostic
    entries: dict[str, OverlayEntry] = {}
    for title, body in raw.items():
        name = str(title).strip()
        if not name:
            raise OverlayError(f"{where}an overlay entry has an empty title")  # i18n-exempt: author diagnostic
        if not isinstance(body, dict):
            raise OverlayError(f"{where}entry {name!r}: override must be a mapping")  # i18n-exempt: author diagnostic
        extra = set(body) - {"enabled", "condition"}
        if extra:
            raise OverlayError(f"{where}entry {name!r}: unknown keys {sorted(extra)}")  # i18n-exempt: author diagnostic
        enabled = body.get("enabled")
        if enabled is not None and not isinstance(enabled, bool):
            raise OverlayError(f"{where}entry {name!r}: enabled must be true or false")  # i18n-exempt: author diagnostic
        condition_raw = body.get("condition")
        if condition_raw is not None and not isinstance(condition_raw, str):
            raise OverlayError(f"{where}entry {name!r}: condition must be a string")  # i18n-exempt: author diagnostic
        try:
            condition = validate_expression(condition_raw or "")
        except OverlayError as exc:
            raise OverlayError(f"{where}entry {name!r}: {exc}") from exc
        # A binding on a file-disabled entry that stayed disabled would be an inert trap:
        # nothing would ever fire it and nothing would say why. A condition therefore
        # implies the switch, exactly as `.lore bind` does.
        if condition and enabled is None:
            enabled = True
        entries[name] = OverlayEntry(enabled=enabled, condition=condition)
    return entries


def _parse_file_setup(raw: Any, where: str) -> tuple[SetupItem, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise OverlayError(f"{where}overlay setup must be a list of items")  # i18n-exempt: author diagnostic
    if len(raw) > MAX_SETUP_ITEMS:
        raise OverlayError(f"{where}overlay declares {len(raw)} setup items; at most {MAX_SETUP_ITEMS}")  # i18n-exempt: author diagnostic
    items: list[SetupItem] = []
    seen: set[str] = set()
    for index, body in enumerate(raw):
        at = f"{where}setup[{index}]"
        if not isinstance(body, dict):
            raise OverlayError(f"{at}: must be a mapping")  # i18n-exempt: author diagnostic
        extra = set(body) - {"path", "options", "labels"}
        if extra:
            raise OverlayError(f"{at}: unknown keys {sorted(extra)}")  # i18n-exempt: author diagnostic
        path = str(body.get("path") or "").strip()
        if not path:
            raise OverlayError(f"{at}: needs a path")  # i18n-exempt: author diagnostic
        if path in seen:
            raise OverlayError(f"{at}: duplicate path {path!r}")  # i18n-exempt: author diagnostic
        seen.add(path)
        items.append(SetupItem(path=path, options=_parse_options(body.get("options"), at), labels=_parse_labels(body.get("labels"), at)))
    return tuple(items)


def _parse_options(raw: Any, at: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise OverlayError(f"{at}: options must be a list")  # i18n-exempt: author diagnostic
    if len(raw) > MAX_SETUP_OPTIONS:
        raise OverlayError(f"{at}: {len(raw)} options declared; at most {MAX_SETUP_OPTIONS}")  # i18n-exempt: author diagnostic
    options: list[str] = []
    for item in raw:
        if isinstance(item, (dict, list)):
            raise OverlayError(f"{at}: an option must be a scalar")  # i18n-exempt: author diagnostic
        text = str(item).strip()
        if text and text not in options:
            options.append(text)
    return tuple(options)


def _parse_labels(raw: Any, at: str) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise OverlayError(f"{at}: labels must be a mapping of locale -> text")  # i18n-exempt: author diagnostic
    labels: dict[str, str] = {}
    for locale, text in raw.items():
        if isinstance(locale, str) and isinstance(text, str) and text.strip():
            labels[locale.split("-")[0].lower()] = text.strip()[:50]
    return labels


def _parse_file_expose(raw: Any, where: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raise OverlayError(f"{where}overlay expose must be a list of path prefixes")  # i18n-exempt: author diagnostic
    prefixes: list[str] = []
    for item in raw[:MAX_EXPOSE_PREFIXES]:
        text = str(item).strip()
        if text and text not in prefixes:
            prefixes.append(text)
    return tuple(prefixes)


async def merge_overlay_file(
    documents: Any,
    chat_key: str,
    parsed: Overlay,
    *,
    current: Overlay,
    known_titles: set[str],
) -> tuple[Overlay, dict[str, int]]:
    """Fold a parsed overlay FILE into a room's overlay; returns ``(merged, report)``.

    Shared by the two doors a file can come through — `.lore overlay <file>` and the
    `overlay:` a pack declares beside a card — so a hand-applied file and a pack-applied
    one do exactly the same thing. `expose:` prefixes are handed to the MVU document's own
    exposure list rather than copied here: exposure has one owner.

    The report counts what LANDED, never what was asked for: unknown titles are reported
    (the card was revised) and a merge that would blow `MAX_OVERLAY_ENTRIES` stops rather
    than raising, because a partially-adopted card is still better than a refused one.
    """
    from core.mvu_compat import mvu_expose

    merged = current
    applied = 0
    for title, entry in parsed.entries.items():
        try:
            merged = set_entry(
                merged, title, enabled=entry.enabled, condition=entry.condition or None
            )
        except OverlayError:
            break
        applied += 1
    merged = set_setup_items(merged, list(parsed.setup))
    exposed = 0
    for prefix in parsed.expose:
        if await mvu_expose(documents, chat_key, prefix):
            exposed += 1
    return merged, {
        "entries": applied,
        "setup": len(parsed.setup),
        "unknown": len(validate_overlay(parsed, known_titles)),
        "exposed": exposed,
    }


def validate_overlay(overlay: Overlay, known_titles: set[str]) -> list[str]:
    """Build-time cross-check against the card's real lorebook: unknown titles are WARNINGS.

    Everything that can be checked without the card is already enforced by
    `parse_overlay_file` (format, grammar, caps); this is the half that needs the entries.
    """
    return [
        f"overlay: entry {title!r} is not in this card's lorebook"  # i18n-exempt: author diagnostic, surfaced by the pack build
        for title in overlay.entries
        if title not in known_titles
    ]


# ---------------------------------------------------------------------------
# Persistence (the keeper-only `lore_overlay` document)
# ---------------------------------------------------------------------------


def normalize_overlay(raw: Any) -> Overlay:
    """Tolerantly rebuild a stored overlay; a corrupt document degrades to EMPTY.

    Same posture as `core.mvu_compat._normalize_exposed`: the worst case is that the room
    falls back to the file's own state, which is a state the module shipped with — never an
    exception on the injection path.
    """
    if not isinstance(raw, dict):
        return EMPTY_OVERLAY
    entries: dict[str, OverlayEntry] = {}
    raw_entries = raw.get("entries")
    if isinstance(raw_entries, dict):
        for title, body in list(raw_entries.items())[:MAX_OVERLAY_ENTRIES]:
            name = str(title).strip()
            if not name or not isinstance(body, dict):
                continue
            enabled = body.get("enabled")
            enabled = enabled if isinstance(enabled, bool) else None
            condition = body.get("condition")
            condition = str(condition)[:MAX_EXPR_LEN] if isinstance(condition, str) else ""
            entry = OverlayEntry(enabled=enabled, condition=condition)
            if not entry.is_empty:
                entries[name] = entry
    setup: list[SetupItem] = []
    raw_setup = raw.get("setup")
    if isinstance(raw_setup, list):
        seen: set[str] = set()
        for body in raw_setup[:MAX_SETUP_ITEMS]:
            if not isinstance(body, dict):
                continue
            path = str(body.get("path") or "").strip()
            if not path or path in seen:
                continue
            seen.add(path)
            raw_options = body.get("options")
            options = tuple(
                str(option).strip()
                for option in (raw_options if isinstance(raw_options, list) else [])[:MAX_SETUP_OPTIONS]
                if str(option).strip()
            )
            raw_labels = body.get("labels")
            labels = (
                {str(key): str(value) for key, value in raw_labels.items() if isinstance(value, str)}
                if isinstance(raw_labels, dict)
                else {}
            )
            setup.append(SetupItem(path=path, options=options, labels=labels, done=bool(body.get("done"))))
    return Overlay(entries=entries, setup=tuple(setup))


async def load_overlay(documents: Any, chat_key: str) -> Overlay:
    """This room's overlay; EMPTY on a miss or a corrupt document."""
    doc = await documents.get(chat_key, OVERLAY_DOC_TYPE, OVERLAY_DOC_ID)
    return normalize_overlay(doc.data) if doc is not None else EMPTY_OVERLAY


async def save_overlay(documents: Any, chat_key: str, overlay: Overlay) -> None:
    """Persist `overlay` (entries + setup; `expose` is the MVU document's business)."""
    await documents.put(chat_key, OVERLAY_DOC_TYPE, OVERLAY_DOC_ID, overlay.to_dict())


async def mark_setup_done(documents: Any, chat_key: str, path: str) -> bool:
    """Record that the table has written `path`. Returns whether anything changed.

    Every writer of a variable calls this — `.var set`/`.var add` and the Keeper's own
    `set_stat`/`adjust_stat` — so "the choice was made" never depends on WHICH hand made
    it. Best-effort by construction: bookkeeping must never fail a variable write.
    """
    if not str(path).strip():
        return False
    try:
        overlay = await load_overlay(documents, chat_key)
        if not overlay.setup:
            return False
        updated, changed = mark_done(overlay, path)
        if changed:
            await save_overlay(documents, chat_key, updated)
        return changed
    except Exception:  # noqa: BLE001 - see docstring
        return False


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="lore_overlay",
        owner="core.lore_overlay",
        reset_scope="all",
        # The admin's switches over the module's own lore, plus the table's opening
        # choices: module annotation, so it leaves with the module exactly like
        # `world_lore` and `mvu_tree` do, and survives `.reset story`/`chars` — replaying
        # the same scenario must not silently revert the difficulty the table picked.
        doc_types=frozenset({OVERLAY_DOC_TYPE}),
        storages=frozenset({STORAGE_DOCUMENTS}),
    ),
)
