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
- an ``image``/``map_pin`` block names its picture by pack-relative ``src`` path;
  :func:`wire_panel` resolves it to the ``{hash,size,mime}`` triple clients fetch over
  the media byte channel. A path (not a hash, and never a ``$var`` binding) is the
  authored form so the pack build owns the addressing — an author cannot aim a panel
  at a blob their pack does not ship.
- any block may carry ``visible_when: "<condition>"`` (protocol 2.1) — a
  `core.condexpr` expression the CLIENT evaluates against its own ``state.variables``.
  ``$var``'s absent-means-hide cannot express value gating ("show once day >= 46"), and
  values move at runtime so a server-side per-viewer filter is impossible. The build
  validates syntax AND portability (`core.condexpr.check_subset`), so an expression a
  second client implementation could read differently never ships.

Instantiating those templates for ONE viewer — bindings substituted, gates evaluated,
repeats expanded — is :func:`resolve_panel_blocks`, which mirrors the reference client
(`clients/tui/src/panelTemplates.ts`) rule for rule;
``tests/fixtures/panel_template_vectors.json`` is the table both implementations run.

The privilege model stays one sentence long: a panel acts as the player viewing it.
``audience`` is resolved server-side into per-viewer manifests and never rides the
wire; a keeper-only panel structurally never enters a player's manifest.
"""

from __future__ import annotations

import math
import posixpath
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from core.condexpr import MAX_EXPR_LEN, CondExprError, check_subset, compile_expression, evaluate_safe
from core.hooks import (
    MAX_UI_BODY_CHARS,
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

# M19 performance templates in their AUTHORED form: kind -> (required, optional) field
# names. `src` and `x`/`y` are handled specially (path / bindable number); everything
# else is a localized string capped by `_PERFORMANCE_CAPS`.
_PERFORMANCE_KINDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "letter": (("body",), ("from", "to", "date")),
    "clipping": (("headline", "body"), ("source", "date")),
    "map_pin": (("src", "label", "x", "y"), ("note",)),
    "title_card": (("title",), ("subtitle", "act")),
}
_PERFORMANCE_CAPS: dict[str, int] = {
    "body": MAX_UI_BODY_CHARS,
    "headline": MAX_UI_LABEL_CHARS,
    "label": MAX_UI_LABEL_CHARS,
    "title": MAX_UI_LABEL_CHARS,
    "from": MAX_UI_LABEL_CHARS,
    "to": MAX_UI_LABEL_CHARS,
    "date": MAX_UI_LABEL_CHARS,
    "source": MAX_UI_LABEL_CHARS,
    "act": MAX_UI_LABEL_CHARS,
    "note": MAX_UI_CAPTION_CHARS,
    "subtitle": MAX_UI_CAPTION_CHARS,
}

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


def _validated_visible_when(raw: Any, label: str) -> str:
    """One ``visible_when`` condition, checked at BUILD time for both syntax and
    portability. It is evaluated CLIENT-side (values move at runtime, so no server-side
    per-viewer filter could do it), which makes every client an implementation of the
    same grammar — so an expression outside `core.condexpr`'s portable subset is
    rejected here rather than shipped to diverge in the field."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{label}: must be a non-empty condition string")
    condition = raw.strip()
    if len(condition) > MAX_EXPR_LEN:
        raise ValueError(f"{label}: condition exceeds {MAX_EXPR_LEN} chars")
    try:
        # probe="1": a viewer's variables may be text, so the build must not reject
        # `note > 'a'` for a type mismatch only the runtime can actually have.
        compile_expression(condition, probe="1")
        check_subset(condition)
    except CondExprError as exc:
        raise ValueError(f"{label}: {exc}") from exc
    return condition


def _validate_block(raw: Any, label: str, *, in_repeat: bool = False) -> dict[str, Any]:
    """One template block, author-time strict. Returns the normalized block dict.

    ``visible_when`` is accepted on ANY block (including a repeat's inner template) and
    is stripped before the per-kind schema runs, so each kind's key check stays exact."""
    if not isinstance(raw, dict):
        raise ValueError(f"{label}: each block must be a mapping")
    if "visible_when" in raw:
        condition = _validated_visible_when(raw["visible_when"], f"{label}.visible_when")
        block = _validate_block({key: value for key, value in raw.items() if key != "visible_when"}, label, in_repeat=in_repeat)
        block["visible_when"] = condition
        return block
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
    if kind in _PERFORMANCE_KINDS:
        # The M19 performance templates in their AUTHORED form: every text field is
        # localized, `map_pin` addresses its map by pack-relative `src` exactly like
        # `image` does, and its coordinates may bind to live variables (a marker that
        # moves is the whole point of pinning it).
        required, optional = _PERFORMANCE_KINDS[kind]
        _require_keys(raw, label, required={"kind", *required}, optional=set(optional))
        block = {"kind": kind}
        for name in required:
            if name == "src":
                block["src"] = _validated_asset_path(raw["src"], f"{label}.src")
            elif name in ("x", "y"):
                block[name] = _scalar(raw[name], f"{label}.{name}", in_repeat=in_repeat, types=(int, float))
            else:
                block[name] = _localized(
                    raw[name], f"{label}.{name}", in_repeat=in_repeat, cap=_PERFORMANCE_CAPS[name]
                )
        for name in optional:
            if name in raw:
                block[name] = _localized(
                    raw[name], f"{label}.{name}", in_repeat=in_repeat, cap=_PERFORMANCE_CAPS[name]
                )
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
        elif "src" in block:
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


# --- Template instantiation, then text rendering ----------------------------
#
# :func:`resolve_panel_blocks` is the server-side half of a contract implemented TWICE:
# it mirrors `clients/tui/src/panelTemplates.ts` `resolvePanelBlocks` — the reference
# client — rule for rule, turning a panel's template blocks plus ONE viewer's variables
# into the protocol-v1.7 `ui` blocks that viewer's client would draw. Blocks arrive in
# WIRE form (`wire_panel` has already resolved every `src` to its content hash), which
# is exactly what a client receives, so both halves start from the same input.
#
# `tests/fixtures/panel_template_vectors.json` IS that agreement: one table, consumed by
# `tests/core/test_panel_template_vectors.py` and by
# `clients/tui/src/panelTemplates.vectors.test.ts`, so a rule that moves on either side
# breaks both suites at once (the shape `visible_when_vectors.json` established for the
# condition grammar). The reference client is the ORACLE: where the two could differ,
# this function copies it — including the small oddities noted inline.
#
# The text renderer below is then a dumb stringify over resolved blocks. A tier-2
# panel's `fallback` exists for exactly one purpose — to be READ by a client that cannot
# render the rich page — and until it existed nothing could turn one into text: a
# 2026-08-18 play-test found `.panel` produced no frame at all, so a module's
# look-at-the-chart clues (its whole ◈ layer) were unreachable on a terminal. Sharing
# the resolver is what keeps the terminal's panel and the rich client's panel from
# disagreeing about what this viewer may see.

_MISSING = object()

# Per performance kind: (required, optional) RESOLVED text fields — the client's
# PERFORMANCE_REQUIRED / PERFORMANCE_OPTIONAL. `map_pin`'s hash and x/y are not text and
# are handled separately, which is why its row differs from `_PERFORMANCE_KINDS` above
# (that one describes the AUTHORED form, where the map is still a `src` path).
_PERFORMANCE_TEXT_FIELDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "letter": (("body",), ("from", "to", "date")),
    "clipping": (("headline", "body"), ("source", "date")),
    "map_pin": (("label",), ("note",)),
    "title_card": (("title",), ("subtitle", "act")),
}


def _js_text(value: Any) -> str:
    """``String(value)`` for the scalars the client stringifies into a text field.

    JavaScript has ONE number type and lowercase booleans, so `3.0` prints as ``3`` and
    `True` prints as ``true``. Python's own ``str`` would answer ``3.0`` and ``True`` —
    two rows of the shared vector table that would then disagree for no reason at all.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _pick_text(value: Any, locale: str | None) -> str | None:
    """The client's ``pickPanelText``: this locale, else ``en``, else any non-empty value.

    ``None`` (not ``""``) means "nothing usable here", which is what makes a required
    field's absence hide its block. A plain string passes through AS IS, empty included —
    the client's rule, and the one place an empty string is not a miss.
    """
    if isinstance(value, str):
        return value
    if not isinstance(value, Mapping):
        return None
    short = ("en" if locale is None else str(locale))[:2]
    for candidate in (value.get(short), value.get("en"), *value.values()):
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _localized_text(value: Any, locale: str) -> str:
    """:func:`_pick_text` for the places that want a plain string (a panel's title)."""
    return _pick_text(value, locale) or ""


def _visible_variables(variables: Sequence[Mapping[str, Any]] | None) -> list[Mapping[str, Any]]:
    """This viewer's variables minus the ``hidden`` ones, dropped BEFORE anything
    resolves: a `$var` pointing at one misses and fail-closes its whole block, and
    `repeat` never instantiates over one. Hidden leaves only reach keeper connections (an
    imported-card MVU leaf before `.var expose`), so this is not a player-facing leak —
    but a pack-authored panel must not be able to surface un-exposed module internals as
    ordinary panel content on any screen."""
    return [entry for entry in (variables or ()) if not entry.get("hidden")]


def _variable_value(variables: Sequence[Mapping[str, Any]], path: str) -> Any:
    """One condexpr reference: the FIRST visible variable of that id, ``None`` when
    absent. Nothing else is addressable — `tests/fixtures/visible_when_vectors.json`
    pins this exact rule for every implementation."""
    for entry in variables:
        if entry.get("id") == path:
            return entry.get("value")
    return None


def _block_visible(block: Mapping[str, Any], variables: Sequence[Mapping[str, Any]]) -> bool:
    """A block's own ``visible_when`` gate (protocol 2.1) — the value gate `$var`'s
    absent-means-hide cannot express. Evaluated against the SAME visible variable set
    every binding sees, so a condition can never widen visibility past the server's wire
    filter, and an undecidable condition hides its block (fail-closed, like every other
    miss here). Absent means visible; anything else present — including an empty string —
    goes through the evaluator, which is the client's `isVisible(condition, …)` exactly."""
    if "visible_when" not in block:
        return True
    return evaluate_safe(block["visible_when"], lambda path: _variable_value(variables, path), default=False)


def _resolve_scalar(value: Any, variables: Sequence[Mapping[str, Any]], leaf: Mapping[str, Any] | None) -> Any:
    """One template scalar with its bindings applied, or :data:`_MISSING` when a binding
    names something this viewer does not have — the fail-closed rule that hides the block.

    A mapping merely CONTAINING ``$var`` is a binding (the client tests `"$var" in value`,
    not "is exactly this key"), and ``$var`` wins over ``$leaf`` when both are present.
    """
    if isinstance(value, Mapping) and "$var" in value:
        name = value["$var"]
        if not isinstance(name, str):
            return _MISSING
        for entry in variables:
            if entry.get("id") == name:
                return entry.get("value")
        return _MISSING
    if isinstance(value, Mapping) and "$leaf" in value:
        # `$leaf` reads the repeat instance's matched variable — its id, label or value,
        # the three fields the reference client exposes; anything else is a miss, and so
        # is any `$leaf` outside a repeat.
        field = value["$leaf"]
        if leaf is None or field not in _LEAF_FIELDS:
            return _MISSING
        return leaf.get(field)
    return value


def _resolve_text(
    value: Any, variables: Sequence[Mapping[str, Any]], locale: str | None, leaf: Mapping[str, Any] | None
) -> str | None:
    resolved = _resolve_scalar(value, variables, leaf)
    if resolved is _MISSING:
        return None
    if isinstance(resolved, (bool, int, float)):
        return _js_text(resolved)
    return _pick_text(resolved, locale)


def _finite_number(resolved: Any) -> float | None:
    """The resolved scalar as a number, or ``None`` — the client's `finiteNumber`. A bool
    is NOT a number here (Python would call it an int; JavaScript never does)."""
    if resolved is _MISSING or isinstance(resolved, bool) or not isinstance(resolved, (int, float)):
        return None
    return resolved if math.isfinite(resolved) else None


def _carry_media_fields(block: Mapping[str, Any], target: dict[str, Any]) -> None:
    """Copy an image/map_pin's `mime`/`size` through when the wire block carries them.

    The client writes `mime: block.mime` unconditionally, which for an absent field means
    the key exists holding `undefined` — a key that disappears the moment the object is
    serialized or compared. An absent key here is that same thing, said in Python.
    """
    for field in ("mime", "size"):
        if field in block:
            target[field] = block[field]


def _resolve_one(
    block: Mapping[str, Any],
    variables: Sequence[Mapping[str, Any]],
    locale: str | None,
    leaf: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    """One template block as the `ui` block a client would draw, or ``None`` when it is
    hidden/unresolvable for this viewer. Mirrors the client's `resolveOne`."""
    if "repeat" in block:
        return None  # expanded by resolve_panel_blocks; nesting resolves to nothing
    if not _block_visible(block, variables):
        return None
    kind = block.get("kind")

    if kind == "divider":
        return {"kind": "divider"}

    if kind == "meter":
        label = _resolve_text(block.get("label"), variables, locale, leaf)
        value = _finite_number(_resolve_scalar(block.get("value"), variables, leaf))
        low = _finite_number(_resolve_scalar(block.get("min"), variables, leaf))
        high = _finite_number(_resolve_scalar(block.get("max"), variables, leaf))
        if label is None or value is None or low is None or high is None or high <= low:
            return None
        return {"kind": "meter", "label": label, "value": value, "min": low, "max": high}

    if kind == "stat":
        label = _resolve_text(block.get("label"), variables, locale, leaf)
        resolved = _resolve_scalar(block.get("value"), variables, leaf)
        if label is None or resolved is _MISSING:
            return None
        if isinstance(resolved, (bool, int, float)):  # numbers and bools ride as themselves
            return {"kind": "stat", "label": label, "value": resolved}
        text = resolved if isinstance(resolved, str) else _pick_text(resolved, locale)
        return None if text is None else {"kind": "stat", "label": label, "value": text}

    if kind == "badge":
        label = _resolve_text(block.get("label"), variables, locale, leaf)
        if label is None:
            return None
        badge: dict[str, Any] = {"kind": "badge", "label": label}
        if "tone" in block:
            tone = _resolve_scalar(block["tone"], variables, leaf)
            # v1.7 stance for optional enums: an invalid tone strips, the badge stays.
            if isinstance(tone, str) and tone in UI_BADGE_TONES:
                badge["tone"] = tone
        return badge

    if kind == "text":
        text = _resolve_text(block.get("text"), variables, locale, leaf)
        if text is None:
            return None
        text_block: dict[str, Any] = {"kind": "text", "text": text}
        if "style" in block:  # passed through unresolved and unvalidated, as the client does
            text_block["style"] = block["style"]
        return text_block

    if kind == "image":
        # Content-addressed by the pack build — nothing to resolve against state, but a
        # manifest hand-edited into a hashless block would render as a dead fetch.
        image_hash = block.get("hash")
        if not isinstance(image_hash, str) or not image_hash:
            return None
        image: dict[str, Any] = {"kind": "image", "hash": image_hash}
        _carry_media_fields(block, image)
        caption = _resolve_text(block.get("caption"), variables, locale, leaf)
        if caption is not None:
            image["caption"] = caption
        alt = _resolve_text(block.get("alt"), variables, locale, leaf)
        if alt is not None:
            image["alt"] = alt
        return image

    if kind in _PERFORMANCE_TEXT_FIELDS:
        # The M19 performance templates: localized text fields, plus `map_pin`'s
        # content-addressed map and its (bindable) fractional coordinates. Required
        # fields resolve or the whole block drops, same fail-closed rule as everywhere.
        required, optional = _PERFORMANCE_TEXT_FIELDS[str(kind)]
        resolved_block: dict[str, Any] = {"kind": kind}
        for name in required:
            text = _resolve_text(block.get(name), variables, locale, leaf)
            if text is None:
                return None
            resolved_block[name] = text
        for name in optional:
            text = _resolve_text(block.get(name), variables, locale, leaf)
            if text is not None:
                resolved_block[name] = text
        if kind == "map_pin":
            x = _finite_number(_resolve_scalar(block.get("x"), variables, leaf))
            y = _finite_number(_resolve_scalar(block.get("y"), variables, leaf))
            pin_hash = block.get("hash")
            if not isinstance(pin_hash, str) or not pin_hash or x is None or y is None:
                return None
            resolved_block["hash"] = pin_hash
            _carry_media_fields(block, resolved_block)
            # Fractions of the map's own box: a pin outside it is clamped, not dropped.
            resolved_block["x"] = min(1, max(0, x))
            resolved_block["y"] = min(1, max(0, y))
        return resolved_block

    if kind == "choices":
        options: list[dict[str, Any]] = []
        for option in block.get("options") or ():
            if not isinstance(option, Mapping):
                continue
            label = _resolve_text(option.get("label"), variables, locale, leaf)
            if label is None or not isinstance(option.get("input"), str) or not isinstance(option.get("id"), str):
                continue
            options.append({"id": option["id"], "label": label, "input": option["input"]})
        if not options:
            return None
        prompt = None if "prompt" not in block else _resolve_text(block["prompt"], variables, locale, leaf)
        if prompt is None:
            return {"kind": "choices", "options": options}
        return {"kind": "choices", "prompt": prompt, "options": options}

    return None


def resolve_panel_blocks(
    blocks: Sequence[Mapping[str, Any]] | None,
    variables: Sequence[Mapping[str, Any]] | None,
    locale: str | None = None,
) -> list[dict[str, Any]]:
    """Instantiate a panel's WIRE template blocks for ONE viewer.

    `repeat` expands to one instance per VISIBLE variable whose id starts with the prefix
    (capped at :data:`MAX_REPEAT_INSTANCES`); every unresolved binding drops its whole
    block (fail-closed), so an empty result is a legitimate outcome — the caller decides
    what to say about a panel with nothing in it. Mirrors the reference client's
    `resolvePanelBlocks`; `tests/fixtures/panel_template_vectors.json` is the agreement.
    """
    visible = _visible_variables(variables)
    resolved: list[dict[str, Any]] = []
    for block in blocks or ():
        if "repeat" in block:
            # A repeat may carry its own `visible_when` (the author gating the WHOLE list,
            # not each instance). `_resolve_one` never sees a repeat, so the gate is
            # checked here — undecidable hides the whole expansion, as everywhere else.
            if not _block_visible(block, visible):
                continue
            spec = block["repeat"] if isinstance(block["repeat"], Mapping) else {}
            prefix = spec.get("prefix")
            inner = spec.get("block")
            if not isinstance(prefix, str) or not prefix or not isinstance(inner, Mapping) or "repeat" in inner:
                continue
            # Filter first, THEN cap: the cap is on instances, never on how far into the
            # variable list a match may sit (an MVU import puts hundreds ahead of it).
            matches = [entry for entry in visible if str(entry.get("id", "")).startswith(prefix)]
            for match in matches[:MAX_REPEAT_INSTANCES]:
                instance = _resolve_one(inner, visible, locale, match)
                if instance is not None:
                    resolved.append(instance)
            continue
        instance = _resolve_one(block, visible, locale)
        if instance is not None:
            resolved.append(instance)
    return resolved


def _resolved_block_text(block: Mapping[str, Any]) -> list[str]:
    """One RESOLVED block as text lines. Pure stringify: every binding, every gate and
    every drop already happened in :func:`resolve_panel_blocks`."""
    kind = block.get("kind")
    if kind == "divider":
        return ["—"]
    if kind == "meter":
        return [f"{block['label']}: {_js_text(block['value'])}/{_js_text(block['max'])}"]
    if kind == "stat":
        return [f"{block['label']}: {_js_text(block['value'])}"]
    if kind == "badge":
        return [f"[{block['label']}]"]
    if kind == "text":
        return [str(block["text"])]
    if kind == "image":
        return [f"🖼 {block.get('caption') or block.get('alt') or ''}".rstrip()]
    if kind == "choices":
        prompt = [str(block["prompt"])] if block.get("prompt") else []
        return prompt + [f"  · {option['label']} → {option['input']}" for option in block["options"]]
    if kind == "title_card":
        head = " · ".join(part for part in (block.get("act"), block.get("title"), block.get("subtitle")) if part)
        return [f"— {head} —"] if head else []
    if kind == "letter":
        head = " · ".join(part for part in (block.get("from"), block.get("to"), block.get("date")) if part)
        return ([f"✉ {head}"] if head else ["✉"]) + [str(block.get("body", ""))]
    if kind == "clipping":
        head = " · ".join(part for part in (block.get("source"), block.get("date")) if part)
        return [f"📰 {block.get('headline', '')}" + (f" ({head})" if head else ""), str(block.get("body", ""))]
    if kind == "map_pin":
        return [f"📍 {block.get('label', '')}" + (f" — {block['note']}" if block.get("note") else "")]
    return []


def panel_title_text(panel: PanelSpec, locale: str) -> str:
    """`panel`'s title in `locale` (falling back to en, then to its id)."""
    return _localized_text(panel.title, locale) or panel.id


def render_panel_text(
    blocks: Sequence[Mapping[str, Any]] | None, variables: Sequence[Mapping[str, Any]], locale: str
) -> list[str]:
    """WIRE panel blocks as text lines for THIS viewer — `wire_panel_blocks` output for a
    tier-1 panel, or a tier-2 panel's `fallback`. Empty when a tier-2 panel declared
    `fallback: null`, or when every block is hidden — the caller decides what to say."""
    lines: list[str] = []
    for block in resolve_panel_blocks(blocks, variables, locale):
        lines.extend(_resolved_block_text(block))
    return [line for line in lines if line != ""]


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
        # Rewrite the repeat IN PLACE inside a copy of the block: a repeat may carry
        # sibling keys — notably the ``visible_when`` gate ``_validate_block`` attaches to
        # any block — and rebuilding the dict from scratch would drop them, turning an
        # author's gate into a block that ships unconditionally (fail-OPEN).
        wired = dict(block)
        spec = block["repeat"]
        wired["repeat"] = {"prefix": spec["prefix"], "block": _wire_block(spec["block"], ref, asset_info)}
        return wired
    if "src" not in block:
        return dict(block)
    source = str(block.get("src") or "")
    info = asset_info.get(source)
    if info is None:
        raise ValueError(f"panel {ref}: no integrity record for image {source!r}")
    wired: dict[str, Any] = {key: value for key, value in block.items() if key != "src"}
    wired["hash"] = str(info["sha256"])
    wired["size"] = int(info["size"])
    wired["mime"] = str(info.get("mime") or "application/octet-stream")
    return wired


def wire_panel_blocks(
    pack_id: str, panel: PanelSpec, asset_info: Mapping[str, Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """``panel``'s blocks in WIRE form: a tier-1 panel's own blocks, a tier-2 panel's
    ``fallback`` (empty when it declared ``fallback: null``).

    The blocks half of :func:`wire_panel`, split out so a server-side renderer
    (`.panel`, via `gateway.panels.panel_wire_blocks`) resolves the SAME
    content-addressed blocks a client draws instead of hashing anything a second time.
    Raises ``ValueError`` when an image's integrity record is missing.
    """
    ref = f"{pack_id}/{panel.id}"
    source = panel.blocks if panel.tier == 1 else (panel.fallback or ())
    return [_wire_block(block, ref, asset_info) for block in source]


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
        entry["blocks"] = wire_panel_blocks(pack_id, panel, asset_info)
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
    entry["fallback"] = None if panel.fallback is None else wire_panel_blocks(pack_id, panel, asset_info)
    return entry
