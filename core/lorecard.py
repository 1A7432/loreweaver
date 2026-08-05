"""Loreweaver native card bundle (``*.lorecard.json``) — the parsing half of the M14 importer.

The card studio's lossless export ("imported cards adapt to us; forged cards are born native and
still play everywhere") is a flat JSON object tagged ``format: "loreweaver.card"``. Unlike a
SillyTavern card it keeps everything ST has no safe shape for: keeper-only variables, ``secret``
lore, typed variable specs (``core.modvars`` shape verbatim), per-entry ``condition`` expressions,
and hook scripts. ``docs/plugins.md`` and the studio's ``docs/FORMATS.md`` document the shape;
this module is the engine side of that contract.

It ONLY parses. No I/O, no network, no ``exec`` — bytes in, a :class:`Lorecard` out. Every trust
decision (who may bring world machinery into a room, whether hooks get installed, whether
``secret`` survives) stays with the caller, i.e. the keeper-gated ``.import … world`` path. Two
consequences are worth stating up front:

- the worldbook half is re-emitted in the ST-ENTRY dict shape ``core.worldbook.import_entries``
  already consumes, so the native path reuses that audited importer instead of growing a second
  one. A typed ``condition`` rides back as a leading ``@@if <expr>`` decorator line (the same
  representation the studio's ST export writes, and the only one that importer reads), and
  ``secret`` rides as a plain ``secret: True`` key — honored only for a keeper import and dropped
  structurally for anyone else, because iron rule #3 lives in the importer, not here;
- the original document is kept verbatim on ``card.raw``, so ``core.card_split`` classifies a
  native bundle like any other card: hooks under the root-level ``extensions`` are found by
  ``card_hook_codes``, and a bundle carrying hooks / variables / secret lore is world-kind by
  construction.

Structural garbage (not JSON, wrong ``format`` tag, unsupported ``format_version``, past a hard
cap) raises ``ValueError`` with an author-actionable message. Entry-level junk (a malformed lore
entry, an invalid variable spec) is SKIPPED and reported through :attr:`Lorecard.warnings`, so one
bad row never costs an author the whole bundle.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from core.charcard import MAX_CARD_FILE_BYTES, CharacterCard
from core.modvars import normalize_spec

LORECARD_FORMAT = "loreweaver.card"
# Every bundle version this build reads. The studio currently emits 0 ("provisional" — the shape
# may still move before it is frozen); an unknown version is refused rather than guessed at.
SUPPORTED_FORMAT_VERSIONS = frozenset({0})

# Mirrors ``core.card_split.HOOKS_EXTENSION_KEY``. Kept local rather than imported so this module
# stays dependency-light (stdlib + charcard + modvars); the two are the same string by contract,
# and card_split re-reads the field off ``card.raw`` anyway.
HOOKS_EXTENSION_KEY = "loreweaver_hooks"

# Hard caps against a hostile or simply broken bundle fed through `.import`. The file cap is the
# character-card cap (same upload path, same OOM concern); the rest bound prompt-injection surface
# and parse cost. Passing one is FATAL: a document that far out of shape is not an author typo
# worth half-importing. Note these are PARSE caps — a room's own limits (``core.modvars.MAX_VARS``,
# ``core.worldbook.MAX_IMPORT_ENTRIES``) still apply when the parsed bundle is actually installed.
MAX_LORECARD_FILE_BYTES = MAX_CARD_FILE_BYTES
MAX_LORECARD_ENTRIES = 512
MAX_LORECARD_ENTRY_CONTENT_BYTES = 128 * 1024
MAX_LORECARD_VARIABLES = 256
# Mirrors ``core.condexpr.MAX_EXPR_LEN`` (not imported — see HOOKS_EXTENSION_KEY). A longer
# condition still rides along, but fails closed downstream, so the author gets a warning here.
MAX_CONDITION_CHARS = 500

_SELECTIVE_LOGICS = ("and_any", "and_all", "not_any", "not_all")
# Native ``"" | "before" | "after"`` → the ST names ``core.worldbook._normalize_import_entry``
# reads. This is the one field where the two engine consumers disagree (``LoreEntry.from_dict``
# wants the bare native words), and the importer is the documented consumer of these dicts.
_POSITIONS = {"before": "before_char", "after": "after_char"}


@dataclass(frozen=True)
class Lorecard:
    """One parsed native bundle: a character-card view plus the native-only extras.

    ``card`` is a plain :class:`core.charcard.CharacterCard` whose ``character_book`` holds
    importer-shaped entry dicts (see the module docstring) and whose ``raw`` is the original
    document. ``variable_specs`` are ``core.modvars`` specs, already normalized. ``warnings``
    lists every tolerated problem, in document order, for the caller to echo to the author.
    """

    card: CharacterCard
    alternate_greetings: tuple[str, ...] = ()
    hooks: tuple[str, ...] = ()
    variable_specs: tuple[dict[str, Any], ...] = ()
    warnings: tuple[str, ...] = ()


def looks_like_lorecard(data: bytes) -> bool:
    """Cheap sniff: does ``data`` look like a native bundle rather than an ST card?

    Total function — never raises, whatever the bytes are. A verbatim substring test gates the
    JSON parse so an unrelated 16MB upload is rejected without paying for a full decode.
    """
    if not isinstance(data, (bytes, bytearray)) or not data or len(data) > MAX_LORECARD_FILE_BYTES:
        return False
    if LORECARD_FORMAT.encode("utf-8") not in data:
        return False
    try:
        parsed = json.loads(bytes(data).decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return False
    return isinstance(parsed, dict) and parsed.get("format") == LORECARD_FORMAT


def parse_lorecard_bytes(data: bytes, filename: str = "") -> Lorecard:
    """Parse one ``*.lorecard.json`` document.

    Raises ``ValueError`` with an author-actionable message when the document is structurally
    unusable (not JSON, not a native bundle, an unsupported ``format_version``, or past a hard
    cap). Anything smaller — a lore entry that isn't an object, an unusable variable spec — is
    skipped and recorded in :attr:`Lorecard.warnings`.
    """
    label = filename or "lorecard"
    if len(data) > MAX_LORECARD_FILE_BYTES:
        raise _fail(label, f"native card bundle exceeds the {MAX_LORECARD_FILE_BYTES}-byte size limit")

    try:
        raw = json.loads(bytes(data).decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise _fail(label, f"not a readable JSON document ({exc})") from exc
    if not isinstance(raw, dict):
        raise _fail(label, "native card bundle must be a JSON object")  # i18n-exempt: author diagnostic, wrapped in a localized import summary

    declared = raw.get("format")
    if declared != LORECARD_FORMAT:
        raise _fail(label, f"not a Loreweaver native card: format is {declared!r}, want {LORECARD_FORMAT!r}")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
    version = raw.get("format_version")
    if isinstance(version, bool) or version not in SUPPORTED_FORMAT_VERSIONS:
        supported = ", ".join(str(item) for item in sorted(SUPPORTED_FORMAT_VERSIONS))
        raise _fail(label, f"unsupported format_version {version!r}; this build reads: {supported}")

    warnings: list[str] = []
    entries = _parse_worldbook(raw.get("worldbook"), label, warnings)
    specs = _parse_variables(raw.get("variables"), label, warnings)
    hooks = _parse_hooks(raw.get("extensions"), warnings)

    card = CharacterCard(
        name=_text(raw.get("name")).strip(),
        description=_text(raw.get("description")),
        personality=_text(raw.get("personality")),
        scenario=_text(raw.get("scenario")),
        first_mes=_text(raw.get("first_mes")),
        mes_example=_text(raw.get("mes_example")),
        creator_notes=_text(raw.get("creator_notes")),
        tags=_text_list(raw.get("tags")),
        character_book=entries,
        raw=raw,
    )
    return Lorecard(
        card=card,
        alternate_greetings=tuple(_text_list(raw.get("alternate_greetings"))),
        hooks=hooks,
        variable_specs=specs,
        warnings=tuple(warnings),
    )


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------


def _parse_worldbook(raw: Any, label: str, warnings: list[str]) -> list[dict[str, Any]]:
    """Native worldbook list → importer-shaped entry dicts, junk rows skipped."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        warnings.append("worldbook: ignored (must be a list of entries)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
        return []
    if len(raw) > MAX_LORECARD_ENTRIES:
        raise _fail(label, f"worldbook has {len(raw)} entries; at most {MAX_LORECARD_ENTRIES} are allowed")

    entries: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        entry = _parse_entry(item, index, label, warnings)
        if entry is not None:
            entries.append(entry)
    return entries


def _parse_entry(raw: Any, index: int, label: str, warnings: list[str]) -> dict[str, Any] | None:
    where = f"worldbook[{index}]"
    if not isinstance(raw, dict):
        warnings.append(f"{where}: skipped (entry must be a JSON object)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
        return None

    body = raw.get("content")
    if isinstance(body, (dict, list, tuple, set)):
        warnings.append(f"{where}: skipped (content must be text)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
        return None
    content = _text(body)
    if len(content.encode("utf-8")) > MAX_LORECARD_ENTRY_CONTENT_BYTES:
        raise _fail(label, f"{where} content exceeds the {MAX_LORECARD_ENTRY_CONTENT_BYTES}-byte limit")
    if not content.strip():
        warnings.append(f"{where}: skipped (empty content)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
        return None

    title = _text(raw.get("title")).strip() or "Untitled Lore"
    # A typed `condition` becomes a leading `@@if` decorator line: that is the ONLY form
    # `core.worldbook._normalize_import_entry` maps back onto `LoreEntry.condition`, and it is
    # exactly what the studio's SillyTavern export writes. Whitespace is collapsed because a
    # decorator is a single line by definition.
    condition = " ".join(_text(raw.get("condition")).split())
    if len(condition) > MAX_CONDITION_CHARS:
        warnings.append(  # i18n-exempt: author diagnostic, wrapped in a localized import summary
            f"{where}: condition is longer than {MAX_CONDITION_CHARS} characters and will never fire"
        )
    if condition:
        content = f"@@if {condition}\n{content}"

    secondary_keys = _text_list(raw.get("secondary_keys"))
    logic = _text(raw.get("selective_logic")).strip()
    return {
        "comment": title,
        "content": content,
        "keys": _text_list(raw.get("keys")),
        "secondary_keys": secondary_keys,
        # V2's gate flag, stated explicitly rather than left to the importer's default —
        # the same thing the studio's SillyTavern export writes.
        "selective": bool(secondary_keys),
        "selective_logic": logic if logic in _SELECTIVE_LOGICS else "and_any",
        "category": _text(raw.get("category")).strip() or "lore",
        # Keeper-only lore. The importer honors this ONLY for `is_keeper=True`; a player-path
        # import drops it structurally, so carrying it here cannot widen anyone's visibility.
        "secret": _flag(raw.get("secret")),
        # Carried for fidelity; the importer forces it off for any uploaded file (an always-on
        # entry would inject itself into every prompt regardless of keywords).
        "constant": _flag(raw.get("constant")),
        "priority": _int(raw.get("priority"), 0),
        "enabled": _flag(raw.get("enabled"), default=True),
        "probability": _int(raw.get("probability"), 100, low=0, high=100),
        "case_sensitive": _flag(raw.get("case_sensitive")),
        "match_whole_words": _flag(raw.get("match_whole_words")),
        "scan_depth": _int(raw.get("scan_depth"), 0, low=0, high=200),
        "position": _POSITIONS.get(_text(raw.get("position")).strip(), ""),
        "sticky": _int(raw.get("sticky"), 0, low=0, high=999),
        "cooldown": _int(raw.get("cooldown"), 0, low=0, high=999),
        "delay": _int(raw.get("delay"), 0, low=0, high=9999),
    }


def _parse_variables(raw: Any, label: str, warnings: list[str]) -> tuple[dict[str, Any], ...]:
    """Native variable list → normalized ``core.modvars`` specs, invalid ones skipped.

    Normalization is ``core.modvars.normalize_spec``, the same tolerant path stored state goes
    through, so a bundle can never introduce a spec the engine would not have accepted itself.
    """
    if raw is None:
        return ()
    if not isinstance(raw, list):
        warnings.append("variables: ignored (must be a list of variable specs)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
        return ()
    if len(raw) > MAX_LORECARD_VARIABLES:
        raise _fail(label, f"{len(raw)} variables declared; at most {MAX_LORECARD_VARIABLES} are allowed")

    specs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        where = f"variables[{index}]"
        if not isinstance(item, dict):
            warnings.append(f"{where}: skipped (variable spec must be a JSON object)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
            continue
        spec = normalize_spec(item.get("id"), item)
        if spec is None:
            warnings.append(f"{where}: skipped (unusable id, kind, bounds or default)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
            continue
        if spec["id"] in seen:
            warnings.append(f"{where}: skipped (duplicate variable id {spec['id']!r})")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
            continue
        seen.add(spec["id"])
        specs.append(spec)
    return tuple(specs)


def _parse_hooks(raw: Any, warnings: list[str]) -> tuple[str, ...]:
    """``extensions.loreweaver_hooks`` → hook sources. Tolerates code strings and ``{code: …}``
    dicts, matching ``core.card_split.card_hook_codes``; installing them is the caller's call."""
    if raw is None:
        return ()
    if not isinstance(raw, dict):
        warnings.append("extensions: ignored (must be a JSON object)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
        return ()
    entries = raw.get(HOOKS_EXTENSION_KEY)
    if entries is None:
        return ()
    if isinstance(entries, str):
        entries = [entries]
    if not isinstance(entries, list):
        warnings.append(f"extensions.{HOOKS_EXTENSION_KEY}: ignored (must be a list of scripts)")  # i18n-exempt: author diagnostic, wrapped in a localized import summary
        return ()
    codes = []
    for item in entries:
        code = item if isinstance(item, str) else item.get("code") if isinstance(item, dict) else None
        if isinstance(code, str) and code.strip():
            codes.append(code)
    return tuple(codes)


# ---------------------------------------------------------------------------
# Coercion helpers — total functions, defensive against author/attacker garbage
# ---------------------------------------------------------------------------


def _fail(label: str, message: str) -> ValueError:
    return ValueError(f"{label}: {message}" if label else message)


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list, tuple, set)):
        return ""
    return str(value)


def _text_list(value: Any) -> list[str]:
    """A list of non-empty trimmed strings; a bare string counts as a one-item list."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [text for text in (_text(item).strip() for item in value) if text]


def _flag(value: Any, *, default: bool = False) -> bool:
    return default if value is None else bool(value)


def _int(value: Any, default: int, *, low: int | None = None, high: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        parsed = default
    if low is not None:
        parsed = max(low, parsed)
    if high is not None:
        parsed = min(high, parsed)
    return parsed
