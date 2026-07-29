"""SillyTavern MVU (MagVarUpdate) card compatibility — variable import + text-protocol updates.

Many SillyTavern cards track story state with the MVU framework: the card ships a worldbook
entry whose NAME contains ``InitVar`` (case-insensitively, usually literally ``[InitVar]``) and
whose content is a JSON5 object declaring a nested variable tree; the model then drives that
tree through ``<UpdateVariable>`` command blocks emitted inside its replies. This module makes
those cards work natively in Loreweaver.

Iron rule #1 (deterministic vs generative split) stays intact: the text protocol is ONE input
channel, and everything on it is handled by deterministic code — the model only *proposes*
updates as text; every mutation is tokenized, validated, and executed here (a bad command is
skipped + reported, never improvised around). No variable value is ever AI-generated here.

Upstream shapes this module implements (verified against the original MVU project):

- InitVar content: nested dicts whose LEAVES are plain scalars/arrays or the
  ValueWithDescription form ``[initial_value, "description/update-conditions"]``, e.g.
  ``{"理": {"情绪状态": {"pleasure": [0.1, "[-1,1] range; updates on emotion change"]}}}``.
  Keys are routinely CJK. JSON5-isms seen in the wild: ``//`` and ``/* */`` comments, trailing
  commas, single-quoted strings, unquoted ASCII identifier keys.
- Update blocks: ``<UpdateVariable> ... </UpdateVariable>`` (case-insensitive, attributes and
  whitespace tolerated, optionally fenced in triple backticks), optionally containing an
  ``<Analysis>...</Analysis>`` sub-block to discard. Command lines look like
  ``_.set('理.好感度', 33, 35);//pleasant discussion`` — five ops, two arities each where noted:
  ``_.set(path, [expected_old,] new)``, ``_.insert(path, [index_or_key,] value)``,
  ``_.delete(path[, index_or_key_or_value])``, ``_.add(path, delta_or_toggle)``,
  ``_.move(from_path, to_path)``. Arguments are single/double-quoted strings, numbers,
  true/false/null, or bracketed JSON chunks; the trailing ``;//reason`` is optional. Paths are
  dot-separated, CJK-heavy, and may address list indices numerically (``a.b.0``).

Mirrors ``core.modvars``/``core.relationships``' layering: intentionally self-contained
(stdlib + json only), pure non-mutating functions plus a thin async ``MvuManager`` over a
duck-typed store ``Protocol``, and defensive normalization of stored garbage.
"""

from __future__ import annotations

import copy
import json
import math
import re
from typing import Any, Protocol

# ---------------------------------------------------------------------------
# Limits and shapes
# ---------------------------------------------------------------------------

MAX_TREE_DEPTH = 8
MAX_TREE_NODES = 512
MAX_FLAT_LEAVES = 200

_SCALAR_TYPES = (str, int, float, bool, type(None))

# One MVU variable tree: nested dicts/lists, CJK-keyed, ValueWithDescription leaves.
MvuTree = dict[str, Any]

# Sentinel used by `normalize_tree` to say "drop this node" (None is a legal stored value).
_DROP = object()


class _StoreProtocol(Protocol):
    """Duck-typed shape of `infra.store.Store` — just enough to load/save MVU state."""

    async def get(self, user_key: str = "", store_key: str = "") -> str | None: ...

    async def set(self, user_key: str = "", store_key: str = "", value: str | None = None) -> None: ...


# ---------------------------------------------------------------------------
# InitVar worldbook entries — detection + tolerant JSON5-lite parsing
# ---------------------------------------------------------------------------


def is_initvar_entry(name: Any) -> bool:
    """Whether a worldbook entry `name` marks an MVU variable-initialization entry.

    Upstream cards name it ``[InitVar]`` (often with decoration around it, e.g.
    ``「[InitVar]变量初始化」``); the match is a case-insensitive substring test.
    """
    return isinstance(name, str) and "initvar" in name.lower()


def parse_initvar(text: str) -> dict | None:
    """Parse an InitVar entry's JSON5-lite content into a dict; `None` when unrecoverable.

    Tolerates the JSON5-isms seen in real MVU cards — ``//`` and ``/* */`` comments
    (string-aware: a ``//`` inside a string, e.g. a URL, is data), trailing commas,
    single-quoted strings, and unquoted ASCII identifier keys — then hands the normalized text
    to `json.loads`. Anything else unrecoverable, or a non-dict top level, degrades to `None`
    rather than raising. CJK keys/values pass through untouched.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    normalized = _json5_normalize(text)
    if normalized is None:
        return None
    try:
        data = json.loads(normalized)
    except (ValueError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def _json5_normalize(text: str) -> str | None:
    """Reduce JSON5-lite `text` to strict JSON: comments out, single → double quotes, trailing
    commas removed, unquoted ASCII identifier keys quoted. `None` on an unterminated construct."""
    stripped = _strip_comments_normalize_quotes(text)
    if stripped is None:
        return None
    return _quote_bare_keys(_drop_trailing_commas(stripped))


def _strip_comments_normalize_quotes(text: str) -> str | None:
    """One string-aware pass: drop ``//``/``/* */`` comments OUTSIDE strings and re-emit
    single-quoted strings as double-quoted JSON strings (re-escaping as needed)."""
    out: list[str] = []
    i, length = 0, len(text)
    while i < length:
        ch = text[i]
        if ch in "\"'":
            quote = ch
            i += 1
            buf: list[str] = []
            closed = False
            while i < length:
                current = text[i]
                if current == "\\":
                    if i + 1 >= length:
                        return None
                    escaped = text[i + 1]
                    if quote == "'" and escaped == "'":
                        buf.append("'")  # \' is not a legal JSON escape — unwrap it
                    else:
                        buf.append("\\" + escaped)
                    i += 2
                    continue
                if current == quote:
                    closed = True
                    i += 1
                    break
                if current == '"' and quote == "'":
                    buf.append('\\"')
                else:
                    buf.append(current)
                i += 1
            if not closed:
                return None
            out.append('"' + "".join(buf) + '"')
            continue
        if ch == "/" and i + 1 < length and text[i + 1] == "/":
            while i < length and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < length and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            if end == -1:
                return None
            i = end + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _drop_trailing_commas(text: str) -> str:
    """Remove commas that directly precede a closing ``}``/``]`` (string-aware)."""
    out: list[str] = []
    i, length = 0, len(text)
    in_string = False
    while i < length:
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < length:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == ",":
            probe = i + 1
            while probe < length and text[probe] in " \t\r\n":
                probe += 1
            if probe < length and text[probe] in "}]":
                i += 1  # drop the comma; the whitespace after it re-emits normally
                continue
        out.append(ch)
        i += 1
    return "".join(out)


_BARE_KEY_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def _quote_bare_keys(text: str) -> str:
    """Wrap unquoted ASCII identifier keys (an identifier followed by ``:``) in double quotes
    (string-aware). Bare ``true``/``false``/``null`` VALUES are never followed by ``:`` and
    pass through untouched."""
    out: list[str] = []
    i, length = 0, len(text)
    in_string = False
    while i < length:
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < length:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        match = _BARE_KEY_RE.match(text, i)
        if match is not None:
            probe = match.end()
            while probe < length and text[probe] in " \t\r\n":
                probe += 1
            if probe < length and text[probe] == ":":
                out.append(f'"{match.group(0)}"')
            else:
                out.append(match.group(0))
            i = match.end()
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# ---------------------------------------------------------------------------
# ValueWithDescription leaves
# ---------------------------------------------------------------------------


def is_value_with_desc(node: Any) -> bool:
    """Whether `node` is MVU's ValueWithDescription form: ``[value, "description"]``.

    This mirrors upstream's own (ambiguous) heuristic — a plain two-element list whose second
    element happens to be a string is indistinguishable from the wrapped form by construction.
    """
    return isinstance(node, list) and len(node) == 2 and isinstance(node[1], str)


def leaf_value(node: Any) -> Any:
    """Unwrap a ValueWithDescription leaf to its value; any other node passes through."""
    return node[0] if is_value_with_desc(node) else node


# ---------------------------------------------------------------------------
# Path resolution — dot-separated, CJK-friendly, numeric segments index lists
# ---------------------------------------------------------------------------


def _split_path(path: Any) -> list[str]:
    if not isinstance(path, str) or not path.strip():
        raise ValueError(f"invalid path {path!r}")
    segments = [segment.strip() for segment in path.split(".")]
    if any(not segment for segment in segments):
        raise ValueError(f"invalid path {path!r} (empty segment)")
    return segments


def _list_index(segment: str, node: list, path: str) -> int:
    if not segment.isdigit():
        raise ValueError(f"path {path!r}: list index {segment!r} isn't a non-negative number")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    index = int(segment)
    if index >= len(node):
        raise ValueError(f"path {path!r}: index {index} is out of range (list length {len(node)})")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    return index


def _descend(node: Any, segment: str, path: str, *, create: bool) -> Any:
    """Step one INTERMEDIATE segment down; `create` auto-creates a missing dict key (dicts
    only — lists never auto-extend)."""
    if isinstance(node, dict):
        if segment not in node:
            if not create:
                raise ValueError(f"path {path!r}: missing segment {segment!r}")
            node[segment] = {}
        return node[segment]
    if isinstance(node, list):
        return node[_list_index(segment, node, path)]
    raise ValueError(f"path {path!r}: segment {segment!r} lands inside a non-container")


def _walk_parent(root: Any, segments: list[str], path: str, *, create: bool) -> Any:
    node = root
    for segment in segments[:-1]:
        node = _descend(node, segment, path, create=create)
    return node


def _child(parent: Any, segment: str, path: str) -> Any:
    """Read the node at the FINAL path segment (must exist)."""
    if isinstance(parent, dict):
        if segment not in parent:
            raise ValueError(f"path {path!r}: no key {segment!r}")
        return parent[segment]
    if isinstance(parent, list):
        return parent[_list_index(segment, parent, path)]
    raise ValueError(f"path {path!r}: segment {segment!r} lands inside a non-container")


# ---------------------------------------------------------------------------
# The five MVU ops — pure, never mutate their input
# ---------------------------------------------------------------------------


def apply_set(tree: MvuTree, path: str, new: Any, expected_old: Any = None) -> MvuTree:
    """Set the leaf at `path` to `new`, returning a new tree (input never mutated).

    A ValueWithDescription leaf updates index 0 and KEEPS its description; a plain leaf is
    replaced. Missing intermediate dicts auto-create — set is the only op that introduces new
    state, per MVU. `expected_old` is advisory only: upstream treats the old value as an
    arbitrary annotation, so a mismatch is deliberately NOT rejected.
    """
    segments = _split_path(path)
    new_tree = copy.deepcopy(tree)
    parent = _walk_parent(new_tree, segments, path, create=True)
    last = segments[-1]
    value = copy.deepcopy(new)
    if isinstance(parent, dict):
        existing = parent.get(last)
        if is_value_with_desc(existing) and not is_value_with_desc(value):
            existing[0] = value
        else:
            parent[last] = value
    elif isinstance(parent, list):
        index = _list_index(last, parent, path)
        if is_value_with_desc(parent[index]) and not is_value_with_desc(value):
            parent[index][0] = value
        else:
            parent[index] = value
    else:
        raise ValueError(f"path {path!r}: parent of {last!r} is not a container")
    return new_tree


def apply_insert(tree: MvuTree, path: str, value: Any, key: Any = None) -> MvuTree:
    """Insert `value` into the container at `path`: list append (`key` None) or index insert
    (out-of-range indices clamp, matching `list.insert`); a dict insert needs a `key`. A
    ValueWithDescription whose wrapped value is itself a container is unwrapped first. Returns
    a new tree; raises `ValueError` on a missing path or a non-container target."""
    segments = _split_path(path)
    new_tree = copy.deepcopy(tree)
    parent = _walk_parent(new_tree, segments, path, create=False)
    target = _child(parent, segments[-1], path)
    if is_value_with_desc(target) and isinstance(target[0], (dict, list)):
        target = target[0]
    inserted = copy.deepcopy(value)
    if isinstance(target, list):
        if key is None:
            target.append(inserted)
        else:
            target.insert(_insert_index(key, path), inserted)
    elif isinstance(target, dict):
        if key is None:
            raise ValueError(f"path {path!r}: inserting into a dict needs a key")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
        target[str(key)] = inserted
    else:
        raise ValueError(f"path {path!r}: insert target is not a list or dict")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    return new_tree


def _insert_index(key: Any, path: str) -> int:
    if isinstance(key, int) and not isinstance(key, bool):
        return key
    if isinstance(key, str) and key.lstrip("-").isdigit() and key.lstrip("-"):
        return int(key)
    raise ValueError(f"path {path!r}: list insert index {key!r} isn't a number")


def apply_delete(tree: MvuTree, path: str, key: Any = None) -> MvuTree:
    """Delete the node at `path` (`key` None), or delete FROM the container at `path`: a dict
    key, a list index (int-like `key`), or the first list element equal to `key`. Returns a new
    tree; raises `ValueError` when there is nothing to delete."""
    segments = _split_path(path)
    new_tree = copy.deepcopy(tree)
    parent = _walk_parent(new_tree, segments, path, create=False)
    last = segments[-1]
    if key is None:
        if isinstance(parent, dict):
            if last not in parent:
                raise ValueError(f"path {path!r}: no key {last!r}")
            del parent[last]
        elif isinstance(parent, list):
            del parent[_list_index(last, parent, path)]
        else:
            raise ValueError(f"path {path!r}: parent of {last!r} is not a container")
        return new_tree

    target = _child(parent, last, path)
    if is_value_with_desc(target) and isinstance(target[0], (dict, list)):
        target = target[0]
    if isinstance(target, dict):
        dict_key = str(key)
        if dict_key not in target:
            raise ValueError(f"path {path!r}: no key {dict_key!r} to delete")
        del target[dict_key]
    elif isinstance(target, list):
        index = _optional_index(key)
        if index is not None:
            if index >= len(target):
                raise ValueError(f"path {path!r}: index {index} is out of range (list length {len(target)})")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
            del target[index]
        else:
            try:
                target.remove(key)
            except ValueError:
                raise ValueError(f"path {path!r}: value {key!r} not found in the list") from None
    else:
        raise ValueError(f"path {path!r}: delete target is not a list or dict")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    return new_tree


def _optional_index(key: Any) -> int | None:
    """Int-like `key` → non-negative list index; anything else → None (a value match)."""
    if isinstance(key, bool):
        return None
    if isinstance(key, int) and key >= 0:
        return key
    if isinstance(key, str) and key.isdigit():
        return int(key)
    return None


def apply_add(tree: MvuTree, path: str, delta: Any) -> MvuTree:
    """Add `delta` to the number at `path` (through a ValueWithDescription wrapper, keeping the
    description), or TOGGLE when the target or `delta` is a bool (upstream `_.add` semantics: a
    boolean flips regardless of the delta's own value). Returns a new tree; raises `ValueError`
    for a missing path or a non-numeric/non-bool combination."""
    segments = _split_path(path)
    new_tree = copy.deepcopy(tree)
    parent = _walk_parent(new_tree, segments, path, create=False)
    last = segments[-1]
    node = _child(parent, last, path)
    wrapped = is_value_with_desc(node)
    current = node[0] if wrapped else node
    if isinstance(current, bool) or isinstance(delta, bool):
        if not isinstance(current, (bool, int, float)):
            raise ValueError(f"path {path!r}: cannot toggle {current!r}")
        updated: Any = not bool(current)
    else:
        if not isinstance(current, (int, float)):
            raise ValueError(f"path {path!r}: target {current!r} isn't a number")
        if not isinstance(delta, (int, float)):
            raise ValueError(f"path {path!r}: delta {delta!r} isn't a number")
        updated = current + delta
    if wrapped:
        node[0] = updated
    elif isinstance(parent, dict):
        parent[last] = updated
    else:
        parent[_list_index(last, parent, path)] = updated
    return new_tree


def apply_move(tree: MvuTree, from_path: str, to_path: str) -> MvuTree:
    """Detach the node at `from_path` (wrapper and all) and re-attach it at `to_path`.

    The destination is a raw placement (no ValueWithDescription merging), and its intermediate
    segments must already exist — only `apply_set` introduces new state. A destination list
    index equal to the list length appends. Returns a new tree; raises `ValueError` on a
    missing source or destination."""
    from_segments = _split_path(from_path)
    to_segments = _split_path(to_path)
    new_tree = copy.deepcopy(tree)

    source_parent = _walk_parent(new_tree, from_segments, from_path, create=False)
    source_last = from_segments[-1]
    if isinstance(source_parent, dict):
        if source_last not in source_parent:
            raise ValueError(f"path {from_path!r}: no key {source_last!r}")
        moved = source_parent.pop(source_last)
    elif isinstance(source_parent, list):
        moved = source_parent.pop(_list_index(source_last, source_parent, from_path))
    else:
        raise ValueError(f"path {from_path!r}: parent of {source_last!r} is not a container")

    dest_parent = _walk_parent(new_tree, to_segments, to_path, create=False)
    dest_last = to_segments[-1]
    if isinstance(dest_parent, dict):
        dest_parent[dest_last] = moved
    elif isinstance(dest_parent, list):
        if dest_last.isdigit() and int(dest_last) == len(dest_parent):
            dest_parent.append(moved)
        else:
            dest_parent[_list_index(dest_last, dest_parent, to_path)] = moved
    else:
        raise ValueError(f"path {to_path!r}: parent of {dest_last!r} is not a container")
    return new_tree


# ---------------------------------------------------------------------------
# <UpdateVariable> block extraction + command-line tokenizing
# ---------------------------------------------------------------------------

_BLOCK_RE = re.compile(r"<updatevariable\b[^>]*>(.*?)</updatevariable\s*>", re.IGNORECASE | re.DOTALL)
_FENCED_BLOCK_RE = re.compile(
    r"```[A-Za-z0-9_-]*\s*(<updatevariable\b[^>]*>.*?</updatevariable\s*>)\s*```",
    re.IGNORECASE | re.DOTALL,
)
_ANALYSIS_RE = re.compile(r"<analysis\b[^>]*>.*?</analysis\s*>", re.IGNORECASE | re.DOTALL)
_COMMAND_RE = re.compile(r"^\s*_\s*\.\s*(set|insert|delete|add|move)\s*\(")
_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")
_KEYWORD_RE = re.compile(r"(true|false|null)\b", re.IGNORECASE)
_KEYWORDS = {"true": True, "false": False, "null": None}
_STRING_ESCAPES = {"n": "\n", "t": "\t", "r": "\r"}

# (min, max) TOTAL argument count per op, path included — the two arities seen in the wild.
_OP_ARITY = {"set": (2, 3), "insert": (2, 3), "delete": (1, 2), "add": (2, 2), "move": (2, 2)}


def parse_update_blocks(text: str) -> tuple[list[dict[str, Any]], str]:
    """Extract every ``<UpdateVariable>`` block from narration `text`.

    Returns ``(commands, cleaned_text)``: the commands in order of appearance as
    ``{"op", "path", "args", "reason"}`` dicts (``args`` excludes the path), and the narration
    with the blocks removed and surrounding whitespace tidied. ``<Analysis>`` sub-blocks are
    discarded, a block fenced in triple backticks is unwrapped, and unparseable lines are
    skipped, never fatal. With no block the ORIGINAL text comes back byte-identical.
    """
    if not isinstance(text, str):
        return [], ""
    unfenced = _FENCED_BLOCK_RE.sub(lambda match: match.group(1), text)
    if not _BLOCK_RE.search(unfenced):
        return [], text
    commands: list[dict[str, Any]] = []
    for match in _BLOCK_RE.finditer(unfenced):
        inner = _ANALYSIS_RE.sub("", match.group(1))
        for line in inner.splitlines():
            command = _parse_command_line(line)
            if command is not None:
                commands.append(command)
    cleaned = _BLOCK_RE.sub("", unfenced)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return commands, cleaned


def _parse_command_line(line: str) -> dict[str, Any] | None:
    """Parse one ``_.op(...)`` line; `None` (skip it) on anything that doesn't tokenize."""
    match = _COMMAND_RE.match(line)
    if match is None:
        return None
    op = match.group(1).lower()
    try:
        args, end = _parse_arg_list(line, match.end())
    except ValueError:
        return None
    if not args or not isinstance(args[0], str):
        return None
    low, high = _OP_ARITY[op]
    if not low <= len(args) <= high:
        return None
    remainder = line[end:].strip()
    if remainder.startswith(";"):
        remainder = remainder[1:].strip()
    reason = remainder[2:].strip() if remainder.startswith("//") else ""
    return {"op": op, "path": args[0], "args": args[1:], "reason": reason}


def _skip_ws(text: str, pos: int) -> int:
    while pos < len(text) and text[pos] in " \t":
        pos += 1
    return pos


def _parse_arg_list(text: str, pos: int) -> tuple[list[Any], int]:
    """Tokenize a parenthesized argument list starting just after ``(``; returns
    ``(args, index_after_close_paren)``. Raises `ValueError` on malformed input. This is a
    real tokenizer, NOT a naive comma split — commas inside strings and JSON chunks bind to
    their own value."""
    args: list[Any] = []
    length = len(text)
    while True:
        pos = _skip_ws(text, pos)
        if pos >= length:
            raise ValueError("unterminated argument list")
        if text[pos] == ")":
            return args, pos + 1
        value, pos = _parse_value(text, pos)
        args.append(value)
        pos = _skip_ws(text, pos)
        if pos >= length:
            raise ValueError("unterminated argument list")
        if text[pos] == ",":
            pos += 1
            continue
        if text[pos] == ")":
            return args, pos + 1
        raise ValueError(f"unexpected character {text[pos]!r}")


def _parse_value(text: str, pos: int) -> tuple[Any, int]:
    ch = text[pos]
    if ch in "\"'":
        return _parse_quoted(text, pos)
    if ch in "[{":
        return _parse_json_chunk(text, pos)
    match = _NUMBER_RE.match(text, pos)
    if match is not None:
        raw = match.group(0)
        return (float(raw) if any(mark in raw for mark in ".eE") else int(raw)), match.end()
    match = _KEYWORD_RE.match(text, pos)
    if match is not None:
        return _KEYWORDS[match.group(1).lower()], match.end()
    raise ValueError(f"unexpected character {ch!r}")


def _parse_quoted(text: str, pos: int) -> tuple[str, int]:
    quote = text[pos]
    pos += 1
    buf: list[str] = []
    length = len(text)
    while pos < length:
        ch = text[pos]
        if ch == "\\":
            if pos + 1 >= length:
                raise ValueError("dangling escape")
            escaped = text[pos + 1]
            buf.append(_STRING_ESCAPES.get(escaped, escaped))
            pos += 2
            continue
        if ch == quote:
            return "".join(buf), pos + 1
        buf.append(ch)
        pos += 1
    raise ValueError("unterminated string")


def _parse_json_chunk(text: str, pos: int) -> tuple[Any, int]:
    """Read one balanced ``[...]``/``{...}`` chunk and decode it via `json.loads` (with the
    JSON5-lite normalizer as a fallback, so single-quoted contents still land)."""
    chunk, end = _balanced_chunk(text, pos)
    try:
        return json.loads(chunk), end
    except (ValueError, RecursionError):
        pass
    normalized = _json5_normalize(chunk)
    if normalized is not None:
        try:
            return json.loads(normalized), end
        except (ValueError, RecursionError):
            pass
    raise ValueError(f"unparseable JSON argument {chunk!r}")


def _balanced_chunk(text: str, pos: int) -> tuple[str, int]:
    depth = 0
    i = pos
    length = len(text)
    while i < length:
        ch = text[i]
        if ch in "\"'":
            quote = ch
            i += 1
            while i < length and text[i] != quote:
                i += 2 if text[i] == "\\" else 1
            if i >= length:
                raise ValueError("unterminated string")
            i += 1
            continue
        if ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
            if depth == 0:
                return text[pos : i + 1], i + 1
        i += 1
    raise ValueError("unbalanced brackets")


# ---------------------------------------------------------------------------
# Tolerant command application
# ---------------------------------------------------------------------------


def apply_commands(tree: MvuTree, commands: list[dict[str, Any]]) -> tuple[MvuTree, list[dict[str, Any]], list[str]]:
    """Apply `commands` in order, tolerantly: a failing command is recorded in `errors` (as an
    ``"op path: reason"`` string) and skipped, never fatal. Returns
    ``(new_tree, applied_commands, errors)``; the input tree is never mutated."""
    current: MvuTree = copy.deepcopy(tree) if isinstance(tree, dict) else {}
    applied: list[dict[str, Any]] = []
    errors: list[str] = []
    for command in commands:
        try:
            current = _apply_one(current, command)
        except ValueError as exc:
            op = command.get("op", "?") if isinstance(command, dict) else "?"
            path = command.get("path", "?") if isinstance(command, dict) else "?"
            errors.append(f"{op} {path}: {exc}")
        else:
            applied.append(command)
    return current, applied, errors


def _apply_one(tree: MvuTree, command: Any) -> MvuTree:
    """Dispatch one parsed command dict onto the matching pure op; `ValueError` on a bad shape."""
    if not isinstance(command, dict):
        raise ValueError(f"command {command!r} is not a dict")
    op = command.get("op")
    path = command.get("path")
    raw_args = command.get("args")
    args = list(raw_args) if isinstance(raw_args, (list, tuple)) else []
    if op == "set":
        if len(args) == 1:
            return apply_set(tree, path, args[0])
        if len(args) == 2:
            return apply_set(tree, path, args[1], expected_old=args[0])
        raise ValueError(f"set takes 1 or 2 arguments after the path, got {len(args)}")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    if op == "insert":
        if len(args) == 1:
            return apply_insert(tree, path, args[0])
        if len(args) == 2:
            return apply_insert(tree, path, args[1], key=args[0])
        raise ValueError(f"insert takes 1 or 2 arguments after the path, got {len(args)}")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    if op == "delete":
        if not args:
            return apply_delete(tree, path)
        if len(args) == 1:
            return apply_delete(tree, path, key=args[0])
        raise ValueError(f"delete takes 0 or 1 arguments after the path, got {len(args)}")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    if op == "add":
        if len(args) == 1:
            return apply_add(tree, path, args[0])
        raise ValueError(f"add takes exactly 1 argument after the path, got {len(args)}")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    if op == "move":
        if len(args) == 1 and isinstance(args[0], str):
            return apply_move(tree, path, args[0])
        raise ValueError("move takes exactly one destination path")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    raise ValueError(f"unknown op {op!r}")


# ---------------------------------------------------------------------------
# Rendering + defensive normalization
# ---------------------------------------------------------------------------


def flatten_leaves(tree: MvuTree, limit: int = MAX_FLAT_LEAVES) -> list[dict[str, Any]]:
    """Flatten `tree` depth-first in insertion order into ``{"path", "value"}`` entries.

    ValueWithDescription leaves unwrap to their value; a list of scalars renders as the list
    itself; a list holding containers recurses with numeric path segments. Traversal stops once
    `limit` entries are collected (prompt-budget guard)."""
    entries: list[dict[str, Any]] = []
    if isinstance(tree, dict) and limit > 0:
        _flatten_into(tree, "", entries, limit)
    return entries


def _flatten_into(node: Any, prefix: str, entries: list[dict[str, Any]], limit: int) -> None:
    if len(entries) >= limit:
        return
    if is_value_with_desc(node):
        entries.append({"path": prefix, "value": node[0]})
        return
    if isinstance(node, dict):
        for key, child in node.items():
            if len(entries) >= limit:
                return
            _flatten_into(child, f"{prefix}.{key}" if prefix else str(key), entries, limit)
        return
    if isinstance(node, list):
        if all(isinstance(item, _SCALAR_TYPES) for item in node):
            entries.append({"path": prefix, "value": list(node)})
            return
        for index, child in enumerate(node):
            if len(entries) >= limit:
                return
            _flatten_into(child, f"{prefix}.{index}" if prefix else str(index), entries, limit)
        return
    entries.append({"path": prefix, "value": node})


def normalize_tree(raw: Any) -> MvuTree:
    """Defensively coerce an arbitrary loaded object into a bounded variable tree.

    A non-dict degrades to ``{}``; containers nested deeper than `MAX_TREE_DEPTH` and anything
    past a `MAX_TREE_NODES` total-node budget are dropped, as are non-string keys, non-finite
    floats, and non-JSON values. Never raises on a hostile stored blob."""
    if not isinstance(raw, dict):
        return {}
    budget = MAX_TREE_NODES

    def clean(node: Any, depth: int) -> Any:
        nonlocal budget
        if isinstance(node, dict):
            if depth >= MAX_TREE_DEPTH:
                return _DROP
            cleaned_dict: dict[str, Any] = {}
            for key, child in node.items():
                if budget <= 0:
                    break
                if not isinstance(key, str):
                    continue
                budget -= 1
                cleaned = clean(child, depth + 1)
                if cleaned is not _DROP:
                    cleaned_dict[key] = cleaned
            return cleaned_dict
        if isinstance(node, list):
            if depth >= MAX_TREE_DEPTH:
                return _DROP
            cleaned_list: list[Any] = []
            for child in node:
                if budget <= 0:
                    break
                budget -= 1
                cleaned = clean(child, depth + 1)
                if cleaned is not _DROP:
                    cleaned_list.append(cleaned)
            return cleaned_list
        if isinstance(node, float) and not isinstance(node, bool):
            return node if math.isfinite(node) else _DROP
        if isinstance(node, _SCALAR_TYPES):
            return node
        return _DROP

    result = clean(raw, 0)
    return result if isinstance(result, dict) else {}


# ---------------------------------------------------------------------------
# MvuManager — thin async persistence wrapper over the pure functions
# ---------------------------------------------------------------------------


def _store_key(chat_key: str) -> str:
    return f"mvu_data.{chat_key}"


def _merge_missing(target: dict, incoming: dict) -> bool:
    """Recursively copy keys `target` lacks from `incoming` (in place on `target`); existing
    values always win. Returns whether anything was added."""
    added = False
    for key, value in incoming.items():
        if key not in target:
            target[key] = copy.deepcopy(value)
            added = True
        elif isinstance(target[key], dict) and isinstance(value, dict):
            if _merge_missing(target[key], value):
                added = True
    return added


class MvuManager:
    """Async load/save wrapper over the pure MVU functions above, keyed by `chat_key`."""

    def __init__(self, store: _StoreProtocol) -> None:
        self._store = store

    async def load(self, chat_key: str) -> MvuTree:
        """Load and normalize this room's variable tree; ``{}`` on a miss or corrupt value."""
        raw = await self._store.get(user_key="", store_key=_store_key(chat_key))
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except (ValueError, TypeError, RecursionError):
            return {}
        return normalize_tree(data)

    async def save(self, chat_key: str, tree: MvuTree) -> None:
        """Persist `tree` verbatim (already normalized/validated by the caller)."""
        await self._store.set(user_key="", store_key=_store_key(chat_key), value=json.dumps(tree, ensure_ascii=False))

    async def init_from_initvar(self, chat_key: str, parsed: dict) -> bool:
        """Deep-merge a parsed InitVar tree into this room's state — EXISTING VALUES WIN, so a
        re-import never resets progress. Returns whether anything new was added (and saved)."""
        incoming = normalize_tree(parsed)
        if not incoming:
            return False
        merged = await self.load(chat_key)
        if not _merge_missing(merged, incoming):
            return False
        await self.save(chat_key, merged)
        return True

    async def apply_text(self, chat_key: str, text: str) -> tuple[str, list[dict[str, Any]], list[str]]:
        """Run one model reply through the MVU text protocol: extract ``<UpdateVariable>``
        blocks, apply the commands to this room's tree, and persist when anything applied.
        Returns ``(cleaned_text, applied_commands, errors)``. (Block parsing runs before the
        store load so ordinary narration — the hot path — never touches the store.)"""
        commands, cleaned = parse_update_blocks(text)
        if not commands:
            return cleaned, [], []
        tree = await self.load(chat_key)
        new_tree, applied, errors = apply_commands(tree, commands)
        if applied:
            await self.save(chat_key, new_tree)
        return cleaned, applied, errors

    async def flatten(self, chat_key: str, limit: int = MAX_FLAT_LEAVES) -> list[dict[str, Any]]:
        """Load this room's tree and flatten it via `flatten_leaves`."""
        return flatten_leaves(await self.load(chat_key), limit)

    async def has_data(self, chat_key: str) -> bool:
        """Whether this room has any (recoverable) MVU state."""
        return bool(await self.load(chat_key))
