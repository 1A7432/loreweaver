"""Module UI panels (M15 Tier 1/2) — parsing + validation for a pack's ``ui/panels.yaml``.

A pack may dress the table with named panels (`docs/specs` M15; user docs in
``docs/plugins.md``): **Tier 1** panels are pure data — layouts of the protocol-v1.7
``ui`` block kinds with live variable bindings — and render on every client; **Tier 2**
panels ship real HTML/JS/CSS for rich clients and MUST declare a Tier-0/1 ``fallback``
(``null`` allowed, but explicitly) for everyone else.

This module is the single schema authority both sides share: ``core.pack`` calls
:func:`parse_panels_text` at build/verify time (author-time strictness: an unknown key,
a bad enum, an oversized string is a hard error, not a silent drop — the opposite
discipline of ``core.hooks.sanitize_ui_emissions``, which sanitizes untrusted hook
output at runtime), and the gateway calls it again when a keeper enables a pack for a
room, then shapes viewer manifests with :func:`wire_panel` + :func:`audience_allows`.

Template additions over the v1.7 block vocabulary (deliberately tiny):

- any scalar field may be ``{$var: "<variable id>"}`` — clients substitute the value
  from their OWN ``state.variables`` (absent/hidden for this viewer → the whole block
  is omitted, fail-closed; the state wire filter stays the single visibility choke);
- ``{repeat: {prefix: "...", block: <TemplateBlock>}}`` — one instance per visible
  variable whose id starts with the prefix; inside, ``{$leaf: id|label|value}``
  substitutes. Instances are client-capped (:data:`MAX_REPEAT_INSTANCES`); ``repeat``
  does not nest.
- localized strings are ``{en,zh}`` maps (or a plain string, treated as ``en``).
- an ``image`` block names its picture by pack-relative ``src`` path; :func:`wire_panel`
  resolves it to the ``{hash,size,mime}`` triple clients fetch over the media byte
  channel. A path (not a hash, and never a ``$var`` binding) is the authored form so
  the pack build owns the addressing — an author cannot aim a panel at a blob their
  pack does not ship.

The privilege model stays one sentence long: a panel acts as the player viewing it.
``audience`` is resolved server-side into per-viewer manifests and never rides the
wire; a keeper-only panel structurally never enters a player's manifest.
"""

from __future__ import annotations

import posixpath
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from core.hooks import (
    MAX_UI_CAPTION_CHARS,
    MAX_UI_ID_CHARS,
    MAX_UI_LABEL_CHARS,
    MAX_UI_OPTION_INPUT_CHARS,
    MAX_UI_OPTIONS,
    MAX_UI_PROMPT_CHARS,
    MAX_UI_TEXT_CHARS,
    UI_BADGE_TONES,
    UI_BLOCK_KINDS,
    UI_TEXT_STYLES,
)
from core.yaml_safety import safe_load_no_aliases

# Hard caps (author-time; the pack build enforces them, the room-enable path re-parses
# under them). MAX_REPEAT_INSTANCES is the RENDER-side cap clients apply per repeat.
MAX_PANELS_PER_PACK = 16
MAX_PANELS_FILE_BYTES = 256 * 1024
MAX_PANEL_BLOCKS = 32
MAX_PANEL_CODE_BYTES = 2 * 1024 * 1024
MAX_PANEL_EXTRA_ASSETS = 8
MAX_REPEAT_INSTANCES = 32
MAX_VAR_ID_CHARS = 256
MAX_REPEAT_PREFIX_CHARS = 128

PANEL_SLOTS = ("sidebar", "tray", "modal")
PANEL_AUDIENCES = ("all", "player", "keeper")
_KEEPER_ROLE = "keeper"
_LEAF_FIELDS = ("id", "label", "value")
_LOCALES = ("en", "zh")

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# Code-bearing mimes counted against MAX_PANEL_CODE_BYTES (entry html + js + css).
CODE_MIMES = frozenset(
    {"text/html", "text/javascript", "application/javascript", "text/css"}
)


@dataclass(frozen=True)
class PanelSpec:
    """One validated panel declaration, exactly as authored (blocks are the normalized
    template dicts). ``tier`` is derived: 2 when ``entry`` is present, else 1.
    ``fallback is None`` means the author wrote the explicit ``fallback: null``."""

    id: str
    title: dict[str, str]
    slot: str
    audience: str
    tier: int
    blocks: tuple[dict[str, Any], ...] = ()
    entry: str = ""
    assets: tuple[str, ...] = ()
    fallback: tuple[dict[str, Any], ...] | None = None

    @property
    def entry_dir(self) -> str:
        return str(PurePosixPath(self.entry).parent) if self.entry else ""

    @property
    def image_sources(self) -> tuple[str, ...]:
        """Every pack-relative ``image`` src this panel references (tier-1 blocks and a
        tier-2 ``fallback`` alike), de-duplicated in declaration order. The pack build
        folds these into its asset pipeline so each one gets a real integrity record —
        without which :func:`wire_panel` cannot address the picture at all."""
        return tuple(_collect_image_sources((*self.blocks, *(self.fallback or ()))))


def _is_binding(value: Any, *, in_repeat: bool) -> bool:
    """Whether ``value`` is a well-formed ``{$var: id}`` (anywhere) or ``{$leaf: field}``
    (inside a repeat template only). Malformed binding-shaped dicts raise."""
    if not isinstance(value, dict) or not (set(value) & {"$var", "$leaf"}):
        return False
    if set(value) not in ({"$var"}, {"$leaf"}):
        raise ValueError(f"a binding must be exactly one $var or $leaf key: {sorted(value)}")
    if "$var" in value:
        var_id = value["$var"]
        if not isinstance(var_id, str) or not var_id.strip() or len(var_id) > MAX_VAR_ID_CHARS:
            raise ValueError("$var must name a variable id (non-empty string)")
        return True
    if not in_repeat:
        raise ValueError("$leaf bindings are only valid inside a repeat template")
    if value["$leaf"] not in _LEAF_FIELDS:
        raise ValueError(f"$leaf must be one of {list(_LEAF_FIELDS)}")
    return True


def _scalar(raw: Any, label: str, *, in_repeat: bool, types: tuple[type, ...]) -> Any:
    """One scalar template field: a literal of an allowed type, or a binding."""
    if _is_binding(raw, in_repeat=in_repeat):
        return dict(raw)
    if isinstance(raw, bool) and bool not in types:
        raise ValueError(f"{label}: unexpected boolean")
    if not isinstance(raw, types):
        allowed = "/".join(item.__name__ for item in types)
        raise ValueError(f"{label}: expected {allowed} or a $var binding")
    return raw


def _localized(raw: Any, label: str, *, in_repeat: bool, cap: int) -> Any:
    """A localized text field: a plain string (treated as ``en``), an ``{en,zh}`` map,
    or a binding. Length-capped per locale — authors get an error, not a truncation."""
    if _is_binding(raw, in_repeat=in_repeat):
        return dict(raw)
    if isinstance(raw, str):
        if not raw.strip() or len(raw) > cap:
            raise ValueError(f"{label}: must be a non-empty string of at most {cap} chars")
        return {"en": raw.strip()}
    if isinstance(raw, dict):
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


def _require_keys(raw: Mapping[str, Any], label: str, *, required: set[str], optional: set[str]) -> None:
    missing = required - set(raw)
    if missing:
        raise ValueError(f"{label}: missing {sorted(missing)}")
    unknown = set(raw) - required - optional
    if unknown:
        raise ValueError(f"{label}: unknown keys {sorted(unknown)}")


def _validate_block(raw: Any, label: str, *, in_repeat: bool = False) -> dict[str, Any]:
    """One template block, author-time strict. Returns the normalized block dict."""
    if not isinstance(raw, dict):
        raise ValueError(f"{label}: each block must be a mapping")
    if "repeat" in raw:
        if in_repeat:
            raise ValueError(f"{label}: repeat does not nest")
        _require_keys(raw, label, required={"repeat"}, optional=set())
        spec = raw["repeat"]
        if not isinstance(spec, dict):
            raise ValueError(f"{label}.repeat: must be a mapping")
        _require_keys(spec, f"{label}.repeat", required={"prefix", "block"}, optional=set())
        prefix = spec["prefix"]
        if not isinstance(prefix, str) or not prefix.strip() or len(prefix) > MAX_REPEAT_PREFIX_CHARS:
            raise ValueError(f"{label}.repeat.prefix: must be a non-empty string")
        block = _validate_block(spec["block"], f"{label}.repeat.block", in_repeat=True)
        return {"repeat": {"prefix": prefix.strip(), "block": block}}

    kind = raw.get("kind")
    if kind not in UI_BLOCK_KINDS:
        raise ValueError(f"{label}: kind must be one of {sorted(UI_BLOCK_KINDS)}")
    if kind == "divider":
        _require_keys(raw, label, required={"kind"}, optional=set())
        return {"kind": "divider"}
    if kind == "meter":
        _require_keys(raw, label, required={"kind", "label", "value", "min", "max"}, optional=set())
        block = {
            "kind": "meter",
            "label": _localized(raw["label"], f"{label}.label", in_repeat=in_repeat, cap=MAX_UI_LABEL_CHARS),
            "value": _scalar(raw["value"], f"{label}.value", in_repeat=in_repeat, types=(int, float)),
            "min": _scalar(raw["min"], f"{label}.min", in_repeat=in_repeat, types=(int, float)),
            "max": _scalar(raw["max"], f"{label}.max", in_repeat=in_repeat, types=(int, float)),
        }
        if (
            isinstance(block["min"], (int, float))
            and isinstance(block["max"], (int, float))
            and block["max"] <= block["min"]
        ):
            raise ValueError(f"{label}: max must be greater than min")
        return block
    if kind == "stat":
        _require_keys(raw, label, required={"kind", "label", "value"}, optional=set())
        return {
            "kind": "stat",
            "label": _localized(raw["label"], f"{label}.label", in_repeat=in_repeat, cap=MAX_UI_LABEL_CHARS),
            "value": _scalar(raw["value"], f"{label}.value", in_repeat=in_repeat, types=(int, float, str, bool)),
        }
    if kind == "badge":
        _require_keys(raw, label, required={"kind", "label"}, optional={"tone"})
        block = {
            "kind": "badge",
            "label": _localized(raw["label"], f"{label}.label", in_repeat=in_repeat, cap=MAX_UI_LABEL_CHARS),
        }
        if "tone" in raw:
            tone = _scalar(raw["tone"], f"{label}.tone", in_repeat=in_repeat, types=(str,))
            if isinstance(tone, str) and tone not in UI_BADGE_TONES:
                raise ValueError(f"{label}.tone: must be one of {sorted(UI_BADGE_TONES)}")
            block["tone"] = tone
        return block
    if kind == "text":
        _require_keys(raw, label, required={"kind", "text"}, optional={"style"})
        block = {
            "kind": "text",
            "text": _localized(raw["text"], f"{label}.text", in_repeat=in_repeat, cap=MAX_UI_TEXT_CHARS),
        }
        if "style" in raw:
            style = raw["style"]
            if style not in UI_TEXT_STYLES:
                raise ValueError(f"{label}.style: must be one of {sorted(UI_TEXT_STYLES)}")
            block["style"] = style
        return block
    if kind == "image":
        _require_keys(raw, label, required={"kind", "src"}, optional={"caption", "alt"})
        block = {"kind": "image", "src": _validated_asset_path(raw["src"], f"{label}.src")}
        if "caption" in raw:
            block["caption"] = _localized(
                raw["caption"], f"{label}.caption", in_repeat=in_repeat, cap=MAX_UI_CAPTION_CHARS
            )
        if "alt" in raw:
            block["alt"] = _localized(raw["alt"], f"{label}.alt", in_repeat=in_repeat, cap=MAX_UI_LABEL_CHARS)
        return block
    # kind == "choices"
    _require_keys(raw, label, required={"kind", "options"}, optional={"prompt"})
    raw_options = raw["options"]
    if not isinstance(raw_options, list) or not raw_options:
        raise ValueError(f"{label}.options: must be a non-empty list")
    if len(raw_options) > MAX_UI_OPTIONS:
        raise ValueError(f"{label}.options: at most {MAX_UI_OPTIONS} options")
    options = []
    for index, raw_option in enumerate(raw_options):
        option_label = f"{label}.options[{index}]"
        if not isinstance(raw_option, dict):
            raise ValueError(f"{option_label}: must be a mapping")
        _require_keys(raw_option, option_label, required={"id", "label", "input"}, optional=set())
        option_id = raw_option["id"]
        if not isinstance(option_id, str) or not option_id.strip() or len(option_id) > MAX_UI_ID_CHARS:
            raise ValueError(f"{option_label}.id: must be a non-empty string of at most {MAX_UI_ID_CHARS} chars")
        option_input = raw_option["input"]
        if not isinstance(option_input, str) or not option_input.strip() or len(option_input) > MAX_UI_OPTION_INPUT_CHARS:
            raise ValueError(
                f"{option_label}.input: must be a non-empty string of at most {MAX_UI_OPTION_INPUT_CHARS} chars"
            )
        options.append(
            {
                "id": option_id.strip(),
                "label": _localized(
                    raw_option["label"], f"{option_label}.label", in_repeat=in_repeat, cap=MAX_UI_LABEL_CHARS
                ),
                "input": option_input.strip(),
            }
        )
    block = {"kind": "choices", "options": options}
    if "prompt" in raw:
        block["prompt"] = _localized(raw["prompt"], f"{label}.prompt", in_repeat=in_repeat, cap=MAX_UI_PROMPT_CHARS)
    return block


def _collect_image_sources(blocks: Any) -> list[str]:
    """The ``image`` srcs in ``blocks``, de-duplicated, order-preserving. Descends into
    ``repeat`` templates (whose inner block is a normal template block)."""
    sources: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if "repeat" in block:
            inner = block["repeat"].get("block") if isinstance(block.get("repeat"), dict) else None
            candidates = _collect_image_sources([inner]) if inner is not None else []
        elif block.get("kind") == "image":
            candidates = [str(block.get("src") or "")]
        else:
            continue
        for source in candidates:
            if source and source not in sources:
                sources.append(source)
    return sources


def _validate_blocks(raw: Any, label: str) -> tuple[dict[str, Any], ...]:
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"{label}: must be a non-empty list of blocks")
    if len(raw) > MAX_PANEL_BLOCKS:
        raise ValueError(f"{label}: at most {MAX_PANEL_BLOCKS} blocks")
    return tuple(_validate_block(block, f"{label}[{index}]") for index, block in enumerate(raw))


def _validated_asset_path(raw: Any, label: str) -> str:
    """A pack-relative posix path. The heavier zip-slip discipline lives in
    ``core.pack._validated_entry_path``; this local check keeps the module
    dependency-free (pack imports panels, never the reverse) while still refusing
    anything non-relative before the pack layer re-validates it."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{label}: must be a relative path string")
    path = PurePosixPath(raw.strip())
    if path.is_absolute() or any(part in {"..", "."} or not part.strip() for part in path.parts):
        raise ValueError(f"{label}: must be a plain relative path (no .. segments)")
    return str(path)


def _parse_panel(raw: Any, index: int) -> PanelSpec:
    label = f"panels[{index}]"
    if not isinstance(raw, dict):
        raise ValueError(f"{label}: each panel must be a mapping")
    _require_keys(
        raw,
        label,
        required={"id", "title", "slot"},
        optional={"audience", "blocks", "entry", "assets", "fallback"},
    )
    panel_id = raw.get("id")
    if not isinstance(panel_id, str) or not _SLUG_RE.match(panel_id):
        raise ValueError(f"{label}.id: must be a lowercase slug ([a-z0-9-], max 64)")
    label = f"panels[{panel_id}]"
    title = _localized(raw["title"], f"{label}.title", in_repeat=False, cap=MAX_UI_LABEL_CHARS)
    if not isinstance(title, dict) or set(title) - set(_LOCALES):
        raise ValueError(f"{label}.title: must be a plain string or en/zh mapping (no bindings)")
    slot = raw.get("slot")
    if slot not in PANEL_SLOTS:
        raise ValueError(f"{label}.slot: must be one of {list(PANEL_SLOTS)}")
    audience = raw.get("audience", "all")
    if audience not in PANEL_AUDIENCES:
        raise ValueError(f"{label}.audience: must be one of {list(PANEL_AUDIENCES)}")

    entry = raw.get("entry")
    if entry is None:
        # Tier 1: blocks required; no tier-2 keys allowed.
        for forbidden in ("assets", "fallback"):
            if forbidden in raw:
                raise ValueError(f"{label}.{forbidden}: only a tier-2 panel (with entry) declares this")
        if "blocks" not in raw:
            raise ValueError(f"{label}: a tier-1 panel needs blocks (or declare a tier-2 entry)")
        blocks = _validate_blocks(raw["blocks"], f"{label}.blocks")
        return PanelSpec(id=panel_id, title=title, slot=slot, audience=audience, tier=1, blocks=blocks)

    # Tier 2: entry + explicit asset list + explicit fallback (null allowed).
    if "blocks" in raw:
        raise ValueError(f"{label}.blocks: a tier-2 panel declares fallback blocks, not blocks")
    entry_path = _validated_asset_path(entry, f"{label}.entry")
    if PurePosixPath(entry_path).suffix.lower() not in {".html", ".htm"}:
        raise ValueError(f"{label}.entry: must be an .html document")
    assets_raw = raw.get("assets")
    if not isinstance(assets_raw, list) or not assets_raw:
        raise ValueError(f"{label}.assets: a tier-2 panel must list every file it ships (entry included)")
    assets = tuple(_validated_asset_path(item, f"{label}.assets[{i}]") for i, item in enumerate(assets_raw))
    if len(set(assets)) != len(assets):
        raise ValueError(f"{label}.assets: lists a duplicate path")
    if entry_path not in assets:
        raise ValueError(f"{label}.assets: must include the entry document itself")
    if len(assets) - 1 > MAX_PANEL_EXTRA_ASSETS:
        raise ValueError(f"{label}.assets: at most {MAX_PANEL_EXTRA_ASSETS} assets beyond the entry")
    entry_dir = str(PurePosixPath(entry_path).parent)
    for asset in assets:
        if entry_dir not in (".", "") and not asset.startswith(f"{entry_dir}/"):
            raise ValueError(f"{label}.assets: {asset!r} is outside the entry's directory {entry_dir!r}")
    if "fallback" not in raw:
        raise ValueError(f"{label}.fallback: required for a tier-2 panel (write `fallback: null` to opt out)")
    fallback_raw = raw["fallback"]
    fallback = None if fallback_raw is None else _validate_blocks(fallback_raw, f"{label}.fallback")
    return PanelSpec(
        id=panel_id,
        title=title,
        slot=slot,
        audience=audience,
        tier=2,
        entry=entry_path,
        assets=assets,
        fallback=fallback,
    )


def parse_panels_text(text: str) -> tuple[PanelSpec, ...]:
    """Parse + validate one ``panels.yaml`` document. Raises ``ValueError`` with an
    author-actionable message on any problem (the pack layer wraps it in ``PackError``)."""
    if len(text.encode("utf-8")) > MAX_PANELS_FILE_BYTES:
        raise ValueError(f"panels.yaml exceeds the {MAX_PANELS_FILE_BYTES}-byte cap")
    try:
        raw = safe_load_no_aliases(text)
    except Exception as exc:
        raise ValueError(f"invalid panels YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("panels.yaml root must be a mapping with a `panels` list")
    _require_keys(raw, "panels.yaml", required={"panels"}, optional=set())
    entries = raw["panels"]
    if not isinstance(entries, list) or not entries:
        raise ValueError("panels: must be a non-empty list")
    if len(entries) > MAX_PANELS_PER_PACK:
        raise ValueError(f"panels: at most {MAX_PANELS_PER_PACK} panels per pack")
    panels = tuple(_parse_panel(entry, index) for index, entry in enumerate(entries))
    seen: set[str] = set()
    for panel in panels:
        if panel.id in seen:
            raise ValueError(f"panels: duplicate panel id {panel.id!r}")
        seen.add(panel.id)
    return panels


def audience_allows(audience: str, role: str) -> bool:
    """Whether a viewer with keystore ``role`` receives a panel with ``audience``.

    The one-way door the iron rules lean on: ``keeper`` panels reach ONLY keeper
    connections (structural, decided server-side before the wire), ``player`` panels
    only non-keeper ones, ``all`` everyone. Unknown audiences fail closed.
    """
    if audience == "all":
        return True
    if audience == _KEEPER_ROLE:
        return role == _KEEPER_ROLE
    if audience == "player":
        return role != _KEEPER_ROLE
    return False


def _wire_block(block: Mapping[str, Any], ref: str, asset_info: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """One template block as it rides the wire. Everything passes through unchanged
    except ``image``, whose authored ``src`` path becomes the ``{hash,size,mime}``
    triple a client fetches over the media byte channel."""
    if "repeat" in block:
        spec = block["repeat"]
        return {"repeat": {"prefix": spec["prefix"], "block": _wire_block(spec["block"], ref, asset_info)}}
    if block.get("kind") != "image":
        return dict(block)
    source = str(block.get("src") or "")
    info = asset_info.get(source)
    if info is None:
        raise ValueError(f"panel {ref}: no integrity record for image {source!r}")
    wired: dict[str, Any] = {
        "kind": "image",
        "hash": str(info["sha256"]),
        "size": int(info["size"]),
        "mime": str(info.get("mime") or "application/octet-stream"),
    }
    for key in ("caption", "alt"):
        if key in block:
            wired[key] = dict(block[key])
    return wired


def wire_panel(pack_id: str, panel: PanelSpec, asset_info: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """One ``ui_manifest`` panel entry (protocol v1.8) for ``panel``.

    ``asset_info`` maps pack-relative asset paths to their integrity records
    (``{"sha256", "size", "mime"}`` — the built manifest's asset block). Tier-2 asset
    paths ride the wire RELATIVE to the entry's directory (each panel is a
    self-contained static root); ``image`` block srcs resolve to content hashes the
    same way. ``audience`` deliberately never appears: the caller already resolved it
    per viewer. Raises ``ValueError`` when a panel's integrity records are missing
    (the caller skips that panel and logs).
    """
    ref = f"{pack_id}/{panel.id}"
    entry: dict[str, Any] = {
        "id": ref,
        "title": dict(panel.title),
        "slot": panel.slot,
        "tier": panel.tier,
    }
    if panel.tier == 1:
        entry["blocks"] = [_wire_block(block, ref, asset_info) for block in panel.blocks]
        return entry
    entry_info = asset_info.get(panel.entry)
    if entry_info is None:
        raise ValueError(f"panel {ref}: no integrity record for entry {panel.entry!r}")
    entry["entry"] = {"hash": str(entry_info["sha256"]), "size": int(entry_info["size"])}
    assets = []
    for path in panel.assets:
        if path == panel.entry:
            continue
        info = asset_info.get(path)
        if info is None:
            raise ValueError(f"panel {ref}: no integrity record for asset {path!r}")
        assets.append(
            {
                "path": posixpath.relpath(path, panel.entry_dir or "."),
                "hash": str(info["sha256"]),
                "size": int(info["size"]),
                "mime": str(info.get("mime") or "application/octet-stream"),
            }
        )
    entry["assets"] = assets
    entry["fallback"] = (
        None if panel.fallback is None else [_wire_block(block, ref, asset_info) for block in panel.fallback]
    )
    return entry
