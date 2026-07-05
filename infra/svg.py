"""Safety checks for SVG media.

SVG is text, not an inert bitmap. The media server still stores blobs opaquely
for normal images/audio, but SVG needs a small allowlist so a shared room cannot
smuggle scriptable browser content as a handout.
"""

from __future__ import annotations

import re
from xml.etree import ElementTree

SVG_MIME = "image/svg+xml"

_MAX_SVG_CHARS = 200_000
_MAX_SVG_ELEMENTS = 800
_ALLOWED_TAGS = {"svg", "g", "title", "desc", "rect", "line", "polyline", "text", "tspan"}
_ALLOWED_ATTRS = {
    "aria-label",
    "class",
    "dominant-baseline",
    "fill",
    "font-family",
    "font-size",
    "font-weight",
    "height",
    "id",
    "points",
    "role",
    "rx",
    "ry",
    "stroke",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-width",
    "text-anchor",
    "viewBox",
    "width",
    "x",
    "x1",
    "x2",
    "y",
    "y1",
    "y2",
}
_FORBIDDEN_RAW = re.compile(
    r"<!doctype|<\?xml-stylesheet|<script\b|<foreignobject\b|<image\b|<iframe\b|<object\b|<embed\b",
    re.I,
)
_FORBIDDEN_VALUE = re.compile(r"javascript:|data:|https?:|url\s*\(|expression\s*\(", re.I)


class SvgSafetyError(ValueError):
    """Raised when SVG bytes fall outside Loreweaver's safe handout subset."""


def validate_svg_bytes(data: bytes) -> str:
    """Return decoded SVG text if it is within the safe subset, else raise."""
    if len(data) > _MAX_SVG_CHARS:
        raise SvgSafetyError("media_bad_svg")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SvgSafetyError("media_bad_svg") from exc
    stripped = text.strip()
    if not stripped or "<svg" not in stripped[:512].lower() or _FORBIDDEN_RAW.search(stripped):
        raise SvgSafetyError("media_bad_svg")
    try:
        root = ElementTree.fromstring(stripped)
    except ElementTree.ParseError as exc:
        raise SvgSafetyError("media_bad_svg") from exc
    if _local_name(root.tag) != "svg":
        raise SvgSafetyError("media_bad_svg")

    count = 0
    for element in root.iter():
        count += 1
        if count > _MAX_SVG_ELEMENTS:
            raise SvgSafetyError("media_bad_svg")
        if _local_name(element.tag) not in _ALLOWED_TAGS:
            raise SvgSafetyError("media_bad_svg")
        for raw_name, raw_value in element.attrib.items():
            name = _local_name(raw_name)
            value = str(raw_value or "")
            if name.casefold().startswith("on") or name not in _ALLOWED_ATTRS or _FORBIDDEN_VALUE.search(value):
                raise SvgSafetyError("media_bad_svg")
    return stripped


def _local_name(name: str) -> str:
    if "}" in name:
        return name.rsplit("}", 1)[1]
    return name
