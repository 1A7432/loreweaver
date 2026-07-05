import json
import re

from core.svg_map import build_svg_map
from infra.svg import validate_svg_bytes


def test_build_svg_map_generates_safe_labeled_svg():
    name, svg = build_svg_map(
        "Old Chapel",
        json.dumps(
            [
                {"id": "chapel", "name": "Chapel", "description": "upper nave"},
                {"id": "crypt", "name": "Crypt", "parent": "chapel", "description": "cold stairs"},
            ]
        ),
    )

    assert name == "old-chapel.svg"
    assert "Old Chapel" in svg
    assert "Crypt" in svg
    assert validate_svg_bytes(svg.encode("utf-8"))


def test_spatial_map_uses_pos_for_relative_north_south():
    _, svg = build_svg_map(
        "Cellar",
        json.dumps(
            [
                {"id": "north", "name": "North Room", "pos": [4, 1], "size": [2, 1]},
                {"id": "south", "name": "South Room", "pos": [4, 6], "size": [2, 1]},
            ]
        ),
        layout="spatial",
    )

    north, south = _area_rects(svg)
    assert north["y"] < south["y"]
    assert validate_svg_bytes(svg.encode("utf-8"))


def test_spatial_map_moves_colliding_boxes_to_free_slot():
    _, svg = build_svg_map(
        "Collision",
        json.dumps(
            [
                {"id": "a", "name": "A", "pos": [1, 1], "size": [2, 1]},
                {"id": "b", "name": "B", "pos": [1, 1], "size": [2, 1]},
            ]
        ),
        layout="spatial",
    )

    first, second = _area_rects(svg)
    assert not _overlap(first, second)


def test_spatial_map_without_any_pos_falls_back_to_hierarchy():
    payload = json.dumps(
        [
            {"id": "root", "name": "Root"},
            {"id": "child", "name": "Child", "parent": "root"},
        ]
    )
    assert build_svg_map("Fallback", payload, layout="spatial")[1] == build_svg_map("Fallback", payload)[1]


def test_spatial_map_appends_missing_pos_after_positioned_rows():
    _, svg = build_svg_map(
        "Append",
        json.dumps(
            [
                {"id": "placed", "name": "Placed", "pos": [2, 1], "size": [2, 1]},
                {"id": "auto", "name": "Auto"},
            ]
        ),
        layout="spatial",
    )

    placed, auto = _area_rects(svg)
    assert auto["y"] > placed["y"]


def test_spatial_map_clamps_out_of_range_hints():
    _, svg = build_svg_map(
        "Clamp",
        json.dumps([{"id": "far", "name": "Far", "pos": [99, -5], "size": [99, 99]}]),
        layout="spatial",
    )

    (rect,) = _area_rects(svg)
    assert 0 <= rect["x"] <= 960
    assert 0 <= rect["y"]
    assert rect["x"] + rect["width"] <= 960
    assert rect["width"] <= 430
    assert validate_svg_bytes(svg.encode("utf-8"))


def _area_rects(svg: str) -> list[dict[str, float]]:
    rects: list[dict[str, float]] = []
    pattern = re.compile(
        r'<rect x="(?P<x>[-\d.]+)" y="(?P<y>[-\d.]+)" width="(?P<width>[-\d.]+)" '
        r'height="(?P<height>[-\d.]+)".*?stroke="#2d3340"',
    )
    for match in pattern.finditer(svg):
        rects.append({key: float(value) for key, value in match.groupdict().items()})
    return rects


def _overlap(a: dict[str, float], b: dict[str, float]) -> bool:
    return not (
        a["x"] + a["width"] <= b["x"]
        or b["x"] + b["width"] <= a["x"]
        or a["y"] + a["height"] <= b["y"]
        or b["y"] + b["height"] <= a["y"]
    )
