"""Confinement tests for `LocalFs.get_file`.

The production Iroh transport wires `SessionCore` to `LocalFs(cwd)`, so
`get_file` is the boundary that keeps `.import` / `upload_document` from
becoming an arbitrary host-file read. These tests pin that boundary: legit
relative and in-base absolute paths still resolve; anything that escapes the
base directory (absolute outside, `../` traversal, symlink-out) is rejected.
"""

from __future__ import annotations

import pytest

from agent.context import LocalFs


def test_relative_path_inside_base_resolves(tmp_path):
    (tmp_path / "card.png").write_bytes(b"x")
    fs = LocalFs(tmp_path)
    assert fs.get_file("card.png") == str((tmp_path / "card.png").resolve())


def test_absolute_path_inside_base_resolves(tmp_path):
    inside = tmp_path / "sub" / "card.json"
    inside.parent.mkdir(parents=True)
    inside.write_text("{}")
    fs = LocalFs(tmp_path)
    assert fs.get_file(str(inside)) == str(inside.resolve())


def test_absolute_path_outside_base_is_rejected(tmp_path):
    fs = LocalFs(tmp_path)
    # The old behaviour returned this verbatim -> arbitrary host-file read.
    with pytest.raises(ValueError, match="escapes the allowed base directory"):
        fs.get_file("/etc/passwd")


def test_dotdot_traversal_is_rejected(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    (tmp_path / "secret.txt").write_text("top secret")
    fs = LocalFs(base)
    with pytest.raises(ValueError, match="escapes the allowed base directory"):
        fs.get_file("../secret.txt")


def test_symlink_escaping_base_is_rejected(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("top secret")
    link = base / "link.txt"
    link.symlink_to(outside)
    fs = LocalFs(base)
    with pytest.raises(ValueError, match="escapes the allowed base directory"):
        fs.get_file("link.txt")


def test_base_directory_itself_is_allowed(tmp_path):
    fs = LocalFs(tmp_path)
    assert fs.get_file(".") == str(tmp_path.resolve())
