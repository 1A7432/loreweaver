"""`.lwpack` community packs — deterministic build, inspection and install (no network).

A pack is one self-contained zip with a root ``pack.yaml`` manifest bundling a work's
skills (SKILL.md + optional hooks.js), rulepacks, SillyTavern cards, lorebooks and media
assets. Distribution is Git: a pack rides a repo release; there is deliberately NO central
registry (``infra.pack_source`` resolves ``gh:owner/repo[@tag]`` refs to a release asset).

Trust stance mirrors full-EJS/hooks (docs/plugins.md): installing is the operator's
decision about the operator's box, so the CLI shows a generated ``trust`` summary
(counts, hooks presence, asset bytes) instead of gating. What IS a red line is byte
integrity and filesystem confinement — this module is the one place untrusted archive
bytes reach the disk, so every entry name is validated against traversal (zip-slip),
symlink entries are rejected, per-asset sha256 digests are verified against the
manifest before anything lands, and sizes/counts are capped throughout.

Install means "on disk and discoverable", never "enabled for a room": skills land in the
user skill dir and rulepacks in the user rulepack dir (existing discovery; built-ins are
never overridden), while cards/lorebooks/assets land under ``data_dir/packs/<id>@<version>/``
for the existing in-room import flows to consume.

Builds are byte-deterministic (sorted entry order, fixed zip timestamps, stable manifest
dump), so packing the same source twice yields the identical file — and the same sha256.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import shutil
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

import yaml

from core.charcard import MAX_CARD_FILE_BYTES, parse_card_bytes
from core.hooks import MAX_HOOK_SOURCE_CHARS
from core.rulepacks import parse_rulepack_text
from core.skills import parse_skill_text
from core.worldbook import MAX_IMPORT_ENTRIES
from core.yaml_safety import safe_load_no_aliases

PACK_SUFFIX = ".lwpack"
MANIFEST_NAME = "pack.yaml"

# Hard caps — the archive is untrusted input. Sizes are checked BOTH against the
# manifest's own declarations and while streaming, so neither a lying manifest nor a
# zip-bomb entry (small compressed, huge inflated) can blow past them.
MAX_PACK_BYTES = 512 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
MAX_PACK_ENTRIES = 2_048
MAX_MANIFEST_BYTES = 256 * 1024
MAX_LOREBOOK_BYTES = 4 * 1024 * 1024
MAX_CONTENT_FILES_PER_KIND = 64
MAX_ASSETS = 512
MAX_ENTRY_NAME_CHARS = 512
MAX_TEXT_FIELD_CHARS = 2_000

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SEMVER_RE = re.compile(r"^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$")
_ENGINE_VERSION_RE = re.compile(r"^\d{1,6}(?:\.\d{1,6}){0,3}$")
_LOCALES = ("en", "zh")
CONTENT_KINDS = ("skills", "rulepacks", "cards", "lorebooks")
_SKILL_FILES = frozenset({"SKILL.md", "hooks.js"})

# Fixed zip metadata so builds are byte-reproducible: the zip epoch timestamp and a
# plain 0644 regular file mode for every entry.
_ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
_ZIP_FILE_ATTR = 0o100644 << 16
_STREAM_CHUNK = 1024 * 1024


class PackError(ValueError):
    """Any pack build/inspect/install failure. Messages are technical English; the CLI
    wraps them in localized copy (`pack.*` keys) with the message as the detail param."""


@dataclass(frozen=True)
class PackAsset:
    """One media asset: integrity fields are machine-generated at pack time."""

    path: str
    sha256: str
    mime: str
    size: int
    title: str = ""
    license: str = ""
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class PackTrust:
    """The auto-generated composition summary shown before install. Hand-written
    trust blocks are rejected at build time — this is disclosure, not marketing."""

    skills: int = 0
    rulepacks: int = 0
    cards: int = 0
    lorebooks: int = 0
    assets: int = 0
    asset_bytes: int = 0
    has_hooks: bool = False
    has_ejs: bool = False


@dataclass(frozen=True)
class PackManifest:
    """A parsed ``pack.yaml``. ``contents`` maps kind -> relative file/dir paths."""

    id: str
    version: str
    name: dict[str, str]
    description: dict[str, str]
    authors: tuple[str, ...]
    license: str
    engine: dict[str, str]
    contents: dict[str, tuple[str, ...]]
    assets: tuple[PackAsset, ...]
    trust: PackTrust | None = None

    def display_name(self, locale: str) -> str:
        return self.name.get(locale) or self.name.get("en") or next(iter(self.name.values()), self.id)


@dataclass(frozen=True)
class BuiltPack:
    path: Path
    sha256: str
    manifest: PackManifest


@dataclass
class InstallReport:
    manifest: PackManifest
    pack_sha256: str = ""
    pack_dir: Path | None = None
    skills: list[str] = field(default_factory=list)
    rulepacks: list[str] = field(default_factory=list)
    cards: list[str] = field(default_factory=list)
    lorebooks: list[str] = field(default_factory=list)
    assets: int = 0
    asset_bytes: int = 0
    shadowed: list[str] = field(default_factory=list)  # ids a same-named built-in keeps winning over


# --- versions ---------------------------------------------------------------


def _version_tuple(value: str) -> tuple[int, ...]:
    if not _ENGINE_VERSION_RE.match(value):
        raise PackError(f"invalid engine version {value!r} (dotted integers only)")
    return tuple(int(part) for part in value.split("."))


_LEADING_VERSION_RE = re.compile(r"^(\d{1,6}(?:\.\d{1,6}){0,3})")


def _lenient_version_tuple(value: str) -> tuple[int, ...]:
    """CURRENT-version side only: tolerate dev/local suffixes (``0.5.1.dev2+g...``)
    by taking the leading dotted-integer prefix; nothing numeric compares as 0."""
    match = _LEADING_VERSION_RE.match(value.strip())
    if match is None:
        return (0,)
    return tuple(int(part) for part in match.group(1).split("."))


def version_at_least(current: str, minimum: str) -> bool:
    """Minimum-version-only comparison (no range syntax): pad to equal length, compare.
    ``minimum`` (author-declared) must be strict dotted integers; ``current`` (this
    server's own version strings) is parsed leniently."""
    left, right = _lenient_version_tuple(current), _version_tuple(minimum)
    width = max(len(left), len(right))
    return left + (0,) * (width - len(left)) >= right + (0,) * (width - len(right))


# --- manifest parsing -------------------------------------------------------


def _localized_field(raw: Any, label: str) -> dict[str, str]:
    """Accept a plain string (treated as ``en``) or an {en,zh} mapping; cap lengths."""
    if isinstance(raw, str) and raw.strip():
        return {"en": raw.strip()[:MAX_TEXT_FIELD_CHARS]}
    if isinstance(raw, dict):
        localized = {
            locale: str(raw[locale]).strip()[:MAX_TEXT_FIELD_CHARS]
            for locale in _LOCALES
            if isinstance(raw.get(locale), str) and str(raw[locale]).strip()
        }
        if localized:
            return localized
    raise PackError(f"manifest field {label!r} must be a non-empty string or an en/zh mapping")


def _relative_content_path(raw: Any, *, kind: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise PackError(f"contents.{kind} entries must be relative path strings")
    return str(_validated_entry_path(raw.strip()))


def parse_manifest_text(text: str, *, expect_trust: bool) -> PackManifest:
    """Parse manifest YAML. ``expect_trust=False`` is the AUTHOR side (a source
    ``pack.yaml``, where a hand-written ``trust`` block is rejected); ``True`` is the
    ARCHIVE side (a built pack, whose generated ``trust`` must be present)."""
    try:
        raw = safe_load_no_aliases(text)
    except Exception as exc:
        raise PackError(f"invalid manifest YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise PackError("manifest root must be a mapping")

    pack_id = raw.get("id")
    if not isinstance(pack_id, str) or not _SLUG_RE.match(pack_id):
        raise PackError("manifest id must be a lowercase slug ([a-z0-9-], max 64)")
    version = raw.get("version")
    if not isinstance(version, str) or not _SEMVER_RE.match(version):
        raise PackError("manifest version must be semver (MAJOR.MINOR.PATCH)")

    authors_raw = raw.get("authors") or []
    if not isinstance(authors_raw, list) or not all(isinstance(item, str) and item.strip() for item in authors_raw):
        raise PackError("manifest authors must be a list of non-empty strings")
    license_name = raw.get("license")
    if not isinstance(license_name, str) or not license_name.strip():
        raise PackError("manifest license is required (an SPDX id or short name)")

    engine_raw = raw.get("engine") or {}
    if not isinstance(engine_raw, dict):
        raise PackError("manifest engine must be a mapping of minimum versions")
    engine: dict[str, str] = {}
    for key in ("protocol", "server"):
        value = engine_raw.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            raise PackError(f"engine.{key} must be a version string")
        _version_tuple(value)  # validates
        engine[key] = value
    unknown_engine = set(engine_raw) - {"protocol", "server"}
    if unknown_engine:
        raise PackError(f"unknown engine keys: {sorted(unknown_engine)}")

    contents_raw = raw.get("contents") or {}
    if not isinstance(contents_raw, dict):
        raise PackError("manifest contents must be a mapping")
    unknown_kinds = set(contents_raw) - set(CONTENT_KINDS)
    if unknown_kinds:
        raise PackError(f"unknown contents kinds: {sorted(unknown_kinds)}")
    contents: dict[str, tuple[str, ...]] = {}
    for kind in CONTENT_KINDS:
        entries = contents_raw.get(kind) or []
        if not isinstance(entries, list):
            raise PackError(f"contents.{kind} must be a list")
        if len(entries) > MAX_CONTENT_FILES_PER_KIND:
            raise PackError(f"contents.{kind} lists too many files (max {MAX_CONTENT_FILES_PER_KIND})")
        parsed = tuple(_relative_content_path(entry, kind=kind) for entry in entries)
        if len(set(parsed)) != len(parsed):
            raise PackError(f"contents.{kind} lists a duplicate path")
        contents[kind] = parsed

    assets_raw = raw.get("assets") or []
    if not isinstance(assets_raw, list):
        raise PackError("manifest assets must be a list")
    if len(assets_raw) > MAX_ASSETS:
        raise PackError(f"too many assets (max {MAX_ASSETS})")
    assets: list[PackAsset] = []
    seen_paths: set[str] = set()
    for entry in assets_raw:
        if not isinstance(entry, dict):
            raise PackError("each asset must be a mapping with at least a path")
        path = _relative_content_path(entry.get("path"), kind="assets")
        if path in seen_paths:
            raise PackError(f"asset path listed twice: {path}")
        seen_paths.add(path)
        sha256 = entry.get("sha256", "")
        if sha256 and (not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256)):
            raise PackError(f"asset {path}: sha256 must be 64 lowercase hex chars")
        if expect_trust and not sha256:
            raise PackError(f"asset {path}: built pack is missing its sha256")
        size = entry.get("size", 0)
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise PackError(f"asset {path}: size must be a non-negative integer")
        tags_raw = entry.get("tags") or []
        if not isinstance(tags_raw, list) or not all(isinstance(tag, str) for tag in tags_raw):
            raise PackError(f"asset {path}: tags must be a list of strings")
        assets.append(
            PackAsset(
                path=path,
                sha256=str(sha256),
                mime=str(entry.get("mime") or ""),
                size=size,
                title=str(entry.get("title") or "")[:MAX_TEXT_FIELD_CHARS],
                license=str(entry.get("license") or "")[:MAX_TEXT_FIELD_CHARS],
                tags=tuple(str(tag)[:64] for tag in tags_raw[:16]),
            )
        )

    trust_raw = raw.get("trust")
    if not expect_trust:
        if trust_raw is not None:
            raise PackError("trust is generated at pack time and must not be hand-written")
        trust = None
    else:
        if not isinstance(trust_raw, dict):
            raise PackError("built pack manifest is missing its generated trust block")
        try:
            trust = PackTrust(
                skills=int(trust_raw.get("skills", 0)),
                rulepacks=int(trust_raw.get("rulepacks", 0)),
                cards=int(trust_raw.get("cards", 0)),
                lorebooks=int(trust_raw.get("lorebooks", 0)),
                assets=int(trust_raw.get("assets", 0)),
                asset_bytes=int(trust_raw.get("asset_bytes", 0)),
                has_hooks=bool(trust_raw.get("has_hooks", False)),
                has_ejs=bool(trust_raw.get("has_ejs", False)),
            )
        except (TypeError, ValueError) as exc:
            raise PackError(f"invalid trust block: {exc}") from exc

    return PackManifest(
        id=pack_id,
        version=version,
        name=_localized_field(raw.get("name"), "name"),
        description=_localized_field(raw.get("description"), "description"),
        authors=tuple(str(author).strip()[:200] for author in authors_raw[:32]),
        license=license_name.strip()[:200],
        engine=engine,
        contents=contents,
        assets=tuple(assets),
        trust=trust,
    )


# --- entry-name safety (the zip-slip red line) ------------------------------


def _validated_entry_path(name: str) -> PurePosixPath:
    """Validate one archive/manifest relative path; raise `PackError` on anything that
    could escape the extraction root: absolute paths, drive letters, ``..`` or ``.``
    segments, backslashes, control bytes, empty segments, oversized names."""
    if not name or len(name) > MAX_ENTRY_NAME_CHARS:
        raise PackError(f"unsafe archive path (empty or too long): {name[:80]!r}")
    if "\\" in name or "\x00" in name or any(ord(ch) < 0x20 for ch in name):
        raise PackError(f"unsafe archive path (illegal characters): {name[:80]!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or (path.parts and re.match(r"^[A-Za-z]:", path.parts[0])):
        raise PackError(f"unsafe archive path (absolute): {name[:80]!r}")
    if not path.parts:
        raise PackError(f"unsafe archive path (empty): {name[:80]!r}")
    for part in path.parts:
        if part in {"..", "."} or not part.strip() or len(part) > 255:
            raise PackError(f"unsafe archive path (traversal segment): {name[:80]!r}")
    return path


def _reject_symlink_entry(info: zipfile.ZipInfo) -> None:
    if (info.external_attr >> 16) & 0o170000 == 0o120000:
        raise PackError(f"archive entry is a symlink (not allowed): {info.filename[:80]!r}")


def _stream_copy(source: BinaryIO, *, expected_size: int, digest: Any | None, sink: BinaryIO | None) -> int:
    """Copy an entry stream with a hard byte ceiling: reading even one byte past the
    declared size aborts, so a lying zip header cannot inflate past its manifest claim."""
    total = 0
    while True:
        chunk = source.read(_STREAM_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > expected_size:
            raise PackError("archive entry is larger than its declared size")
        if digest is not None:
            digest.update(chunk)
        if sink is not None:
            sink.write(chunk)
    return total


# --- shared validation of pack contents ------------------------------------


def _detect_ejs(text: str) -> bool:
    return "<%" in text


def _validate_skill_dir(read_text: Callable[[str], str], skill_dir: str, files: set[str]) -> tuple[str, bool, bool]:
    """Validate one bundled skill directory (source tree or archive): exactly
    SKILL.md (+ optional hooks.js), both parseable/capped. Returns (skill_id,
    has_hooks, has_ejs)."""
    skill_path = _validated_entry_path(skill_dir)
    skill_id = skill_path.name
    if not _SLUG_RE.match(skill_id):
        raise PackError(f"skill directory name must be a slug: {skill_dir!r}")
    extras = {name for name in files if name not in _SKILL_FILES}
    if extras:
        raise PackError(f"skill {skill_id}: unexpected files {sorted(extras)} (only SKILL.md + hooks.js ship)")
    if "SKILL.md" not in files:
        raise PackError(f"skill {skill_id}: missing SKILL.md")
    skill_text = read_text(f"{skill_dir}/SKILL.md")
    try:
        parse_skill_text(skill_id, skill_text)
    except ValueError as exc:
        raise PackError(f"skill {skill_id}: invalid SKILL.md: {exc}") from exc
    has_hooks = "hooks.js" in files
    has_ejs = _detect_ejs(skill_text)
    if has_hooks:
        hooks_text = read_text(f"{skill_dir}/hooks.js")
        if len(hooks_text) > MAX_HOOK_SOURCE_CHARS:
            raise PackError(f"skill {skill_id}: hooks.js exceeds {MAX_HOOK_SOURCE_CHARS} chars")
    return skill_id, has_hooks, has_ejs


def _validate_rulepack_file(read_text: Callable[[str], str], path: str) -> str:
    stem = PurePosixPath(path).stem
    if not _SLUG_RE.match(stem):
        raise PackError(f"rulepack filename must be a slug: {path!r}")
    if PurePosixPath(path).suffix not in {".yaml", ".yml"}:
        raise PackError(f"rulepack must be a .yaml file: {path!r}")
    try:
        parse_rulepack_text(stem, read_text(path))
    except ValueError as exc:
        raise PackError(f"rulepack {stem}: {exc}") from exc
    return stem


def _validate_card_bytes(path: str, data: bytes) -> bool:
    if len(data) > MAX_CARD_FILE_BYTES:
        raise PackError(f"card {path}: exceeds the {MAX_CARD_FILE_BYTES}-byte cap")
    try:
        parse_card_bytes(data, filename=PurePosixPath(path).name)
    except ValueError as exc:
        raise PackError(f"card {path}: {exc}") from exc
    return _detect_ejs(data.decode("utf-8", errors="ignore"))


def _validate_lorebook_bytes(path: str, data: bytes) -> bool:
    if len(data) > MAX_LOREBOOK_BYTES:
        raise PackError(f"lorebook {path}: exceeds the {MAX_LOREBOOK_BYTES}-byte cap")
    try:
        raw = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackError(f"lorebook {path}: invalid JSON: {exc}") from exc
    if isinstance(raw, dict) and "entries" not in raw:
        book = raw.get("character_book") or (raw.get("data") or {}).get("character_book")
        if isinstance(book, dict):
            raw = book
    entries = raw.get("entries") if isinstance(raw, dict) else raw
    if isinstance(entries, dict):
        entries = list(entries.values())
    if not isinstance(entries, list) or not entries:
        raise PackError(f"lorebook {path}: no entries found (expected a SillyTavern lorebook shape)")
    if len(entries) > MAX_IMPORT_ENTRIES:
        raise PackError(f"lorebook {path}: {len(entries)} entries exceeds the {MAX_IMPORT_ENTRIES} cap")
    return _detect_ejs(data.decode("utf-8", errors="ignore"))


# --- build ------------------------------------------------------------------


def _manifest_to_yaml(manifest: PackManifest) -> str:
    data: dict[str, Any] = {
        "id": manifest.id,
        "version": manifest.version,
        "name": dict(manifest.name),
        "description": dict(manifest.description),
        "authors": list(manifest.authors),
        "license": manifest.license,
        "engine": dict(manifest.engine),
        "contents": {kind: list(paths) for kind, paths in manifest.contents.items() if paths},
        "assets": [
            {
                key: value
                for key, value in (
                    ("path", asset.path),
                    ("sha256", asset.sha256),
                    ("mime", asset.mime),
                    ("size", asset.size),
                    ("title", asset.title),
                    ("license", asset.license),
                    ("tags", list(asset.tags)),
                )
                if value not in ("", [], None)
            }
            for asset in manifest.assets
        ],
        "trust": {
            "skills": manifest.trust.skills,
            "rulepacks": manifest.trust.rulepacks,
            "cards": manifest.trust.cards,
            "lorebooks": manifest.trust.lorebooks,
            "assets": manifest.trust.assets,
            "asset_bytes": manifest.trust.asset_bytes,
            "has_hooks": manifest.trust.has_hooks,
            "has_ejs": manifest.trust.has_ejs,
        },
    }
    return yaml.safe_dump(data, sort_keys=True, allow_unicode=True, default_flow_style=False)


def _source_file(source_dir: Path, relative: str) -> Path:
    """Resolve a validated relative path inside `source_dir`, refusing symlinks and escapes."""
    _validated_entry_path(relative)
    base = source_dir.resolve()
    candidate = source_dir / PurePosixPath(relative)
    if candidate.is_symlink():
        raise PackError(f"source path is a symlink (not allowed): {relative!r}")
    resolved = candidate.resolve()
    if not resolved.is_relative_to(base):
        raise PackError(f"source path escapes the pack source dir: {relative!r}")
    return resolved


def build_pack(source_dir: Path, out_path: Path | None = None) -> BuiltPack:
    """Validate everything in ``source_dir`` (manifest, every declared content file via the
    real engine parsers, every asset) and emit a byte-deterministic ``.lwpack``.

    The written archive contains the REWRITTEN manifest — asset sha256/mime/size filled in
    (an author-declared sha256 must match the file or the build fails) and the ``trust``
    block generated — followed by every declared file at its source-relative path.
    """
    source_dir = Path(source_dir)
    manifest_path = source_dir / MANIFEST_NAME
    if not manifest_path.is_file():
        raise PackError(f"no {MANIFEST_NAME} in {source_dir}")
    if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        raise PackError(f"{MANIFEST_NAME} exceeds the {MAX_MANIFEST_BYTES}-byte cap")
    manifest = parse_manifest_text(manifest_path.read_text(encoding="utf-8"), expect_trust=False)

    def read_text(relative: str) -> str:
        return _source_file(source_dir, relative).read_text(encoding="utf-8")

    has_hooks = False
    has_ejs = False
    archive_files: list[str] = []

    for skill_dir in manifest.contents["skills"]:
        source_skill_dir = _source_file(source_dir, skill_dir)
        if not source_skill_dir.is_dir():
            raise PackError(f"skill path is not a directory: {skill_dir!r}")
        files = {entry.name for entry in source_skill_dir.iterdir()}
        _, skill_hooks, skill_ejs = _validate_skill_dir(read_text, skill_dir, files)
        has_hooks = has_hooks or skill_hooks
        has_ejs = has_ejs or skill_ejs
        archive_files.append(f"{skill_dir}/SKILL.md")
        if skill_hooks:
            archive_files.append(f"{skill_dir}/hooks.js")

    for rulepack_path in manifest.contents["rulepacks"]:
        _validate_rulepack_file(read_text, rulepack_path)
        archive_files.append(rulepack_path)

    for card_path in manifest.contents["cards"]:
        card_ejs = _validate_card_bytes(card_path, _source_file(source_dir, card_path).read_bytes())
        has_ejs = has_ejs or card_ejs
        archive_files.append(card_path)

    for lorebook_path in manifest.contents["lorebooks"]:
        lore_ejs = _validate_lorebook_bytes(lorebook_path, _source_file(source_dir, lorebook_path).read_bytes())
        has_ejs = has_ejs or lore_ejs
        archive_files.append(lorebook_path)

    completed_assets: list[PackAsset] = []
    asset_bytes = 0
    for asset in manifest.assets:
        asset_file = _source_file(source_dir, asset.path)
        if not asset_file.is_file():
            raise PackError(f"asset missing from source: {asset.path!r}")
        data = asset_file.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if asset.sha256 and asset.sha256 != digest:
            raise PackError(f"asset {asset.path}: declared sha256 does not match the file")
        mime = asset.mime or mimetypes.guess_type(asset.path)[0] or "application/octet-stream"
        completed_assets.append(
            PackAsset(
                path=asset.path,
                sha256=digest,
                mime=mime,
                size=len(data),
                title=asset.title,
                license=asset.license,
                tags=asset.tags,
            )
        )
        asset_bytes += len(data)
        archive_files.append(asset.path)

    if len(set(archive_files)) != len(archive_files):
        raise PackError("a file is declared under more than one contents kind")
    total_bytes = sum(_source_file(source_dir, name).stat().st_size for name in archive_files)
    if total_bytes > MAX_UNPACKED_BYTES:
        raise PackError(f"pack contents exceed the {MAX_UNPACKED_BYTES}-byte cap")
    if len(archive_files) + 1 > MAX_PACK_ENTRIES:
        raise PackError(f"pack has too many files (max {MAX_PACK_ENTRIES})")

    trust = PackTrust(
        skills=len(manifest.contents["skills"]),
        rulepacks=len(manifest.contents["rulepacks"]),
        cards=len(manifest.contents["cards"]),
        lorebooks=len(manifest.contents["lorebooks"]),
        assets=len(completed_assets),
        asset_bytes=asset_bytes,
        has_hooks=has_hooks,
        has_ejs=has_ejs,
    )
    built_manifest = PackManifest(
        id=manifest.id,
        version=manifest.version,
        name=manifest.name,
        description=manifest.description,
        authors=manifest.authors,
        license=manifest.license,
        engine=manifest.engine,
        contents=manifest.contents,
        assets=tuple(completed_assets),
        trust=trust,
    )

    if out_path is None:
        out_path = Path.cwd() / f"{manifest.id}-{manifest.version}{PACK_SUFFIX}"
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    def _zip_info(name: str) -> zipfile.ZipInfo:
        info = zipfile.ZipInfo(name, date_time=_ZIP_EPOCH)
        info.external_attr = _ZIP_FILE_ATTR
        info.compress_type = zipfile.ZIP_DEFLATED
        return info

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr(_zip_info(MANIFEST_NAME), _manifest_to_yaml(built_manifest))
        for name in sorted(archive_files):
            archive.writestr(_zip_info(name), _source_file(source_dir, name).read_bytes())

    return BuiltPack(path=out_path, sha256=_file_sha256(out_path), manifest=built_manifest)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_STREAM_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- inspect / install ------------------------------------------------------


def _open_pack(path: Path) -> zipfile.ZipFile:
    if not path.is_file():
        raise PackError(f"pack not found: {path}")
    if path.stat().st_size > MAX_PACK_BYTES:
        raise PackError(f"pack exceeds the {MAX_PACK_BYTES}-byte cap")
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise PackError(f"not a zip archive: {exc}") from exc
    try:
        entries = archive.infolist()
        if len(entries) > MAX_PACK_ENTRIES:
            raise PackError(f"pack has too many entries (max {MAX_PACK_ENTRIES})")
        declared_total = 0
        for info in entries:
            if info.is_dir():
                continue
            _validated_entry_path(info.filename)
            _reject_symlink_entry(info)
            declared_total += info.file_size
        if declared_total > MAX_UNPACKED_BYTES:
            raise PackError(f"pack inflates past the {MAX_UNPACKED_BYTES}-byte cap")
    except BaseException:
        archive.close()
        raise
    return archive


def _archive_manifest(archive: zipfile.ZipFile) -> PackManifest:
    try:
        info = archive.getinfo(MANIFEST_NAME)
    except KeyError as exc:
        raise PackError(f"pack has no root {MANIFEST_NAME}") from exc
    if info.file_size > MAX_MANIFEST_BYTES:
        raise PackError(f"{MANIFEST_NAME} exceeds the {MAX_MANIFEST_BYTES}-byte cap")
    with archive.open(info) as handle:
        text = handle.read(MAX_MANIFEST_BYTES + 1).decode("utf-8")
    if len(text.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise PackError(f"{MANIFEST_NAME} exceeds the {MAX_MANIFEST_BYTES}-byte cap")
    return parse_manifest_text(text, expect_trust=True)


def inspect_pack(path: Path) -> PackManifest:
    """Validate archive safety (names, symlinks, caps) and return the parsed manifest —
    what the CLI shows on the pre-install trust card. Does not touch the filesystem."""
    with _open_pack(Path(path)) as archive:
        return _archive_manifest(archive)


def _archive_read_text(archive: zipfile.ZipFile, name: str) -> str:
    info = archive.getinfo(name)
    with archive.open(info) as handle:
        raw = handle.read(min(info.file_size, MAX_UNPACKED_BYTES) + 1)
    if len(raw) > info.file_size:
        raise PackError(f"archive entry larger than declared: {name!r}")
    return raw.decode("utf-8")


def _verify_pack(archive: zipfile.ZipFile, manifest: PackManifest) -> None:
    """The no-write validation pass: every declared file must exist, parse with the same
    engine parsers used at build time, every asset's bytes must match its sha256, and the
    archive must contain NOTHING beyond the manifest's declarations — bytes that were
    never declared never get a chance to ride along, even inertly."""
    names = {name for name in archive.namelist() if not name.endswith("/")}

    declared: set[str] = {MANIFEST_NAME}
    for skill_dir in manifest.contents["skills"]:
        declared.add(f"{skill_dir}/SKILL.md")
        declared.add(f"{skill_dir}/hooks.js")
    for kind in ("rulepacks", "cards", "lorebooks"):
        declared.update(manifest.contents[kind])
    declared.update(asset.path for asset in manifest.assets)
    undeclared = sorted(names - declared)
    if undeclared:
        raise PackError(f"archive contains undeclared entries: {undeclared[:5]}")

    def read_text(name: str) -> str:
        return _archive_read_text(archive, name)

    for skill_dir in manifest.contents["skills"]:
        prefix = f"{skill_dir}/"
        files = {name[len(prefix):] for name in names if name.startswith(prefix) and "/" not in name[len(prefix):]}
        _validate_skill_dir(read_text, skill_dir, files)
    for rulepack_path in manifest.contents["rulepacks"]:
        if rulepack_path not in names:
            raise PackError(f"declared rulepack missing from archive: {rulepack_path!r}")
        _validate_rulepack_file(read_text, rulepack_path)
    for card_path in manifest.contents["cards"]:
        if card_path not in names:
            raise PackError(f"declared card missing from archive: {card_path!r}")
        info = archive.getinfo(card_path)
        if info.file_size > MAX_CARD_FILE_BYTES:
            raise PackError(f"card {card_path}: exceeds the {MAX_CARD_FILE_BYTES}-byte cap")
        with archive.open(info) as handle:
            data = handle.read(MAX_CARD_FILE_BYTES + 1)
        _validate_card_bytes(card_path, data)
    for lorebook_path in manifest.contents["lorebooks"]:
        if lorebook_path not in names:
            raise PackError(f"declared lorebook missing from archive: {lorebook_path!r}")
        with archive.open(lorebook_path) as handle:
            data = handle.read(MAX_LOREBOOK_BYTES + 1)
        _validate_lorebook_bytes(lorebook_path, data)
    for asset in manifest.assets:
        if asset.path not in names:
            raise PackError(f"declared asset missing from archive: {asset.path!r}")
        digest = hashlib.sha256()
        with archive.open(asset.path) as handle:
            total = _stream_copy(handle, expected_size=asset.size, digest=digest, sink=None)
        if total != asset.size:
            raise PackError(f"asset {asset.path}: size does not match the manifest")
        if digest.hexdigest() != asset.sha256:
            raise PackError(f"asset {asset.path}: sha256 does not match the manifest")


def _extract_entry(archive: zipfile.ZipFile, name: str, target: Path) -> int:
    info = archive.getinfo(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(info) as source, target.open("wb") as sink:
        return _stream_copy(source, expected_size=info.file_size, digest=None, sink=sink)


def _confined_target(base: Path, relative: PurePosixPath | str) -> Path:
    base = base.resolve()
    target = (base / PurePosixPath(relative)).resolve()
    if not target.is_relative_to(base):
        raise PackError(f"refusing to write outside {base}: {relative!r}")
    return target


def install_pack(
    pack_path: Path,
    *,
    packs_dir: Path,
    skills_dir: Path,
    rulepacks_dir: Path,
    current_protocol: str,
    current_server: str,
    builtin_skill_ids: Iterable[str] = (),
    builtin_rulepack_ids: Iterable[str] = (),
) -> InstallReport:
    """Install a verified pack: skills/rulepacks into their discovery dirs, everything
    else (cards/lorebooks/assets + the manifest) under ``packs_dir/<id>@<version>/``.

    Two passes: a full no-write verification (parsers + per-asset sha256) first, then
    extraction — so a bad archive can never leave a half-installed pack behind. The
    pack directory is staged in a temp sibling and swapped in atomically-enough
    (rmtree old + rename); re-installing the same id@version replaces it.
    """
    pack_path = Path(pack_path)
    with _open_pack(pack_path) as archive:
        manifest = _archive_manifest(archive)

        for engine_key, minimum in manifest.engine.items():
            current = current_protocol if engine_key == "protocol" else current_server
            try:
                satisfied = version_at_least(current, minimum)
            except PackError:
                satisfied = False
            if not satisfied:
                raise PackError(
                    f"pack requires {engine_key} >= {minimum}, this server has {current}"
                )

        _verify_pack(archive, manifest)

        report = InstallReport(manifest=manifest, pack_sha256=_file_sha256(pack_path))
        builtin_skills = set(builtin_skill_ids)
        builtin_rulepacks = set(builtin_rulepack_ids)

        version_dir_name = f"{manifest.id}@{manifest.version}"
        packs_dir = Path(packs_dir)
        packs_dir.mkdir(parents=True, exist_ok=True)
        staging = packs_dir / f".tmp-install-{manifest.id}"
        if staging.exists():
            shutil.rmtree(staging)

        try:
            # Stage the pack home first (cards/lorebooks/assets + provenance manifest).
            staging.mkdir(parents=True)
            manifest_target = _confined_target(staging, MANIFEST_NAME)
            manifest_target.write_text(_archive_read_text(archive, MANIFEST_NAME), encoding="utf-8")
            for kind in ("cards", "lorebooks"):
                for name in manifest.contents[kind]:
                    _extract_entry(archive, name, _confined_target(staging, name))
                    getattr(report, kind).append(name)
            for asset in manifest.assets:
                report.asset_bytes += _extract_entry(archive, asset.path, _confined_target(staging, asset.path))
                report.assets += 1

            # Then the discovery dirs (validated again above; built-ins always shadow).
            names = set(archive.namelist())
            skills_dir = Path(skills_dir)
            for skill_dir in manifest.contents["skills"]:
                skill_id = PurePosixPath(skill_dir).name
                for filename in ("SKILL.md", "hooks.js"):
                    archive_name = f"{skill_dir}/{filename}"
                    if archive_name in names:
                        _extract_entry(archive, archive_name, _confined_target(skills_dir, f"{skill_id}/{filename}"))
                report.skills.append(skill_id)
                if skill_id in builtin_skills:
                    report.shadowed.append(skill_id)
            rulepacks_dir = Path(rulepacks_dir)
            for rulepack_path in manifest.contents["rulepacks"]:
                stem = PurePosixPath(rulepack_path).stem
                _extract_entry(archive, rulepack_path, _confined_target(rulepacks_dir, f"{stem}.yaml"))
                report.rulepacks.append(stem)
                if stem in builtin_rulepacks:
                    report.shadowed.append(stem)

            final_dir = _confined_target(packs_dir, version_dir_name)
            if final_dir.exists():
                shutil.rmtree(final_dir)
            staging.rename(final_dir)
            report.pack_dir = final_dir
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    return report
