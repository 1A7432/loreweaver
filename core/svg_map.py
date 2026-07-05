"""Deterministic SVG map/layout generation for player handouts."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from html import escape
from typing import Any

_MAX_AREAS = 32
_MAX_LINKS = 80
_CANVAS_WIDTH = 960
_TOP = 92
_ROW_HEIGHT = 150
_BOX_HEIGHT = 86
_MARGIN_X = 56


@dataclass(frozen=True)
class MapArea:
    id: str
    name: str
    parent: str = ""
    description: str = ""
    links: tuple[str, ...] = field(default_factory=tuple)
    pos: tuple[float, float] | None = None
    size: tuple[float, float] | None = None


def build_svg_map(title: str, areas_json: str, *, layout: str = "hierarchy") -> tuple[str, str]:
    """Build a safe SVG map from a JSON area list.

    ``areas_json`` accepts either ``[{...}]`` or ``{"areas":[...]}``. Each area
    may contain ``id``, ``name``, ``parent``, ``description``/``notes``,
    ``links``, and for ``layout="spatial"`` rough ``pos``/``size`` hints. The
    output uses only the SVG subset accepted by ``infra.svg``.
    """
    parsed_title, areas = parse_map_areas(title, areas_json)
    if not areas:
        areas = (MapArea(id="start", name="Scene"),)
    layout_key = layout.strip().casefold()
    if layout_key == "spatial" and any(area.pos is not None for area in areas):
        return (_slug(parsed_title or "map") + ".svg", _build_spatial_svg(parsed_title, areas))
    return (
        _slug(parsed_title or "map") + ".svg",
        _build_grid_svg(parsed_title, areas) if layout_key in {"grid", "floor", "rooms"} else _build_hierarchy_svg(parsed_title, areas),
    )


def parse_map_areas(title: str, areas_json: str) -> tuple[str, tuple[MapArea, ...]]:
    try:
        payload = json.loads(areas_json)
    except (json.JSONDecodeError, TypeError, ValueError):
        payload = []
    parsed_title = str(title or "").strip()
    if isinstance(payload, dict):
        parsed_title = str(payload.get("title") or parsed_title).strip()
        raw_areas = payload.get("areas") or []
    else:
        raw_areas = payload
    if not isinstance(raw_areas, list):
        raw_areas = []

    areas: list[MapArea] = []
    used: set[str] = set()
    for index, item in enumerate(raw_areas[:_MAX_AREAS]):
        if not isinstance(item, dict):
            continue
        name = _clean(item.get("name") or item.get("label") or item.get("id") or f"Area {index + 1}", 80)
        area_id = _slug(str(item.get("id") or name or f"area-{index + 1}"))
        while area_id in used:
            area_id = f"{area_id}-{index + 1}"
        used.add(area_id)
        links_value = item.get("links") or item.get("connects") or []
        links = tuple(_slug(str(link)) for link in links_value[:12]) if isinstance(links_value, list) else ()
        areas.append(
            MapArea(
                id=area_id,
                name=name,
                parent=_slug(str(item.get("parent") or "")),
                description=_clean(item.get("description") or item.get("notes") or item.get("type") or "", 96),
                links=links,
                pos=_parse_pair(item.get("pos"), minimum=0.0, maximum=11.0),
                size=_parse_pair(item.get("size"), minimum=1.0, maximum=6.0),
            )
        )
    return parsed_title or "Map", tuple(areas)


def _build_spatial_svg(title: str, areas: tuple[MapArea, ...]) -> str:
    slots = _spatial_slots(areas)
    if not slots:
        return _build_hierarchy_svg(title, areas)
    max_bottom = max(slot[1] + slot[3] for slot in slots.values())
    height = _TOP + max_bottom * 116 + 64
    positions: dict[str, tuple[float, float, float, float]] = {}
    for area in areas:
        gx, gy, gw, gh = slots[area.id]
        positions[area.id] = (
            _MARGIN_X + gx * _spatial_unit_x() + 4,
            _TOP + gy * 116 + 4,
            max(48.0, gw * _spatial_unit_x() - 8),
            max(_BOX_HEIGHT, gh * _BOX_HEIGHT + (gh - 1) * 22),
        )
    lines = [_svg_header(title, height)]
    lines.extend(_connection_lines(areas, positions))
    for index, area in enumerate(areas):
        lines.extend(_area_rect(area, positions[area.id], index))
    lines.append("</svg>")
    return "\n".join(lines)


def _spatial_slots(areas: tuple[MapArea, ...]) -> dict[str, tuple[int, int, int, int]]:
    slots: dict[str, tuple[int, int, int, int]] = {}
    occupied: set[tuple[int, int]] = set()
    for area in areas:
        if area.pos is None:
            continue
        desired = _snapped_slot(area)
        placed = _nearest_free_slot(desired, occupied)
        slots[area.id] = placed
        _occupy(occupied, placed)

    if not slots:
        return {}

    append_y = max(y + h for _, y, _, h in slots.values()) + 1
    cursor_x = 0
    cursor_y = append_y
    for area in areas:
        if area.id in slots:
            continue
        width, height = _snapped_size(area)
        if cursor_x + width > 12:
            cursor_x = 0
            cursor_y += 2
        placed = _nearest_free_slot((cursor_x, cursor_y, width, height), occupied, min_y=append_y)
        slots[area.id] = placed
        _occupy(occupied, placed)
        cursor_x = placed[0] + width + 1
        cursor_y = max(cursor_y, placed[1])
    return slots


def _snapped_slot(area: MapArea) -> tuple[int, int, int, int]:
    width, height = _snapped_size(area)
    assert area.pos is not None
    gx = _clamp_int(round(area.pos[0]), 0, max(0, 12 - width))
    gy = _clamp_int(round(area.pos[1]), 0, 11)
    return gx, gy, width, height


def _snapped_size(area: MapArea) -> tuple[int, int]:
    if area.size is None:
        return 2, 1
    width = _clamp_int(round(area.size[0]), 1, 6)
    height = _clamp_int(round(area.size[1]), 1, 6)
    return width, height


def _nearest_free_slot(
    desired: tuple[int, int, int, int],
    occupied: set[tuple[int, int]],
    *,
    min_y: int = 0,
) -> tuple[int, int, int, int]:
    dx, dy, width, height = desired
    best: tuple[int, int, int, int] | None = None
    best_key: tuple[int, int, int] | None = None
    for y in range(min_y, 48):
        for x in range(0, max(1, 12 - width + 1)):
            candidate = (x, y, width, height)
            if _slot_overlaps(candidate, occupied):
                continue
            key = (abs(x - dx) + abs(y - dy), y, x)
            if best_key is None or key < best_key:
                best_key = key
                best = candidate
    return best if best is not None else (0, max(min_y, dy), width, height)


def _slot_overlaps(slot: tuple[int, int, int, int], occupied: set[tuple[int, int]]) -> bool:
    x, y, width, height = slot
    return any((col, row) in occupied for row in range(y, y + height) for col in range(x, x + width))


def _occupy(occupied: set[tuple[int, int]], slot: tuple[int, int, int, int]) -> None:
    x, y, width, height = slot
    for row in range(y, y + height):
        for col in range(x, x + width):
            occupied.add((col, row))


def _spatial_unit_x() -> float:
    return (_CANVAS_WIDTH - 2 * _MARGIN_X) / 12


def _build_hierarchy_svg(title: str, areas: tuple[MapArea, ...]) -> str:
    area_by_id = {area.id: area for area in areas}
    levels: dict[int, list[MapArea]] = {}
    for area in areas:
        depth = _depth(area, area_by_id)
        levels.setdefault(depth, []).append(area)
    max_depth = max(levels) if levels else 0
    height = _TOP + (max_depth + 1) * _ROW_HEIGHT + 64
    positions: dict[str, tuple[float, float, float, float]] = {}
    for depth, row in levels.items():
        gap = 24
        box_width = min(220, max(140, (_CANVAS_WIDTH - 2 * _MARGIN_X - gap * (len(row) - 1)) / max(1, len(row))))
        total = box_width * len(row) + gap * max(0, len(row) - 1)
        x = (_CANVAS_WIDTH - total) / 2
        y = _TOP + depth * _ROW_HEIGHT
        for area in row:
            positions[area.id] = (x, y, box_width, _BOX_HEIGHT)
            x += box_width + gap
    lines = [_svg_header(title, height)]
    lines.extend(_connection_lines(areas, positions))
    for depth in sorted(levels):
        for area in levels[depth]:
            lines.extend(_area_rect(area, positions[area.id], depth))
    lines.append("</svg>")
    return "\n".join(lines)


def _build_grid_svg(title: str, areas: tuple[MapArea, ...]) -> str:
    columns = min(4, max(1, math.ceil(math.sqrt(len(areas)))))
    rows = math.ceil(len(areas) / columns)
    gap = 24
    box_width = (_CANVAS_WIDTH - 2 * _MARGIN_X - gap * (columns - 1)) / columns
    height = _TOP + rows * (_BOX_HEIGHT + gap) + 64
    positions: dict[str, tuple[float, float, float, float]] = {}
    for index, area in enumerate(areas):
        col = index % columns
        row = index // columns
        positions[area.id] = (_MARGIN_X + col * (box_width + gap), _TOP + row * (_BOX_HEIGHT + gap), box_width, _BOX_HEIGHT)
    lines = [_svg_header(title, height)]
    lines.extend(_connection_lines(areas, positions))
    for area in areas:
        lines.extend(_area_rect(area, positions[area.id], 1))
    lines.append("</svg>")
    return "\n".join(lines)


def _connection_lines(areas: tuple[MapArea, ...], positions: dict[str, tuple[float, float, float, float]]) -> list[str]:
    out: list[str] = []
    emitted: set[tuple[str, str]] = set()
    for area in areas:
        targets = [area.parent, *area.links]
        for target in targets:
            if not target or target not in positions or area.id not in positions:
                continue
            key = tuple(sorted((area.id, target)))
            if key in emitted or len(emitted) >= _MAX_LINKS:
                continue
            emitted.add(key)
            x1, y1 = _center(positions[area.id])
            x2, y2 = _center(positions[target])
            out.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#8a8f98" stroke-width="3" stroke-linecap="round" />'  # i18n-exempt
            )
    return out


def _area_rect(area: MapArea, pos: tuple[float, float, float, float], depth: int) -> list[str]:
    x, y, width, height = pos
    fill = "#f7f3e8" if depth % 2 == 0 else "#e9f2ef"
    title = _truncate(area.name, 26)
    desc = _truncate(area.description, 34)
    lines = [
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{width:.1f}" height="{height:.1f}" rx="8" ry="8" fill="{fill}" stroke="#2d3340" stroke-width="3" />',
        f'<text x="{x + width / 2:.1f}" y="{y + 34:.1f}" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="700" fill="#111827">{escape(title)}</text>',  # i18n-exempt
    ]
    if desc:
        lines.append(
            f'<text x="{x + width / 2:.1f}" y="{y + 62:.1f}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#374151">{escape(desc)}</text>'  # i18n-exempt
        )
    return lines


def _svg_header(title: str, height: int) -> str:
    safe_title = escape(_truncate(title, 80))
    return "\n".join(
        [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{_CANVAS_WIDTH}" height="{height}" viewBox="0 0 {_CANVAS_WIDTH} {height}" role="img" aria-label="{safe_title}">',
            f"<title>{safe_title}</title>",
            '<rect x="0" y="0" width="960" height="' + str(height) + '" fill="#fbfaf6" />',
            f'<text x="480" y="42" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#111827">{safe_title}</text>',  # i18n-exempt
        ]
    )


def _depth(area: MapArea, area_by_id: dict[str, MapArea]) -> int:
    depth = 0
    seen = {area.id}
    parent = area.parent
    while parent and parent in area_by_id and parent not in seen and depth < 8:
        seen.add(parent)
        depth += 1
        parent = area_by_id[parent].parent
    return depth


def _center(pos: tuple[float, float, float, float]) -> tuple[float, float]:
    x, y, width, height = pos
    return x + width / 2, y + height / 2


def _clean(value: Any, limit: int) -> str:
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]+", "", str(value or "")).strip()
    return text[:limit]


def _parse_pair(value: Any, *, minimum: float, maximum: float) -> tuple[float, float] | None:
    if not isinstance(value, list | tuple) or len(value) != 2:
        return None
    try:
        x = float(value[0])
        y = float(value[1])
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return (max(minimum, min(maximum, x)), max(minimum, min(maximum, y)))


def _clamp_int(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, int(value)))


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else f"{value[: max(0, limit - 1)]}..."


def _slug(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_-]+", "-", value.strip().lower()).strip("-_")
    return text or "area"
