"""The module brief — where a world card's PROSE goes at import (UPSTREAM item 10).

Before this type existed, `.import <card> world` consumed a card's machinery (lore,
hooks, variable specs, pregens) and dropped its prose on the floor: description,
scenario, the authored opening and its alternates seeded nothing, so the Keeper could
never quote the module's own opening or foreshadow from its pitch. The brief is that
prose, copied DETERMINISTICALLY at import (no model involvement — iron rule #1) into
one document per imported world card, replaced on re-import of the same card.

Keeper-side only: scenario text and openings routinely carry setup the players must
discover in play, so the player-grade projection is ``None`` (iron rule #3,
fail-closed — the same stance as `core.table_habits`). What of it reaches the table is
keeper restraint, exercised through narration, exactly like the rest of the module
truth the Keeper permanently holds.

The brief also carries the card's two standing DIRECTIVES — ST's per-card
``system_prompt`` / ``post_history_instructions`` — as ``directives_head`` /
``directives_post``. Unlike the prose (read on demand through the `module_brief`
tool), these are standing instructions by nature, so `agent.prompt_builder` folds them
on the same two bands an imported preset uses (:func:`directive_bands`): head text
into the stable head, post-history text late in the volatile tail. They exist only on
a brief a keeper world import wrote — the character half of a split never carries
them (`core.card_split`) — which is what keeps a player import from pushing standing
text into the Keeper prompt. :func:`prepare_directive` is the deterministic import-time
copy: EJS removed, ``{{original}}`` dropped, ``{{char}}`` bound to the card name.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING, Any

from core.card_split import strip_ejs
from infra.room_facets import STORAGE_DOCUMENTS, RoomStateFacet

if TYPE_CHECKING:
    from core.documents import Document, Viewer

BRIEF_DOC_TYPE = "module_brief"

MAX_FIELD_CHARS = 8_000
MAX_OPENINGS = 8
MAX_TAGS = 24

#: The two directive fields, by the band `agent.prompt_builder` folds each into.
DIRECTIVE_FIELDS: dict[str, str] = {"head": "directives_head", "post_history": "directives_post"}

_TEXT_FIELDS = (
    "name",
    "description",
    "personality",
    "scenario",
    "opening",
    "examples",
    "notes",
    *DIRECTIVE_FIELDS.values(),
)

# `{{original}}` is where ST splices the preset's own main/post-history prompt into a
# card override. The engine has no override to splice (the preset layer rides the same
# bands on its own), so the macro is dropped rather than left as literal noise.
_ORIGINAL_MACRO_RE = re.compile(r"\{\{\s*original\s*\}\}", re.IGNORECASE)
_CHAR_MACRO_RE = re.compile(r"\{\{\s*char\s*\}\}", re.IGNORECASE)
_COMMENT_MACRO_RE = re.compile(r"\{\{\s*//[^{}]*\}\}")


def project_brief(doc: Document, viewer: Viewer) -> dict[str, Any] | None:
    """Keeper-only, whole or nothing — prose is module truth, not a partial view."""
    return dict(doc.data) if viewer.is_keeper else None


def validate_brief_write(doc: Document, services: Any) -> list[str]:
    """Shape and ceilings only, never meaning (the `table_habits` discipline)."""
    problems: list[str] = []
    data = doc.data
    for field in _TEXT_FIELDS:
        value = data.get(field, "")
        if not isinstance(value, str):
            problems.append(f"{field} must be a string")
        elif len(value) > MAX_FIELD_CHARS:
            problems.append(f"{field} exceeds {MAX_FIELD_CHARS} chars")
    openings = data.get("openings", [])
    if not isinstance(openings, list) or len(openings) > MAX_OPENINGS:
        problems.append(f"openings must be a list of at most {MAX_OPENINGS}")  # i18n-exempt: developer diagnostic, wrapped by the store's validation error
    elif any(not isinstance(entry, str) or len(entry) > MAX_FIELD_CHARS for entry in openings):
        problems.append("each opening must be a bounded string")  # i18n-exempt: developer diagnostic, wrapped by the store's validation error
    tags = data.get("tags", [])
    if not isinstance(tags, list) or len(tags) > MAX_TAGS or any(not isinstance(tag, str) for tag in tags):
        problems.append(f"tags must be a list of at most {MAX_TAGS} strings")  # i18n-exempt: developer diagnostic, wrapped by the store's validation error
    return problems


def prepare_directive(text: Any, char_name: str) -> str:
    """The deterministic import-time copy of ONE directive field.

    EJS spans are removed (raw template syntax never reaches the model from this path;
    render-time EJS lives in lore), ``{{original}}`` is dropped, comment macros go, and
    ``{{char}}`` is bound statically to the card name — the same static binding every
    card import applies. Every other macro is left for the per-turn pass the prompt
    lane runs on the post-history band (the head band stays byte-stable by design).
    """
    clean, _spans = strip_ejs(str(text or ""))
    clean = _ORIGINAL_MACRO_RE.sub("", clean)
    clean = _COMMENT_MACRO_RE.sub("", clean)
    if char_name:
        clean = _CHAR_MACRO_RE.sub(lambda _match: char_name, clean)
    return clean[:MAX_FIELD_CHARS].strip()


def directive_bands(views: Iterable[Mapping[str, Any]]) -> dict[str, str]:
    """Every imported brief's directives joined per band, in document order — the
    prompt builder's input: ``head`` (the cards' system prompts) and ``post_history``
    (their post-history instructions). A band no brief fills is ``""``."""
    texts: dict[str, list[str]] = {band: [] for band in DIRECTIVE_FIELDS}
    for view in views:
        for band, field in DIRECTIVE_FIELDS.items():
            text = str(view.get(field, "") or "").strip()
            if text:
                texts[band].append(text)
    return {band: "\n\n".join(parts) for band, parts in texts.items()}


def build_brief(card: Any, alternate_openings: tuple[str, ...] = ()) -> dict[str, Any] | None:
    """The deterministic copy: a `core.charcard.CharacterCard`'s prose fields, trimmed
    to their ceilings, plus its two directives (:func:`prepare_directive`). Returns
    ``None`` when the card carries neither prose nor directives (a brief that says
    nothing would only clutter the keeper's shelf)."""
    clip = lambda text: str(text or "")[:MAX_FIELD_CHARS].strip()  # noqa: E731 — three-use local
    name = clip(getattr(card, "name", ""))
    data = {
        "name": name,
        "description": clip(getattr(card, "description", "")),
        "personality": clip(getattr(card, "personality", "")),
        "scenario": clip(getattr(card, "scenario", "")),
        "opening": clip(getattr(card, "first_mes", "")),
        "openings": [clip(entry) for entry in alternate_openings[:MAX_OPENINGS] if clip(entry)],
        "examples": clip(getattr(card, "mes_example", "")),
        "notes": clip(getattr(card, "creator_notes", "")),
        "tags": [str(tag)[:200] for tag in list(getattr(card, "tags", ()) or ())[:MAX_TAGS]],
        DIRECTIVE_FIELDS["head"]: prepare_directive(getattr(card, "system_prompt", ""), name),
        DIRECTIVE_FIELDS["post_history"]: prepare_directive(
            getattr(card, "post_history_instructions", ""), name
        ),
    }
    has_content = (
        any(
            data[field]
            for field in ("description", "personality", "scenario", "opening", "examples", *DIRECTIVE_FIELDS.values())
        )
        or data["openings"]
    )
    return data if has_content else None


def brief_id(card_name: str) -> str:
    """A stable per-card document id, so re-importing the same card replaces its brief."""
    slug = "".join(ch if ch.isalnum() else "-" for ch in str(card_name or "").casefold()).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:64] or "card"


ROOM_FACETS = (
    RoomStateFacet(
        name="module_brief",
        owner="core.module_brief",
        # The brief describes the MODULE, like the `world_import` marker beside it: a
        # story or chars reset replays the same module, so only `.reset all` clears it.
        reset_scope="all",
        doc_types=frozenset({BRIEF_DOC_TYPE}),
        storages=frozenset({STORAGE_DOCUMENTS}),
    ),
)
