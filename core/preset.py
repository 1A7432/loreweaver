"""SillyTavern completion presets (预设) — the engine-side parser/normalizer.

A "preset" is how the SillyTavern community actually distributes a *style*: ONE JSON file
that mixes sampler knobs, a flat ``prompts[]`` pool (routinely 250 entries), a SECOND
per-character enable matrix in ``prompt_order[]``, and ST-only ``extensions``. This module
is the single engine-side authority on that shape; ``loreweaver-studio``'s
``src/features/studio/ai/stPreset.ts`` is the browser-side mirror and the two agree
wherever they overlap (marker slots, the dual enable matrix, marker content forcing,
macro naming, order-group resolution).

Three facts drive the whole design:

- **The order list IS the sequence.** ``prompts[]`` is an unordered pool; the chosen
  ``prompt_order`` group decides both the order and the second enable bit. An entry is
  live only when BOTH ``prompts[].enabled`` and its order ref say enabled, so an entry the
  order list never mentions is inert — :func:`effective_prompts` drops it (upstream ST
  behaves the same way; the studio mirror pins it as ``position: null``).
- **Markers are anchors, not text.** The 8 :data:`MARKER_SLOTS` identifiers are where the
  runtime injects its OWN context (persona, character fields, world info, chat history).
  Their content is forced to ``""`` on import so a mis-authored marker can never leak its
  payload as prompt text, and :func:`style_segments` emits them as empty boundaries the
  prompt builder fills.
- **Author-time strictness, entry-level tolerance.** Structural garbage (not JSON, no
  ``prompts`` array, oversized) raises ``ValueError`` with an author-actionable message,
  like ``core.panels``; a single broken entry inside an otherwise fine 250-prompt file is
  skipped or degraded to its ST default with a warning, like ``core.mvu_compat``.

Nothing here is executed and nothing is I/O: ``extensions`` (regex scripts, tavern_helper)
is reduced to presence flags rather than carried, macros are counted and never expanded,
and the module is stdlib-only.

Deliberate divergences from the studio mirror (it is an importer/inspector; this is the
engine's fold path):

- a preset with no usable ``prompts`` array is a hard error here, not a sampling-only
  import — engine-side a preset exists to supply prompt text;
- duplicate pool identifiers keep the FIRST entry (the mirror keeps both and lets the last
  win on lookup); duplicate ORDER refs still resolve first-ref-wins, as upstream;
- ``forbid_overrides`` is parsed past but not carried: the engine has no card-level
  override mechanism for preset prompts, so storing it would be dead weight.

Warning/error strings are developer- and author-facing diagnostics (the keeper command
layer wraps them in localized templates), the same convention ``core/charcard.py`` and
``core/panels.py`` are allowlisted for; the ``# i18n-exempt`` comments below mark them.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field, replace
from typing import Any

# --- caps -------------------------------------------------------------------
# Real files are ~1 MiB / ~250 prompts, so these are generous sanity bounds. The first
# three are structural (exceeding them raises); the content caps degrade with a warning.

MAX_PRESET_BYTES = 2 * 1024 * 1024
MAX_PROMPTS = 512
MAX_PROMPT_CONTENT_CHARS = 64_000
#: Total folded text `style_segments` will hand the prompt builder. Markers cost nothing.
MAX_STYLE_CHARS = 32_000
#: Cosmetic cap — names ride the keeper's preset listing, never the prompt.
MAX_PROMPT_NAME_CHARS = 200

#: The 8 predefined ``marker: true`` identifiers, in ST's own declaration order.
MARKER_SLOTS: tuple[str, ...] = (
    "personaDescription",
    "charDescription",
    "charPersonality",
    "scenario",
    "worldInfoBefore",
    "worldInfoAfter",
    "dialogueExamples",
    "chatHistory",
)

ROLES: tuple[str, ...] = ("system", "assistant", "user")
DEFAULT_ROLE = "system"
DEFAULT_INJECTION_DEPTH = 4

# ST's pseudo-character ids for the GLOBAL order list, most modern first. Real exports ship
# the legacy 100000 group as a decoy ahead of the live 100001 one, so "first group wins"
# would pick the wrong list; the plain first group stays the last-resort fallback.
GLOBAL_ORDER_CHARACTER_IDS: tuple[int, ...] = (100001, 100000)

# ST key → our normalized (snake_case) name. Same set the studio mirror maps to camelCase.
SAMPLING_KEYS: dict[str, str] = {
    "temperature": "temperature",
    "top_p": "top_p",
    "top_k": "top_k",
    "top_a": "top_a",
    "min_p": "min_p",
    "frequency_penalty": "frequency_penalty",
    "presence_penalty": "presence_penalty",
    "repetition_penalty": "repetition_penalty",
    "seed": "seed",
    "n": "n",
    "openai_max_tokens": "max_tokens",
    "openai_max_context": "max_context",
}

_STRUCTURAL_KEYS = frozenset({"prompts", "prompt_order", "extensions"})

# One macro span: `{{name}}`, `{{name::arg}}`, `{{name:arg}}`, `{{// comment}}`.
_MACRO_RE = re.compile(r"\{\{([^{}]*)\}\}")


# ---------------------------------------------------------------------------
# Normalized shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PresetPrompt:
    """One normalized ``prompts[]`` entry.

    ``content`` is ``""`` for every marker (anchors carry no text, by construction), and
    ``slot`` names the marker's :data:`MARKER_SLOTS` member — ``None`` both for ordinary
    prompts and for a ``marker: true`` entry whose identifier is outside the 8 (kept, with
    a warning, so nothing silently disappears). ``enabled`` is only the FIRST layer of the
    enable matrix; :func:`effective_prompts` resolves it against the order list.
    """

    identifier: str
    name: str = ""
    content: str = ""
    role: str = DEFAULT_ROLE
    enabled: bool = True
    marker: bool = False
    slot: str | None = None
    system_prompt: bool = False
    #: 0 = relative (follows the order list), 1 = absolute (depth-injected).
    injection_position: int = 0
    injection_depth: int = DEFAULT_INJECTION_DEPTH
    injection_order: int | None = None


@dataclass(frozen=True)
class PresetOrderGroup:
    """One ``prompt_order`` group: a character scope plus its ``(identifier, enabled)``
    refs, verbatim and in file order (duplicates and refs to identifiers absent from the
    pool are kept here — resolution drops them, import never does)."""

    character_id: int | None = None
    refs: tuple[tuple[str, bool], ...] = ()


@dataclass(frozen=True)
class StPreset:
    """One parsed completion preset.

    ``sampling`` holds only the keys the file actually carried, under the normalized names
    of :data:`SAMPLING_KEYS`. ``unknown_top_level`` lists (in file order) every top-level
    key that was neither structural nor a mapped sampler knob, so the caller can report
    what it is ignoring without the module storing it. ``has_regex_scripts`` /
    ``has_tavern_helper`` reduce ST-only ``extensions`` machinery to presence — those
    payloads are megabytes and Loreweaver never runs them.
    """

    name: str
    sampling: dict[str, float | int] = field(default_factory=dict)
    prompts: tuple[PresetPrompt, ...] = ()
    order: tuple[PresetOrderGroup, ...] = ()
    unknown_top_level: tuple[str, ...] = ()
    has_regex_scripts: bool = False
    has_tavern_helper: bool = False
    warnings: tuple[str, ...] = ()


# ---------------------------------------------------------------------------
# Tolerant field coercion
# ---------------------------------------------------------------------------


def _as_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _as_bool(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _as_int(value: Any, default: int) -> int:
    """A JSON int (integral floats included); anything else — bools especially — degrades."""
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return default


def _optional_int(value: Any) -> int | None:
    """An optional JSON int; ``None`` both when absent and when unusable."""
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not (math.isfinite(value) and value.is_integer()):
        return None
    return int(value)


def _identifier(value: Any) -> str | None:
    """Stringify an identifier (ST writes UUIDs, predefined names, and bare numbers);
    ``None`` when there is nothing usable to key on."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        return str(int(value)) if value.is_integer() else str(value)
    return None


def _character_id(value: Any) -> int | None:
    """ST's pseudo-character ids arrive as numbers, occasionally as numeric strings."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text.lstrip("-").isdigit():
            return int(text)
    return None


def _is_present(value: Any) -> bool:
    """Whether an ``extensions`` sub-payload is actually there (an empty list/dict is not)."""
    return value is not None and bool(value)


def _payload_count(value: Any) -> int:
    return len(value) if isinstance(value, (list, dict)) else 1


# ---------------------------------------------------------------------------
# prompts[]
# ---------------------------------------------------------------------------


def _normalize_prompt(raw: Any, index: int, warnings: list[str]) -> PresetPrompt | None:
    """One pool entry, tolerantly. ``None`` (skip it, with a warning) only when the entry is
    not an object or has no usable identifier — everything else degrades to its ST default."""
    if not isinstance(raw, dict):
        warnings.append(f"prompts[{index}] is not an object — skipped")  # i18n-exempt: author diagnostic, wrapped by the command layer
        return None
    identifier = _identifier(raw.get("identifier"))
    if identifier is None:
        warnings.append(f"prompts[{index}] has no usable identifier — skipped")  # i18n-exempt: author diagnostic, wrapped by the command layer
        return None

    marker = _as_bool(raw.get("marker"), False)
    slot = identifier if marker and identifier in MARKER_SLOTS else None
    if marker and slot is None:
        warnings.append(f"marker {identifier!r} is not one of the 8 standard slots — kept as an unfillable anchor")  # i18n-exempt: author diagnostic, wrapped by the command layer

    content = _as_text(raw.get("content"))
    if marker:
        # An anchor's payload must never reach the model as prompt text (iron rule: the
        # runtime owns what goes in a slot), so it is dropped here, not at fold time.
        if content.strip():
            warnings.append(f"marker {identifier!r} carried content — treated as an anchor, content ignored")  # i18n-exempt: author diagnostic, wrapped by the command layer
        content = ""
    elif len(content) > MAX_PROMPT_CONTENT_CHARS:
        warnings.append(f"prompt {identifier!r} exceeds the {MAX_PROMPT_CONTENT_CHARS}-char content cap — truncated")  # i18n-exempt: author diagnostic, wrapped by the command layer
        content = content[:MAX_PROMPT_CONTENT_CHARS]

    role = raw.get("role")
    if role not in ROLES:
        if role is not None:
            warnings.append(f"prompt {identifier!r} has an unknown role {role!r} — treated as {DEFAULT_ROLE!r}")  # i18n-exempt: author diagnostic, wrapped by the command layer
        role = DEFAULT_ROLE

    depth = _as_int(raw.get("injection_depth"), DEFAULT_INJECTION_DEPTH)
    return PresetPrompt(
        identifier=identifier,
        name=_as_text(raw.get("name"))[:MAX_PROMPT_NAME_CHARS],
        content=content,
        role=role,
        enabled=_as_bool(raw.get("enabled"), True),
        marker=marker,
        slot=slot,
        system_prompt=_as_bool(raw.get("system_prompt"), False),
        injection_position=1 if _as_int(raw.get("injection_position"), 0) == 1 else 0,
        injection_depth=depth if depth >= 0 else DEFAULT_INJECTION_DEPTH,
        injection_order=_optional_int(raw.get("injection_order")),
    )


def _normalize_prompts(raw: list[Any], warnings: list[str]) -> tuple[PresetPrompt, ...]:
    prompts: list[PresetPrompt] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        prompt = _normalize_prompt(entry, index, warnings)
        if prompt is None:
            continue
        if prompt.identifier in seen:
            warnings.append(f"prompts carries a duplicate identifier {prompt.identifier!r} — the first one wins")  # i18n-exempt: author diagnostic, wrapped by the command layer
            continue
        seen.add(prompt.identifier)
        prompts.append(prompt)
    return tuple(prompts)


# ---------------------------------------------------------------------------
# prompt_order[]
# ---------------------------------------------------------------------------


def _normalize_order_groups(
    raw: Any, known: frozenset[str], warnings: list[str]
) -> tuple[PresetOrderGroup, ...]:
    if raw is None:
        warnings.append("preset has no prompt_order — the order list IS the sequence, so nothing is effective")  # i18n-exempt: author diagnostic, wrapped by the command layer
        return ()
    if not isinstance(raw, list):
        warnings.append("prompt_order is not an array — ignored, so nothing is effective")  # i18n-exempt: author diagnostic, wrapped by the command layer
        return ()

    groups: list[PresetOrderGroup] = []
    reported: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            warnings.append(f"prompt_order[{index}] is not an object — skipped")  # i18n-exempt: author diagnostic, wrapped by the command layer
            continue
        raw_refs = item.get("order")
        if raw_refs is not None and not isinstance(raw_refs, list):
            warnings.append(f"prompt_order[{index}].order is not an array — treated as empty")  # i18n-exempt: author diagnostic, wrapped by the command layer
        refs: list[tuple[str, bool]] = []
        for raw_ref in raw_refs if isinstance(raw_refs, list) else []:
            if not isinstance(raw_ref, dict):
                continue
            identifier = _identifier(raw_ref.get("identifier"))
            if identifier is None:
                continue
            if identifier not in known and identifier not in reported:
                reported.add(identifier)
                warnings.append(f"prompt_order references {identifier!r}, which no prompt declares — skipped")  # i18n-exempt: author diagnostic, wrapped by the command layer
            refs.append((identifier, _as_bool(raw_ref.get("enabled"), True)))
        groups.append(PresetOrderGroup(character_id=_character_id(item.get("character_id")), refs=tuple(refs)))
    if not groups:
        warnings.append("prompt_order holds no usable group — nothing is effective")  # i18n-exempt: author diagnostic, wrapped by the command layer
    return tuple(groups)


# ---------------------------------------------------------------------------
# Top level
# ---------------------------------------------------------------------------


def _extract_sampling(top: dict[str, Any], warnings: list[str]) -> tuple[dict[str, float | int], set[str]]:
    """The sampler knobs the file carried, normalized. A present-but-unusable value is left
    unconsumed (so it still shows up in ``unknown_top_level``) and warned about."""
    sampling: dict[str, float | int] = {}
    consumed: set[str] = set()
    for st_key, our_key in SAMPLING_KEYS.items():
        if st_key not in top:
            continue
        value = top[st_key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            warnings.append(f"sampling field {st_key!r} is not a finite number — ignored")  # i18n-exempt: author diagnostic, wrapped by the command layer
            continue
        sampling[our_key] = value
        consumed.add(st_key)
    return sampling, consumed


def _extension_flags(top: dict[str, Any], warnings: list[str]) -> tuple[bool, bool, bool]:
    """``(has_regex_scripts, has_tavern_helper, consumed_extensions_key)``.

    ST ships whole regex-script suites and TavernHelper bundles in ``extensions``; they are
    reported as presence (with a count in the warning) and never stored or executed."""
    if "extensions" not in top:
        return False, False, True
    extensions = top["extensions"]
    if not isinstance(extensions, dict):
        warnings.append("extensions is not an object — ignored")  # i18n-exempt: author diagnostic, wrapped by the command layer
        return False, False, False

    has_regex = _is_present(extensions.get("regex_scripts"))
    has_helper = _is_present(extensions.get("tavern_helper"))
    if has_regex:
        count = _payload_count(extensions.get("regex_scripts"))
        warnings.append(f"preset ships {count} SillyTavern regex script(s) — recorded, never executed")  # i18n-exempt: author diagnostic, wrapped by the command layer
    if has_helper:
        warnings.append("preset ships TavernHelper machinery — recorded, never executed")  # i18n-exempt: author diagnostic, wrapped by the command layer
    return has_regex, has_helper, True


def parse_st_preset(text: str, fallback_name: str) -> StPreset:
    """Parse one SillyTavern completion-preset JSON document.

    Raises ``ValueError`` with an author-actionable message when the file is structurally
    unusable — not JSON, not a JSON object, over :data:`MAX_PRESET_BYTES`, no ``prompts``
    array (or an empty one), more than :data:`MAX_PROMPTS` entries. Everything recoverable
    below that degrades into ``preset.warnings``: a broken entry is skipped, an odd field
    falls back to its ST default, an oversized prompt is truncated.

    ``fallback_name`` names the preset (ST keeps the name in the filename, not the file); a
    top-level ``name`` key, if any, is left in ``unknown_top_level`` rather than trusted.
    """
    if len(text.encode("utf-8")) > MAX_PRESET_BYTES:
        raise ValueError(f"preset JSON exceeds the {MAX_PRESET_BYTES}-byte cap")  # i18n-exempt: author diagnostic, wrapped by the command layer
    try:
        data = json.loads(text)
    except (ValueError, RecursionError) as exc:
        raise ValueError(f"preset is not valid JSON: {exc}") from exc  # i18n-exempt: author diagnostic, wrapped by the command layer
    if not isinstance(data, dict):
        raise ValueError("preset root must be a JSON object (a SillyTavern completion preset)")  # i18n-exempt: author diagnostic, wrapped by the command layer

    raw_prompts = data.get("prompts")
    if not isinstance(raw_prompts, list):
        raise ValueError("preset has no `prompts` array — this is not a SillyTavern completion preset")  # i18n-exempt: author diagnostic, wrapped by the command layer
    if not raw_prompts:
        raise ValueError("preset `prompts` is empty — there is no prompt text to fold")  # i18n-exempt: author diagnostic, wrapped by the command layer
    if len(raw_prompts) > MAX_PROMPTS:
        raise ValueError(f"preset `prompts` holds more than {MAX_PROMPTS} entries")  # i18n-exempt: author diagnostic, wrapped by the command layer

    warnings: list[str] = []
    prompts = _normalize_prompts(raw_prompts, warnings)
    order = _normalize_order_groups(data.get("prompt_order"), frozenset(p.identifier for p in prompts), warnings)
    sampling, consumed = _extract_sampling(data, warnings)
    has_regex, has_helper, consumed_extensions = _extension_flags(data, warnings)

    unknown = tuple(
        key
        for key in data
        if key not in consumed and (key not in _STRUCTURAL_KEYS or (key == "extensions" and not consumed_extensions))
    )

    preset = StPreset(
        name=str(fallback_name).strip(),
        sampling=sampling,
        prompts=prompts,
        order=order,
        unknown_top_level=unknown,
        has_regex_scripts=has_regex,
        has_tavern_helper=has_helper,
        warnings=tuple(warnings),
    )
    # The fold cap is checked here, for the DEFAULT group, so the truncation shows up in
    # `warnings` alongside everything else (`style_segments` itself stays pure).
    if _fold_segments(preset, None)[1]:
        warnings.append(f"folded preset text exceeds the {MAX_STYLE_CHARS}-char cap — later prompts are dropped")  # i18n-exempt: author diagnostic, wrapped by the command layer
        preset = replace(preset, warnings=tuple(warnings))
    return preset


# ---------------------------------------------------------------------------
# The dual enable matrix
# ---------------------------------------------------------------------------


def resolve_order_group(preset: StPreset, character_id: int | None = None) -> PresetOrderGroup | None:
    """The order list ST itself would use.

    An explicit ``character_id`` wins when the file has that group (upstream's per-character
    override); otherwise the global pseudo-characters in
    :data:`GLOBAL_ORDER_CHARACTER_IDS` order, then the first group present. Real exports
    keep a stale 100000 group ahead of the live 100001 one, so plain "first wins" would pick
    the wrong sequence; an unknown explicit id falls back the same way ST falls back to the
    global list. ``None`` only when the file declared no usable group at all.
    """
    if not preset.order:
        return None
    if character_id is not None:
        for group in preset.order:
            if group.character_id == character_id:
                return group
    for wanted in GLOBAL_ORDER_CHARACTER_IDS:
        for group in preset.order:
            if group.character_id == wanted:
                return group
    return preset.order[0]


def effective_prompts(preset: StPreset, character_id: int | None = None) -> tuple[PresetPrompt, ...]:
    """The prompts that actually run, in the resolved order list's sequence.

    Both enable layers must agree: ``prompts[].enabled`` AND the order ref's ``enabled``.
    **Entries absent from the chosen order group are dropped entirely** — the order list is
    the sequence, so a pool entry it never mentions has no position and is inert (upstream
    ST behavior; the studio mirror surfaces the same entries with ``position: null`` /
    ``effective: false`` because it renders an inspector, and this is the fold path). The
    first ref for an identifier decides; a later duplicate ref cannot resurrect it. Refs to
    identifiers no prompt declares are skipped (already warned about at parse time).
    """
    group = resolve_order_group(preset, character_id)
    if group is None:
        return ()
    pool: dict[str, PresetPrompt] = {}
    for prompt in preset.prompts:
        pool.setdefault(prompt.identifier, prompt)
    live: list[PresetPrompt] = []
    placed: set[str] = set()
    for identifier, order_enabled in group.refs:
        entry = pool.get(identifier)
        if entry is None or identifier in placed:
            continue
        placed.add(identifier)
        if entry.enabled and order_enabled:
            live.append(entry)
    return tuple(live)


# ---------------------------------------------------------------------------
# Macros — counted, never expanded
# ---------------------------------------------------------------------------


def _macro_name(body: str) -> str:
    """``{{getvar::x}}`` → ``getvar``, ``{{roll:1d6}}`` → ``roll``, ``{{// note}}`` → ``//``.

    The token before the first ``::`` (then before a single ``:``, the older argument form),
    lowercased — the studio mirror's rule, verbatim."""
    trimmed = body.strip()
    if trimmed.startswith("//"):
        return "//"
    return trimmed.split("::", 1)[0].split(":", 1)[0].strip().lower()


def macro_report(preset: StPreset, character_id: int | None = None) -> dict[str, int]:
    """Count ``{{macro}}`` uses across the EFFECTIVE prompts' content, by macro name.

    Content rides to the model verbatim — nothing here expands a macro — so this is a
    capability report: it tells the keeper which ST macros a preset leans on before the
    engine grows real expansion for them. Markers contribute nothing (their content is
    empty by construction), and so do disabled or unordered prompts. Ordered by count
    descending, then name, so the display order is deterministic.
    """
    counts: dict[str, int] = {}
    for prompt in effective_prompts(preset, character_id):
        if prompt.marker:
            continue
        for match in _MACRO_RE.finditer(prompt.content):
            name = _macro_name(match.group(1))
            if not name:
                continue
            counts[name] = counts.get(name, 0) + 1
    return {name: count for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))}


# ---------------------------------------------------------------------------
# Folding — the prompt builder's input
# ---------------------------------------------------------------------------


def _fold_segments(
    preset: StPreset, character_id: int | None
) -> tuple[tuple[tuple[str | None, str], ...], bool]:
    """``(segments, truncated)`` — see :func:`style_segments`."""
    segments: list[tuple[str | None, str]] = []
    buffer: list[str] = []
    used = 0
    truncated = False
    exhausted = False

    def flush() -> None:
        nonlocal buffer
        if buffer:
            segments.append((None, "\n\n".join(buffer)))
            buffer = []

    for prompt in effective_prompts(preset, character_id):
        if prompt.marker:
            # An unfillable anchor (marker outside the 8) is no boundary at all: it is
            # dropped so the text around it stays one segment.
            if prompt.slot is None:
                continue
            flush()
            segments.append((prompt.slot, ""))
            continue
        if exhausted:
            continue
        content = prompt.content.strip()
        if not content:
            continue
        cost = len(content) + (2 if buffer else 0)  # the "\n\n" that will join it
        if used + cost > MAX_STYLE_CHARS:
            # Never cut a prompt in half, and never reorder around the cut: stop taking
            # text here. Marker boundaries keep flowing — they cost nothing and the builder
            # still needs the skeleton (chat history, world info) intact.
            truncated = True
            exhausted = True
            continue
        used += cost
        buffer.append(content)
    flush()
    return tuple(segments), truncated


STYLE_BANDS: tuple[str, ...] = ("head", "pre_lore", "post_lore", "post_history")

# Which band a marker moves the walk into. The walk is MONOTONIC — bands only move
# forward — so a preset with markers in an odd order (worldInfoAfter before
# worldInfoBefore, repeated markers) still folds deterministically instead of
# bouncing text backwards. Only three ST anchors have an honest Loreweaver
# counterpart (owner verdict 2026-08-15: four bands, no fake 8-way mapping; play
# experience outranks ST-compat fidelity): everything up to the world-info block,
# the text after it, and the post-history slot. The other five markers merely mean
# "the author's context section has started" and advance the walk to `pre_lore`.
_MARKER_BAND: dict[str, int] = {
    "personaDescription": 1,
    "charDescription": 1,
    "charPersonality": 1,
    "scenario": 1,
    "dialogueExamples": 1,
    "worldInfoBefore": 1,
    "worldInfoAfter": 2,
    "chatHistory": 3,
}


def style_bands(preset: StPreset, character_id: int | None = None) -> dict[str, str]:
    """The four-band fold for ``agent.prompt_builder`` (the finer marker→section
    contract, v1 of the single-fold policy):

    - ``head`` — text before any marker: global style/identity directives. The prompt
      builder keeps these in the stable head, exactly where the v0 fold put everything.
    - ``pre_lore`` — text between the first marker and ``worldInfoAfter``: the framing
      an author wrote around their context/world-info block; lands directly before the
      world-lore section.
    - ``post_lore`` — text after ``worldInfoAfter`` but before ``chatHistory``; lands
      directly after the world-lore section.
    - ``post_history`` — text after the ``chatHistory`` marker, ST's position-critical
      slot; lands late in the volatile tail, the closest standing text to generation
      (the tail rides the wire AFTER the replayed history, so the geometry is real).

    A preset with no markers folds entirely into ``head`` — byte-identical to the v0
    behavior. Size is already capped upstream by :func:`style_segments`.
    """
    texts: dict[str, list[str]] = {band: [] for band in STYLE_BANDS}
    band_index = 0
    for slot, text in style_segments(preset, character_id):
        if slot is not None:
            band_index = max(band_index, _MARKER_BAND.get(slot, 1))
            continue
        if text:
            texts[STYLE_BANDS[band_index]].append(text)
    return {band: "\n\n".join(parts) for band, parts in texts.items()}


def style_segments(preset: StPreset, character_id: int | None = None) -> tuple[tuple[str | None, str], ...]:
    """The folding input for ``agent.prompt_builder``: the effective sequence collapsed into
    ``(marker_slot_or_None, text)`` segments.

    Consecutive non-marker prompts join with ``"\\n\\n"`` into one ``(None, text)`` segment;
    each fillable marker emits a ``(slot, "")`` boundary the builder replaces with its own
    context (markers never contribute text). Blank prompts and unfillable markers are
    dropped rather than emitted as empty segments.

    Total text is capped at :data:`MAX_STYLE_CHARS`, truncated at a prompt boundary — never
    mid-prompt and never reordered: once the budget would be exceeded, that prompt and every
    later one are dropped, while marker boundaries keep flowing. When the DEFAULT group
    truncates, :func:`parse_st_preset` has already recorded it in ``preset.warnings``.
    """
    return _fold_segments(preset, character_id)[0]
