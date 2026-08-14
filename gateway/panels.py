"""Room-level module UI panels (M15): manifests, enable/disable plumbing, asset lookup.

`core.panels` owns the schema; this module owns the ROOM view of it. Enabled pack ids
live at ``room_panels.{chat_key}`` (`gateway.ops`); each enabled pack resolves to its
installed home (``data_dir/packs/<id>@<version>/`` — see `core.pack.install_pack`),
whose built ``pack.yaml`` + declared panels files are re-parsed on demand. A pack that
fails to load degrades to "no panels from this pack (logged)", never to a broken room.

Iron-rule threading happens here, in exactly two functions:

- :func:`build_ui_manifest_frame` resolves ``audience`` per viewer ROLE before anything
  reaches the wire (`core.panels.audience_allows`) — a keeper-only panel structurally
  never enters a player's manifest, and ``audience`` itself never rides the frame.
- :func:`resolve_pack_asset` answers hash→bytes lookups ONLY from packs enabled in the
  caller's room (no arbitrary blob oracle), verifying the bytes still match their
  manifest digest before serving.

Everything is read-on-demand: rooms rarely flip panels, panels files are ≤ 256 KB, and
re-reading keeps enable/install/upgrade coherent without a cache to invalidate.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from core.pack import MANIFEST_NAME, PackManifest, parse_manifest_text
from core.panels import PanelSpec, audience_allows, parse_panels_text, wire_panel
from gateway.hub import Event, RoomHub
from gateway.ops import get_enabled_panel_packs

if TYPE_CHECKING:
    from agent.services import Services

logger = logging.getLogger(__name__)

_PACKS_DIRNAME = "packs"


def _version_key(version: str) -> tuple[Any, ...]:
    """Sort key for ``<id>@<version>`` homes: numeric on the dotted prefix, then raw."""
    prefix = version.split("-", 1)[0].split("+", 1)[0]
    parts: list[int] = []
    for piece in prefix.split("."):
        if not piece.isdigit():
            break
        parts.append(int(piece))
    return (tuple(parts), version)


# Dev-room virtual homes (`gateway.dev_room`): a mounted pack SOURCE dir served as if
# it were an installed home. A dev home WINS over an installed pack of the same id —
# the author mounted it precisely to test the source of that pack. Everything below
# (enabled_packs, `.panels list`, asset resolution) inherits it through
# `installed_pack_homes`, the one aggregation point.
_DEV_HOMES: dict[str, Path] = {}


def set_dev_pack_homes(homes: Mapping[str, Path]) -> None:
    """Replace the dev-room virtual homes (called only by `gateway.dev_room`)."""
    _DEV_HOMES.clear()
    _DEV_HOMES.update({pack_id: Path(home) for pack_id, home in homes.items()})


def installed_pack_homes(data_dir: Path) -> dict[str, Path]:
    """Newest installed home per pack id (``packs/<id>@<version>`` dirs, best version wins),
    plus any dev-room mounts (which win on an id clash — see `set_dev_pack_homes`)."""
    packs_dir = Path(data_dir) / _PACKS_DIRNAME
    homes: dict[str, tuple[tuple[Any, ...], Path]] = {}
    if packs_dir.is_dir():
        for entry in packs_dir.iterdir():
            if not entry.is_dir() or "@" not in entry.name or entry.name.startswith("."):
                continue
            pack_id, _, version = entry.name.partition("@")
            key = _version_key(version)
            current = homes.get(pack_id)
            if current is None or key > current[0]:
                homes[pack_id] = (key, entry)
    result = {pack_id: path for pack_id, (_key, path) in homes.items()}
    result.update(_DEV_HOMES)
    return result


def _digest_source_assets(home: Path, manifest: PackManifest) -> PackManifest:
    """Complete a SOURCE manifest the way `build_pack` would: fold panel/kit asset paths
    into the asset block and stamp sha256/mime/size from the live files, so panels'
    integrity checks hold against a dev mount exactly as against an installed home.
    Build-only caps (panel code size) are deliberately not enforced here — a dev room
    is the author's own box; `--pack` remains the authority that gates release."""
    import hashlib
    from dataclasses import replace as dc_replace

    from core.pack import PackAsset, _asset_mime, _validate_pack_panels, _validate_pack_presentation

    def read_text(relative: str) -> str:
        return (home / relative).read_text(encoding="utf-8")

    referenced: list[str] = []
    for validator in (_validate_pack_panels, _validate_pack_presentation):
        try:
            _parsed, paths = validator(read_text, manifest)
            referenced.extend(path for path in paths if path not in referenced)
        except Exception:
            logger.warning("panels: dev manifest %s fails %s", home, validator.__name__, exc_info=True)
    declared = {asset.path for asset in manifest.assets}
    assets = list(manifest.assets) + [
        PackAsset(path=path, sha256="", mime="", size=0) for path in referenced if path not in declared
    ]
    stamped: list[PackAsset] = []
    for asset in assets:
        file = home / asset.path
        if not file.is_file():
            continue
        data = file.read_bytes()
        stamped.append(
            dc_replace(
                asset,
                sha256=hashlib.sha256(data).hexdigest(),
                mime=asset.mime or _asset_mime(asset.path),
                size=len(data),
            )
        )
    return dc_replace(manifest, assets=tuple(stamped))


def _load_manifest(home: Path) -> PackManifest | None:
    is_dev = home in _DEV_HOMES.values()
    try:
        manifest = parse_manifest_text(
            (home / MANIFEST_NAME).read_text(encoding="utf-8"),
            # A dev mount is a SOURCE tree: no generated trust/files blocks yet.
            expect_trust=not is_dev,
        )
        return _digest_source_assets(home, manifest) if is_dev else manifest
    except Exception:
        logger.warning("panels: unreadable pack manifest under %s", home, exc_info=True)
        return None


def _load_pack_panels(home: Path, manifest: PackManifest) -> list[PanelSpec]:
    panels: list[PanelSpec] = []
    for panels_path in manifest.contents.get("panels", ()):
        try:
            panels.extend(parse_panels_text((home / panels_path).read_text(encoding="utf-8")))
        except Exception:
            logger.warning("panels: unreadable panels file %s under %s", panels_path, home, exc_info=True)
    return panels


def list_installed_panel_packs(services: Services) -> list[tuple[str, int]]:
    """``(pack_id, panel_count)`` for every installed pack that ships panels (for `.panels list`)."""
    result: list[tuple[str, int]] = []
    for pack_id, home in sorted(installed_pack_homes(services.settings.data_dir).items()):
        manifest = _load_manifest(home)
        if manifest is None:
            continue
        # A dev mount's source manifest has no trust block; count its real panels.
        count = manifest.trust.panels if manifest.trust is not None else len(_load_pack_panels(home, manifest))
        if count:
            result.append((pack_id, count))
    return result


def installed_panel_count(services: Services, pack_id: str) -> int:
    """How many panels ``pack_id``'s newest installed home ships (0 = none/not installed)."""
    home = installed_pack_homes(services.settings.data_dir).get(pack_id)
    if home is None:
        return 0
    manifest = _load_manifest(home)
    if manifest is None:
        return 0
    if manifest.trust is None:  # a dev mount's source manifest — count its real panels
        return len(_load_pack_panels(home, manifest))
    return manifest.trust.panels


async def enabled_packs(services: Services, chat_key: str) -> list[tuple[str, Path, PackManifest]]:
    homes = installed_pack_homes(services.settings.data_dir)
    packs: list[tuple[str, Path, PackManifest]] = []
    for pack_id in await get_enabled_panel_packs(services.store, chat_key):
        home = homes.get(pack_id)
        if home is None:
            logger.warning("panels: enabled pack %s is not installed; skipping", pack_id)
            continue
        manifest = _load_manifest(home)
        if manifest is not None:
            packs.append((pack_id, home, manifest))
    return packs


async def build_ui_manifest_frame(services: Services, chat_key: str, role: str) -> dict[str, Any]:
    """The complete ``ui_manifest`` frame for ONE viewer role (full-replace semantics).

    The audience filter runs HERE, server-side, per `core.panels.audience_allows` —
    the red line "a keeper panel never appears in a player's manifest" is this line of
    code, not client behavior. A panel whose integrity records are missing is skipped
    and logged (its pack home was hand-edited; fail closed).
    """
    panels: list[dict[str, Any]] = []
    for pack_id, home, manifest in await enabled_packs(services, chat_key):
        asset_info = {
            asset.path: {"sha256": asset.sha256, "size": asset.size, "mime": asset.mime}
            for asset in manifest.assets
        }
        for panel in _load_pack_panels(home, manifest):
            if not audience_allows(panel.audience, role):
                continue
            try:
                panels.append(wire_panel(pack_id, panel, asset_info))
            except ValueError:
                logger.warning("panels: skipping %s/%s (broken integrity records)", pack_id, panel.id, exc_info=True)
    return {"type": "ui_manifest", "panels": panels}


async def member_panel_ids(services: Services, chat_key: str, role: str) -> set[str]:
    """The wire panel ids in ``role``'s manifest for this room — the `panel_intent`
    authorization set (an intent naming any other panel is refused)."""
    ids: set[str] = set()
    for pack_id, home, manifest in await enabled_packs(services, chat_key):
        for panel in _load_pack_panels(home, manifest):
            if audience_allows(panel.audience, role):
                ids.add(f"{pack_id}/{panel.id}")
    return ids


async def pack_asset_mime(services: Services, chat_key: str, sha256: str) -> str | None:
    """The declared MIME of ``sha256`` when a pack ENABLED in this room ships it, else
    ``None`` — the metadata-only sibling of :func:`resolve_pack_asset`, for callers that
    only need to know a hash is reachable (`gateway.ui_media`) and must not pay a disk
    read + re-digest per lookup. Same room scoping: a pack the room has not enabled
    answers ``None``."""
    wanted = sha256.lower()
    if not wanted:
        return None
    for _pack_id, _home, manifest in await enabled_packs(services, chat_key):
        for asset in manifest.assets:
            if asset.sha256 == wanted:
                return asset.mime or None
    return None


async def resolve_pack_asset(services: Services, chat_key: str, sha256: str) -> tuple[bytes, str, str] | None:
    """``(bytes, mime, name)`` for a pack-asset hash, or ``None`` when no pack enabled in
    THIS room declares it. Bytes are re-hashed against the manifest digest before serving
    — an on-disk tamper of a pack home serves nothing rather than something else."""
    import hashlib

    wanted = sha256.lower()
    if not wanted:
        return None
    for _pack_id, home, manifest in await enabled_packs(services, chat_key):
        for asset in manifest.assets:
            if asset.sha256 != wanted:
                continue
            try:
                data = (home / asset.path).read_bytes()
            except OSError:
                logger.warning("panels: asset %s missing from %s", asset.path, home)
                continue
            if hashlib.sha256(data).hexdigest() != wanted:
                logger.warning("panels: asset %s under %s no longer matches its digest", asset.path, home)
                continue
            return data, asset.mime or "application/octet-stream", Path(asset.path).name
    return None


async def publish_ui_manifests(hub: RoomHub, services: Services, chat_key: str) -> None:
    """Push a fresh per-viewer manifest to every connected member (after `.panels` changes)."""

    async def build(member: Any) -> Event:
        role = str(getattr(member, "role", "") or "")
        return Event.ui_manifest(await build_ui_manifest_frame(services, chat_key, role))

    await hub.publish_each(chat_key, build)


async def deliver_panel_events(hub: RoomHub, services: Services, chat_key: str, events: list[dict[str, Any]]) -> None:
    """Deliver hook-emitted `panel_event` payloads, each ONLY to members whose manifest
    contains the target panel (an event naming an unknown/foreign panel reaches nobody).
    Best-effort per member — one dead connection never blocks the rest."""
    if not events:
        return
    members = hub.members(chat_key)
    if not members:
        return
    ids_by_role: dict[str, set[str]] = {}
    for member in members:
        role = str(getattr(member, "role", "") or "")
        if role not in ids_by_role:
            ids_by_role[role] = await member_panel_ids(services, chat_key, role)
        allowed = ids_by_role[role]
        for event in events:
            if event.get("panel") not in allowed:
                continue
            try:
                await member.deliver(Event.panel_event({"type": "panel_event", **event}))
            except Exception:
                logger.warning(
                    "panels: could not deliver panel_event to %s", getattr(member, "id", member), exc_info=True
                )
