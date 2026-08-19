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
is parsed with ``yaml.safe_load`` (via ``core.yaml_safety.safe_load_no_aliases``, which additionally
rejects alias/anchor nodes -- see that module) only, and the Markdown body is opaque text.

``unlocked_tools_for`` (Layer B.2 -- ``allowed-tools`` enforcement, see
``docs/plugins.md`` "Layer B") is the one exception to "no store imports": it
takes a duck-typed `store` parameter (shaped like ``infra.store.Store`` --
an async ``state_get(room, key)``) rather than importing ``infra.store``, so
this module still imports nothing from ``infra``/``agent``/``gateway`` and
stays below both in the layering; callers in either layer can use it directly.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from functools import cache
from pathlib import Path
from typing import Any

from core.yaml_safety import safe_load_no_aliases

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SKILL_DIR = _REPO_ROOT / "skills"
_FRONTMATTER_FENCE = "---"

# Layer B.3a (the skill-generation engine, `agent.forge`) discovery target: a user data-dir
# `skills/` directory, set once at startup (`app.py`: `core.skills._USER_SKILL_DIR =
# Path(settings.data_dir) / "skills"`) so a generated skill need not live inside the checkout.
# `None` (the default, and every test unless it opts in) means discovery scans ONLY `_SKILL_DIR`,
# byte-identical to before this existed. `_discover_registry` reads this module attribute at scan
# time (not a value captured at import time), so setting it after import -- as `app.py` and tests
# both do -- takes effect on the next `reload_skills()`/cache miss.
_USER_SKILL_DIR: Path | None = None


@dataclass(frozen=True)
class Skill:
    """A loaded ``SKILL.md`` bundle."""

    id: str
    name: str
    description: str
    # Optional localized display metadata (frontmatter `name-zh` / `description-zh`);
    # empty means the English name/description are used for that locale too.
    name_zh: str = ""
    description_zh: str = ""
    allowed_tools: list[str] = field(default_factory=list)
    scope: str = "room"
    systems: list[str] = field(default_factory=list)
    content_rating: str = ""
    body: str = ""
    # Optional sandboxed event handlers (`hooks.js` next to SKILL.md — Layer C, see
    # `core.hooks`): raw JS source, NEVER executed here; `agent.hook_runtime` feeds it to the
    # QuickJS sandbox only while the skill is enabled for a room.
    hooks: str = ""


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
        name=str(frontmatter.get("name") or skill_id).strip(),
        description=str(frontmatter.get("description") or "").strip(),
        name_zh=str(frontmatter.get("name-zh") or "").strip(),
        description_zh=str(frontmatter.get("description-zh") or "").strip(),
        allowed_tools=[str(item) for item in (frontmatter.get("allowed-tools") or [])],
        scope=str(metadata.get("scope") or "room"),
        systems=[str(item) for item in (metadata.get("systems") or [])],
        content_rating=str(metadata.get("content-rating") or ""),
        body=body,
    )


def parse_skill_text(skill_id: str, text: str) -> Skill:
    """Parse ``SKILL.md``-shaped `text` into a `Skill`, assigning it `skill_id`.

    The same frontmatter+body parser `_discover_registry` uses on-disk, exposed so a caller that
    has SKILL.md content in memory (`agent.forge`, validating LLM-generated skill text before ever
    writing it to disk) can validate against the identical rules real discovery will later apply —
    no separate/divergent parser to keep in sync. Raises `ValueError` on any malformed input
    (missing/unclosed frontmatter fence, or frontmatter that isn't a YAML mapping); never
    `eval`/`exec`s anything -- the frontmatter is `yaml.safe_load`-ed only (via
    `core.yaml_safety.safe_load_no_aliases`, which also rejects alias/anchor nodes so a small
    frontmatter block can never alias-bomb into an exponential in-memory structure).
    """
    frontmatter_text, body = _split_frontmatter(text)
    data = safe_load_no_aliases(frontmatter_text) or {}
    if not isinstance(data, dict):
        raise ValueError(f"skill '{skill_id}': frontmatter must be a mapping, got {type(data).__name__}")
    return _build_skill(skill_id, data, body)


def _parse_skill_file(path: Path) -> Skill:
    text = path.read_text(encoding="utf-8")
    skill = parse_skill_text(path.parent.name, text)
    hooks_path = path.parent / "hooks.js"
    if hooks_path.is_file():
        try:
            skill = replace(skill, hooks=hooks_path.read_text(encoding="utf-8"))
        except OSError:
            logger.warning("Skipping unreadable hooks.js for skill %s", skill.id, exc_info=True)
    return skill


def _scan_skill_dir(directory: Path, registry: dict[str, Skill], *, allow_override: bool) -> None:
    """Scan `directory` for `<id>/SKILL.md` subdirectories, adding valid parses into `registry`.

    A directory with no ``SKILL.md``, bad/missing frontmatter, or any other parse failure is
    logged and skipped -- it never prevents discovery of the other, valid skills (mirrors
    ``core.rulepacks._discover_registry``). When `allow_override` is False, an id already present
    in `registry` is left untouched: this is how a user-dir skill (Layer B.3a) can never shadow a
    built-in of the same id -- a built-in always wins.
    """
    if not directory.is_dir():
        return
    for entry in sorted(directory.iterdir()):
        if not entry.is_dir():
            continue
        if not allow_override and entry.name in registry:
            continue
        try:
            registry[entry.name] = _parse_skill_file(entry / "SKILL.md")
        except Exception:
            logger.warning("Skipping malformed skill: %s", entry, exc_info=True)


@cache
def _discover_registry() -> dict[str, Skill]:
    """Scan ``skills/<id>/SKILL.md`` (built-in), then `_USER_SKILL_DIR` (Layer B.3a) when set.

    Robust by construction (mirrors ``core.rulepacks._discover_registry``): a skill directory with
    no ``SKILL.md``, bad/missing frontmatter, or any other parse failure is logged and skipped — it
    never prevents discovery of the other, valid skills. A built-in id always wins over a
    same-named user-dir entry (`_scan_skill_dir`'s `allow_override=False` for the user dir), so a
    generated skill can never override e.g. `mature-mode`. With `_USER_SKILL_DIR` left at its
    default `None` (every test unless it opts in), this scans ONLY `_SKILL_DIR` -- byte-identical
    to before the user data-dir existed.
    """
    global _LAST_SCAN_SIGNATURE
    _LAST_SCAN_SIGNATURE = _discovery_signature()
    registry: dict[str, Skill] = {}
    _scan_skill_dir(_SKILL_DIR, registry, allow_override=True)
    if _USER_SKILL_DIR is not None:
        _scan_skill_dir(_USER_SKILL_DIR, registry, allow_override=False)
    for extra in _EXTRA_SKILL_DIRS:
        _scan_skill_dir(extra, registry, allow_override=False)
    return registry


# Extra discovery dirs beyond the built-in and user dirs: dev-room mounts
# (`gateway.dev_room`) point these at a pack SOURCE tree's `skills/` so an author's
# edit is one cache-clear away from live. Same precedence rule as the user dir —
# a built-in id always wins.
_EXTRA_SKILL_DIRS: tuple[Path, ...] = ()


def _discovery_dirs() -> tuple[Path, ...]:
    """Every directory discovery scans, in precedence order (built-in first)."""
    dirs = [_SKILL_DIR]
    if _USER_SKILL_DIR is not None:
        dirs.append(_USER_SKILL_DIR)
    dirs.extend(_EXTRA_SKILL_DIRS)
    return tuple(dirs)


def _discovery_signature() -> tuple[object, ...]:
    """A fingerprint of the discovery dirs: each dir's `mtime_ns` plus its skills' manifests.

    The twin of ``core.rulepacks._discovery_signature`` for the same reason: a pack installed
    by ANOTHER process (Studio's install button shells out to the CLI) ships skill directories
    into a dir this process already scanned, and the `@cache` would otherwise stay stale for
    the rest of the process lifetime. Only ever computed on a resolution MISS, so the hit path
    never touches the filesystem.
    """
    signature: list[object] = []
    for directory in _discovery_dirs():
        try:
            dir_mtime: int | None = directory.stat().st_mtime_ns
            files = tuple(
                sorted((path.parent.name, path.stat().st_mtime_ns) for path in directory.glob("*/SKILL.md"))
            )
        except OSError:
            dir_mtime, files = None, ()
        signature.append((str(directory), dir_mtime, files))
    return tuple(signature)


# Signature of the discovery dirs as they looked during the last real scan. `None` means
# discovery has not run yet in this process.
_LAST_SCAN_SIGNATURE: tuple[object, ...] | None = None
# When the signature was last compared (monotonic seconds); -inf means never.
_LAST_SIGNATURE_CHECK: float = float("-inf")

# The twin of `core.rulepacks.RESCAN_MIN_INTERVAL_SECONDS`; see it for the reasoning. Two
# out-of-process shapes to cover: a NEW id (a miss, which forces a check) and an id
# UPGRADED IN PLACE — a HIT that would otherwise keep serving the body from the old scan,
# which is exactly what reinstalling a pack at a newer version does to its skill.
RESCAN_MIN_INTERVAL_SECONDS = 2.0


def _rescan_if_dirs_changed(*, force: bool = False) -> bool:
    """Reload discovery when the dirs changed since the last scan; True if a reload happened.

    Signature unchanged means nothing on disk moved, so nothing is rescanned and a bad id
    cannot trigger a scan storm. `force` skips the throttle for a resolution MISS, so
    "install a pack, enable its skill in the next breath" never waits out an interval.
    """
    global _LAST_SIGNATURE_CHECK
    now = time.monotonic()
    if not force and now - _LAST_SIGNATURE_CHECK < RESCAN_MIN_INTERVAL_SECONDS:
        return False
    changed = _discovery_signature() != _LAST_SCAN_SIGNATURE
    if changed:
        reload_skills()
    # Stamped AFTER the reload, never before: reload_skills() clears this timestamp so an
    # EXPLICIT reload is followed by a fresh look, and stamping first would let that
    # clearing undo the throttle we just paid for — leaving every probe unthrottled.
    _LAST_SIGNATURE_CHECK = now
    return changed


def set_extra_skill_dirs(dirs: Iterable[Path | str]) -> None:
    """Replace the extra discovery dirs and drop the cache (dev-room mounts)."""
    global _EXTRA_SKILL_DIRS
    _EXTRA_SKILL_DIRS = tuple(Path(entry) for entry in dirs)
    reload_skills()


def reload_skills() -> None:
    """Clear the discovery cache so a just-written skill (`agent.forge`) is picked up immediately.

    Discovery is otherwise cached for process lifetime (`@cache`); nothing else needs to call
    this in normal operation since the on-disk skill set doesn't change outside of generation.
    """
    global _LAST_SCAN_SIGNATURE, _LAST_SIGNATURE_CHECK
    _LAST_SCAN_SIGNATURE = None
    _LAST_SIGNATURE_CHECK = float("-inf")
    _discover_registry.cache_clear()


def built_in_skill_ids() -> set[str]:
    """Directory names under `_SKILL_DIR` — the BUILT-IN skills only, never `_USER_SKILL_DIR`.

    Used by `agent.forge` to reject a generated skill id that collides with a built-in (e.g.
    `mature-mode`) before ever writing it -- deliberately a raw directory listing rather than
    going through `_discover_registry`/`available_skills`, so this stays accurate even if a
    built-in's own `SKILL.md` happens to be malformed at the moment of the check.
    """
    if not _SKILL_DIR.is_dir():
        return set()
    return {entry.name for entry in _SKILL_DIR.iterdir() if entry.is_dir()}


def available_skills() -> list[Skill]:
    """Return every discoverable skill in ``skills/``, sorted by id.

    Self-heals like `load_skill`, and it matters MORE here: `.skill list` and the
    membership check behind `.skill enable` (`gateway.commands.rules`) both read this, so
    without the check a skill installed by another process stayed "unknown" at the very
    command a keeper reaches for right after installing a pack.
    """
    _rescan_if_dirs_changed()
    return [skill for _, skill in sorted(_discover_registry().items())]


def load_skill(skill_id: str) -> Skill | None:
    """Load ``skill_id``'s ``Skill``, or ``None`` when unknown.

    Callers must tolerate ``None`` (an id enabled for a room that no longer
    resolves to a discoverable skill, e.g. after its directory was removed).

    Self-healing against out-of-process installs, the same way `core.rulepacks.load_rulepack`
    is: a throttled signature check every call (catching a skill UPGRADED in place, so an
    enabled skill's body follows a pack upgrade) and a forced one on a MISS (catching a
    newly installed id). Neither needs a restart.
    """
    _rescan_if_dirs_changed()
    skill = _discover_registry().get(skill_id)
    if skill is None and _rescan_if_dirs_changed(force=True):
        skill = _discover_registry().get(skill_id)
    return skill


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
    raw = await store.state_get(chat_key, "skills_enabled")
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
