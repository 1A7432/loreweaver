"""A safe, deterministic subset of EJS templating for worldbook/prompt content.

SillyTavern cards written for the ST-Prompt-Template extension embed real EJS (arbitrary
JavaScript) in worldbook entries and prompts. We cannot and will not run JavaScript server-side
(trust boundary — see ``docs/plugins.md``); instead this module renders the SUBSET that the
overwhelming majority of cards actually use, on top of ``core.condexpr``'s closed expression
grammar:

- conditional blocks: ``<% if (expr) { %> … <% } else if (expr) { %> … <% } else { %> … <% } %>``
- output tags: ``<%= expr %>`` and ``<%- expr %>`` (both render ``str(value)``; None → "")
- comment tags: ``<%# … %>`` (dropped)
- statement tags: ``setvar('name', expr)`` / ``incvar('name'[, expr])`` / ``decvar('name'[, expr])``
  (applied through a caller-supplied setter; silently no-ops without one)
- whitespace-trim tag variants (``<%_``, ``_%>``, ``-%>``)
- the ``<#escape-ejs> … <#/escape-ejs>`` passthrough block (``<%%`` / ``%%>`` unescape inside)
- ST macro compatibility via `substitute_macros`: ``{{getvar::name}}``, our native
  ``{{var:name}}``, and ``{{user}}``/``{{char}}`` from a caller-supplied name map; unknown
  macros pass through untouched
- entry-level ``@@decorator`` lines via `split_decorators` (notably ``@@if <expr>``)

FAIL-SAFE, NEVER FAIL-OPEN: raw template syntax must never reach the LLM. An output/statement
tag that doesn't parse renders as "" (with a warning recorded); an unbalanced block structure
degrades to stripping every tag and keeping the plain text. Rendering is pure — the only side
effects are explicit setter calls — and bounded (template length, nesting depth).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from core.condexpr import CondExprError, evaluate, truthy

MAX_TEMPLATE_LEN = 20_000
MAX_DEPTH = 16

Resolver = Callable[[str], Any]
Setter = Callable[[str, Any], None]

_TAG_RE = re.compile(r"<%[=\-_#]?(?:(?!%>).)*?[\-_]?%>", re.DOTALL)
_ESCAPE_BLOCK_RE = re.compile(r"<#escape-ejs>(.*?)<[#/]{1,2}escape-ejs>", re.DOTALL | re.IGNORECASE)

_IF_RE = re.compile(r"^if\s*\((?P<expr>.*)\)\s*\{?$", re.DOTALL)
_ELSE_IF_RE = re.compile(r"^\}?\s*else\s+if\s*\((?P<expr>.*)\)\s*\{?$", re.DOTALL)
_ELSE_RE = re.compile(r"^\}?\s*else\s*\{?$")
_END_RE = re.compile(r"^\}$")
_STATEMENT_RE = re.compile(r"^(?P<fn>setvar|incvar|decvar)\s*\((?P<args>.*)\)\s*;?$", re.DOTALL)

_MACRO_GETVAR_RE = re.compile(r"\{\{\s*getvar::(?P<name>[^{}]+?)\s*\}\}")
_MACRO_VAR_RE = re.compile(r"\{\{\s*var:(?P<name>[^{}]+?)\s*\}\}")
_MACRO_NAME_RE = re.compile(r"\{\{\s*(?P<name>user|char)\s*\}\}", re.IGNORECASE)
_MACRO_COMMENT_RE = re.compile(r"\{\{\s*//[^{}]*\}\}")
_MACRO_NEWLINE_RE = re.compile(r"\{\{\s*newline\s*\}\}", re.IGNORECASE)
_MACRO_TIME_RE = re.compile(r"\{\{\s*(?:time|date)\s*\}\}", re.IGNORECASE)
_MACRO_RANDOM_RE = re.compile(r"\{\{\s*(?:random|pick)\s*[:]{1,2}\s*(?P<options>[^{}]+?)\s*\}\}", re.IGNORECASE)
_MACRO_ROLL_RE = re.compile(r"\{\{\s*roll\s*[:]{1,2}\s*(?P<expr>[^{}]+?)\s*\}\}", re.IGNORECASE)

_AT_DECORATOR_RE = re.compile(r"^@@(?P<name>[A-Za-z_]+)(?:\s+(?P<arg>.*))?$")


@dataclass
class RenderResult:
    """Rendered text plus non-fatal warnings (unsupported constructs, bad expressions)."""

    text: str
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Template parsing — segments, then a nested node tree
# ---------------------------------------------------------------------------


@dataclass
class _Segment:
    kind: str  # "text" | "tag"
    value: str
    mode: str = ""  # tag only: "" (statement) | "=" | "-" | "#"


def _split_segments(text: str) -> list[_Segment]:
    segments: list[_Segment] = []
    pos = 0
    for match in _TAG_RE.finditer(text):
        if match.start() > pos:
            segments.append(_Segment("text", text[pos : match.start()]))
        raw = match.group(0)
        inner = raw[2:-2]
        mode = ""
        if inner[:1] in ("=", "-", "#", "_"):
            mode = inner[0] if inner[0] != "_" else ""
            inner = inner[1:]
        if inner[-1:] in ("-", "_"):
            trim_after = inner[-1]
            inner = inner[:-1]
        else:
            trim_after = ""
        segment = _Segment("tag", inner.strip(), mode)
        segments.append(segment)
        pos = match.end()
        if trim_after == "-" and text[pos : pos + 1] == "\n":
            pos += 1  # `-%>` swallows the immediately following newline
        elif trim_after == "_":
            while pos < len(text) and text[pos].isspace():
                pos += 1
    if pos < len(text):
        segments.append(_Segment("text", text[pos:]))
    return segments


@dataclass
class _Node:
    kind: str  # "text" | "output" | "statement" | "if"
    value: str = ""
    branches: list[tuple[str | None, list[_Node]]] = field(default_factory=list)


def _build_tree(segments: list[_Segment]) -> list[_Node]:
    """Build the nested node tree; raises `ValueError` on unbalanced structure."""
    root: list[_Node] = []
    # Each stack frame: (nodes_list_of_current_branch, branches_of_open_if)
    stack: list[tuple[list[_Node], list[tuple[str | None, list[_Node]]]]] = []
    current = root

    for segment in segments:
        if segment.kind == "text":
            current.append(_Node("text", segment.value))
            continue
        if segment.mode == "#":
            continue
        if segment.mode in ("=", "-"):
            current.append(_Node("output", segment.value))
            continue

        code = segment.value
        if _IF_RE.match(code) and not code.startswith("}"):
            if len(stack) >= MAX_DEPTH:
                raise ValueError("template nesting too deep")
            branch_nodes: list[_Node] = []
            branches: list[tuple[str | None, list[_Node]]] = [(_IF_RE.match(code).group("expr"), branch_nodes)]
            stack.append((current, branches))
            current = branch_nodes
            continue
        match = _ELSE_IF_RE.match(code)
        if match:
            if not stack:
                raise ValueError("else-if without an open if")  # i18n-exempt: developer diagnostic; callers degrade fail-safe, never show this raw to players
            branch_nodes = []
            stack[-1][1].append((match.group("expr"), branch_nodes))
            current = branch_nodes
            continue
        if _ELSE_RE.match(code) and not _END_RE.match(code):
            if not stack:
                raise ValueError("else without an open if")
            branch_nodes = []
            stack[-1][1].append((None, branch_nodes))
            current = branch_nodes
            continue
        if _END_RE.match(code):
            if not stack:
                raise ValueError("closing brace without an open if")  # i18n-exempt: developer diagnostic; callers degrade fail-safe, never show this raw to players
            parent, branches = stack.pop()
            parent.append(_Node("if", branches=branches))
            current = parent
            continue
        current.append(_Node("statement", code))

    if stack:
        raise ValueError("unclosed if block")
    return root


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render(text: str, resolve: Resolver, setter: Setter | None = None) -> RenderResult:
    """Render `text`'s EJS-subset constructs against `resolve` (+ optional `setter`).

    Never raises and never leaks raw ``<% %>`` syntax: an oversized template comes back
    verbatim with a warning (nothing in it is executed), a broken expression renders as ""
    with a warning, and an unbalanced block structure strips every tag but keeps the text.
    """
    warnings: list[str] = []
    if len(text) > MAX_TEMPLATE_LEN:
        return RenderResult(text, [f"template too long ({len(text)} chars); left unprocessed"])

    escaped_chunks: list[str] = []

    def _stash_escape(match: re.Match[str]) -> str:
        escaped_chunks.append(match.group(1).replace("<%%", "<%").replace("%%>", "%>"))
        return f"\x00ejs-escape:{len(escaped_chunks) - 1}\x00"

    text = _ESCAPE_BLOCK_RE.sub(_stash_escape, text)

    segments = _split_segments(text)
    try:
        tree = _build_tree(segments)
    except ValueError as exc:
        warnings.append(f"unbalanced template structure ({exc}); tags stripped")
        plain = "".join(segment.value for segment in segments if segment.kind == "text")
        return RenderResult(_restore_escapes(plain, escaped_chunks), warnings)

    out: list[str] = []
    _render_nodes(tree, resolve, setter, out, warnings)
    return RenderResult(_restore_escapes("".join(out), escaped_chunks), warnings)


def _restore_escapes(text: str, chunks: list[str]) -> str:
    for index, chunk in enumerate(chunks):
        text = text.replace(f"\x00ejs-escape:{index}\x00", chunk)
    return text


def _render_nodes(
    nodes: list[_Node], resolve: Resolver, setter: Setter | None, out: list[str], warnings: list[str]
) -> None:
    for node in nodes:
        if node.kind == "text":
            out.append(node.value)
        elif node.kind == "output":
            try:
                value = evaluate(node.value, resolve)
                out.append("" if value is None else str(value))
            except CondExprError as exc:
                warnings.append(f"unsupported output expression {node.value!r}: {exc}")
        elif node.kind == "statement":
            _run_statements(node.value, resolve, setter, warnings)
        elif node.kind == "if":
            for expr, branch in node.branches:
                taken = True
                if expr is not None:
                    try:
                        taken = truthy(evaluate(expr, resolve))
                    except CondExprError as exc:
                        warnings.append(f"broken condition {expr!r}: {exc}")
                        taken = False
                if taken:
                    _render_nodes(branch, resolve, setter, out, warnings)
                    break


def _run_statements(code: str, resolve: Resolver, setter: Setter | None, warnings: list[str]) -> None:
    for statement in filter(None, (part.strip() for part in code.split(";"))):
        match = _STATEMENT_RE.match(statement)
        if match is None:
            warnings.append(f"unsupported statement {statement!r}")
            continue
        if setter is None:
            continue
        try:
            args = _split_call_args(match.group("args"))
            name = evaluate(args[0], resolve)
            if not isinstance(name, str) or not name:
                raise CondExprError("first argument must be a variable name string")  # i18n-exempt: developer diagnostic; callers degrade fail-safe, never show this raw to players
            fn = match.group("fn")
            if fn == "setvar":
                if len(args) < 2:
                    raise CondExprError("setvar needs a value")
                setter(name, evaluate(args[1], resolve))
            else:
                amount = evaluate(args[1], resolve) if len(args) > 1 else 1
                current = resolve(name)
                base = current if isinstance(current, (int, float)) and not isinstance(current, bool) else 0
                delta = amount if isinstance(amount, (int, float)) and not isinstance(amount, bool) else 1
                setter(name, base + delta if fn == "incvar" else base - delta)
        except (CondExprError, IndexError) as exc:
            warnings.append(f"broken statement {statement!r}: {exc}")


def _split_call_args(raw: str) -> list[str]:
    """Split a call's argument list on top-level commas (quote- and bracket-aware)."""
    args: list[str] = []
    depth = 0
    quote = ""
    start = 0
    i = 0
    while i < len(raw):
        ch = raw[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = ""
        elif ch in ("'", '"'):
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            args.append(raw[start:i].strip())
            start = i + 1
        i += 1
    tail = raw[start:].strip()
    if tail:
        args.append(tail)
    return args


# ---------------------------------------------------------------------------
# ST macro substitution + @@decorator parsing
# ---------------------------------------------------------------------------


@dataclass
class MacroContext:
    """Runtime context for SillyTavern-native macros beyond plain variable reads.

    All pieces are optional; a macro whose context is absent passes through untouched, so
    callers only wire what their surface honestly has. ``roll`` MUST be backed by the real
    dice engine (iron rule #2 — a ``{{roll:1d20}}`` in lore is a real roll, never model-made
    or ad-hoc randomness); ``rng`` backs ``{{random}}``/``{{pick}}``; ``clock_time`` is the
    GAME clock (deterministic world state), not the wall clock.
    """

    names: dict[str, str] = field(default_factory=dict)  # "user"/"char" display names
    clock_time: str = ""  # {{time}}/{{date}}
    rng: Any = None  # random.Random-like, for {{random:...}}/{{pick:...}}
    roll: Callable[[str], str] | None = None  # dice expression -> result text, real dice only


def substitute_macros(
    text: str,
    resolve: Resolver,
    names: dict[str, str] | None = None,
    macros: MacroContext | None = None,
) -> str:
    """Substitute the compatible macro forms; unknown ``{{...}}`` macros pass through.

    `names` is the stable back-compat argument; when both are given, entries in
    `macros.names` win. Comment macros (``{{// ...}}``) always strip.
    """
    merged_names = dict(names or {})
    if macros is not None:
        merged_names.update(macros.names)

    def _sub_var(match: re.Match[str]) -> str:
        value = resolve(match.group("name").strip())
        return "" if value is None else str(value)

    text = _MACRO_COMMENT_RE.sub("", text)
    text = _MACRO_GETVAR_RE.sub(_sub_var, text)
    text = _MACRO_VAR_RE.sub(_sub_var, text)
    text = _MACRO_NEWLINE_RE.sub("\n", text)

    if merged_names:
        def _sub_name(match: re.Match[str]) -> str:
            replacement = merged_names.get(match.group("name").lower())
            return replacement if replacement else match.group(0)

        text = _MACRO_NAME_RE.sub(_sub_name, text)

    if macros is not None:
        if macros.clock_time:
            text = _MACRO_TIME_RE.sub(macros.clock_time, text)
        if macros.rng is not None:
            def _sub_random(match: re.Match[str]) -> str:
                raw = match.group("options")
                options = [part.strip() for part in (raw.split("::") if "::" in raw else raw.split(","))]
                options = [option for option in options if option]
                return macros.rng.choice(options) if options else ""

            text = _MACRO_RANDOM_RE.sub(_sub_random, text)
        if macros.roll is not None:
            def _sub_roll(match: re.Match[str]) -> str:
                try:
                    return str(macros.roll(match.group("expr").strip()))
                except Exception:
                    return match.group(0)  # a bad expression passes through untouched

            text = _MACRO_ROLL_RE.sub(_sub_roll, text)
    return text


def split_decorators(text: str) -> tuple[dict[str, Any], str]:
    """Split leading ST-Prompt-Template ``@@decorator`` lines off `text`.

    Returns ``(decorators, body)`` where flag decorators map to ``True`` and ``@@if`` maps
    its expression string (``{"if": "variables.stage === 2"}``). Parsing stops at the first
    non-decorator, non-blank line; a text with no decorators returns ``({}, text)`` unchanged.
    """
    decorators: dict[str, Any] = {}
    lines = text.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line and decorators:
            index += 1
            continue
        match = _AT_DECORATOR_RE.match(line)
        if match is None:
            break
        name = match.group("name").lower()
        arg = (match.group("arg") or "").strip()
        decorators[name] = arg if name == "if" and arg else True
        index += 1
    if not decorators:
        return {}, text
    return decorators, "\n".join(lines[index:])
