"""Dev rooms — mount a pack SOURCE dir into a room and reload it on save (H2 Bomb-1
author DX). Kills the edit → pack → install → reimport minute-loop: the author edits
files, the room follows.

The moving parts, and where each lives:

- **Confinement.** `.dev mount <path>` reads server-side files, so mounts only resolve
  under `settings.dev.source_root` (`TRPG_DEV__SOURCE_ROOT`); with the root unset the
  whole surface is off. This is deliberate networked-admin posture, not paranoia — a
  remote keeper must not be able to point the server's parsers at arbitrary paths.
- **Discovery.** A mount registers three ways at once: as a virtual pack home
  (`gateway.panels.set_dev_pack_homes` — panels, presentation kits and pack-relative
  assets read straight from source), and as extra skill/rulepack discovery dirs
  (`core.skills` / `core.rulepacks` — a save is one cache-clear away from live).
- **Reload.** Re-reads the source manifest, REMOVES the lore this mount previously
  wrote (`core.worldbook.add` dedupes by id, so without the removal an edited entry
  would keep its stale text forever), then re-imports: world-detected cards through
  the real `.import … world` path (hooks/modvars/pregens/brief all replace by
  construction; InitVar merge and modvar redefinition keep the room's live values),
  lorebooks through the real `.lore import` path, then a skills/rulepacks cache clear
  and a panels/state push. A manifest that no longer parses reports and changes
  NOTHING.
- **The watcher.** One asyncio task per mounted room polls the tree's mtimes (no new
  dependency; the repo has no file-watching precedent to reuse). It is the only
  caller that takes `hub.turn_lock` itself — the `.dev` command paths are already
  inside the transport choke points' lock (defensive-patterns #1) and must not
  re-acquire. Each cycle re-checks the persisted mount record, so a `.reset all`,
  room import or restore that cleared it stops the watcher instead of it re-seeding
  a fresh room. After a server restart the record survives but the task does not;
  any `.dev` command re-arms it (documented, deliberate v1).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from agent.context import AgentCtx, LocalFs
from core.pack import MANIFEST_NAME, PackError, PackManifest, parse_manifest_text
from core.rulepacks import reload_rulepacks, set_extra_rulepack_dirs
from core.skills import reload_skills, set_extra_skill_dirs
from core.worldbook import LORE_DOC_TYPE
from gateway.hub import Event, RoomHub
from gateway.panels import publish_ui_manifests, set_dev_pack_homes
from infra.room_facets import STORAGE_ROOM_STATE, FacetContext, RoomStateFacet

if TYPE_CHECKING:
    from agent.services import Services

logger = logging.getLogger(__name__)

DEV_MOUNT_KEY = "dev_mount"
POLL_SECONDS = 1.5
MAX_SCAN_FILES = 4000


@dataclass(frozen=True)
class Mount:
    chat_key: str
    path: Path
    pack_id: str
    # The lore sources this mount's last reload wrote (card names + lorebook file
    # names) — the removal set that makes the next reload replace instead of stack.
    sources: tuple[str, ...] = ()


_MOUNTS: dict[str, Mount] = {}
_WATCHERS: dict[str, asyncio.Task] = {}


def _sync_registries() -> None:
    """Project the current mount set into the three discovery surfaces."""
    set_dev_pack_homes({mount.pack_id: mount.path for mount in _MOUNTS.values()})
    set_extra_skill_dirs(
        [mount.path / "skills" for mount in _MOUNTS.values() if (mount.path / "skills").is_dir()]
    )
    set_extra_rulepack_dirs(
        [mount.path / "rulepacks" for mount in _MOUNTS.values() if (mount.path / "rulepacks").is_dir()]
    )


def _dev_ctx(services: Services, chat_key: str, mount_path: Path) -> AgentCtx:
    """The synthetic keeper-context reload imports run under. `platform="cli"` is the
    trusted-operator marker; `fs` confines relative paths to the mounted tree."""
    return AgentCtx(
        chat_key=chat_key,
        user_id="dev-room",
        platform="cli",
        locale=services.settings.locale,
        fs=LocalFs(str(mount_path)),
    )


async def _persist(services: Services, mount: Mount) -> None:
    await services.store.state_set(
        mount.chat_key,
        DEV_MOUNT_KEY,
        json.dumps({"path": str(mount.path), "pack_id": mount.pack_id, "sources": list(mount.sources)}),
    )


def resolve_source(services: Services, raw_path: str) -> Path | str:
    """A confined mount path, or the i18n key naming why not (feature off / outside
    the root / not a pack source)."""
    root = str(services.settings.dev.source_root or "").strip()
    if not root:
        return "dev.commands.disabled"
    try:
        root_dir = Path(root).expanduser().resolve(strict=True)
        candidate = Path(raw_path).expanduser().resolve(strict=True)
    except OSError:
        return "dev.commands.outside_root"
    if not candidate.is_relative_to(root_dir) or not candidate.is_dir():
        return "dev.commands.outside_root"
    if not (candidate / MANIFEST_NAME).is_file():
        return "dev.commands.no_manifest"
    return candidate


def _read_manifest(path: Path) -> PackManifest:
    return parse_manifest_text((path / MANIFEST_NAME).read_text(encoding="utf-8"), expect_trust=False)


async def mount(
    services: Services, hub: RoomHub | None, chat_key: str, raw_path: str, locale: str | None = None
) -> str:
    """Mount + initial reload; returns the localized reply for the issuing keeper."""
    i18n = services.i18n.with_locale(locale or services.settings.locale)
    resolved = resolve_source(services, raw_path)
    if isinstance(resolved, str):
        return i18n.t(resolved, root=str(services.settings.dev.source_root))
    try:
        manifest = _read_manifest(resolved)
    except (PackError, OSError, UnicodeDecodeError) as exc:
        return i18n.t("dev.commands.bad_source", error=str(exc))

    _MOUNTS[chat_key] = Mount(chat_key=chat_key, path=resolved, pack_id=manifest.id)
    await _persist(services, _MOUNTS[chat_key])
    _sync_registries()
    ensure_watcher(services, hub, chat_key)
    summary = await reload(services, hub, chat_key, locale)
    return i18n.t("dev.commands.mounted", pack=manifest.id, path=str(resolved)) + "\n" + summary


async def unmount(services: Services, chat_key: str) -> bool:
    """Stop watching and forget the mount. Imported content stays — the room keeps
    playing what it has; only the live sync ends."""
    task = _WATCHERS.pop(chat_key, None)
    if task is not None:
        task.cancel()
    had = _MOUNTS.pop(chat_key, None) is not None
    await services.store.state_set(chat_key, DEV_MOUNT_KEY, "")
    _sync_registries()
    return had


async def rearm(services: Services, hub: RoomHub | None, chat_key: str) -> Mount | None:
    """The process-side mount for ``chat_key``, rebuilt from the persisted record when
    this process has never seen it (the after-restart path). None = not mounted."""
    existing = _MOUNTS.get(chat_key)
    if existing is not None:
        ensure_watcher(services, hub, chat_key)
        return existing
    raw = await services.store.state_get(chat_key, DEV_MOUNT_KEY)
    if not raw:
        return None
    try:
        record = json.loads(raw)
        path = Path(str(record["path"]))
        restored = Mount(
            chat_key=chat_key,
            path=path,
            pack_id=str(record.get("pack_id", "")) or "dev",
            sources=tuple(str(entry) for entry in record.get("sources", [])),
        )
    except (ValueError, KeyError, TypeError):
        return None
    if isinstance(resolve_source(services, str(path)), str):
        # The record outlived its confinement (root changed, dir gone): drop it.
        await services.store.state_set(chat_key, DEV_MOUNT_KEY, "")
        return None
    _MOUNTS[chat_key] = restored
    _sync_registries()
    ensure_watcher(services, hub, chat_key)
    return restored


async def reload(services: Services, hub: RoomHub | None, chat_key: str, locale: str | None = None) -> str:
    """One full source→room sync. Parse first, mutate after — a broken source tree
    reports and changes nothing. Callers hold (or are inside) the room's turn lock."""
    from agent.kp_tools_charcard import CharcardTools, _parse_any_card_file
    from agent.kp_tools_worldbook import WorldbookTools
    from core.card_split import detect_world_payloads
    from gateway.turn import publish_state

    i18n = services.i18n.with_locale(locale or services.settings.locale)
    current = _MOUNTS.get(chat_key)
    if current is None:
        return i18n.t("dev.commands.not_mounted")
    try:
        manifest = _read_manifest(current.path)
        # Decide the card split up front, before anything mutates.
        world_cards: list[str] = []
        for card_path in manifest.contents.get("cards", ()):
            card, lorecard = _parse_any_card_file(current.path / card_path)
            if detect_world_payloads(card).any or (lorecard is not None and lorecard.variable_specs):
                world_cards.append(card_path)
    except Exception as exc:  # noqa: BLE001 — every parse failure is the author's next fix
        return i18n.t("dev.commands.reload_failed", error=str(exc))

    # Remove the lore this mount wrote last time: `worldbook.add` dedupes by entry id,
    # so a re-import over live entries would silently keep every stale text.
    removed = 0
    if current.sources:
        owned = set(current.sources)
        for doc in await services.documents.list(chat_key, LORE_DOC_TYPE):
            if doc.source in owned:
                await services.documents.delete(chat_key, LORE_DOC_TYPE, doc.id)
                removed += 1

    ctx = _dev_ctx(services, chat_key, current.path)
    sources: list[str] = []
    for card_path in world_cards:
        card, _lorecard = _parse_any_card_file(current.path / card_path)
        await CharcardTools(services).import_world_card(ctx, file_path=card_path)
        if card.name:
            sources.append(card.name)
    lore_tools = WorldbookTools(services)
    for book_path in manifest.contents.get("lorebooks", ()):
        await lore_tools.import_lorebook(ctx, file_path=book_path, _keeper=True)
        sources.append(Path(book_path).name)

    reload_skills()
    reload_rulepacks()

    _MOUNTS[chat_key] = Mount(
        chat_key=chat_key, path=current.path, pack_id=current.pack_id, sources=tuple(sources)
    )
    await _persist(services, _MOUNTS[chat_key])

    live = sum(1 for doc in await services.documents.list(chat_key, LORE_DOC_TYPE) if doc.source in set(sources))
    if hub is not None:
        await publish_ui_manifests(hub, services, chat_key)
        await publish_state(hub, services, ctx)
    return i18n.t(
        "dev.commands.reload_done",
        cards=len(world_cards),
        lorebooks=len(manifest.contents.get("lorebooks", ())),
        lore=live,
        removed=removed,
    )


def ensure_watcher(services: Services, hub: RoomHub | None, chat_key: str) -> None:
    existing = _WATCHERS.get(chat_key)
    if existing is not None and not existing.done():
        return
    task = asyncio.create_task(_watch(services, hub, chat_key))
    _WATCHERS[chat_key] = task
    task.add_done_callback(lambda done: _WATCHERS.pop(chat_key, None) if _WATCHERS.get(chat_key) is done else None)


def fingerprint(root: Path) -> tuple[tuple[str, int, int], ...]:
    """The tree's change signature: (relative path, mtime_ns, size) per file, hidden
    entries skipped, capped at MAX_SCAN_FILES (a tree that large changes inside the
    cap anyway on any real edit)."""
    entries: list[tuple[str, int, int]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if not path.is_file():
            continue
        stat = path.stat()
        entries.append((str(relative), stat.st_mtime_ns, stat.st_size))
        if len(entries) >= MAX_SCAN_FILES:
            break
    return tuple(entries)


async def _watch(services: Services, hub: RoomHub | None, chat_key: str) -> None:
    mount_state = _MOUNTS.get(chat_key)
    if mount_state is None:
        return
    try:
        last = fingerprint(mount_state.path)
    except OSError:
        last = ()
    while True:
        await asyncio.sleep(POLL_SECONDS)
        if chat_key not in _MOUNTS:
            return
        # Self-healing against `.reset all` / room import / restore: the persisted
        # record is the mount's ground truth; when an operation cleared it, stop.
        try:
            raw = await services.store.state_get(chat_key, DEV_MOUNT_KEY)
        except Exception:  # noqa: BLE001 — a store hiccup must not kill the watcher
            continue
        if not raw:
            _MOUNTS.pop(chat_key, None)
            _sync_registries()
            return
        mount_state = _MOUNTS[chat_key]
        try:
            current = fingerprint(mount_state.path)
        except OSError:
            continue
        if current == last:
            continue
        last = current
        try:
            # The one out-of-band caller: take the room's turn lock so a reload never
            # interleaves a player turn (the `.dev` command paths are already inside it).
            if hub is not None:
                async with hub.turn_lock(chat_key):
                    summary = await reload(services, hub, chat_key)
                await hub.publish(chat_key, Event.system("info", summary))
            else:
                await reload(services, hub, chat_key)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a broken save must not kill the watcher
            logger.warning("dev room: reload failed for %s", chat_key, exc_info=True)


async def _on_room_delete(context: FacetContext) -> None:
    task = _WATCHERS.pop(context.chat_key, None)
    if task is not None:
        task.cancel()
    _MOUNTS.pop(context.chat_key, None)
    _sync_registries()


ROOM_FACETS = (
    RoomStateFacet(
        name="dev_mount",
        owner="gateway.dev_room",
        # The mount is a workbench fixture: story/chars resets replay the same module
        # (exactly when an author WANTS the mount kept); only a full wipe clears it.
        # The watcher re-checks this key every cycle, so clearing it stops the sync.
        reset_scope="all",
        state_keys=frozenset({DEV_MOUNT_KEY}),
        storages=frozenset({STORAGE_ROOM_STATE}),
        on_delete=_on_room_delete,
    ),
)
