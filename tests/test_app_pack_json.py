"""`--pack --json` machine output: exactly one JSON object on stdout, humans on stderr."""

from __future__ import annotations

import json

import app


def _write_minimal_pack(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "lorebooks").mkdir()
    (src / "lorebooks" / "tiny.json").write_text(
        json.dumps({"entries": [{"comment": "hello", "content": "world", "keys": ["hi"]}]}),
        encoding="utf-8",
    )
    (src / "pack.yaml").write_text(
        "\n".join(
            [
                "id: json-cli-test",
                "version: 0.0.1",
                "name: JSON CLI test",
                "description: fixture",
                "authors: [test]",
                "license: MIT",
                "contents:",
                "  lorebooks: [lorebooks/tiny.json]",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return src


def test_pack_json_success_emits_single_object_on_stdout(tmp_path, capsys):
    src = _write_minimal_pack(tmp_path)
    out_file = tmp_path / "built.lwpack"
    code = app.main(["--pack", str(src), "--out", str(out_file), "--json"])
    captured = capsys.readouterr()
    assert code == 0
    payload = json.loads(captured.out)  # exactly one object, nothing else on stdout
    assert payload["ok"] is True
    assert payload["id"] == "json-cli-test"
    assert payload["version"] == "0.0.1"
    assert payload["path"] == str(out_file)
    assert len(payload["sha256"]) == 64
    assert payload["trust"]["lorebooks"] == 1
    assert payload["trust"]["has_hooks"] is False
    assert captured.err  # the human lines (done + trust card) stay on stderr


def test_pack_json_failure_emits_error_object_and_exit_1(tmp_path, capsys):
    src = tmp_path / "broken"
    src.mkdir()
    (src / "pack.yaml").write_text("id: [not a slug\n", encoding="utf-8")
    code = app.main(["--pack", str(src), "--json"])
    captured = capsys.readouterr()
    assert code == 1
    payload = json.loads(captured.out)
    assert payload["ok"] is False
    assert payload["error"]


def test_pack_without_json_keeps_stdout_empty(tmp_path, capsys):
    src = _write_minimal_pack(tmp_path)
    code = app.main(["--pack", str(src), "--out", str(tmp_path / "b.lwpack")])
    captured = capsys.readouterr()
    assert code == 0
    assert captured.out == ""
