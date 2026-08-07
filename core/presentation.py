"""The presentation kit (M19) — parsing + validation for a pack's ``ui/presentation.yaml``.

A module author knows what their work should LOOK and SOUND like. The kit is where
they say so, once, as data — and it is the entire creative brief the Stage Director
(`agent.stage_director`) works from. Same discipline as `core.panels`: this module is
the single schema authority, author-time strict (an unknown key is an error, not a
silent drop), and it never touches the runtime — `gateway.presentation` owns the room
view of an installed kit.

```yaml
version: 1
generation: allow            # or `pack_only` — the 宁缺毋滥 veto (see below)
style:
  keywords: {en: "ink wash, muted indigo, 1925 coastal China", zh: "水墨, 靛青, 一九二五浙东"}
  banned: [text overlays, modern clothing]
subjects:                    # the 定妆 convention: what may be pictured, and how
  - id: gu-wantang
    kind: npc                # npc | location | item
    name: {en: Gu Wantang, zh: 顾晚棠}
    ref: assets/gu-wantang.png          # the fixed-portrait REFERENCE image
    prompt: "a woman in her thirties, plain dark coat, wet hair"
audio:                       # the cues the Director may call for
  - {id: chao-yong, layer: bgm, asset: assets/chao-yong.mp3, title: 潮涌}
```

Three rules carry the whole image discipline, and two of them are structural:

- **Ref-mandatory.** A subject with no ``ref`` can never be generated. Consistency —
  not plumbing — is the hard part of AI art in a module, so the kit's reference image
  and style keywords ride EVERY request. No ref, no portrait; the Director cannot opt
  out because it can only name subjects the kit declares.
- **宁缺毋滥.** ``generation: pack_only`` is an author's veto: the Director stages with
  the pack's own art and nothing else. No config flag overrides it — an atmosphere-first
  author gets to be right.
- **Pre-generation** (慢菜先备) is a runtime concern, not a format one: the kit only has
  to make subjects nameable for a warm-up request to refer to them.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

from core.yaml_safety import safe_load_no_aliases

MAX_PRESENTATION_FILE_BYTES = 128 * 1024
MAX_SUBJECTS = 64
MAX_AUDIO_CUES = 32
MAX_BANNED = 24
MAX_TEXT_CHARS = 400
MAX_PROMPT_CHARS = 1_000

KIT_VERSION = 1
GENERATION_MODES = ("allow", "pack_only")
SUBJECT_KINDS = ("npc", "location", "item")
AUDIO_LAYERS = ("bgm", "ambience", "sfx")
# What a cue's asset may be, stated here rather than imported from `infra.media_store`:
# `core/` does not depend upward on `infra/`, and `core.hooks.UI_IMAGE_MIMES` set the
# same precedent. Keep in step with the upload MIME list in `docs/protocol.md`.
AUDIO_MIMES = frozenset({"audio/mpeg", "audio/ogg", "audio/wav", "audio/flac", "audio/mp4", "audio/aac"})

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_LOCALES = ("en", "zh")


@dataclass(frozen=True)
class Subject:
    """One picturable thing. ``ref`` empty means "declared, but never generate it"
    — the kit can still name it for a caption without licensing an imagegen call."""

    id: str
    kind: str
    name: dict[str, str]
    ref: str = ""
    prompt: str = ""

    def display_name(self, locale: str | None) -> str:
        short = (locale or "en").split("-", 1)[0].split("_", 1)[0]
        for candidate in (short, "en"):
            if self.name.get(candidate):
                return self.name[candidate]
        return next((text for text in self.name.values() if text), self.id)


@dataclass(frozen=True)
class AudioCue:
    """One playable cue the Director may call for, bound to a pack audio asset."""

    id: str
    layer: str
    asset: str
    title: str = ""


@dataclass(frozen=True)
class PresentationKit:
    """One validated ``presentation.yaml``."""

    version: int = KIT_VERSION
    generation: str = "allow"
    style_keywords: dict[str, str] = field(default_factory=dict)
    banned: tuple[str, ...] = ()
    subjects: tuple[Subject, ...] = ()
    audio: tuple[AudioCue, ...] = ()

    @property
    def generates(self) -> bool:
        """Whether this module licenses image generation at all (宁缺毋滥)."""
        return self.generation == "allow"

    def subject(self, subject_id: str) -> Subject | None:
        return next((item for item in self.subjects if item.id == subject_id), None)

    def cue(self, cue_id: str) -> AudioCue | None:
        return next((item for item in self.audio if item.id == cue_id), None)

    def style_for(self, locale: str | None) -> str:
        short = (locale or "en").split("-", 1)[0].split("_", 1)[0]
        for candidate in (short, "en"):
            if self.style_keywords.get(candidate):
                return self.style_keywords[candidate]
        return next((text for text in self.style_keywords.values() if text), "")

    @property
    def asset_paths(self) -> tuple[str, ...]:
        """Every pack file the kit references, de-duplicated in declaration order —
        what the pack build must fold into its content-addressed asset pipeline."""
        paths: list[str] = []
        for path in (*(subject.ref for subject in self.subjects), *(cue.asset for cue in self.audio)):
            if path and path not in paths:
                paths.append(path)
        return tuple(paths)


def _require_keys(raw: Mapping[str, Any], label: str, *, required: set[str], optional: set[str]) -> None:
    missing = required - set(raw)
    if missing:
        raise ValueError(f"{label}: missing {sorted(missing)}")
    unknown = set(raw) - required - optional
    if unknown:
        raise ValueError(f"{label}: unknown keys {sorted(unknown)}")


def _localized(raw: Any, label: str, *, cap: int = MAX_TEXT_CHARS) -> dict[str, str]:
    """A plain string (treated as ``en``) or an ``{en,zh}`` map — the same shape
    `core.panels` uses for every author-facing string."""
    if isinstance(raw, str):
        if not raw.strip() or len(raw) > cap:
            raise ValueError(f"{label}: must be a non-empty string of at most {cap} chars")
        return {"en": raw.strip()}
    if isinstance(raw, Mapping):
        unknown = set(raw) - set(_LOCALES)
        if unknown:
            raise ValueError(f"{label}: unknown locale keys {sorted(unknown)}")
        localized = {}
        for locale in _LOCALES:
            if locale not in raw:
                continue
            text = raw[locale]
            if not isinstance(text, str) or not text.strip() or len(text) > cap:
                raise ValueError(f"{label}.{locale}: must be a non-empty string of at most {cap} chars")
            localized[locale] = text.strip()
        if not localized:
            raise ValueError(f"{label}: needs at least one of {list(_LOCALES)}")
        return localized
    raise ValueError(f"{label}: expected a string or an en/zh mapping")


def _asset_path(raw: Any, label: str) -> str:
    """A pack-relative posix path. Mirrors `core.panels._validated_asset_path`; the
    pack layer re-validates against its own zip-slip discipline afterwards."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{label}: must be a relative path string")
    path = PurePosixPath(raw.strip())
    if path.is_absolute() or any(part in {"..", "."} or not part.strip() for part in path.parts):
        raise ValueError(f"{label}: must be a plain relative path (no .. segments)")
    return str(path)


def _slug(raw: Any, label: str) -> str:
    if not isinstance(raw, str) or not _SLUG_RE.match(raw):
        raise ValueError(f"{label}: must be a lowercase slug ([a-z0-9-], max 64)")
    return raw


def _parse_subject(raw: Any, index: int) -> Subject:
    label = f"subjects[{index}]"
    if not isinstance(raw, Mapping):
        raise ValueError(f"{label}: each subject must be a mapping")
    _require_keys(raw, label, required={"id", "kind", "name"}, optional={"ref", "prompt"})
    subject_id = _slug(raw["id"], f"{label}.id")
    kind = raw["kind"]
    if kind not in SUBJECT_KINDS:
        raise ValueError(f"subjects[{subject_id}].kind: must be one of {list(SUBJECT_KINDS)}")
    prompt = raw.get("prompt", "")
    if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"subjects[{subject_id}].prompt: must be a string of at most {MAX_PROMPT_CHARS} chars")
    return Subject(
        id=subject_id,
        kind=kind,
        name=_localized(raw["name"], f"subjects[{subject_id}].name"),
        ref=_asset_path(raw["ref"], f"subjects[{subject_id}].ref") if raw.get("ref") else "",
        prompt=prompt.strip(),
    )


def _parse_cue(raw: Any, index: int) -> AudioCue:
    label = f"audio[{index}]"
    if not isinstance(raw, Mapping):
        raise ValueError(f"{label}: each audio cue must be a mapping")
    _require_keys(raw, label, required={"id", "layer", "asset"}, optional={"title"})
    cue_id = _slug(raw["id"], f"{label}.id")
    layer = raw["layer"]
    if layer not in AUDIO_LAYERS:
        raise ValueError(f"audio[{cue_id}].layer: must be one of {list(AUDIO_LAYERS)}")
    title = raw.get("title", "")
    if not isinstance(title, str) or len(title) > MAX_TEXT_CHARS:
        raise ValueError(f"audio[{cue_id}].title: must be a string of at most {MAX_TEXT_CHARS} chars")
    return AudioCue(
        id=cue_id,
        layer=layer,
        asset=_asset_path(raw["asset"], f"audio[{cue_id}].asset"),
        title=title.strip(),
    )


def parse_presentation_text(text: str) -> PresentationKit:
    """Parse + validate one ``presentation.yaml``. Raises ``ValueError`` with an
    author-actionable message (the pack layer wraps it in ``PackError``)."""
    if len(text.encode("utf-8")) > MAX_PRESENTATION_FILE_BYTES:
        raise ValueError(f"presentation.yaml exceeds the {MAX_PRESENTATION_FILE_BYTES}-byte cap")
    try:
        raw = safe_load_no_aliases(text)
    except Exception as exc:
        raise ValueError(f"invalid presentation YAML: {exc}") from exc
    if not isinstance(raw, Mapping):
        raise ValueError("presentation.yaml root must be a mapping")
    _require_keys(
        raw,
        "presentation.yaml",
        required={"version"},
        optional={"generation", "style", "subjects", "audio"},
    )
    if raw["version"] != KIT_VERSION:
        raise ValueError(f"presentation.yaml version must be {KIT_VERSION}")

    generation = raw.get("generation", "allow")
    if generation not in GENERATION_MODES:
        raise ValueError(f"generation: must be one of {list(GENERATION_MODES)}")

    style_raw = raw.get("style") or {}
    if not isinstance(style_raw, Mapping):
        raise ValueError("style: must be a mapping")
    _require_keys(style_raw, "style", required=set(), optional={"keywords", "banned"})
    keywords = _localized(style_raw["keywords"], "style.keywords") if style_raw.get("keywords") else {}
    banned_raw = style_raw.get("banned") or []
    if not isinstance(banned_raw, list) or len(banned_raw) > MAX_BANNED:
        raise ValueError(f"style.banned: must be a list of at most {MAX_BANNED} entries")
    banned = []
    for index, entry in enumerate(banned_raw):
        if not isinstance(entry, str) or not entry.strip() or len(entry) > MAX_TEXT_CHARS:
            raise ValueError(f"style.banned[{index}]: must be a non-empty string")
        banned.append(entry.strip())

    subjects_raw = raw.get("subjects") or []
    if not isinstance(subjects_raw, list) or len(subjects_raw) > MAX_SUBJECTS:
        raise ValueError(f"subjects: must be a list of at most {MAX_SUBJECTS} entries")
    subjects = tuple(_parse_subject(entry, index) for index, entry in enumerate(subjects_raw))
    if len({subject.id for subject in subjects}) != len(subjects):
        raise ValueError("subjects: duplicate subject id")

    audio_raw = raw.get("audio") or []
    if not isinstance(audio_raw, list) or len(audio_raw) > MAX_AUDIO_CUES:
        raise ValueError(f"audio: must be a list of at most {MAX_AUDIO_CUES} entries")
    cues = tuple(_parse_cue(entry, index) for index, entry in enumerate(audio_raw))
    if len({cue.id for cue in cues}) != len(cues):
        raise ValueError("audio: duplicate cue id")

    return PresentationKit(
        version=KIT_VERSION,
        generation=generation,
        style_keywords=keywords,
        banned=tuple(banned),
        subjects=subjects,
        audio=cues,
    )
