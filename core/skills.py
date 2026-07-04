"""KP-skill discovery and parsing (Layer B.1 — see ``docs/plugins.md`` "Layer B").

A "skill" packages a play style (tone, focus, a content gate, ...) as a
Claude-Code-style ``skills/<skill-id>/SKILL.md`` bundle: YAML frontmatter
followed by a Markdown body. Dropping a new ``skills/<id>/SKILL.md`` file
makes it discoverable — no code change, mirroring ``core.rulepacks``'s
discovery style.

This module is a pure DATA layer, parallel to ``core.rulepacks``: discovery
and parsing only, no ``store``/``infra`` imports. Per-room enablement lives in
``gateway.ops`` (``get_enabled_skills``/``set_enabled_skills``); folding an
enabled skill's body into the KP system prompt is ``agent.prompt_builder``'s
job; the content-rating censor gate is ``gateway.ops.room_content_unfiltered``
+ ``gateway.turn``. Nothing here is ever ``eval``/``exec``-ed: the frontmatter
is parsed with ``yaml.safe_load`` only, and the Markdown body is opaque text.

``unlocked_tools_for`` (Layer B.2 -- ``allowed-tools`` enforcement, see
``docs/plugins.md`` "Layer B") is the one exception to "no store imports": it
takes a duck-typed `store` parameter (shaped like ``infra.store.Store`` --
an async ``get(store_key=...)``) rather than importing ``infra.store``, so
this module still imports nothing from ``infra``/``agent``/``gateway`` and
stays below both in the layering; callers in either layer can use it directly.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SKILL_DIR = _REPO_ROOT / "skills"
_FRONTMATTER_FENCE = "---"


@dataclass(frozen=True)
class Skill:
    """A loaded ``SKILL.md`` bundle."""

    id: str
    name: str
    description: str
    allowed_tools: list[str] = field(default_factory=list)
    scope: str = "room"
    systems: list[str] = field(default_factory=list)
    content_rating: str = ""
    body: str = ""


def _split_frontmatter(text: str) -> tuple[str, str]:
    """Split ``SKILL.md`` text into ``(frontmatter_yaml, markdown_body)``.

    Frontmatter is the block between the leading ``---`` fences. Raises
    ``ValueError`` when the file has no (properly closed) frontmatter block —
    the caller treats that as a malformed skill to skip.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != _FRONTMATTER_FENCE:
        raise ValueError("SKILL.md missing leading frontmatter fence")
    for index in range(1, len(lines)):
        if lines[index].strip() == _FRONTMATTER_FENCE:
            frontmatter = "\n".join(lines[1:index])
            body = "\n".join(lines[index + 1 :]).strip("\n")
            return frontmatter, body
    raise ValueError("SKILL.md missing closing frontmatter fence")


def _build_skill(skill_id: str, frontmatter: Mapping[str, Any], body: str) -> Skill:
    metadata = frontmatter.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    return Skill(
        id=skill_id,
        name=str(frontmatter.get("name") or skill_id),
        description=str(frontmatter.get("description") or ""),
        allowed_tools=[str(item) for item in (frontmatter.get("allowed-tools") or [])],
        scope=str(metadata.get("scope") or "room"),
        systems=[str(item) for item in (metadata.get("systems") or [])],
        content_rating=str(metadata.get("content-rating") or ""),
        body=body,
    )


def _parse_skill_file(path: Path) -> Skill:
    text = path.read_text(encoding="utf-8")
    frontmatter_text, body = _split_frontmatter(text)
    data = yaml.safe_load(frontmatter_text) or {}
    if not isinstance(data, dict):
        raise ValueError(f"skill '{path.parent.name}': frontmatter must be a mapping, got {type(data).__name__}")
    return _build_skill(path.parent.name, data, body)


@cache
def _discover_registry() -> dict[str, Skill]:
    """Scan ``skills/<id>/SKILL.md``; each directory name is the skill id.

    Robust by construction (mirrors ``core.rulepacks._discover_registry``): a
    skill directory with no ``SKILL.md``, bad/missing frontmatter, or any other
    parse failure is logged and skipped — it never prevents discovery of the
    other, valid skills.
    """
    registry: dict[str, Skill] = {}
    if not _SKILL_DIR.is_dir():
        return registry
    for entry in sorted(_SKILL_DIR.iterdir()):
        if not entry.is_dir():
            continue
        try:
            registry[entry.name] = _parse_skill_file(entry / "SKILL.md")
        except Exception:
            logger.warning("Skipping malformed skill: %s", entry, exc_info=True)
    return registry


def available_skills() -> list[Skill]:
    """Return every discoverable skill in ``skills/``, sorted by id."""
    return [skill for _, skill in sorted(_discover_registry().items())]


def load_skill(skill_id: str) -> Skill | None:
    """Load ``skill_id``'s ``Skill``, or ``None`` when unknown.

    Callers must tolerate ``None`` (an id enabled for a room that no longer
    resolves to a discoverable skill, e.g. after its directory was removed).
    """
    return _discover_registry().get(skill_id)


async def unlocked_tools_for(store: Any, chat_key: str) -> set[str]:
    """The union of ``allowed_tools`` across every KP skill enabled for `chat_key`'s room.

    This is Layer B.2's toolset-gating input (see the module docstring and
    ``docs/plugins.md`` "Layer B"): `agent.loop.run_kp_turn` passes the result
    to ``Toolset.schemas``/``Toolset.dispatch`` as the room's `unlocked` set of
    otherwise-gated tool names.

    Reads the room's enabled-skill ids off `store` the same way
    ``gateway.ops.get_enabled_skills``/``agent.prompt_builder`` do (the
    ``skills_enabled.{chat_key}`` flag, tolerating a missing/corrupt value as
    the empty default rather than raising). An id that no longer resolves to a
    discoverable skill (``load_skill`` returns ``None``) contributes nothing --
    same as everywhere else this flag is read.
    """
    raw = await store.get(store_key=f"skills_enabled.{chat_key}")
    if not raw:
        return set()
    try:
        skill_ids = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return set()
    if not isinstance(skill_ids, list):
        return set()

    unlocked: set[str] = set()
    for skill_id in skill_ids:
        skill = load_skill(str(skill_id))
        if skill is not None:
            unlocked.update(skill.allowed_tools)
    return unlocked
