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
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from infra.room_facets import STORAGE_DOCUMENTS, RoomStateFacet

if TYPE_CHECKING:
    from core.documents import Document, Viewer

BRIEF_DOC_TYPE = "module_brief"

MAX_FIELD_CHARS = 8_000
MAX_OPENINGS = 8
MAX_TAGS = 24

_TEXT_FIELDS = ("name", "description", "personality", "scenario", "opening", "examples", "notes")


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


def build_brief(card: Any, alternate_openings: tuple[str, ...] = ()) -> dict[str, Any] | None:
    """The deterministic copy: a `core.charcard.CharacterCard`'s prose fields, trimmed
    to their ceilings. Returns ``None`` when the card carries no prose at all (a brief
    that says nothing would only clutter the keeper's shelf)."""
    clip = lambda text: str(text or "")[:MAX_FIELD_CHARS].strip()  # noqa: E731 — three-use local
    data = {
        "name": clip(getattr(card, "name", "")),
        "description": clip(getattr(card, "description", "")),
        "personality": clip(getattr(card, "personality", "")),
        "scenario": clip(getattr(card, "scenario", "")),
        "opening": clip(getattr(card, "first_mes", "")),
        "openings": [clip(entry) for entry in alternate_openings[:MAX_OPENINGS] if clip(entry)],
        "examples": clip(getattr(card, "mes_example", "")),
        "notes": clip(getattr(card, "creator_notes", "")),
        "tags": [str(tag)[:200] for tag in list(getattr(card, "tags", ()) or ())[:MAX_TAGS]],
    }
    has_prose = any(data[field] for field in ("description", "personality", "scenario", "opening", "examples")) or data[
        "openings"
    ]
    return data if has_prose else None


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
