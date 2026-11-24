"""Advisory pack lint — what a pack SOURCE tree gets wrong without failing its build.

`core.pack.build_pack` answers "is this a valid pack": every file parses, every cap
holds, the trust card is honest. It cannot answer "does this pack do what its author
meant", because the mistakes below are all perfectly valid packs:

- a panel block bound to a variable no player screen ever receives (a keeper-visibility
  tracker, or an imported-card leaf nothing in the pack exposes) renders as NOTHING —
  the block is omitted, silently, by the same fail-closed rule that keeps module
  internals off player screens. That trap is one the exposure model itself created;
- a variable declared and then mentioned nowhere else;
- a lore entry that keyword matching can never select, or whose condition reads a
  variable nothing declares;
- a bilingual pack with a label written in one language only.

Three properties hold for every check here:

1. **Deterministic, offline, no model.** Pure functions over the source tree and the
   real engine parsers (iron rule #1). Nothing is imported into a room, nothing runs.
2. **Advisory.** A finding never fails a build and never blocks a mount. The lint exists
   to say something out loud at the moment the author can still fix it.
3. **Only what is certain.** Each check reports a state the engine's own rules make
   true — "would a player's screen receive this variable" is asked of the real
   document projections (`core.documents.project`), never re-derived here — and steps
   aside where runtime could change the answer: a variable a hook
   script or a skill mentions may be created at the table, so it is never called
   undeclared; an ``[InitVar]`` block the static parser cannot read turns the
   tree-shape checks off rather than guessing. A lint that cries wolf gets ignored,
   and then the one real finding is lost with the rest.

Callers: ``python -m app --lint <src-dir>``, ``--pack`` (printed with the build's own
warnings), and the dev room (sent to the mounting admin after every reload).

**Findings are keeper-grade.** They name secret entry titles, keeper-visibility
variables and unexposed variable paths — the module's internals, by design. A caller
that can reach a room must deliver them to the admin who asked and to nobody else
(`gateway.dev_room` does; iron rule #3). The two CLI callers print to the operator.

A finding carries no prose of its own: it is a message KEY plus parameters, rendered
through the locale catalogs (``pack.lint.msg.*``) by whoever shows it. These notes are
the one thing an author reads from this module, and most authors here write in Chinese —
English-only diagnostics would be the wrong economy (iron rule #4).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from core.card_split import card_hook_codes
from core.charcard import MAX_CARD_FILE_BYTES, CharacterCard, parse_card_bytes
from core.condexpr import CondExprError, referenced_paths
from core.documents import KEEPER_VIEWER, MODVARS_ID, MVU_ID, PLAYER_VIEWER, Document, project
from core.lore_overlay import Overlay, OverlayError, parse_overlay_file
from core.lore_overlay import apply as apply_overlay
from core.lorecard import looks_like_lorecard, parse_lorecard_bytes
from core.modvars import MODVARS_DOC_TYPE
from core.mvu_compat import (
    MAX_FLAT_LEAVES,
    MVU_DOC_TYPE,
    _normalize_prefix,  # deliberate: the room normalizes an exposure prefix exactly this way
    is_value_with_desc,
    normalize_tree,
)
from core.pack import (
    MANIFEST_NAME,
    MAX_LOREBOOK_BYTES,
    MAX_MANIFEST_BYTES,
    PackError,
    PackManifest,
    _source_file,  # deliberate: the build's own symlink/escape-refusing source resolver
    parse_manifest_text,
)
from core.panels import PanelSpec, parse_panels_text
from core.worldbook import (
    MAX_IMPORT_CONTENT_CHARS,
    LoreEntry,
    _consume_initvar,  # deliberate: the import's own definition of a declaration entry
    _normalize_import_entry,  # deliberate: the entry a keeper import would actually store
)
from core.yaml_safety import safe_load_no_aliases

__all__ = ["MESSAGE_KEYS", "LintFinding", "lint_pack"]

_LOCALES = ("en", "zh")
# The two root spellings `core.varspace.build_resolver` strips before it looks a path up.
_ROOT_PREFIXES = ("variables.", "stat_data.")
# A panel addresses an imported-card leaf as ``mvu.<path>`` (`net.state._variables`).
_MVU_ID_PREFIX = "mvu."
# Text files whose contents can mention — or, for code, create — a variable.
_TEXT_SUFFIXES = frozenset({".html", ".htm", ".js", ".mjs", ".css", ".json", ".md", ".txt", ".yaml", ".yml"})
_MAX_CORPUS_FILE_BYTES = 2_000_000
# All mention evidence together. Past this the lint stops READING, and every check that
# needs "nothing mentions it" switches off — a partial corpus can only cry wolf.
_MAX_CORPUS_CHARS = 8_000_000
# A localized map sits a handful of levels down in any real document; a hostile one can
# nest thousands deep.
_MAX_WALK_DEPTH = 24
# A hook that builds a variable name at runtime (`setvar('coalition_' + who, 0)`) can
# create leaves no static read will ever see: any first argument that is not one plain
# string literal counts.
_DYNAMIC_WRITE_RE = re.compile(r"""\b(?:setvar|incvar)\s*\((?!\s*(?:'[^'$\\]*'|"[^"$\\]*")\s*[,)])""")
_ASCII_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


# Every message this module can emit, as ``<code>`` or ``<code>.<variant>``. The catalogs
# carry one ``pack.lint.msg.<key>`` per entry in BOTH locales (`tests/core/test_pack_lint`
# pins the set), and `_note` refuses a key that is not listed — a finding can never reach
# an author as a raw key.
MESSAGE_KEYS: tuple[str, ...] = (
    "unreadable",
    "card-note",
    "panel-var-keeper-only.bind",
    "panel-var-keeper-only.gate",
    "panel-var-unknown.bind",
    "panel-var-unknown.gate",
    "panel-var-unknown.spelling",
    "panel-var-unknown.leaf-bind",
    "panel-var-unknown.leaf-gate",
    "panel-var-unexposed.bind",
    "panel-var-unexposed.gate",
    "panel-var-unexposed.repeat",
    "panel-repeat-empty",
    "var-unused",
    "lore-no-keys",
    "lore-never-fires",
    "lore-condition-unknown-var",
    "overlay-expose-unknown",
    "locale-gap",
)
MESSAGE_KEY_PREFIX = "pack.lint.msg."


class _Translator(Protocol):
    """Duck-typed `infra.i18n.I18n` — the one lookup a finding needs to be shown."""

    def t(self, key: str, /, **params: Any) -> str: ...


@dataclass(frozen=True)
class LintFinding:
    """One advisory note. ``code`` is the stable machine id tools key on; ``where`` is
    the file plus the place in it (structural, language-neutral); ``key`` + ``params``
    are the message, rendered per locale by the caller."""

    code: str
    where: str
    key: str
    params: Mapping[str, Any] = field(default_factory=dict)

    def message(self, i18n: _Translator) -> str:
        return i18n.t(MESSAGE_KEY_PREFIX + self.key, **self.params)

    def render(self, i18n: _Translator) -> str:
        return f"{self.where}: {self.message(i18n)} [{self.code}]"

    def to_dict(self, i18n: _Translator) -> dict[str, str]:
        return {"code": self.code, "where": self.where, "message": self.message(i18n)}


def _note(tree: _Tree, key: str, where: str, **params: Any) -> None:
    if key not in MESSAGE_KEYS:
        raise KeyError(f"pack lint message key not declared: {key!r}")  # i18n-exempt: programmer error, never shown
    tree.findings.append(LintFinding(code=key.split(".", 1)[0], where=where, key=key, params=params))


class _Corpus:
    """Text gathered for one question — "does anything here name X?" — answered in one
    pass per text instead of one scan per name: ASCII names are looked up in a word set
    built as the text arrives, and only non-ASCII names (CJK has no word boundary to
    split on) fall back to a substring test."""

    def __init__(self) -> None:
        self._texts: list[str] = []
        self._words: set[str] = set()
        self.chars = 0
        #: False once a text had to be turned away: absence is no longer evidence.
        self.complete = True

    def add(self, text: str) -> None:
        if not text:
            return
        if self.chars + len(text) > _MAX_CORPUS_CHARS:
            self.complete = False
            return
        self.chars += len(text)
        self._texts.append(text)
        self._words.update(_ASCII_WORD_RE.findall(text))

    def mentions(self, needle: str) -> bool:
        """Whether any text names ``needle``. An ASCII name must stand as a whole word
        (``day`` is not mentioned by ``today``); anything else is matched as written."""
        if not needle:
            return False
        if _ASCII_WORD_RE.fullmatch(needle):
            return needle in self._words
        return any(needle in text for text in self._texts)

    def any_matches(self, pattern: re.Pattern[str]) -> bool:
        return any(pattern.search(text) for text in self._texts)

    def texts_containing(self, marker: str) -> list[str]:
        return [text for text in self._texts if marker in text]


@dataclass
class _Tree:
    """Everything the checks read, gathered in one pass over the declared contents."""

    manifest: PackManifest
    #: Native variable specs by id (`core.modvars` shape), and the card each came from.
    native: dict[str, dict[str, Any]] = field(default_factory=dict)
    native_where: dict[str, str] = field(default_factory=dict)
    #: The imported-card variable tree every `[InitVar]` entry in the pack seeds, merged.
    mvu: dict[str, Any] = field(default_factory=dict)
    #: False once any declaration entry could not be read statically: from then on the
    #: tree is a lower bound, and "this leaf does not exist" is no longer a certainty.
    mvu_complete: bool = True
    #: Prefixes the pack's overlays publish to player panels, with the file naming each.
    exposes: list[tuple[str, str]] = field(default_factory=list)
    #: ``(file, entry)`` — every lore entry as a keeper import would store it, with the
    #: card's own overlay already applied (effective state has one definition).
    lore: list[tuple[str, LoreEntry]] = field(default_factory=list)
    panels: list[tuple[str, PanelSpec]] = field(default_factory=list)
    #: Everything that can MENTION a variable — the evidence behind "nothing else names
    #: it": skill bodies, lore text and conditions, hook scripts, tier-2 panel code, prep
    #: scripts, presets, rule and kit files.
    corpus: _Corpus = field(default_factory=lambda: _Corpus())
    #: The subset that reaches the Keeper's context or RUNS, and can therefore bring a
    #: variable into existence at the table: a hook's or a lore template's ``setvar``, a
    #: card telling the model to ``_.set`` a path, a skill telling the Keeper to define a
    #: tracker. A condition or a panel binding only READS, so neither is in here.
    runtime: _Corpus = field(default_factory=lambda: _Corpus())
    #: ``(file, raw document)`` pairs the locale-gap walk reads.
    documents: list[tuple[str, Any]] = field(default_factory=list)
    findings: list[LintFinding] = field(default_factory=list)


def lint_pack(source_dir: Path | str) -> list[LintFinding]:
    """Every advisory finding for the pack source tree at ``source_dir``.

    Raises :class:`core.pack.PackError` only when there is no readable ``pack.yaml`` —
    without a manifest there is nothing to lint. Any OTHER file that does not parse is
    reported as an ``unreadable`` finding and skipped (the build will refuse it with the
    full reason), so one broken file never hides what is wrong with the rest.
    """
    source = Path(source_dir)
    manifest_path = source / MANIFEST_NAME
    if not manifest_path.is_file():
        raise PackError(f"no {MANIFEST_NAME} in {source}")
    try:
        if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            raise PackError(f"{MANIFEST_NAME} exceeds the {MAX_MANIFEST_BYTES}-byte cap")
        manifest_text = manifest_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise PackError(f"{MANIFEST_NAME}: {exc}") from exc
    manifest = parse_manifest_text(manifest_text, expect_trust=False)
    tree = _Tree(manifest=manifest)
    try:
        tree.documents.append((MANIFEST_NAME, safe_load_no_aliases(manifest_text)))
    except Exception:  # noqa: BLE001 — parse_manifest_text already accepted this text
        pass

    _gather_cards(tree, source)
    _gather_lorebooks(tree, source)
    _gather_panels(tree, source)
    _gather_text(tree, source)
    # The room stores the tree through `normalize_tree` (depth, node budget, string
    # keys); judge the tree the room would actually hold, which also bounds every walk.
    tree.mvu = normalize_tree(tree.mvu)
    if tree.runtime.any_matches(_DYNAMIC_WRITE_RE):
        tree.mvu_complete = False

    _check_panels(tree)
    _check_unused_variables(tree)
    _check_lore(tree)
    _check_exposes(tree)
    _check_locale_gaps(tree)
    return tree.findings


# ---------------------------------------------------------------------------
# Gathering
# ---------------------------------------------------------------------------


def _read_bytes(tree: _Tree, source: Path, relative: str, cap: int) -> bytes | None:
    try:
        path = _source_file(source, relative)
        if path.stat().st_size > cap:
            raise PackError(f"exceeds the {cap}-byte cap")
        return path.read_bytes()
    except (PackError, OSError) as exc:
        _unreadable(tree, relative, exc)
        return None


def _read_text(tree: _Tree, source: Path, relative: str, cap: int = MAX_LOREBOOK_BYTES) -> str | None:
    data = _read_bytes(tree, source, relative, cap)
    if data is None:
        return None
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        _unreadable(tree, relative, exc)
        return None


def _unreadable(tree: _Tree, relative: str, exc: Exception) -> None:
    _note(tree, "unreadable", relative, error=str(exc))


def _book_entries(book: Any) -> list[dict[str, Any]]:
    """A card's or lorebook's raw entry dicts, whichever of the three shapes it uses."""
    entries = book.get("entries") if isinstance(book, dict) else book
    if isinstance(entries, dict):
        entries = list(entries.values())
    return [raw for raw in entries if isinstance(raw, dict)] if isinstance(entries, list) else []


def _gather_entries(tree: _Tree, relative: str, raw_entries: list[dict[str, Any]], overlay: Overlay | None) -> None:
    """Split one file's entries the way a KEEPER import does: declaration entries seed
    the variable tree, everything else becomes lore (with the overlay applied)."""
    for index, raw in enumerate(raw_entries, start=1):
        try:
            declared = _consume_initvar(raw)
            entry = None if declared is not None else _normalize_import_entry(
                raw, source="", index=index, is_keeper=True
            )
        except (TypeError, ValueError, AttributeError) as exc:
            # A row the import itself chokes on (`keys: 5`, `secondary_keys: null`): the
            # build does not parse entries, so this is the first place anyone hears of it.
            _note(tree, "unreadable", f"{relative}: entries[{index}]", error=f"{type(exc).__name__}: {exc}")
            continue
        if declared is not None:
            if declared:
                _merge_tree(tree.mvu, normalize_tree(declared))
            else:
                tree.mvu_complete = False
            continue
        # Same two exits as the import: an empty entry stores nothing, and an oversized
        # one is skipped whole — neither ever exists in a room to be judged.
        if entry is None or not entry.content or len(entry.content) > MAX_IMPORT_CONTENT_CHARS:
            continue
        entry = apply_overlay(entry, overlay)
        tree.lore.append((relative, entry))
        tree.corpus.add(entry.content)
        tree.runtime.add(entry.content)
        # The decorator peeled the condition off the content; it still names what it reads.
        tree.corpus.add(entry.condition)


def _merge_tree(target: dict[str, Any], incoming: Mapping[str, Any]) -> None:
    """Existing keys win, like the room's own InitVar merge; only the SHAPE matters here."""
    for key, value in incoming.items():
        name = str(key)
        if name not in target:
            target[name] = value
        elif isinstance(target[name], dict) and isinstance(value, Mapping):
            _merge_tree(target[name], value)


def _gather_cards(tree: _Tree, source: Path) -> None:
    for card_entry in tree.manifest.card_entries:
        data = _read_bytes(tree, source, card_entry.path, MAX_CARD_FILE_BYTES)
        if data is None:
            continue
        name = PurePosixPath(card_entry.path).name
        card: CharacterCard
        native = looks_like_lorecard(data)
        try:
            if native:
                bundle = parse_lorecard_bytes(data, filename=name)
                card = bundle.card
                for spec in bundle.variable_specs:
                    # Two cards may declare one id differently, and which the room ends
                    # up with depends on what the admin imports last. Keep the reading
                    # that produces no finding: player-visible wins.
                    known = tree.native.get(spec["id"])
                    if known is None or known.get("visibility") == "keeper":
                        tree.native[spec["id"]] = spec
                    tree.native_where.setdefault(spec["id"], card_entry.path)
                # The native parser SKIPS a malformed row and says so; the build never
                # printed those notes, so an author only met them at import time.
                for warning in bundle.warnings:
                    _note(tree, "card-note", card_entry.path, detail=warning)
            else:
                card = parse_card_bytes(data, filename=name)
        except (ValueError, RecursionError) as exc:
            # RecursionError: JSON nested past what this interpreter's decoder will
            # follow (the limit differs by Python version) — the ST parser lets it out.
            _unreadable(tree, card_entry.path, exc)
            continue

        overlay: Overlay | None = None
        if card_entry.overlay:
            overlay_text = _read_text(tree, source, card_entry.overlay)
            if overlay_text is not None:
                try:
                    overlay = parse_overlay_file(overlay_text, label=card_entry.overlay)
                except OverlayError as exc:
                    _unreadable(tree, card_entry.overlay, exc)
                else:
                    tree.exposes.extend(
                        (cleaned, card_entry.overlay)
                        for cleaned in (_normalize_prefix(prefix) for prefix in overlay.expose)
                        if cleaned
                    )
                    try:
                        tree.documents.append((card_entry.overlay, safe_load_no_aliases(overlay_text)))
                    except Exception:  # noqa: BLE001 — parse_overlay_file already accepted it
                        pass

        _gather_entries(tree, card_entry.path, _book_entries(card.character_book), overlay)
        if native and isinstance(card.raw, dict):
            # The one localized section of a native card. A foreign card's raw document
            # is NOT walked: its extension blobs are someone else's data, and an
            # `{"en": …}` object in there says nothing about this pack's translations.
            tree.documents.append((card_entry.path, {"variables": card.raw.get("variables")}))
        # Everything of the card that reaches the Keeper's context or runs.
        for text in (
            *card_hook_codes(card),
            card.description,
            card.personality,
            card.scenario,
            card.first_mes,
            card.mes_example,
            card.creator_notes,
            card.system_prompt,
            card.post_history_instructions,
        ):
            tree.corpus.add(text)
            tree.runtime.add(text)


def _gather_lorebooks(tree: _Tree, source: Path) -> None:
    for relative in tree.manifest.contents["lorebooks"]:
        text = _read_text(tree, source, relative)
        if text is None:
            continue
        try:
            raw = json.loads(text)
        except (ValueError, RecursionError) as exc:
            _unreadable(tree, relative, exc)
            continue
        if isinstance(raw, dict) and "entries" not in raw:
            book = raw.get("character_book") or (raw.get("data") or {}).get("character_book")
            if isinstance(book, dict):
                raw = book
        _gather_entries(tree, relative, _book_entries(raw), None)


def _gather_panels(tree: _Tree, source: Path) -> None:
    for relative in tree.manifest.contents["panels"]:
        text = _read_text(tree, source, relative)
        if text is None:
            continue
        try:
            parsed = parse_panels_text(text)
            tree.documents.append((relative, safe_load_no_aliases(text)))
        except Exception as exc:  # noqa: BLE001 — every parse failure is the same finding
            _unreadable(tree, relative, exc)
            continue
        for panel in parsed:
            tree.panels.append((relative, panel))
            # Tier-2 panel code reads variables through the client's own API; it cannot be
            # analysed statically, but its text still counts as a mention.
            for asset in dict.fromkeys(filter(None, (panel.entry, *panel.assets))):
                _add_text_file(tree, source, asset, runtime=True)


def _gather_text(tree: _Tree, source: Path) -> None:
    for skill_dir in tree.manifest.contents["skills"]:
        _add_text_file(tree, source, f"{skill_dir}/SKILL.md", runtime=True)
        _add_text_file(tree, source, f"{skill_dir}/hooks.js", runtime=True)  # optional file
    for kind in ("prep", "presets"):
        # A prep script runs; a preset is prompt text folded into the Keeper's context.
        for relative in tree.manifest.contents[kind]:
            _add_text_file(tree, source, relative, runtime=True)
    for relative in tree.manifest.contents["rulepacks"]:
        _add_text_file(tree, source, relative)
    for relative in tree.manifest.contents["presentation"]:
        text = _add_text_file(tree, source, relative)
        if text is None:
            continue
        try:
            document = safe_load_no_aliases(text)
        except Exception:  # noqa: BLE001 — the build reports a kit that does not parse
            continue
        if isinstance(document, dict):
            # `style` is the image-generation prompt (`PresentationKit.style_for`): no
            # viewer ever reads it, so a one-language `style.keywords` is not a gap.
            document = {key: value for key, value in document.items() if key != "style"}
        tree.documents.append((relative, document))


def _add_text_file(tree: _Tree, source: Path, relative: str, *, runtime: bool = False) -> str | None:
    """Add one pack file to the mention corpus. Best-effort and silent: this is evidence
    gathering, not validation — a missing or binary file simply contributes nothing."""
    if PurePosixPath(relative).suffix.lower() not in _TEXT_SUFFIXES:
        return None
    try:
        path = _source_file(source, relative)
        if not path.is_file():
            return None
        if path.stat().st_size > _MAX_CORPUS_FILE_BYTES:
            # Unread evidence: "nothing mentions it" can no longer be claimed.
            tree.corpus.complete = False
            if runtime:
                tree.runtime.complete = False
            return None
        text = path.read_text(encoding="utf-8-sig")
    except (PackError, OSError, UnicodeDecodeError):
        return None
    tree.corpus.add(text)
    if runtime:
        tree.runtime.add(text)
    return text


# ---------------------------------------------------------------------------
# Shared predicates
# ---------------------------------------------------------------------------


def _strip_root(path: str) -> str:
    for prefix in _ROOT_PREFIXES:
        if path.startswith(prefix):
            return path[len(prefix) :]
    return path


def _tree_node(tree: Any, path: str) -> tuple[bool, Any]:
    """``(exists, node)`` for one dot path — existence, unlike
    `core.varspace.resolve_tree_path`, which cannot tell a null leaf from a missing one."""
    node = tree
    for segment in path.split("."):
        if isinstance(node, dict) and segment in node:
            node = node[segment]
        elif isinstance(node, list) and not is_value_with_desc(node):
            try:
                node = node[int(segment)]
            except (ValueError, IndexError):
                return False, None
        else:
            return False, None
    return True, node


def _tree_has(tree: _Tree, path: str) -> bool:
    return bool(path) and _tree_node(tree.mvu, path)[0]


def _player_native_ids(tree: _Tree) -> set[str]:
    """The native variables a PLAYER-grade state frame carries — which is every state
    frame, the admin's included (`net.state._variables`). Asked of the real `modvars`
    projection, so this module can never drift from what the wire actually ships."""
    doc = Document(id=MODVARS_ID, type=MODVARS_DOC_TYPE, schema_version=1, data={"specs": tree.native, "values": {}})
    view = project(doc, PLAYER_VIEWER) or {}
    return set(view.get("specs") or {})


def _mvu_doc(tree_data: dict[str, Any], tree: _Tree) -> Document:
    """The `mvu_tree` document a room would hold once the keeper imported this pack's
    cards and its overlays published their `expose:` prefixes."""
    exposed = [prefix for prefix, _file in tree.exposes]
    return Document(id=MVU_ID, type=MVU_DOC_TYPE, schema_version=1, data={"tree": tree_data, "exposed": exposed})


def _exposed(tree: _Tree, path: str) -> bool:
    """Whether a player's screen would receive the leaf at ``path``.

    Answered by the real `mvu_tree` projection over a one-leaf PROBE tree, not over the
    pack's own tree: exposure is a property of the path and the prefixes alone, so the
    answer stays right even when an `[InitVar]` block could not be read statically."""
    probe: dict[str, Any] = {}
    node = probe
    segments = path.split(".")
    for segment in segments[:-1]:
        node = node.setdefault(segment, {})
    node[segments[-1]] = 0
    view = project(_mvu_doc(probe, tree), PLAYER_VIEWER) or {}
    return bool(view.get("leaves"))


def _exposed_leaf_ids(tree: _Tree) -> list[str] | None:
    """The ``mvu.<path>`` ids of every leaf a player's screen would receive, or ``None``
    when the pack's tree is not fully known (an unreadable declaration, or more leaves
    than one flatten carries) — the keeper projection tags each leaf with its exposure."""
    if not tree.mvu_complete:
        return None
    view = project(_mvu_doc(tree.mvu, tree), KEEPER_VIEWER) or {}
    leaves = view.get("leaves") or []
    if len(leaves) >= MAX_FLAT_LEAVES:
        return None
    return [_MVU_ID_PREFIX + str(leaf["path"]) for leaf in leaves if leaf.get("exposed")]


def _could_appear_at_runtime(tree: _Tree, name: str) -> bool:
    """A name that anything reaching the Keeper's context or running at the table
    mentions (a hook, a lore template's ``setvar``, a skill body, a preset, tier-2 panel
    code) may be brought into existence there — never call it undeclared. An incomplete
    corpus answers yes: unread text may be the text that creates it."""
    if not tree.runtime.complete:
        return True
    return tree.runtime.mentions(name) or tree.runtime.mentions(name.rsplit(".", 1)[-1])


# ---------------------------------------------------------------------------
# Panels
# ---------------------------------------------------------------------------


def _panel_references(blocks: Any, label: str) -> Iterator[tuple[str, str, str]]:
    """Every variable a block list reads, as ``(kind, id, where)``: kind is ``bind`` (a
    ``$var``), ``gate`` (a ``visible_when`` path) or ``repeat`` (a prefix)."""
    for index, block in enumerate(blocks or ()):
        if not isinstance(block, dict):
            continue
        where = f"{label}[{index}]"
        condition = block.get("visible_when")
        if isinstance(condition, str):
            try:
                for path in referenced_paths(condition):
                    yield "gate", path, f"{where}.visible_when"
            except CondExprError:
                pass
        repeat = block.get("repeat")
        if isinstance(repeat, dict):
            yield "repeat", str(repeat.get("prefix") or ""), f"{where}.repeat"
            yield from _panel_references([repeat.get("block")], f"{where}.repeat.block")
            continue
        yield from _bindings(block, where)


def _bindings(node: Any, where: str) -> Iterator[tuple[str, str, str]]:
    if isinstance(node, dict):
        if set(node) == {"$var"} and isinstance(node["$var"], str):
            yield "bind", node["$var"], where
            return
        for key, value in node.items():
            if key == "visible_when":
                continue
            yield from _bindings(value, f"{where}.{key}")
    elif isinstance(node, (list, tuple)):
        for index, value in enumerate(node):
            yield from _bindings(value, f"{where}[{index}]")


def _check_panels(tree: _Tree) -> None:
    for file, panel in tree.panels:
        base = f"{file}: panels[{panel.id}]"
        sections = [(panel.blocks, f"{base}.blocks")]
        if panel.fallback:
            sections.append((panel.fallback, f"{base}.fallback"))
        for blocks, label in sections:
            for kind, name, where in _panel_references(blocks, label):
                if kind == "repeat":
                    _judge_repeat(tree, name, where)
                else:
                    _judge_reference(tree, kind, name, where)


def _judge_reference(tree: _Tree, kind: str, name: str, where: str) -> None:
    """One ``$var`` (``bind``) or ``visible_when`` path (``gate``). The two fail
    differently for the viewer — a missed binding drops its whole block, a gate is
    evaluated as if the variable were unset — so each has its own message."""
    if name.startswith(_MVU_ID_PREFIX):
        path = name[len(_MVU_ID_PREFIX) :]
        if tree.mvu_complete and not _tree_has(tree, path) and not _could_appear_at_runtime(tree, path):
            _note(tree, f"panel-var-unknown.leaf-{kind}", where, name=path)
        elif not _exposed(tree, path):
            _note(tree, f"panel-var-unexposed.{kind}", where, name=path)
        return
    spec = tree.native.get(name)
    if spec is None:
        if _could_appear_at_runtime(tree, name):
            return
        if _tree_has(tree, _strip_root(name)):
            _note(tree, "panel-var-unknown.spelling", where, name=name, suggestion=_MVU_ID_PREFIX + _strip_root(name))
        else:
            _note(tree, f"panel-var-unknown.{kind}", where, name=name)
    elif name not in _player_native_ids(tree):
        _note(tree, f"panel-var-keeper-only.{kind}", where, name=name)


def _judge_repeat(tree: _Tree, prefix: str, where: str) -> None:
    """A ``repeat`` draws one row per VISIBLE variable whose id starts with the prefix —
    a plain string prefix over one id space, native ids and ``mvu.<path>`` leaves alike."""
    if not prefix:
        return
    if any(name.startswith(prefix) for name in _player_native_ids(tree)):
        return
    reaches_leaves = prefix.startswith(_MVU_ID_PREFIX) or (_MVU_ID_PREFIX.startswith(prefix) and bool(tree.mvu))
    if reaches_leaves:
        exposed_ids = _exposed_leaf_ids(tree)
        if exposed_ids is None or any(leaf_id.startswith(prefix) for leaf_id in exposed_ids):
            return
        if _could_appear_at_runtime(tree, prefix[len(_MVU_ID_PREFIX) :]):
            return
        _note(tree, "panel-var-unexposed.repeat", where, name=prefix)
        return
    if _could_appear_at_runtime(tree, prefix) or _could_appear_at_runtime(tree, prefix.rstrip("._-")):
        return
    _note(tree, "panel-repeat-empty", where, name=prefix)


# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------


def _check_unused_variables(tree: _Tree) -> None:
    if not tree.native or not tree.corpus.complete:
        return
    referenced: set[str] = set()
    prefixes: list[str] = []
    for _file, panel in tree.panels:
        for blocks in (panel.blocks, panel.fallback or ()):
            for kind, name, _where in _panel_references(blocks, ""):
                if kind == "repeat":
                    prefixes.append(name)
                else:
                    referenced.add(_strip_root(name))
    for _file, entry in tree.lore:
        referenced.update(_condition_paths(entry.condition))

    for var_id, spec in tree.native.items():
        # A "set before play" variable is read by the setup flow itself.
        if spec.get("setup") or var_id in referenced:
            continue
        if any(prefix and var_id.startswith(prefix) for prefix in prefixes):
            continue
        labels = [text for text in (spec.get("labels") or {}).values() if isinstance(text, str)]
        if tree.corpus.mentions(var_id) or any(tree.corpus.mentions(label) for label in labels):
            continue
        _note(tree, "var-unused", f"{tree.native_where.get(var_id, MANIFEST_NAME)}: variables[{var_id}]")


def _condition_paths(condition: str) -> tuple[str, ...]:
    """The variable paths a condition reads, root prefix stripped; ``()`` for an
    expression outside the closed grammar (an arbitrary-JS ``@@if`` is the sandbox's to
    judge, not this module's)."""
    if not condition:
        return ()
    try:
        return tuple(_strip_root(path) for path in referenced_paths(condition))
    except CondExprError:
        return ()


# ---------------------------------------------------------------------------
# Lore
# ---------------------------------------------------------------------------


def _check_lore(tree: _Tree) -> None:
    # Templates that pull another entry in by title (`getwi('Ledger')`) are a second
    # way into a prompt that keyword matching knows nothing about.
    pulled_by_title = tree.runtime.texts_containing("getwi")
    for file, entry in tree.lore:
        # A switched-off entry is parked on purpose (the admin, a hook or an overlay
        # turns it on); judge only what is live as shipped.
        if not entry.enabled:
            continue
        where = f"{file}: entries[{entry.title}]"
        if entry.probability <= 0:
            _note(tree, "lore-never-fires", where)
        elif (
            not entry.constant
            and not any(str(key).strip() for key in entry.keys)
            and not any(entry.title in text for text in pulled_by_title)
        ):
            _note(tree, "lore-no-keys", where)
        for path in _condition_paths(entry.condition):
            if path in tree.native or _tree_has(tree, path):
                continue
            if not tree.mvu_complete or _could_appear_at_runtime(tree, path):
                continue
            _note(tree, "lore-condition-unknown-var", where, name=path)


def _check_exposes(tree: _Tree) -> None:
    if not tree.mvu_complete:
        return
    for prefix, file in tree.exposes:
        if prefix == "*" or _tree_has(tree, prefix) or _could_appear_at_runtime(tree, prefix):
            continue
        _note(tree, "overlay-expose-unknown", f"{file}: expose", name=prefix)


# ---------------------------------------------------------------------------
# Locale gaps
# ---------------------------------------------------------------------------


def _check_locale_gaps(tree: _Tree) -> None:
    """A BILINGUAL pack with a text written in one language only.

    "Bilingual" is the pack's own claim: its manifest ``name`` carries both languages. A
    single-language pack is a complete single-language pack, not sixty missing
    translations, so it gets no findings here at all. Only an authored ``{en, zh}``-shaped
    MAP with one side empty counts; a bare string is the author saying "this text is the
    same everywhere" (``HP``, a proper noun) and is left alone.
    """
    if not all(tree.manifest.name.get(locale) for locale in _LOCALES):
        return
    for file, document in tree.documents:
        for path, present in _locale_maps(document, ""):
            missing = [locale for locale in _LOCALES if locale not in present]
            if missing and present:
                _note(
                    tree,
                    "locale-gap",
                    f"{file}: {path}" if path else file,
                    present=", ".join(sorted(present)),
                    missing=", ".join(missing),
                )


def _locale_maps(node: Any, path: str, depth: int = 0) -> Iterator[tuple[str, set[str]]]:
    """Every ``{en, zh}``-shaped map under ``node`` as ``(path, locales with text)``.

    Two shapes count: a map of locale → text, and ``option_labels``' map of locale →
    {option: text}. Anything else that merely happens to have an ``en`` key is not a
    localized field and is walked through."""
    if depth > _MAX_WALK_DEPTH:
        return
    if isinstance(node, dict):
        keys = set(node)
        if keys and keys <= set(_LOCALES):
            values = list(node.values())
            if all(isinstance(value, str) for value in values):
                yield path, {locale for locale, value in node.items() if value.strip()}
                return
            if all(isinstance(value, dict) for value in values):
                options = {str(option) for value in values for option in value}
                for option in sorted(options):
                    present = {
                        locale
                        for locale, value in node.items()
                        if isinstance(value.get(option), str) and value[option].strip()
                    }
                    yield f"{path}.{option}", present
                if len(keys) < len(_LOCALES):
                    yield path, keys
                return
        for key, value in node.items():
            yield from _locale_maps(value, f"{path}.{key}" if path else str(key), depth + 1)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            name = value.get("id") if isinstance(value, dict) and isinstance(value.get("id"), str) else index
            yield from _locale_maps(value, f"{path}[{name}]", depth + 1)
