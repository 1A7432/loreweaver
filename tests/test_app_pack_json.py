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


# --- `--lint` and the lint riding `--pack` -----------------------------------


def _write_pack_with_a_dead_entry(tmp_path):
    """Valid for the build; one live entry has no keyword and is not always-on."""
    src = _write_minimal_pack(tmp_path)
    (src / "lorebooks" / "tiny.json").write_text(
        json.dumps({"entries": [{"comment": "Cellar", "keys": [], "content": "Damp."}]}), encoding="utf-8"
    )
    return src


def test_lint_json_lists_findings_and_exits_zero(tmp_path, capsys):
    src = _write_pack_with_a_dead_entry(tmp_path)
    code = app.main(["--lint", str(src), "--json"])
    captured = capsys.readouterr()
    assert code == 0  # the exit status says the lint RAN, never what it found
    payload = json.loads(captured.out)
    assert payload["ok"] is True
    assert [finding["code"] for finding in payload["findings"]] == ["lore-no-keys"]
    assert set(payload["findings"][0]) == {"code", "where", "message"}
    assert "lore-no-keys" in captured.err
    assert not list(tmp_path.rglob("*.lwpack"))  # a lint builds nothing


def test_lint_clean_pack_says_so(tmp_path, capsys):
    src = _write_minimal_pack(tmp_path)
    code = app.main(["--lint", str(src), "--json"])
    captured = capsys.readouterr()
    assert code == 0
    assert json.loads(captured.out) == {"ok": True, "findings": []}
    assert captured.err.strip()


def test_lint_without_a_manifest_is_exit_1(tmp_path, capsys):
    code = app.main(["--lint", str(tmp_path), "--json"])
    captured = capsys.readouterr()
    assert code == 1
    payload = json.loads(captured.out)
    assert payload["ok"] is False and payload["error"]


def test_pack_reports_lint_findings_without_failing_the_build(tmp_path, capsys):
    src = _write_pack_with_a_dead_entry(tmp_path)
    out_file = tmp_path / "built.lwpack"
    code = app.main(["--pack", str(src), "--out", str(out_file), "--json"])
    captured = capsys.readouterr()
    assert code == 0 and out_file.is_file()
    payload = json.loads(captured.out)
    assert payload["warnings"] == []  # build warnings and lint notes stay separate lists
    assert [finding["code"] for finding in payload["lint"]] == ["lore-no-keys"]
    assert "lore-no-keys" in captured.err


def test_lint_json_answers_even_when_the_lint_itself_fails(tmp_path, capsys, monkeypatch):
    # `--json` promises exactly one object on stdout; a traceback and an empty stdout
    # would break every tool that parses it.
    def boom(_source):
        raise RuntimeError("lint bug")

    monkeypatch.setattr(app, "lint_pack", boom)
    code = app.main(["--lint", str(_write_minimal_pack(tmp_path)), "--json"])
    captured = capsys.readouterr()
    assert code == 1
    assert json.loads(captured.out) == {"ok": False, "error": "lint bug"}

    # ...and the same failure after a successful build costs the build nothing.
    code = app.main(["--pack", str(tmp_path / "src"), "--out", str(tmp_path / "ok.lwpack"), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 0 and payload["ok"] is True and payload["lint"] == []
