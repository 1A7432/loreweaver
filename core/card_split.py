"""Card splitting ("拆卡") — the character half vs the world machinery, deterministically.

A SillyTavern "heavy card" is a WORLD wearing a character card's clothing: hook scripts,
variable schemas (``[InitVar]``), and executable EJS ride along with the persona because
upstream's single-player architecture had nowhere else to put them. Loreweaver has real
module/keeper concepts, so import splits every card into its two native artifacts instead
of carrying the fusion forward:

- the CHARACTER half — persona prose, sheet-relevant fields, plain personal lore — safe
  for any player to self-import;
- the WORLD payloads — hook scripts, variable declarations, executable templates — which
  only the room's keeper may bring in (``.import <file> world``), because they reshape
  play for everyone at the table;
- the card's standing DIRECTIVES — ``system_prompt`` / ``post_history_instructions``,
  ST's per-card prompt overrides. Not machinery (a plain persona card routinely carries
  a system prompt, so they never make a card a world card), but standing Keeper-prompt
  text all the same: the character half drops them, and only a keeper world import
  folds them (``core.module_brief``).

Detection and stripping are pure functions with no model involvement (iron rule #1), so
the player-path guarantee is structural: a stripped card CANNOT install room hooks, seed
the shared variable tree, or execute template code, regardless of how it is phrased.
`agent.kp_tools_charcard` runs every import through here; `core.worldbook` reuses
:func:`is_variable_declaration_entry` so the two layers can never disagree about what
counts as variable machinery.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any

from core.charcard import CharacterCard
from core.ejs_lite import split_decorators
from core.mvu_compat import is_initvar_entry

# One EJS span: `<% ... %>` in any of its forms (`<%=`, `<%-`, `<%_`, trimmed closers).
# Non-greedy so adjacent spans strip independently; DOTALL via [\s\S] so multi-line
# template blocks are covered.
_EJS_SPAN_RE = re.compile(r"<%[\s\S]*?%>")
# A dangling opener with no closer strips to end-of-text: fail closed — no template
# fragment may survive into prompt-rendered prose.
_EJS_DANGLING_RE = re.compile(r"<%[\s\S]*\Z")

HOOKS_EXTENSION_KEY = "loreweaver_hooks"
# The native lorecard's (format v1) top-level hooks list — see `core.lorecard.HOOKS_KEY`.
NATIVE_HOOKS_KEY = "hooks"


@dataclass(frozen=True)
class WorldPayloads:
    """What the world half of a card contains, by count (all zero for a plain persona card)."""

    hooks: int = 0
    initvar_entries: int = 0
    ejs_blocks: int = 0
    # Keeper-only (`secret: true`) worldbook entries — a native bundle (M14) can carry
    # them; stock ST cards never do. Keeper-only lore IS world machinery.
    secret_entries: int = 0
    # The card's standing directives (`system_prompt` / `post_history_instructions`, 0-2).
    # Deliberately OUTSIDE `any`: they are prompt text, not machinery, and `core.pack` keys
    # a card's kind on `any` — a persona card with a system prompt is still a character card.
    directives: int = 0

    @property
    def any(self) -> bool:
        """Whether the card carries world MACHINERY (what makes it a world card)."""
        return bool(self.hooks or self.initvar_entries or self.ejs_blocks or self.secret_entries)

    @property
    def any_stripped(self) -> bool:
        """Whether a character import had anything at all to leave out — machinery or
        directives — i.e. whether the import receipt owes the importer an itemized line."""
        return self.any or bool(self.directives)


def card_hook_codes(card: CharacterCard) -> list[str]:
    """The card's hook scripts. A native lorecard (format v1) carries them as the
    top-level ``hooks`` list; imported ST-shaped cards (and the card forge) use
    ``extensions.loreweaver_hooks`` in both the v2/v3 ``data.extensions`` and
    root-level ``extensions`` locations. Entries may be code strings or
    ``{code: ...}`` dicts."""
    raw = card.raw if isinstance(card.raw, dict) else {}
    entries = raw.get(NATIVE_HOOKS_KEY)
    if not isinstance(entries, list):
        data = raw.get("data")
        extensions = data.get("extensions") if isinstance(data, dict) else None
        if not isinstance(extensions, dict):
            root_extensions = raw.get("extensions")
            extensions = root_extensions if isinstance(root_extensions, dict) else {}
        entries = extensions.get(HOOKS_EXTENSION_KEY)
    if not isinstance(entries, list):
        return []
    codes = [
        entry if isinstance(entry, str) else entry.get("code", "")
        for entry in entries
        if isinstance(entry, (str, dict))
    ]
    return [code for code in codes if isinstance(code, str) and code.strip()]


def is_variable_declaration_entry(raw: dict[str, Any]) -> bool:
    """Whether one worldbook entry declares variables rather than telling lore: an MVU
    ``[InitVar]`` title, an ST ``[InitialVariables]`` title, or an ``@@initial_variables``
    decorator. Shared with `core.worldbook._consume_initvar` — the single definition of
    "variable machinery" for both the split and the import."""
    title = str(raw.get("title") or raw.get("comment") or raw.get("name") or "")
    decorators = split_decorators(str(raw.get("content") or ""))[0]
    return (
        is_initvar_entry(title)
        or "[initialvariables]" in title.replace(" ", "").lower()
        or "initial_variables" in decorators
    )


def strip_ejs(text: str) -> tuple[str, int]:
    """Remove every EJS span from `text`, returning ``(clean_text, spans_removed)``.
    A dangling unclosed ``<%`` is removed to end-of-text (counted once)."""
    if "<%" not in text:
        return text, 0
    clean, count = _EJS_SPAN_RE.subn("", text)
    if "<%" in clean:
        clean, dangling = _EJS_DANGLING_RE.subn("", clean)
        count += dangling
    return clean, count


def detect_world_payloads(card: CharacterCard) -> WorldPayloads:
    """Count the card's world payloads without modifying anything (the classifier)."""
    return split_card(card)[1]


def split_card(card: CharacterCard) -> tuple[CharacterCard, WorldPayloads]:
    """Split a parsed card into ``(character_half, world_payloads)``.

    The character half is a new :class:`CharacterCard`: prose fields with EJS spans
    stripped, ``character_book`` minus variable-declaration entries (their contents
    EJS-stripped too), the two directive fields blanked, and ``raw`` with the hooks
    extension and the directive keys removed. The original card is never mutated. The
    world payloads are counts only — a keeper who wants that half imports the ORIGINAL
    card through the world path, which reads it in full.
    """
    ejs_blocks = 0

    def _clean(text: str) -> str:
        nonlocal ejs_blocks
        clean, count = strip_ejs(text)
        ejs_blocks += count
        return clean

    entries: list[dict[str, Any]] = []
    initvar_entries = 0
    secret_entries = 0
    for raw_entry in card.character_book:
        if is_variable_declaration_entry(raw_entry):
            initvar_entries += 1
            continue
        # Keeper-only lore never rides the character half (a native bundle can flag it;
        # the worldbook import chokepoint additionally drops it fail-closed on any
        # non-keeper path — two layers, same rule).
        if bool(raw_entry.get("secret")):
            secret_entries += 1
            continue
        entry = dict(raw_entry)
        content = entry.get("content")
        if isinstance(content, str):
            entry["content"] = _clean(content)
        entries.append(entry)

    hooks = card_hook_codes(card)
    directives = sum(1 for text in (card.system_prompt, card.post_history_instructions) if text.strip())
    character = replace(
        card,
        description=_clean(card.description),
        personality=_clean(card.personality),
        scenario=_clean(card.scenario),
        first_mes=_clean(card.first_mes),
        mes_example=_clean(card.mes_example),
        creator_notes=_clean(card.creator_notes),
        # Standing directives never ride the character half: a player import must not
        # push standing text into the Keeper prompt (see the module docstring).
        system_prompt="",
        post_history_instructions="",
        character_book=entries,
        raw=_raw_without_world_text(card.raw) if hooks or directives else card.raw,
    )
    return character, WorldPayloads(
        hooks=len(hooks),
        initvar_entries=initvar_entries,
        ejs_blocks=ejs_blocks,
        secret_entries=secret_entries,
        directives=directives,
    )


# The card-level directive keys, in both the v2/v3 ``data`` body and a v1 root.
DIRECTIVE_KEYS: tuple[str, ...] = ("system_prompt", "post_history_instructions")


def _raw_without_world_text(raw: Any) -> Any:
    """A shallow-per-level copy of `raw` with hook scripts and the directive keys
    dropped: the native top-level ``hooks`` list, ``extensions.loreweaver_hooks`` in both
    the v2/v3 ``data.extensions`` location and the root-level ``extensions``, and
    :data:`DIRECTIVE_KEYS` wherever the body lives — so nothing downstream can read a
    directive back off the character half's raw document."""
    if not isinstance(raw, dict):
        return raw
    clean = dict(raw)
    clean.pop(NATIVE_HOOKS_KEY, None)
    for holder_key in ("data", None):
        holder = clean if holder_key is None else clean.get(holder_key)
        if not isinstance(holder, dict):
            continue
        extensions = holder.get("extensions")
        if isinstance(extensions, dict) and HOOKS_EXTENSION_KEY in extensions:
            extensions = {key: value for key, value in extensions.items() if key != HOOKS_EXTENSION_KEY}
            holder = {**holder, "extensions": extensions}
        if any(key in holder for key in DIRECTIVE_KEYS):
            holder = {key: value for key, value in holder.items() if key not in DIRECTIVE_KEYS}
        if holder_key is None:
            clean = holder
        else:
            clean[holder_key] = holder
    return clean
