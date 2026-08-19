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
from collections.abc import Callable, Mapping
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

from core.pack import DEV_PACK_HOMES, MANIFEST_NAME, PackManifest, parse_manifest_text
from core.pack import set_dev_pack_homes as _set_dev_pack_homes
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
# The `.dev mount` registry lives in `core.pack` (the pack helpers there must see it
# too); this module reads THE SAME dict and re-exports the setter for `gateway.dev_room`.
_DEV_HOMES: dict[str, Path] = DEV_PACK_HOMES
set_dev_pack_homes = _set_dev_pack_homes


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


def installed_card_entries(data_dir: Path) -> list[dict[str, str]]:
    """Every installed pack's card files as `{ref, pack, name, kind}` entries (the
    `pack_cards` frame + `.import list`): `ref` is exactly what `.import <ref>`
    accepts, `name` is the filename stem for display. Filenames only — the trust
    card already printed them to the operator; card CONTENT never rides this.

    `kind` (protocol 2.3) is the manifest's 拆卡 classification, `"character"` or
    `"world"`, and it is what a picker needs to send the RIGHT verb: without it
    every client hard-coded `.import <ref> pc`, so clicking a world card tried to
    make a player character out of a module and failed on a name collision. It
    leaks nothing a filename does not — "this pack ships module machinery" is the
    same claimable fact as "this pack ships a card"; the keeper gate on
    `.import … world` is unchanged and structural.

    A SOURCE tree (a `.dev mount` room) has no stamped kind — detection runs at
    build time — so its cards are read and classified here, which an author's own
    box can afford and an installed pack never pays for.
    """
    entries: list[dict[str, str]] = []
    for pack_id, home in sorted(installed_pack_homes(data_dir).items()):
        cards_dir = home / "cards"
        if not cards_dir.is_dir():
            continue
        kinds = _card_kinds(home)
        for entry in sorted(cards_dir.iterdir()):
            if entry.is_file() and entry.suffix.casefold() in {".json", ".png"}:
                entries.append(
                    {
                        "ref": f"{pack_id}/cards/{entry.name}",
                        "pack": pack_id,
                        "name": entry.stem,
                        "kind": kinds(f"cards/{entry.name}", entry),
                    }
                )
    return entries


def _file_stamp(path: Path) -> tuple[int, int] | None:
    """`(mtime_ns, size)` — the identity a memo key needs; None when unreadable."""
    try:
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


@lru_cache(maxsize=256)
def _manifest_card_kinds(home: Path, is_dev: bool, _stamp: tuple[int, int] | None) -> Mapping[str, str] | None:
    """`relative path -> kind` from one home's manifest, memoized on the manifest file's
    identity: an installed home's manifest never changes (a new version is a new dir),
    a dev mount's changes when the author saves — either way the parse happens once per
    file version, not once per `list_pack_cards` frame (player-open, off the turn lock)."""
    try:
        manifest = parse_manifest_text((home / MANIFEST_NAME).read_text(encoding="utf-8"), expect_trust=not is_dev)
    except Exception:
        logger.warning("panels: unreadable pack manifest under %s", home, exc_info=True)
        return None
    return {card.path: card.kind for card in manifest.card_entries}


@lru_cache(maxsize=1024)
def _detected_card_kind(path: Path, relative: str, _stamp: tuple[int, int] | None) -> str:
    """The build's own detector over one SOURCE card, memoized on the file's identity —
    a dev mount's cards are read and classified once per save, not per listing."""
    from core.pack import detect_card_kind

    try:
        return detect_card_kind(relative, path.read_bytes())
    except Exception:
        logger.warning("panels: card %s at %s is unclassifiable", relative, path, exc_info=True)
        return "character"


def _card_kinds(home: Path) -> Callable[[str, Path], str]:
    """`(relative_path, file) -> kind` for one pack home. Best-effort: an unreadable
    manifest or an unparseable card falls back to `"character"`, which is the verb
    every client sent before kinds existed."""
    is_dev = home in _DEV_HOMES.values()
    kinds = _manifest_card_kinds(home, is_dev, _file_stamp(home / MANIFEST_NAME))

    def kind_of(relative: str, path: Path) -> str:
        if not is_dev:
            return kinds.get(relative, "character") if kinds is not None else "character"
        # Source tree: no stamped kind, so ask the same detector the build uses.
        return _detected_card_kind(path, relative, _file_stamp(path))

    return kind_of


def resolve_pack_ref(data_dir: Path | str, ref: str) -> Path | None:
    """The file a pack-relative ref (`<packId>/<relative>`) names, for `.import`.

    `core.pack.resolve_installed_path` knows only `data_dir/packs/<id>@<ver>/`; a
    `.dev mount` home is a SOURCE tree elsewhere, and its cards are listed by
    `installed_card_entries` under the same ref shape — so a ref must resolve against
    the dev home too, or the picker offers rows `.import` cannot take. Confined exactly
    the same way (resolved path must stay under the home; regular files only)."""
    from core.pack import resolve_installed_path

    text = str(ref).strip()
    pack_id, _, rest = text.partition("/")
    home = _DEV_HOMES.get(pack_id)
    if home is not None and rest.strip():
        base = home.resolve()
        try:
            target = (home / rest.strip()).resolve(strict=True)
            target.relative_to(base)
        except (OSError, ValueError):
            target = None
        if target is not None and target.is_file():
            return target
    return resolve_installed_path(data_dir, text)


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


def installed_presentation_count(services: Services, pack_id: str) -> int:
    """How many presentation kits ``pack_id``'s newest installed home declares (0/1).

    `.panels enable` is the ONE switch that admits a pack's table dressing — panels
    AND the Stage Director's kit ride it together (`gateway.presentation`) — so a
    module that ships only a kit must pass the same door. Declared-in-manifest is
    the right test (not subject count): an audio-only kit stages cues with zero
    picturable subjects and is still a kit."""
    home = installed_pack_homes(services.settings.data_dir).get(pack_id)
    if home is None:
        return 0
    manifest = _load_manifest(home)
    if manifest is None:
        return 0
    return len(manifest.contents.get("presentation", ()))


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


async def enabled_panels(services: Services, chat_key: str, role: str) -> list[tuple[str, PanelSpec]]:
    """Every panel ``role`` may see in this room, as ``(wire_id, spec)`` in pack order.

    The audience filter is the same one `build_ui_manifest_frame` applies — keeper panels
    are absent from a player's list here too, structurally, not hidden downstream."""
    panels: list[tuple[str, PanelSpec]] = []
    for pack_id, home, manifest in await enabled_packs(services, chat_key):
        for panel in _load_pack_panels(home, manifest):
            if audience_allows(panel.audience, role):
                panels.append((f"{pack_id}/{panel.id}", panel))
    return panels


async def member_panel_ids(services: Services, chat_key: str, role: str) -> set[str]:
    """The wire panel ids in ``role``'s manifest for this room — the `panel_intent`
    authorization set (an intent naming any other panel is refused)."""
    return {wire_id for wire_id, _panel in await enabled_panels(services, chat_key, role)}


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
