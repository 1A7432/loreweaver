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


def build_svg_map(title: str, areas_json: str, *, layout: str = "hierarchy") -> tuple[str, str]:
    """Build a safe SVG map from a JSON area list.

    ``areas_json`` accepts either ``[{...}]`` or ``{"areas":[...]}``. Each area
    may contain ``id``, ``name``, ``parent``, ``description``/``notes``, and
    ``links``. The output uses only the SVG subset accepted by ``infra.svg``.
    """
    parsed_title, areas = parse_map_areas(title, areas_json)
    if not areas:
        areas = (MapArea(id="start", name="Scene"),)
    layout_key = layout.strip().casefold()
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
            )
        )
    return parsed_title or "Map", tuple(areas)


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


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else f"{value[: max(0, limit - 1)]}..."


def _slug(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_-]+", "-", value.strip().lower()).strip("-_")
    return text or "area"
