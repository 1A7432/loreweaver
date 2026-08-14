"""The ROOM view of installed presentation kits (M19).

`core.presentation` owns the schema; this owns what a room's Stage Director can
actually reach. It mirrors `gateway.panels` deliberately — same installed-home lookup,
same "a pack that fails to load degrades to nothing (logged), never to a broken room",
same read-on-demand stance (kits are ≤ 128 KB and change only on install/enable).

One difference matters: a kit is admitted to a room by the SAME `.panels enable <packId>`
switch as its panels. Presentation is the module dressing the table; splitting it into a
second keeper toggle would only create rooms whose Director has a style guide but no
pictures, or the reverse.

Resolving a kit yields `RoomKit` — the merged view across every enabled pack, with each
subject/cue tagged by the pack that declared it so the runtime can find its bytes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from core.pack import PackManifest
from core.presentation import AudioCue, PresentationKit, Subject, parse_presentation_text
from gateway.panels import enabled_packs

if TYPE_CHECKING:
    from agent.services import Services

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class KitSubject:
    """One picturable subject plus where its reference image lives on disk."""

    pack_id: str
    subject: Subject
    ref_path: Path | None
    ref_mime: str = ""

    @property
    def generatable(self) -> bool:
        """Ref-mandatory, enforced structurally: without a readable reference image
        this subject can be NAMED but never generated."""
        return self.ref_path is not None and self.ref_path.is_file()


@dataclass(frozen=True)
class KitCue:
    """One audio cue plus the content hash clients fetch it by."""

    pack_id: str
    cue: AudioCue
    hash: str
    mime: str
    size: int

    def audio_item(self) -> dict[str, Any]:
        """The shape `gateway.audio.build_audio_control` expects. Pack audio never has
        to be imported into the room library first: the media byte channel already
        resolves an enabled pack's assets by hash, so the control frame is enough."""
        item = {"hash": self.hash, "mime": self.mime, "name": Path(self.cue.asset).name, "size": self.size}
        if self.cue.title:
            item["title"] = self.cue.title
        return item


@dataclass(frozen=True)
class RoomKit:
    """Every enabled pack's presentation kit, merged for one room."""

    subjects: tuple[KitSubject, ...] = ()
    cues: tuple[KitCue, ...] = ()
    style: tuple[str, ...] = ()  # one style line per contributing pack, viewer-localized
    banned: tuple[str, ...] = ()
    palette: tuple[str, ...] = ()  # union across packs, declaration order (like `style`)
    # None = no pack restricts (every TEMPLATE_KINDS shape allowed); a tuple = the
    # INTERSECTION of every declaring pack's allowlist — most-restrictive-wins, the
    # same direction as the `generates` AND, and it may honestly be empty.
    templates: tuple[str, ...] | None = None
    generates: bool = True

    def __bool__(self) -> bool:
        return bool(self.subjects or self.cues or self.style)

    def subject(self, subject_id: str) -> KitSubject | None:
        return next((item for item in self.subjects if item.subject.id == subject_id), None)

    def cue(self, cue_id: str) -> KitCue | None:
        return next((item for item in self.cues if item.cue.id == cue_id), None)

    def allows_template(self, kind: str) -> bool:
        return self.templates is None or kind in self.templates


def _load_pack_kit(home: Path, manifest: PackManifest) -> PresentationKit | None:
    for path in manifest.contents.get("presentation", ()):
        try:
            return parse_presentation_text((home / path).read_text(encoding="utf-8"))
        except Exception:
            logger.warning("presentation: unreadable kit %s under %s", path, home, exc_info=True)
    return None


async def load_room_kit(services: Services, chat_key: str, locale: str | None = None) -> RoomKit:
    """The merged presentation kit for every pack enabled in ``chat_key``.

    ``generates`` is the AND of every contributing pack's own setting: one author's
    ``generation: pack_only`` veto (宁缺毋滥) silences generation for the room, because
    a room mixing two modules would otherwise let the permissive one overrule the
    restrictive one's whole aesthetic.
    """
    subjects: list[KitSubject] = []
    cues: list[KitCue] = []
    style: list[str] = []
    banned: list[str] = []
    palette: list[str] = []
    templates: tuple[str, ...] | None = None
    generates = True
    for pack_id, home, manifest in await enabled_packs(services, chat_key):
        kit = _load_pack_kit(home, manifest)
        if kit is None:
            continue
        generates = generates and kit.generates
        if kit.templates:
            # Most-restrictive-wins, like `generates`: a second pack's allowlist can only
            # narrow the room's set, never widen a stricter author's choice back open.
            templates = kit.templates if templates is None else tuple(k for k in templates if k in kit.templates)
        line = kit.style_for(locale)
        if line:
            style.append(line)
        banned.extend(entry for entry in kit.banned if entry not in banned)
        palette.extend(entry for entry in kit.palette if entry not in palette)
        assets = {asset.path: asset for asset in manifest.assets}
        for subject in kit.subjects:
            asset = assets.get(subject.ref) if subject.ref else None
            subjects.append(
                KitSubject(
                    pack_id=pack_id,
                    subject=subject,
                    ref_path=(home / subject.ref) if asset is not None else None,
                    ref_mime=asset.mime if asset is not None else "",
                )
            )
        for cue in kit.audio:
            asset = assets.get(cue.asset)
            if asset is None:
                logger.warning("presentation: %s cue %s names an undeclared asset", pack_id, cue.id)
                continue
            cues.append(KitCue(pack_id=pack_id, cue=cue, hash=asset.sha256, mime=asset.mime, size=asset.size))
    return RoomKit(
        subjects=tuple(subjects),
        cues=tuple(cues),
        style=tuple(style),
        banned=tuple(banned),
        palette=tuple(palette),
        templates=templates,
        generates=generates,
    )
