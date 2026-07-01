"""Lint Python string literals for hardcoded user-facing text."""

from __future__ import annotations

import ast
import re
import sys
import tokenize
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCAN_PATHS = ["core", "infra", "agent", "gateway", "adapters", "net", "app.py"]
ALLOWLIST_PATH = REPO_ROOT / "scripts" / "i18n_allowlist.txt"

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_CJK_SENTENCE_PUNCT_RE = re.compile(r"[，。！？；：、]")
_EN_WORD_RE = re.compile(r"[A-Za-z]+")
_LOWER_WORD_RE = re.compile(r"\b[a-z]{3,}\b")
_I18N_OR_STORE_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_{}-]+)+$")
_PLACEHOLDER_ONLY_RE = re.compile(r"^[\s{}A-Za-z0-9_.,:;!?\-/|()[\]<>%]+$")
_SQL_RE = re.compile(
    r"^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b",
    re.IGNORECASE,
)
_LOGGER_METHODS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "log"}
_REGEX_META = frozenset("^$.*+?[]()|\\")


@dataclass(frozen=True, order=True)
class Finding:
    path: str
    line: int
    snippet: str


@dataclass(frozen=True)
class _Literal:
    value: str
    node: ast.AST
    line: int
    source: str


@dataclass(frozen=True)
class _Allowlist:
    whole_files: frozenset[str]
    snippets: tuple[tuple[str, str], ...]

    def permits(self, path: str, value: str) -> bool:
        if path in self.whole_files:
            return True
        return any(allowed_path == path and snippet in value for allowed_path, snippet in self.snippets)


def is_hardcoded_ui_literal(value: str) -> bool:
    """Return True when a literal looks like natural-language UI text."""
    text = value.strip()
    if not text:
        return False
    if _is_intrinsically_exempt(text):
        return False
    if _looks_like_cjk_ui_text(text):
        return True
    return _looks_like_english_ui_text(text)


def scan_tree(paths: list[str]) -> list[Finding]:
    """Scan Python files under paths and return hardcoded UI string findings."""
    allowlist = _load_allowlist(ALLOWLIST_PATH)
    findings: list[Finding] = []
    for py_file in _iter_python_files(paths):
        rel_path = _relative_path(py_file)
        if rel_path in allowlist.whole_files:
            continue
        source = py_file.read_text(encoding="utf-8")
        try:
            tree = ast.parse(source, filename=str(py_file))
        except SyntaxError as exc:
            findings.append(Finding(rel_path, exc.lineno or 1, f"syntax error: {exc.msg}"))
            continue

        parents = _parent_map(tree)
        comments = _line_comments(source)
        docstring_nodes = _docstring_nodes(tree)
        for literal in _string_literals(tree, source):
            if literal.node in docstring_nodes:
                continue
            if _line_has_i18n_exemption(comments.get(literal.line, "")):
                continue
            if allowlist.permits(rel_path, literal.value):
                continue
            if _is_logging_template(literal.node, parents):
                continue
            if not is_hardcoded_ui_literal(literal.value):
                continue
            findings.append(Finding(rel_path, literal.line, _snippet(literal.value)))
    return sorted(findings)


def main(argv: list[str] | None = None) -> int:
    paths = argv if argv is not None and argv else DEFAULT_SCAN_PATHS
    findings = scan_tree(paths)
    if findings:
        for finding in findings:
            print(f"{finding.path}:{finding.line}: {finding.snippet}")
        return 1
    print(f"OK: i18n hardcoded-string lint passed ({len(list(_iter_python_files(paths)))} files scanned)")
    return 0


def _is_intrinsically_exempt(text: str) -> bool:
    if len(text.split()) <= 1 and not _CJK_SENTENCE_PUNCT_RE.search(text):
        if _CJK_RE.search(text):
            return len(_CJK_RE.findall(text)) < 6
        return True
    if _I18N_OR_STORE_KEY_RE.fullmatch(text):
        return True
    if _SQL_RE.match(text):
        return True
    if _is_ascii_symbol_text(text):
        return True
    if _looks_like_regex(text):
        return True
    if _looks_like_format_only(text):
        return True
    return False


def _looks_like_cjk_ui_text(text: str) -> bool:
    cjk_count = len(_CJK_RE.findall(text))
    if cjk_count == 0:
        return False
    if _CJK_SENTENCE_PUNCT_RE.search(text):
        return True
    return cjk_count >= 6


def _looks_like_english_ui_text(text: str) -> bool:
    if text.count(" ") < 3:
        return False
    words = _EN_WORD_RE.findall(text)
    if len(words) < 4:
        return False
    if not _LOWER_WORD_RE.search(text):
        return False
    return text[-1] in ".!?:" or len(words) >= 6


def _is_ascii_symbol_text(text: str) -> bool:
    return text.isascii() and not any(ch.isalpha() for ch in text)


def _looks_like_regex(text: str) -> bool:
    if not any(ch in text for ch in _REGEX_META):
        return False
    # Store paths with `{chat_key}` are handled by key/path exemptions. This is
    # intentionally broad for compiled regex literals and regex-like guards.
    return bool(re.search(r"(?:\\[wdsbAZ]|\[[^\]]+\]|\(\?:|\^|\$|\.\*)", text))


def _looks_like_format_only(text: str) -> bool:
    if "{" not in text and "%" not in text:
        return False
    without_placeholders = re.sub(r"\{[^{}]*\}", "", text)
    without_percent = re.sub(r"%\(?[A-Za-z0-9_]*\)?[sdifr]", "", without_placeholders)
    return _PLACEHOLDER_ONLY_RE.fullmatch(without_percent) is not None and not _LOWER_WORD_RE.search(
        without_percent
    )


def _iter_python_files(paths: list[str]):
    for raw_path in paths:
        path = Path(raw_path)
        if not path.is_absolute():
            path = REPO_ROOT / path
        if path.is_file():
            if path.suffix == ".py":
                yield path
            continue
        if path.is_dir():
            yield from sorted(item for item in path.rglob("*.py") if item.is_file())


def _relative_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def _load_allowlist(path: Path) -> _Allowlist:
    if not path.exists():
        return _Allowlist(frozenset(), ())
    whole_files: set[str] = set()
    snippets: list[tuple[str, str]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "::" in line:
            allowed_path, snippet = line.split("::", 1)
            snippets.append((allowed_path.strip(), snippet.strip()))
        else:
            whole_files.add(line)
    return _Allowlist(frozenset(whole_files), tuple(snippets))


def _line_comments(source: str) -> dict[int, str]:
    comments: dict[int, str] = {}
    readline = iter(source.splitlines(keepends=True)).__next__
    try:
        for token in tokenize.generate_tokens(readline):
            if token.type == tokenize.COMMENT:
                comments[token.start[0]] = token.string
    except tokenize.TokenError:
        return comments
    return comments


def _line_has_i18n_exemption(comment: str) -> bool:
    return "# i18n-exempt" in comment or "# noqa-i18n" in comment


def _parent_map(tree: ast.AST) -> dict[ast.AST, ast.AST]:
    parents: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
    return parents


def _docstring_nodes(tree: ast.AST) -> set[ast.AST]:
    nodes: set[ast.AST] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            if node.body and isinstance(node.body[0], ast.Expr):
                value = node.body[0].value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    nodes.add(value)
    return nodes


def _string_literals(tree: ast.AST, source: str) -> list[_Literal]:
    literals: list[_Literal] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            literals.append(_Literal(node.value, node, node.lineno, ast.get_source_segment(source, node) or node.value))
    return literals


def _is_logging_template(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> bool:
    current = node
    while current in parents:
        parent = parents[current]
        if isinstance(parent, ast.Call):
            return _is_logger_call(parent)
        current = parent
    return False


def _is_logger_call(call: ast.Call) -> bool:
    func = call.func
    if not isinstance(func, ast.Attribute) or func.attr not in _LOGGER_METHODS:
        return False
    value = func.value
    if isinstance(value, ast.Name) and value.id in {"logger", "logging"}:
        return True
    return isinstance(value, ast.Attribute) and value.attr == "logger"


def _snippet(value: str) -> str:
    text = " ".join(value.split())
    if len(text) <= 88:
        return text
    return f"{text[:85]}..."


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
