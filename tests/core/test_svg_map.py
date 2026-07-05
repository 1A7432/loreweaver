import json

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
