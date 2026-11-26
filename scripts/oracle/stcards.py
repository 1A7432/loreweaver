"""One-time oracle exporter: SillyTavern card behaviour of the frozen Python engine.

Records "format-level input -> what the validated Python implementation does" vectors for
the ST-compatibility surface the TypeScript rebuild keeps as a feature: card parsing (ST
v1/v2/v3 JSON, PNG-embedded cards, the native lorecard), the card split, worldbook import
normalization and activation over a sequence of turns, ST macros, `@@decorator` lines, MVU
variables (`[InitVar]` + `<UpdateVariable>`), and full / subset EJS templates.

Inputs come only from public test fixtures, the vendored ejs/lodash the engine loads itself,
literals copied from public tests, and literals written here. Every random draw the engine
makes (worldbook `probability`, inclusion groups, `{{random}}`/`{{pick}}`, `{{roll}}`) is fed
from a scripted source and recorded in the vector, so the other side can replay it.

Run alone: ``.venv/bin/python -m scripts.oracle.stcards``.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import gzip
import hashlib
import io
import json
import struct
import zlib
from pathlib import Path
from typing import Any

from core import card_split, charcard, ejs_lite, lorecard, mvu_compat, worldbook
from core.ejs_full import EjsFullError, build_room_engine, create_full_engine, quickjs_available
from core.varspace import build_resolver
from infra.i18n import I18n
from infra.store import Store

REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / "server" / "test" / "fixtures" / "reference"
FIXTURES = REPO / "tests" / "fixtures"
ROOM = "room1"
GZIP_THRESHOLD = 1_000_000

# ---------------------------------------------------------------------------
# Deterministic writer (private: same format rules as the shared oracle writer)
# ---------------------------------------------------------------------------


def _dumps(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _write(name: str, rows: list[dict[str, Any]]) -> tuple[str, int, str]:
    payload = "".join(_dumps(row) + "\n" for row in rows).encode("utf-8")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{name}.jsonl"
    if len(payload) > GZIP_THRESHOLD:
        filename += ".gz"
        buffer = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as handle:
            handle.write(payload)
        payload = buffer.getvalue()
    stale = OUT_DIR / (filename[:-3] if filename.endswith(".gz") else filename + ".gz")
    if stale.exists():
        stale.unlink()
    (OUT_DIR / filename).write_bytes(payload)
    return filename, len(rows), hashlib.sha256(payload).hexdigest()


def _jsonable(value: Any) -> Any:
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return value


def _error(exc: BaseException) -> dict[str, str]:
    return {"type": type(exc).__name__, "message": str(exc)}


# ---------------------------------------------------------------------------
# Scripted randomness — every draw is taken from a script and recorded
# ---------------------------------------------------------------------------


def _label(item: Any) -> Any:
    return item.title if isinstance(item, worldbook.LoreEntry) else item


class ScriptedRng:
    """A `random.Random` stand-in: `randint` returns the next scripted int, `choices` and
    `choice` return the element at the next scripted index. Exhaustion is a hard error."""

    def __init__(self, script: list[int] | None = None) -> None:
        self.script = list(script or [])
        self.draws: list[dict[str, Any]] = []

    def _next(self, method: str) -> int:
        if not self.script:
            raise RuntimeError(f"scripted rng exhausted at {method}")
        return self.script.pop(0)

    def randint(self, low: int, high: int) -> int:
        value = self._next("randint")
        assert low <= value <= high, (low, high, value)
        self.draws.append({"method": "randint", "args": [low, high], "value": value})
        return value

    def choices(self, population: list[Any], weights: list[int] | None = None, k: int = 1) -> list[Any]:
        assert k == 1
        index = self._next("choices")
        picked = population[index]
        self.draws.append(
            {
                "method": "choices",
                "population": [_label(item) for item in population],
                "weights": list(weights) if weights is not None else None,
                "index": index,
                "value": _label(picked),
            }
        )
        return [picked]

    def choice(self, seq: list[Any]) -> Any:
        index = self._next("choice")
        self.draws.append({"method": "choice", "options": list(seq), "index": index, "value": seq[index]})
        return seq[index]


class ScriptedRoller:
    """Backs `{{roll:...}}`: maps a dice expression to a scripted total (or raises)."""

    def __init__(self, table: dict[str, Any] | None = None) -> None:
        self.table = dict(table or {})
        self.draws: list[dict[str, Any]] = []

    def __call__(self, expr: str) -> str:
        if expr not in self.table or self.table[expr] == "raise":
            self.draws.append({"method": "roll", "expr": expr, "value": None, "raised": True})
            raise ValueError(f"bad dice expression {expr!r}")
        value = self.table[expr]
        self.draws.append({"method": "roll", "expr": expr, "value": value, "raised": False})
        return str(value)


# ---------------------------------------------------------------------------
# Shared views
# ---------------------------------------------------------------------------

_CARD_FIELDS = (
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
    "tags",
    "character_book",
)


def _card_view(card: charcard.CharacterCard, *, raw: bool = True) -> dict[str, Any]:
    view = {name: _jsonable(getattr(card, name)) for name in _CARD_FIELDS}
    if raw:
        view["raw"] = _jsonable(card.raw)
    return view


def _entry_view(entry: worldbook.LoreEntry) -> dict[str, Any]:
    data = entry.to_dict()
    data.pop("id", None)
    return data


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    head = struct.pack(">I", len(payload)) + kind + payload
    return head + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def _png(*chunks: tuple[bytes, bytes]) -> bytes:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    body = b"".join(_png_chunk(kind, payload) for kind, payload in chunks)
    return charcard.PNG_SIGNATURE + _png_chunk(b"IHDR", ihdr) + body + _png_chunk(b"IEND", b"")


def _b64_json(obj: Any) -> bytes:
    return base64.b64encode(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def _text_chunk(payload: bytes, keyword: bytes = b"chara") -> tuple[bytes, bytes]:
    return b"tEXt", keyword + b"\x00" + payload


def _ztxt_chunk(payload: bytes, keyword: bytes = b"chara", method: int = 0) -> tuple[bytes, bytes]:
    return b"zTXt", keyword + b"\x00" + bytes([method]) + zlib.compress(payload)


def _itxt_chunk(payload: bytes, *, compressed: bool, keyword: bytes = b"chara") -> tuple[bytes, bytes]:
    body = zlib.compress(payload) if compressed else payload
    return b"iTXt", keyword + b"\x00" + (b"\x01" if compressed else b"\x00") + b"\x00" + b"\x00" + b"\x00" + body


def _fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _fixture_json(name: str) -> Any:
    return json.loads(_fixture_bytes(name).decode("utf-8"))


# A v2 persona card with every body field and an embedded character_book, written for
# this exporter. (`cards/` in this repository is untracked, user-supplied material and
# is never an input.)
V2_COMPANION: dict[str, Any] = {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "林檎",
        "description": "{{char}}是一名旧书店的店员，记性极好，说话慢。",
        "personality": "谨慎、好奇、不爱下结论",
        "scenario": "{{user}}在雨天走进了巷子尽头的旧书店。",
        "first_mes": "欢迎光临。要找哪一类的书？",
        "mes_example": "<START>\n{{user}}: 这本多少钱？\n{{char}}: 标签在扉页上。",
        "creator_notes": "A sample companion card for the reference vectors.",
        "system_prompt": "Stay in character as {{char}}.",
        "post_history_instructions": "Keep replies under three sentences.",
        "alternate_greetings": [],
        "tags": ["companion", "bookshop", "sample", "zh", "slice-of-life", "v2"],
        "creator": "loreweaver",
        "character_version": "1.0",
        "character_book": {
            "name": "旧书店",
            "scan_depth": 4,
            "token_budget": 400,
            "recursive_scanning": False,
            "entries": [
                {"keys": ["书店", "店里"], "content": "书店只有一间屋，靠墙是到顶的书架。", "enabled": True,
                 "insertion_order": 10, "name": "店面", "constant": False},
                {"keys": ["账本"], "secondary_keys": ["柜台"], "selective": True,
                 "content": "柜台下的账本记着每一本书的来处。", "enabled": True, "insertion_order": 20, "name": "账本"},
                {"keys": [], "content": "{{char}}从不谈论书店的前一任主人。", "enabled": True,
                 "insertion_order": 5, "name": "禁忌", "constant": True},
            ],
        },
    },
}


def _companion_card() -> Any:
    return json.loads(json.dumps(V2_COMPANION))


def _input_view(data: bytes, filename: str) -> dict[str, Any]:
    view: dict[str, Any] = {"filename": filename}
    if not data.startswith(charcard.PNG_SIGNATURE):
        try:
            view["text"] = data.decode("utf-8")
            return view
        except UnicodeDecodeError:
            pass
    view["b64"] = base64.b64encode(data).decode("ascii")
    return view


# ---------------------------------------------------------------------------
# 1. Card parsing
# ---------------------------------------------------------------------------

V2_ADA = {"spec": "chara_card_v2", "data": {"name": "Ada", "description": "scholar"}}

HOOK_SOURCE = "on('turn_start', () => {});"


def _lore_entry(**overrides: Any) -> dict[str, Any]:
    """One native lorecard worldbook row, as the studio's exporter emits it."""
    entry = {
        "title": "Untitled Lore",
        "content": "...",
        "keys": [],
        "category": "lore",
        "secret": False,
        "constant": False,
        "priority": 0,
        "enabled": True,
        "condition": "",
        "secondary_keys": [],
        "selective_logic": "and_any",
        "probability": 100,
        "case_sensitive": False,
        "match_whole_words": False,
        "scan_depth": 0,
        "position": "",
        "sticky": 0,
        "cooldown": 0,
        "delay": 0,
    }
    entry.update(overrides)
    return entry


def _native_bundle(**overrides: Any) -> dict[str, Any]:
    bundle = {
        "format": "loreweaver.card",
        "format_version": 1,
        "name": "雾锁山庄",
        "description": "A rain-soaked manor on the cliff road.",
        "personality": "Watchful.",
        "scenario": "The guests arrive at dusk.",
        "opening": "The door swings open.",
        "dialogue_examples": "<START>\n{{user}}: Hello.",
        "alternate_openings": ["Lightning splits the sky.", "   ", ""],
        "author_notes": "Run it slow.",
        "tags": ["mystery", "克苏鲁"],
        "variables": [
            {
                "id": "suspicion",
                "kind": "number",
                "visibility": "player",
                "labels": {"en": "Suspicion", "zh": "怀疑度"},
                "default": 0,
                "minimum": 0,
                "maximum": 10,
            },
            {
                "id": "culprit",
                "kind": "enum",
                "visibility": "keeper",
                "labels": {"en": "Culprit", "zh": "凶手"},
                "default": "butler",
                "options": ["butler", "heir", "doctor"],
            },
            {"id": "mood", "kind": "colour", "visibility": "player", "labels": {}, "default": "grey"},
        ],
        "worldbook": [
            _lore_entry(title="山庄", content="The manor looms over the road.", keys=["山庄", "manor"], priority=5),
            _lore_entry(title="The Culprit", content="The butler did it.", keys=["butler"], secret=True, constant=True),
            _lore_entry(
                title="Suspicion Rises",
                content="The guests stop meeting your eye.",
                keys=["guests"],
                secondary_keys=["dinner", "study"],
                selective_logic="and_all",
                condition="suspicion >= 5",
                position="before",
                probability=70,
                case_sensitive=True,
                match_whole_words=True,
                scan_depth=4,
                sticky=2,
                cooldown=3,
                delay=1,
            ),
            "not an entry at all",
            _lore_entry(title="Blank", content="   "),
        ],
        "hooks": [HOOK_SOURCE],
    }
    bundle.update(overrides)
    return bundle


def _parse_cases() -> list[tuple[str, str, bytes, str]]:
    """(case, note, bytes, filename)."""
    j = lambda obj: json.dumps(obj, ensure_ascii=False).encode("utf-8")  # noqa: E731
    cases: list[tuple[str, str, bytes, str]] = [
        ("v2_minimal", "chara_card_v2: fields come from `data`", j(V2_ADA), "ada.json"),
        ("v3_studio_fixture", "chara_card_v3 export from the card studio (public fixture)",
         _fixture_bytes("studio_export.st.json"), "studio_export.st.json"),
        ("v2_companion_full", "a v2 persona card with every body field and an embedded character_book",
         j(V2_COMPANION), "companion.json"),
        ("v1_flat", "no `spec`: the root object is the card body (v1 shape)",
         j({"name": "Bert", "description": "A valet.", "personality": "dry", "first_mes": "Sir?",
            "mes_example": "<START>", "scenario": "A house.", "tags": ["butler"]}), "bert.json"),
        ("v2_data_not_object", "spec v2 but `data` is not an object: every field empty",
         j({"spec": "chara_card_v2", "data": "oops", "name": "Root"}), "x.json"),
        ("unknown_spec_uses_root", "an unknown spec string reads the ROOT, not `data`",
         j({"spec": "chara_card_v4", "name": "RootName", "data": {"name": "DataName"}}), "x.json"),
        ("v3_spec_reads_data", "chara_card_v3 reads `data`",
         j({"spec": "chara_card_v3", "name": "RootName", "data": {"name": "DataName"}}), "x.json"),
        ("book_entries_not_list", "character_book.entries not a list -> no entries",
         j({"spec": "chara_card_v2", "data": {"name": "N", "character_book": {"entries": {"0": {"content": "x"}}}}}),
         "x.json"),
        ("book_not_object", "character_book is a list (not an object) -> no entries",
         j({"spec": "chara_card_v2", "data": {"name": "N", "character_book": [{"content": "x"}]}}), "x.json"),
        ("book_filters_non_dict_entries", "non-object entries are dropped, objects kept verbatim",
         j({"spec": "chara_card_v2", "data": {"name": "N", "character_book": {
             "entries": [{"keys": ["a"], "content": "A", "extensions": {"x": 1}}, "junk", 3, None, {"content": "B"}]}}}),
         "x.json"),
        ("tags_coercion", "tags: non-strings stringified, empty/None dropped",
         j({"spec": "chara_card_v2", "data": {"name": "N", "tags": ["a", "", None, 3, True, "b"]}}), "x.json"),
        ("tags_not_list", "tags given as a string -> []",
         j({"spec": "chara_card_v2", "data": {"name": "N", "tags": "a,b"}}), "x.json"),
        ("non_string_fields", "numbers/bools/objects are str()-ed (Python repr for objects); null -> ''",
         j({"spec": "chara_card_v2", "data": {"name": 42, "description": None, "personality": True,
                                              "scenario": {"a": 1}, "first_mes": [1, "x"], "mes_example": 1.5}}),
         "x.json"),
        ("creator_notes_multilingual_fallback", "creator_notes empty -> creator_notes_multilingual (str()-ed)",
         j({"spec": "chara_card_v2", "data": {"name": "N", "creator_notes": "",
                                              "creator_notes_multilingual": {"en": "hi", "zh": "你好"}}}), "x.json"),
        ("creator_notes_wins", "non-empty creator_notes wins over the multilingual field",
         j({"spec": "chara_card_v2", "data": {"name": "N", "creator_notes": "plain",
                                              "creator_notes_multilingual": {"en": "hi"}}}), "x.json"),
        ("directives_parsed", "system_prompt / post_history_instructions are parsed",
         j({"spec": "chara_card_v2", "data": {"name": "N", "system_prompt": "Be terse.",
                                              "post_history_instructions": "Stay in character."}}), "x.json"),
        ("utf8_bom", "a UTF-8 BOM before the JSON is tolerated",
         b"\xef\xbb\xbf" + j(V2_ADA), "ada.json"),
        ("json_sniffed_without_extension", "leading whitespace + `{` is JSON even without a .json name",
         b"  \n" + j(V2_ADA), "card.bin"),
        ("json_array_top_level", "a JSON array is rejected", j([V2_ADA]), "x.json"),
        ("json_invalid_with_json_name", "invalid JSON under a .json name raises the raw JSON decode error",
         b"{not json", "broken.json"),
        ("json_invalid_without_name", "invalid JSON that looks like JSON (leading `{`) raises the raw decode error",
         b"{not json", ""),
        ("unsupported_bytes", "neither JSON nor PNG", b"GIF89a\x00\x01binary", "x.gif"),
        ("non_json_text_without_name", "plain text that is not JSON", b"hello world", "notes.txt"),
        ("json_scalar_fallback", "bytes not sniffed as JSON but decoding to a JSON scalar -> not an object",
         b"42", "x.txt"),
    ]

    v2 = {"spec": "chara_card_v2", "data": {"name": "Ada", "description": "scholar"}}
    v3 = {"spec": "chara_card_v3", "data": {"name": "Ada3", "description": "v3 scholar"}}
    cases += [
        ("png_text_chara", "PNG tEXt chunk keyword `chara`, base64 JSON", _png(_text_chunk(_b64_json(v2))), "a.png"),
        ("png_text_ccv3", "PNG tEXt chunk keyword `ccv3`", _png(_text_chunk(_b64_json(v3), b"ccv3")), "a.png"),
        ("png_first_card_chunk_wins", "chara before ccv3: the FIRST card chunk in file order wins",
         _png(_text_chunk(_b64_json(v2)), _text_chunk(_b64_json(v3), b"ccv3")), "a.png"),
        ("png_ccv3_first", "ccv3 before chara: ccv3 wins (file order, not keyword priority)",
         _png(_text_chunk(_b64_json(v3), b"ccv3"), _text_chunk(_b64_json(v2))), "a.png"),
        ("png_ztxt", "zTXt (zlib) chunk", _png(_ztxt_chunk(_b64_json(v2))), "a.png"),
        ("png_ztxt_bad_method_skipped", "zTXt with compression method 1 is skipped -> no card",
         _png(_ztxt_chunk(_b64_json(v2), method=1)), "a.png"),
        ("png_itxt_compressed", "iTXt compressed", _png(_itxt_chunk(_b64_json(v2), compressed=True)), "a.png"),
        ("png_itxt_uncompressed", "iTXt uncompressed", _png(_itxt_chunk(_b64_json(v2), compressed=False)), "a.png"),
        ("png_other_keyword_ignored", "a tEXt chunk with another keyword is ignored, a later chara is used",
         _png(_text_chunk(b"made with paint", b"Comment"), _text_chunk(_b64_json(v2))), "a.png"),
        ("png_text_without_separator", "tEXt without a NUL separator is skipped -> no card",
         _png((b"tEXt", b"chara" + _b64_json(v2))), "a.png"),
        ("png_no_card", "a PNG without any card chunk", _png(), "a.png"),
        ("png_invalid_base64_json", "payload decodes to non-JSON", _png(_text_chunk(b"bm90IGpzb24=")), "a.png"),
        ("png_payload_not_object", "payload is a JSON array", _png(_text_chunk(_b64_json([1, 2]))), "a.png"),
        ("png_base64_with_newlines", "base64 wrapped with newlines/spaces is tolerated (non-strict decode)",
         _png(_text_chunk(b"\n ".join(_b64_json(v2)[i:i + 16] for i in range(0, len(_b64_json(v2)), 16)))), "a.png"),
        ("png_truncated_chunk", "a chunk whose length runs past EOF stops the walk -> no card",
         charcard.PNG_SIGNATURE + struct.pack(">I", 9999) + b"tEXtchara\x00abc", "a.png"),
        ("png_ztxt_zlib_bomb", "decompressed text above 4 MiB is refused",
         _png((b"zTXt", b"chara\x00\x00" + zlib.compress(b"A" * (charcard.MAX_DECOMPRESSED_BYTES + 1), 9))),
         "a.png"),
        ("png_studio_fixture", "PNG exported by the card studio (public fixture)",
         _fixture_bytes("studio_export.png"), "studio_export.png"),
        ("png_named_json", "PNG bytes under a .json filename go down the JSON path and fail to decode",
         _png(_text_chunk(_b64_json(v2))), "a.json"),
    ]

    bundle = _native_bundle()
    cases += [
        ("lorecard_full", "native lorecard: every field, junk rows/invalid variable skipped with warnings",
         j(bundle), "manor.lorecard.json"),
        ("lorecard_studio_fixture", "native lorecard exported by the card studio (public fixture)",
         _fixture_bytes("studio_export.lorecard.json"), "studio_export.lorecard.json"),
        ("lorecard_minimal", "only the format tag + version", j({"format": "loreweaver.card", "format_version": 1}),
         "min.lorecard.json"),
        ("lorecard_version_zero", "format_version 0 (pre-freeze) is refused",
         j({"format": "loreweaver.card", "format_version": 0}), "old.lorecard.json"),
        ("lorecard_version_newer", "format_version 2 is newer than this build",
         j({"format": "loreweaver.card", "format_version": 2}), "new.lorecard.json"),
        ("lorecard_version_string", "format_version must be an integer",
         j({"format": "loreweaver.card", "format_version": "1"}), "s.lorecard.json"),
        ("lorecard_version_bool", "a boolean format_version is refused",
         j({"format": "loreweaver.card", "format_version": True}), "b.lorecard.json"),
        ("lorecard_wrong_typed_sections", "wrong-typed sections warn instead of raising",
         j({"format": "loreweaver.card", "format_version": 1, "worldbook": {"a": 1}, "variables": "x",
            "hooks": 5, "pregens": {"a": 1}, "tags": "solo-tag", "alternate_openings": "one"}), "w.lorecard.json"),
        ("lorecard_hooks_string", "a bare string hooks value counts as one script",
         j({"format": "loreweaver.card", "format_version": 1, "hooks": HOOK_SOURCE}), "h.lorecard.json"),
        ("lorecard_hooks_mixed", "hooks: strings and {code} objects; blank/non-string dropped",
         j({"format": "loreweaver.card", "format_version": 1,
            "hooks": [HOOK_SOURCE, {"code": "on('x',()=>{});"}, "  ", {"code": 5}, 7, {"nocode": 1}]}),
         "h.lorecard.json"),
        ("lorecard_condition_multiline", "a multi-line condition collapses onto one `@@if` line",
         j({"format": "loreweaver.card", "format_version": 1,
            "worldbook": [_lore_entry(title="c", content="body", condition="a >= 1\n  &&   b")]}), "c.lorecard.json"),
        ("lorecard_condition_overlong", "a >500-char condition warns but still imports",
         j({"format": "loreweaver.card", "format_version": 1,
            "worldbook": [_lore_entry(title="c", content="body", condition="x == 1 && " * 60 + "y")]}),
         "c.lorecard.json"),
        ("lorecard_entry_coercions", "entry field coercion: clamps, bad ints, unknown logic/position, id, title",
         j({"format": "loreweaver.card", "format_version": 1, "worldbook": [
             {"content": "a", "probability": 150, "scan_depth": -3, "sticky": 5000, "cooldown": "x", "delay": None,
              "selective_logic": "xor", "position": "middle", "id": "  e1 ", "title": "  ", "keys": "solo",
              "secondary_keys": ["", " s "], "priority": "7", "enabled": None, "constant": 1, "secret": 0,
              "category": ""},
             {"content": 12345, "title": "num", "position": "after"},
             {"content": {"x": 1}, "title": "dict content"},
         ]}), "e.lorecard.json"),
        ("lorecard_entry_over_cap", "an entry over 16000 chars is skipped with a warning",
         j({"format": "loreweaver.card", "format_version": 1, "worldbook": [
             _lore_entry(title="big", content="x" * (lorecard.MAX_LORECARD_ENTRY_CONTENT_CHARS + 1)),
             _lore_entry(title="ok", content="fine")]}), "big.lorecard.json"),
        ("lorecard_entry_count_cap", "more than 200 worldbook entries is fatal",
         j({"format": "loreweaver.card", "format_version": 1,
            "worldbook": [{"title": f"e{i}", "content": "x"} for i in range(lorecard.MAX_LORECARD_ENTRIES + 1)]}),
         "many.lorecard.json"),
        ("lorecard_variable_count_cap", "more than 64 variables is fatal",
         j({"format": "loreweaver.card", "format_version": 1,
            "variables": [{"id": f"v{i}", "kind": "number", "default": 0} for i in range(lorecard.MAX_LORECARD_VARIABLES + 1)]}),
         "vars.lorecard.json"),
        ("lorecard_variables_duplicate_and_labels", "duplicate ids skipped; option_labels on a non-enum warns",
         j({"format": "loreweaver.card", "format_version": 1, "variables": [
             {"id": "a", "kind": "number", "default": 1},
             {"id": "a", "kind": "number", "default": 2},
             {"id": "b", "kind": "text", "default": "x", "option_labels": {"en": {"x": "X"}}},
             {"id": "c", "kind": "enum", "default": "p", "options": ["p", "q"],
              "option_labels": {"en": {"p": "P", "zzz": "Z"}}},
             "not a spec",
         ]}), "v.lorecard.json"),
        ("lorecard_pregens", "pregens: normalized, capped at 8, junk skipped",
         j({"format": "loreweaver.card", "format_version": 1, "pregens": [
             {"name": "  Ada  ", "concept": "scholar", "notes": "n", "skills": {"Library Use": "60", "Spot": "x"}},
             {"name": "", "concept": "nameless"},
             "junk",
             {"name": "Bo", "blurb": "boxer", "skills": [1, 2]},
             *[{"name": f"P{i}"} for i in range(8)],
         ]}), "p.lorecard.json"),
        ("lorecard_not_json", "lorecard-looking bytes that are not JSON go to the ST parser",
         b'{"format": "loreweaver.card", broken', "bad.lorecard.json"),
        ("lorecard_tag_inside_string_only", "the tag appearing only as a value elsewhere is not a lorecard",
         j({"spec": "chara_card_v2", "data": {"name": "N", "description": "format: loreweaver.card"}}), "x.json"),
        ("lorecard_json_array", "a JSON array mentioning the tag is not a lorecard",
         j([{"format": "loreweaver.card"}]), "x.json"),
    ]
    return cases


def export_card_parse() -> list[dict[str, Any]]:
    rows = []
    for case, note, data, filename in _parse_cases():
        row: dict[str, Any] = {"case": case, "note": note, "input": _input_view(data, filename)}
        is_lorecard = lorecard.looks_like_lorecard(data)
        row["looks_like_lorecard"] = is_lorecard
        row["dispatch"] = "lorecard" if is_lorecard else "st"
        try:
            if is_lorecard:
                parsed = lorecard.parse_lorecard_bytes(data, filename)
                row["card"] = _card_view(parsed.card, raw=False)
                row["lorecard"] = {
                    "alternate_greetings": list(parsed.alternate_greetings),
                    "hooks": list(parsed.hooks),
                    "variable_specs": _jsonable(list(parsed.variable_specs)),
                    "pregens": _jsonable(list(parsed.pregens)),
                    "warnings": list(parsed.warnings),
                }
            else:
                card = charcard.parse_card_bytes(data, filename)
                # `raw` is the input JSON verbatim; it is recorded only when the input was a
                # PNG (the embedded document is not otherwise visible in the vector).
                row["card"] = _card_view(card, raw=data.startswith(charcard.PNG_SIGNATURE))
            row["ok"] = True
        except Exception as exc:  # noqa: BLE001 — the failure class IS the vector
            row["ok"] = False
            row["error"] = _error(exc)
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# 2. Card split (+ what each import path keeps)
# ---------------------------------------------------------------------------


def _heavy_card_raw() -> dict[str, Any]:
    return {
        "spec": "chara_card_v2",
        "data": {
            "name": "理",
            "description": "A caretaker. <% setvar('好感度', 50) %>Quiet.",
            "personality": "curious <%= getvar('mood') %>",
            "scenario": "An old manor.",
            "first_mes": "Hello.",
            "alternate_greetings": ["<%= getvar('mood') %> Good evening."],
            "tags": ["mystery"],
            "extensions": {
                "loreweaver_hooks": [HOOK_SOURCE, {"code": "on('reply_ready', () => {});"}],
                "unrelated": {"keep": "me"},
            },
            "character_book": {"entries": [
                {"comment": "[InitVar]变量初始化", "content": '{"理": {"好感度": [33, "affinity"]}}'},
                {"comment": "manor", "keys": ["manor"], "content": "The manor. <% incvar('visits') %> It looms."},
                {"comment": "plain", "keys": ["door"], "content": "The door is locked."},
            ]},
        },
    }


def _split_cases() -> list[tuple[str, str, Any]]:
    v2 = lambda data: {"spec": "chara_card_v2", "data": data}  # noqa: E731
    return [
        ("heavy_card", "hooks + [InitVar] + EJS in prose and lore: a world card", _heavy_card_raw()),
        ("plain_persona", "no machinery: a character card, raw passed through",
         {"name": "Bert", "description": "A valet.",
          "character_book": {"entries": [{"comment": "plain", "keys": ["hat"], "content": "A fine hat."}]}}),
        ("root_extensions_hooks_v1", "v1 card with root-level extensions.loreweaver_hooks",
         {"name": "V1", "extensions": {"loreweaver_hooks": ["on('turn_start',()=>{});"]}}),
        ("root_hooks_shadowed_by_data_extensions",
         "v2 card: data.extensions exists WITHOUT hooks, so root-level extensions hooks are not looked at",
         {"spec": "chara_card_v2", "extensions": {"loreweaver_hooks": [HOOK_SOURCE]},
          "data": {"name": "Shadow", "extensions": {"other": 1}}}),
        ("top_level_hooks_on_st_card", "a top-level `hooks` list is read off ANY card's raw, not only lorecards",
         {"spec": "chara_card_v2", "hooks": [HOOK_SOURCE], "data": {"name": "TopHooks"}}),
        ("hooks_blank_and_junk", "blank hook strings and non-string codes are not counted",
         v2({"name": "H", "extensions": {"loreweaver_hooks": ["  ", {"code": ""}, {"code": 3}, 4, "real();"]}})),
        ("directives_only", "system_prompt/post_history_instructions are blanked but do not make a world card",
         v2({"name": "D", "description": "plain", "system_prompt": "Always answer in verse.",
             "post_history_instructions": "  "})),
        ("directives_both", "both directives present: directives=2, raw keys removed",
         v2({"name": "D2", "system_prompt": "A", "post_history_instructions": "B", "extensions": {"x": 1}})),
        ("dangling_ejs", "an unclosed `<%` strips to end of text (counted once)",
         v2({"name": "E", "description": "safe <% broken", "scenario": "a<% one %>b<%= two %>c"})),
        ("ejs_in_greetings_and_title_kept", "EJS in alternate_greetings (raw), entry titles and keys is NOT stripped",
         v2({"name": "<%= n %>", "alternate_greetings": ["<% setvar('x',1) %>hi"],
             "character_book": {"entries": [{"comment": "t<%= x %>", "keys": ["<%= k %>"], "content": "ok"}]}})),
        ("initial_variables_title", "`[Initial Variables]` title counts as a variable declaration",
         v2({"name": "IV", "character_book": {"entries": [
             {"comment": "[Initial Variables]", "content": '{"a": 1}'},
             {"comment": "lore", "keys": ["x"], "content": "X"}]}})),
        ("initial_variables_decorator", "`@@initial_variables` decorator counts as a declaration",
         v2({"name": "IV2", "character_book": {"entries": [
             {"comment": "vars", "content": "@@initial_variables\n{\"hp\": [10, \"health\"]}"}]}})),
        ("initvar_in_name_field", "the declaration marker may sit in `name` when title/comment are absent",
         v2({"name": "IV3", "character_book": {"entries": [{"name": "MVU INITVAR", "content": "a: 1\n"}]}})),
        ("secret_entry_top_level", "`secret: true` entries are world machinery (counted, dropped from the half)",
         v2({"name": "S", "character_book": {"entries": [
             {"comment": "truth", "keys": ["truth"], "content": "The butler.", "secret": True},
             {"comment": "lore", "keys": ["x"], "content": "X"}]}})),
        ("secret_in_extensions", "`extensions.secret` is NOT counted by the split, but the player import drops it",
         v2({"name": "S2", "character_book": {"entries": [
             {"comment": "truth", "keys": ["truth"], "content": "The butler.", "extensions": {"secret": True}},
             {"comment": "lore", "keys": ["x"], "content": "X"}]}})),
        ("constant_entry_player_vs_keeper", "constant survives a keeper world import, forced off on a player import",
         v2({"name": "C", "character_book": {"entries": [
             {"comment": "always", "keys": [], "content": "Always on.", "constant": True}]}})),
        ("char_macro_binding", "{{char}} binds statically to the card name on both import paths",
         v2({"name": "络络", "character_book": {"entries": [
             {"comment": "about {{char}}", "keys": ["{{char}}"], "content": "{{char}} fears <BOT>. {{user}} asks."}]}})),
        ("lorecard_native", "native lorecard: secret lore + hooks + variables => world",
         _native_bundle()),
        ("lorecard_plain", "native lorecard with only plain lore => character",
         {"format": "loreweaver.card", "format_version": 1, "name": "Plain",
          "worldbook": [_lore_entry(title="hat", content="A hat.", keys=["hat"])]}),
        ("studio_fixture_v3", "public studio v3 fixture", _fixture_json("studio_export.st.json")),
        ("studio_fixture_lorecard", "public studio lorecard fixture", _fixture_json("studio_export.lorecard.json")),
        ("companion_full", "a full v2 persona card with an embedded character_book", _companion_card()),
    ]


async def _import_view(book: list[dict[str, Any]], *, is_keeper: bool, char_name: str,
                       source: str) -> dict[str, Any]:
    from core.documents import DocumentStore

    store = Store(":memory:")
    manager = worldbook.Worldbook(store)
    skipped: list[str] = []
    unreachable: list[str] = []
    out: dict[str, Any] = {}
    try:
        out["count"] = await manager.import_entries(
            ROOM, book, source=source, is_keeper=is_keeper, char_name=char_name,
            skipped_titles=skipped, unreachable_titles=unreachable,
        )
    except Exception as exc:  # noqa: BLE001
        out["error"] = _error(exc)
    out["entries"] = [_entry_view(entry) for entry in await manager.list(ROOM)]
    out["skipped_titles"] = skipped
    out["unreachable_titles"] = unreachable
    out["mvu_tree"] = await mvu_compat.load_mvu(DocumentStore(store), ROOM)
    return out


async def export_card_split() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for case, note, raw in _split_cases():
        data = json.dumps(raw, ensure_ascii=False).encode("utf-8")
        if lorecard.looks_like_lorecard(data):
            card = lorecard.parse_lorecard_bytes(data, "card.lorecard.json").card
            dispatch = "lorecard"
        else:
            card = charcard.parse_card_bytes(data, "card.json")
            dispatch = "st"
        character, world = card_split.split_card(card)
        player = await _import_view(character.character_book, is_keeper=False, char_name=card.name,
                                    source=card.name)
        keeper = await _import_view(card.character_book, is_keeper=True, char_name=card.name, source=card.name)
        keeper["hooks"] = card_split.card_hook_codes(card)
        rows.append({
            "op": "split_card",
            "case": case,
            "note": note,
            "input": {"card": raw, "dispatch": dispatch},
            "kind": "world" if world.any else "character",
            "payloads": {
                "hooks": world.hooks, "initvar_entries": world.initvar_entries, "ejs_blocks": world.ejs_blocks,
                "secret_entries": world.secret_entries, "directives": world.directives,
                "any": world.any, "any_stripped": world.any_stripped,
            },
            "character_half": _card_view(character),
            "character_half_hooks": card_split.card_hook_codes(character),
            "player_import": player,
            "keeper_world_import": keeper,
        })

    strip_cases = [
        ("adjacent", "two adjacent spans", "a<% one %>b<%= two %>c"),
        ("dangling", "unclosed opener strips to end", "safe <% broken"),
        ("none", "no template", "no templates"),
        ("multiline", "spans may cross lines", "a<% if (x) {\n%>b<% } %>c"),
        ("all_forms", "<%= <%- <%# <%_ and trimming closers are all one span shape",
         "1<%= a %>2<%- b %>3<%# c %>4<%_ d _%>5<% e -%>6"),
        ("percent_literal", "a lone %> without opener is kept", "50%> done"),
        ("dangling_after_span", "a dangling opener after a complete span", "x<% a %>y<% z"),
        ("escape_ejs_block", "the escape-ejs passthrough is not special to the splitter",
         "<#escape-ejs><%% x %%><#/escape-ejs>"),
    ]
    for case, note, text in strip_cases:
        clean, count = card_split.strip_ejs(text)
        rows.append({"op": "strip_ejs", "case": f"strip_{case}", "note": note, "input": {"text": text},
                     "text": clean, "spans_removed": count})

    decl_cases = [
        ("initvar_cjk", {"comment": "「[InitVar]变量初始化」", "content": "{}"}),
        ("initial_variables_spaced", {"title": "[Initial Variables]", "content": "{}"}),
        ("initial_variables_compact_lower", {"comment": "[initialvariables]", "content": "{}"}),
        ("decorator", {"comment": "vars", "content": "@@initial_variables\n{}"}),
        ("decorator_after_blank_first_line", {"comment": "vars", "content": "\n@@initial_variables\n{}"}),
        ("plain", {"comment": "manor", "content": "The manor."}),
        ("init_var_with_space", {"comment": "init var", "content": "{}"}),
        ("title_wins_over_comment", {"title": "lore", "comment": "[InitVar]", "content": "{}"}),
        ("name_fallback", {"name": "initvar block", "content": "{}"}),
        ("initvar_in_content_only", {"comment": "x", "content": "[InitVar]\n{}"}),
    ]
    for case, raw_entry in decl_cases:
        rows.append({"op": "is_variable_declaration_entry", "case": f"decl_{case}",
                     "note": "which worldbook entries count as variable machinery",
                     "input": {"entry": raw_entry},
                     "result": card_split.is_variable_declaration_entry(raw_entry)})
    return rows


# ---------------------------------------------------------------------------
# 3. Worldbook import normalization
# ---------------------------------------------------------------------------


def _import_cases() -> list[dict[str, Any]]:
    from tests.fixtures.overlay_card import card_book

    def single(case: str, note: str, book: Any, *, is_keeper: bool = True, char_name: str = "",
               source: str = "book") -> dict[str, Any]:
        return {"case": case, "note": note,
                "steps": [{"book": book, "is_keeper": is_keeper, "char_name": char_name, "source": source}]}

    big_initvar = "{" + ",".join(f'"k{i}": [{i}, "some longer description text"]' for i in range(150)) + "}"
    cases = [
        single("st_native_field_names", "SillyTavern world-info field names map onto the entry model", [{
            "comment": "st-entry", "content": "lore", "key": ["ritual"], "keysecondary": ["chapel"],
            "selective": True, "selectiveLogic": 3, "probability": 75, "useProbability": True,
            "caseSensitive": True, "matchWholeWords": True, "scanDepth": 4, "position": "before_char",
            "sticky": 2, "cooldown": 3, "delay": 5, "group": "rumors", "groupWeight": 60}]),
        single("v2_character_book_names", "V2 character_book field names", [{
            "comment": "v2", "content": "lore", "keys": ["a", "b"], "secondary_keys": ["c"], "selective": True,
            "selective_logic": "not_any", "insertion_order": 7, "case_sensitive": True, "position": "after_char",
            "enabled": True, "constant": False, "name": "ignored-when-comment-present", "id": 99}]),
        single("selective_off_and_use_probability_off", "selective:false drops secondary keys; useProbability:false => 100",
               [{"comment": "e", "content": "lore", "key": ["k"], "keysecondary": ["s"], "selective": False,
                 "probability": 25, "useProbability": False}]),
        single("use_probability_snake_case", "`use_probability: false` also forces 100",
               [{"comment": "e", "content": "lore", "keys": ["k"], "probability": 10, "use_probability": False}]),
        single("selective_logic_ints", "ST integer selectiveLogic 0..3 and an unknown int",
               [{"comment": f"l{i}", "content": "x", "keys": ["k"], "secondary_keys": ["s"], "selectiveLogic": i}
                for i in (0, 1, 2, 3, 4)]),
        single("selective_logic_bad_string", "an unknown logic string falls back to and_any",
               [{"comment": "l", "content": "x", "keys": ["k"], "secondary_keys": ["s"], "selective_logic": "xor"}]),
        single("position_values", "position: before_char/after_char/0/1 map; other values -> default bucket",
               [{"comment": f"p{index}", "content": "x", "keys": ["k"], "position": value}
                for index, value in enumerate(["before_char", "after_char", 0, 1, 2, 4, "before", "after", None])]),
        single("numeric_clamps", "probability/scan_depth/sticky/cooldown/delay/group_weight clamping and coercion", [
            {"comment": "hi", "content": "x", "keys": ["k"], "probability": 150, "scanDepth": 500, "sticky": 5000,
             "cooldown": 1000, "delay": 99999, "groupWeight": -5},
            {"comment": "lo", "content": "x", "keys": ["k"], "probability": -5, "scanDepth": -1, "sticky": -1,
             "groupWeight": 0},
            {"comment": "junk", "content": "x", "keys": ["k"], "probability": "abc", "priority": "high",
             "insertion_order": 3, "sticky": "2"},
        ]),
        single("priority_vs_insertion_order", "`priority` wins over `insertion_order`; ST-native `order` is not read", [
            {"comment": "both", "content": "x", "keys": ["k"], "priority": 4, "insertion_order": 9},
            {"comment": "io", "content": "x", "keys": ["k"], "insertion_order": 9},
            {"comment": "order", "content": "x", "keys": ["k"], "order": 9},
        ]),
        single("st_native_disable_flag", "ST-native `disable: true` is not read (only `enabled`)", [
            {"comment": "disabled-st", "content": "x", "key": ["k"], "disable": True},
            {"comment": "disabled-v2", "content": "x", "keys": ["k"], "enabled": False},
        ]),
        single("v2_extensions_fields_ignored", "trigger fields carried under V2 `extensions` are not read", [{
            "comment": "ext", "content": "x", "keys": ["k"],
            "extensions": {"probability": 10, "useProbability": True, "selectiveLogic": 3, "group": "g",
                           "sticky": 2, "scan_depth": 3, "case_sensitive": True, "match_whole_words": True,
                           "position": 4, "depth": 4, "category": "npc"}}]),
        single("char_binding", "{{char}}, <char>, <BOT> bind statically to char_name; {{user}} stays",
               [{"comment": "about {{char}}", "content": "{{char}} fears <BOT>'s past. <char>! {{user}} may ask.",
                 "keys": ["{{char}}"], "secondary_keys": ["{{ CHAR }}"]}], char_name="络络"),
        single("char_binding_literal_backslash", "a char name with backslashes is inserted literally",
               [{"comment": "c", "content": "Hi {{char}}", "keys": ["k"]}], char_name="A\\1B\\g<0>"),
        single("char_binding_absent", "without char_name the macros stay",
               [{"comment": "c", "content": "Hi {{char}}", "keys": ["{{char}}"]}]),
        single("at_if_condition", "`@@if` becomes the condition and the decorator line is removed",
               [{"comment": "stage two lore", "content": "@@if variables.stage === 2\nThe cult mobilizes.",
                 "keys": ["cult"]}]),
        single("at_if_without_expression", "`@@if` with no expression is a flag, not a condition",
               [{"comment": "c", "content": "@@if\nbody", "keys": ["k"]}]),
        single("render_only_disabled", "[RENDER:*] titles, @@render_after, @@iframe, @@message_formatting, @@dont_activate import disabled", [
            {"comment": "[RENDER:AFTER]status bar", "content": "<div>hp bar</div>", "keys": ["x"]},
            {"comment": "footer", "content": "@@render_after\n<div>ui</div>", "keys": ["y"]},
            {"comment": "frame", "content": "@@iframe\n<html></html>", "keys": ["y"]},
            {"comment": "fmt", "content": "@@message_formatting\nx", "keys": ["y"]},
            {"comment": "hidden", "content": "@@dont_activate\ndraft", "keys": ["z"]},
            {"comment": "render_before", "content": "@@render_before\nx", "keys": ["z"]},
        ]),
        single("activate_decorator_ignored", "`@@activate` is stripped but does not force constant",
               [{"comment": "a", "content": "@@activate\nalways?", "keys": []}]),
        single("generate_prefix_stripped", "[GENERATE:*] title prefix stripped, entry kept enabled", [
            {"comment": "[GENERATE:BEFORE] opening scene", "content": "It rains.", "keys": ["rain"]},
            {"comment": "[GENERATE:AFTER]", "content": "Only a prefix.", "keys": ["x"]},
        ]),
        single("title_fallbacks", "title: title > comment > name > '<source> <index>'", [
            {"title": "T", "comment": "C", "name": "N", "content": "x"},
            {"comment": "C", "name": "N", "content": "x"},
            {"name": "N", "content": "x"},
            {"content": "x"},
        ], source="mybook"),
        single("title_fallback_no_source", "with no source the fallback is 'Lore <index>'", [{"content": "x"}],
               source=""),
        single("empty_and_junk_entries", "non-dict rows skipped; empty content stored as nothing (not counted)", [
            "junk", 3, None, {"comment": "empty", "content": ""}, {"comment": "decorator only", "content": "@@if x"},
            {"comment": "real", "content": "kept", "keys": "single-key"}]),
        single("content_non_string", "numeric content is stringified", [{"comment": "n", "content": 42, "keys": ["k"]}]),
        single("frontend_residue_disabled", "pure frontend-template residue imports disabled; mixed stays enabled", [
            {"title": "变量列表", "content": "<status_current_variables>{{format_message_variable::stat_data}}</status_current_variables>",
             "keys": [], "constant": True},
            {"title": "带分隔", "content": "---\n<status_current_variables>\n{{format_message_variable::stat_data}}\n</status_current_variables>",
             "keys": [], "constant": True},
            {"title": "纯分隔线条目", "content": "---", "keys": [], "constant": True},
            {"title": "混合", "content": "开场规则照旧。\n<s>{{get_message_variable::x}}</s>\n结尾。", "keys": [],
             "constant": True},
        ]),
        single("index_keyed_entries", "ST world-info export keyed by index", {"entries": {
            "0": {"comment": "Dock", "key": ["dock"], "content": "Wet planks."},
            "1": {"comment": "Bell", "key": ["bell"], "content": "It rings."}}}),
        single("entries_not_list", "a book whose entries is neither list nor dict imports nothing",
               {"entries": "nope"}),
        single("entry_count_cap", "more than 200 entries fails the whole import",
               [{"comment": f"e{i}", "content": "x"} for i in range(worldbook.MAX_IMPORT_ENTRIES + 1)]),
        single("oversize_entry_skipped", "an entry over 16000 chars is skipped and reported by title", [
            {"comment": "huge", "content": "x" * (worldbook.MAX_IMPORT_CONTENT_CHARS + 1), "keys": ["k"]},
            {"comment": "small", "content": "fine", "keys": ["k"]}]),
        single("secret_player_dropped", "a player import drops secret entries (top-level or extensions)", [
            {"comment": "s1", "content": "truth", "keys": ["k"], "secret": True},
            {"comment": "s2", "content": "truth", "keys": ["k"], "extensions": {"secret": True}},
            {"comment": "pub", "content": "public", "keys": ["k"], "constant": True}], is_keeper=False),
        single("secret_keeper_kept", "a keeper import keeps secret and constant", [
            {"comment": "s1", "content": "truth", "keys": ["k"], "secret": True},
            {"comment": "s2", "content": "truth", "keys": ["k"], "extensions": {"secret": True, "category": "npc"}},
            {"comment": "pub", "content": "public", "keys": ["k"], "constant": True}]),
        single("unreachable_titles", "disabled AND keyless entries are reported unreachable", [
            {"comment": "off-keyless", "content": "x", "keys": [], "enabled": False, "constant": True},
            {"comment": "off-keyed", "content": "x", "keys": ["k"], "enabled": False},
            {"comment": "render-keyless", "content": "@@render_after\nx", "keys": []}]),
        single("initvar_keeper_json5", "keeper import consumes [InitVar] (JSON5) into the MVU tree, not lore", [
            {"comment": "[InitVar]变量初始化", "content": '{\n  // starting state\n  "理": {"好感度": [33, "desc"],},\n}'},
            {"comment": "real lore", "content": "The chapel is locked.", "keys": ["chapel"]}]),
        single("initvar_player_dropped", "a player import neither stores nor applies [InitVar]", [
            {"comment": "[InitVar]", "content": '{"真凶": ["管家", "twist"]}'},
            {"comment": "real lore", "content": "The chapel is locked.", "keys": ["chapel"]}], is_keeper=False),
        single("initvar_yaml_decorator", "@@initial_variables with a YAML body", [
            {"comment": "vars", "content": "@@initial_variables\n世界:\n  日: 1\n  天气: 雨\n"}]),
        single("initvar_unparseable", "an unparseable declaration is consumed and seeds nothing", [
            {"comment": "[InitVar]", "content": "this is not a tree"}]),
        single("initvar_bypasses_content_cap", "a long [InitVar] is not subject to the content cap",
               [{"comment": "[InitVar]", "content": big_initvar}]),
        single("overlay_card_fixture", "synthetic real-shaped card book (public fixture): variants, oversize, initvar",
               card_book()),
        {"case": "initvar_existing_values_win", "note": "a second [InitVar] import adds new keys, never resets existing ones",
         "steps": [
             {"book": [{"comment": "[InitVar]", "content": '{"a": 1, "b": {"c": 2}}'}], "is_keeper": True,
              "char_name": "", "source": "card"},
             {"book": [{"comment": "[InitVar]", "content": '{"a": 99, "b": {"c": 99, "d": 3}, "e": 4}'}],
              "is_keeper": True, "char_name": "", "source": "card2"}]},
        {"case": "keeper_reimport_replaces", "note": "a keeper re-import from the same source replaces that source's entries",
         "steps": [
             {"book": [{"comment": "old", "content": "v1", "keys": ["k"]}], "is_keeper": True, "char_name": "",
              "source": "card"},
             {"book": [{"comment": "new", "content": "v2", "keys": ["k"]}], "is_keeper": True, "char_name": "",
              "source": "card"}]},
        {"case": "player_reimport_stacks", "note": "a player re-import from the same source stacks (no removal)",
         "steps": [
             {"book": [{"comment": "old", "content": "v1", "keys": ["k"]}], "is_keeper": False, "char_name": "",
              "source": "card"},
             {"book": [{"comment": "new", "content": "v2", "keys": ["k"]}], "is_keeper": False, "char_name": "",
              "source": "card"}]},
    ]
    return cases


async def export_worldbook_import() -> list[dict[str, Any]]:
    from core.documents import DocumentStore

    rows = []
    for case in _import_cases():
        store = Store(":memory:")
        manager = worldbook.Worldbook(store)
        results = []
        for step in case["steps"]:
            skipped: list[str] = []
            unreachable: list[str] = []
            result: dict[str, Any] = {}
            try:
                result["count"] = await manager.import_entries(
                    ROOM, copy.deepcopy(step["book"]), source=step["source"], is_keeper=step["is_keeper"],
                    char_name=step["char_name"], skipped_titles=skipped, unreachable_titles=unreachable,
                )
            except Exception as exc:  # noqa: BLE001
                result["error"] = _error(exc)
            result["skipped_titles"] = skipped
            result["unreachable_titles"] = unreachable
            result["entries_after"] = [_entry_view(entry) for entry in await manager.list(ROOM)]
            result["mvu_tree_after"] = await mvu_compat.load_mvu(DocumentStore(store), ROOM)
            results.append(result)
        rows.append({"case": case["case"], "note": case["note"], "input": {"steps": case["steps"]},
                     "steps": results})
    return rows


# ---------------------------------------------------------------------------
# 4. Worldbook activation over a sequence of turns
# ---------------------------------------------------------------------------


class _RecordingWorldbook(worldbook.Worldbook):
    """Captures the entries `match` selected and the `activewi` lookups of one injection."""

    def __init__(self, store: Any) -> None:
        super().__init__(store)
        self.last_match: list[worldbook.LoreEntry] = []
        self.extra_lookups: list[worldbook.LoreEntry] = []
        self.recording_extra = False

    async def match(self, *args: Any, **kwargs: Any) -> list[worldbook.LoreEntry]:
        chosen = await super().match(*args, **kwargs)
        self.last_match = list(chosen)
        self.recording_extra = True
        return chosen

    async def effective_get(self, *args: Any, **kwargs: Any) -> worldbook.LoreEntry | None:
        entry = await super().effective_get(*args, **kwargs)
        if self.recording_extra and entry is not None:
            self.extra_lookups.append(entry)
        return entry


class _Ctx:
    chat_key = ROOM


def E(title: str, content: str = "", **fields: Any) -> dict[str, Any]:  # noqa: N802
    """One ST character_book-shaped entry (`comment` = title)."""
    entry: dict[str, Any] = {"comment": title, "content": content or f"[{title}]"}
    entry.update(fields)
    return entry


def T(context: str = "", **fields: Any) -> dict[str, Any]:  # noqa: N802
    turn: dict[str, Any] = {"context": context}
    turn.update(fields)
    return turn


def _activation_cases() -> list[dict[str, Any]]:
    from tests.fixtures.overlay_card import card_book

    C = lambda title, content="", **kw: E(title, content, keys=[], constant=True, **kw)  # noqa: E731,N806
    K = lambda title, keys, content="", **kw: E(title, content, keys=keys, **kw)  # noqa: E731,N806

    def case(name: str, note: str, lorebook: Any, turns: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
        out = {"case": name, "note": note, "lorebook": lorebook, "turns": turns}
        out.update(extra)
        return out

    cases = [
        case("constant_only", "constant entries inject with an empty context", [C("rules", "Rules apply.")], [T()]),
        case("constant_disabled", "a disabled constant never injects", [C("off", enabled=False), C("on")], [T()]),
        case("constant_forced_off_on_player_import", "a player-imported constant is keyword-only",
             [C("rules", "Rules apply.")], [T(), T("rules")], **{"import": {"is_keeper": False}}),
        case("primary_key_hit", "a primary key found in the context", [K("well", ["well"], "The well is dry.")],
             [T("we go to the well"), T("nothing here")]),
        case("any_primary_key", "any one of several primary keys suffices",
             [K("bell", ["bell", "chime", "钟"], "It rings.")], [T("a chime"), T("钟声"), T("silence")]),
        case("empty_keys_never_fire", "a non-constant entry without keys never fires", [K("nokeys", [])], [T("anything")]),
        case("case_insensitive_default", "matching is case-insensitive by default",
             [K("ritual", ["Ritual"])], [T("the RITUAL begins")]),
        case("case_sensitive", "case_sensitive requires exact case",
             [K("ritual", ["Ritual"], case_sensitive=True)], [T("the ritual begins"), T("the Ritual begins")]),
        case("whole_word_ascii", "match_whole_words: ASCII word keys need word boundaries",
             [K("rit", ["rit"], match_whole_words=True), K("rit-sub", ["rit"])], [T("the ritual begins"), T("a rit here")]),
        case("whole_word_cjk_unaffected", "CJK keys ignore whole-word mode",
             [K("仪式", ["仪式"], match_whole_words=True)], [T("黑弥撒仪式开始了")]),
        case("whole_word_non_word_key", "a key with a hyphen/space is never whole-word checked (substring)",
             [K("elf", ["dark-elf"], match_whole_words=True), K("sp", ["old man"], match_whole_words=True)],
             [T("a dark-elfling and the bold mankind"), T("the dark elf")]),
        case("whole_word_unicode_neighbor", "whole-word is ASCII-only: a CJK char next to an ASCII key is a boundary? (\\b over the lowered haystack)",
             [K("gun", ["gun"], match_whole_words=True)], [T("他拿起gun了"), T("shotgun")]),
        case("key_whitespace_trimmed", "keys are trimmed before matching; a blank key never matches",
             [K("pad", ["  well  ", "   "])], [T("the well")]),
    ]

    sec = ["chapel", "crypt"]
    for logic in ("and_any", "and_all", "not_any", "not_all"):
        cases.append(case(
            f"secondary_{logic}", f"secondary keys with selective_logic={logic}",
            [K("omen", ["ritual"], secondary_keys=sec, selective_logic=logic, selective=True)],
            [T("a ritual in the woods"), T("a ritual in the chapel"), T("ritual at the chapel crypt"),
             T("chapel crypt, no primary")]))
    cases += [
        case("secondary_selective_false", "selective:false ignores the secondary keys entirely",
             [K("omen", ["ritual"], secondary_keys=["chapel"], selective=False)], [T("a ritual in the woods")]),
        case("secondary_st_int_logic", "ST integer selectiveLogic 2 = not_any",
             [K("omen", ["ritual"], keysecondary=["chapel"], selectiveLogic=2)],
             [T("a ritual in the woods"), T("a ritual in the chapel")]),
        case("scan_depth_lines", "scan_depth N scans the last N non-empty lines of the context",
             [K("d1", ["ritual"], scanDepth=1), K("d2", ["ritual"], scanDepth=2), K("d0", ["ritual"])],
             [T("the ritual was mentioned\nline2\n\n\nline3"), T("line1\nthe ritual\n\nline3")]),
        case("probability_pass_and_fail", "probability 50: a draw of 30 passes, 80 fails (randint 1..100 <= p)",
             [C("rare", probability=50)], [T(script=[30]), T(script=[80]), T(script=[50]), T(script=[51])]),
        case("probability_zero_and_hundred", "probability 0 never draws or fires; 100 never draws",
             [C("never", probability=0), C("always", probability=100)], [T()]),
        case("probability_use_off", "useProbability:false forces 100 (no draw)",
             [C("forced", probability=1, useProbability=False)], [T()]),
        case("probability_draw_order", "draws happen in entry order over triggered entries with 0<p<100",
             [C("a", probability=10), K("b", ["x"], probability=90), C("c"), C("d", probability=50)],
             [T("x", script=[5, 95, 50]), T("", script=[11, 1])]),
        case("probability_before_secrecy", "the probability roll happens before the viewer/secret filter",
             [C("secret-rare", probability=50, secret=True), C("pub-rare", probability=50)],
             [T(viewer="player", script=[1, 1]), T(viewer="keeper", script=[1, 99])]),
        case("inclusion_group_weighted", "an inclusion group injects ONE member via a weighted pick",
             [C("rumor-a", group="rumors", groupWeight=30), C("rumor-b", group="rumors", groupWeight=70), C("solo")],
             [T(script=[0]), T(script=[1])]),
        case("inclusion_group_single_member", "a group with one triggered member needs no draw",
             [C("lonely", group="g"), K("keyed", ["zzz"], group="g")], [T()]),
        case("inclusion_group_default_weights", "default weight 100; weight 0 imports as 100 (falsy -> default)",
             [C("w-default", group="g"), C("w-zero", group="g", groupWeight=0), C("w-neg", group="g", groupWeight=-3)],
             [T(script=[2])]),
        case("inclusion_group_after_condition", "condition/secret filtering happens BEFORE the group pick",
             [C("g-secret", group="g", secret=True), C("g-pub", group="g"), C("g-cond", group="g", content="@@if hp > 5\nhurt")],
             [T(viewer="player"), T(viewer="keeper", script=[1])], variables={"flat": {"hp": 3}, "tree": {}}),
        case("inclusion_group_reorders", "grouped entries move after ungrouped ones before the stable sort",
             [C("grouped", group="g", insertion_order=5), C("plain", insertion_order=5), C("first", insertion_order=9)],
             [T()]),
        case("inclusion_groups_two", "two groups each pick one, in first-seen group order",
             [C("a1", group="A"), C("b1", group="B"), C("a2", group="A"), C("b2", group="B")], [T(script=[1, 0])]),
        case("ordering_position_priority", "order: position bucket (before, default, after) then priority desc, then document order", [
            C("tail", position="after_char", insertion_order=99), C("mid-low", insertion_order=1),
            C("head", position="before_char", insertion_order=0), C("mid-high", insertion_order=50),
            C("mid-tie-1", insertion_order=1), C("head-2", position=0, insertion_order=3),
        ], [T()]),
        case("limit_truncates", "only the first `limit` after sorting survive",
             [C(f"e{i}", insertion_order=i) for i in range(6)], [T()], limit=3),
        case("budget_skips_and_continues", "an entry that would overflow the char budget is skipped; later smaller ones still fit",
             [C("big", "x" * 60, insertion_order=9), C("mid", "y" * 30, insertion_order=8), C("small", "z" * 10, insertion_order=7)],
             [T()], budget_chars=75),
        case("budget_counts_raw_content", "the budget counts RAW (pre-render) content length",
             [C("tmpl", "<%= 'a' %>" * 5, insertion_order=2), C("next", "12345", insertion_order=1)],
             [T()], budget_chars=52),
        case("budget_zero", "a zero budget injects nothing", [C("a")], [T()], budget_chars=0),
        case("limit_before_budget", "limit applies BEFORE the budget (a skipped entry does not free a slot)",
             [C("huge", "x" * 100, insertion_order=3), C("a", insertion_order=2), C("b", insertion_order=1)],
             [T()], limit=2, budget_chars=50),
        case("browse_defaults", "the match defaults (8 entries / 4000 chars) used by browse paths",
             [C(f"c{i}", "x" * 700, insertion_order=10) for i in range(9)] + [K("scene", ["well"], "the well is dry", insertion_order=8)],
             [T("we go to the well")], limit=8, budget_chars=4000),
        case("secret_viewer", "secret entries inject for the keeper only",
             [C("truth", "The butler did it.", secret=True), C("public", "The manor.")],
             [T(viewer="keeper"), T(viewer="player")]),
        case("condition_closed_grammar", "conditions evaluate over the variables; broken/absent fail closed", [
            C("panic", "@@if fear >= 5\nPanic."), C("calm", "@@if fear < 5\nCalm."),
            C("broken", "@@if 1 ~ 2\nNever."), C("missing", "@@if ghost.value > 1\nNo."),
            C("always", "Always."), C("stage", "@@if variables.stage === 2\nStage two."),
            C("vwd", "@@if stat_data.理.好感度 >= 30\nFond."),
        ], [T()], variables={"flat": {"fear": 7, "stage": 2}, "tree": {"理": {"好感度": [33, "affinity"]}}}),
        case("condition_loose_vs_strict", "== is loose (\"2\" == 2), === is strict",
             [C("loose", "@@if stage == 2\nL"), C("strict", "@@if stage === 2\nS")], [T()],
             variables={"flat": {"stage": "2"}, "tree": {}}),
        case("condition_js_only_no_engine", "an arbitrary-JS @@if fails closed without the full engine",
             [C("js", "@@if [1,2,3].includes(variables.hp)\nIncluded.")], [T()],
             variables={"flat": {"hp": 2}, "tree": {}}),
        case("condition_js_with_engine", "the full engine evaluates an @@if the closed grammar cannot parse",
             [C("js", "@@if [1,2,3].includes(variables.hp)\nIncluded."), C("js-false", "@@if [7].includes(variables.hp)\nNo.")],
             [T()], variables={"flat": {"hp": 2}, "tree": {}}, full_ejs=True),
        case("condition_js_error_with_engine", "a JS @@if that throws fails closed",
             [C("js-throws", "@@if nonexistent.deep.path > 1\nNo.")], [T()], full_ejs=True),
        case("render_lite_ejs", "without the engine, content renders through the EJS subset + macros",
             [C("boarded", "<% if (fear >= 5) { %>Windows are boarded. <% } %>Fear: {{var:fear}} / {{getvar::理.好感度}}")],
             [T()], variables={"flat": {"fear": 7}, "tree": {"理": {"好感度": [33, "affinity"]}}}),
        case("render_full_ejs", "with the engine, content runs as real EJS, then macros",
             [C("loop", "<% for (const i of _.range(3)) { %>[<%= i %>]<% } %> fear={{var:fear}}")],
             [T()], variables={"flat": {"fear": 7}, "tree": {}}, full_ejs=True),
        case("render_full_ejs_error_falls_back", "a full-EJS template error falls back to the subset renderer",
             [C("bad", "a<%= undefined_name_xyz %>b<% if (fear > 1) { %>F<% } %>")],
             [T()], variables={"flat": {"fear": 7}, "tree": {}}, full_ejs=True),
        case("render_bool_python_vs_js", "a boolean renders 'True' through the subset but 'true' through full EJS",
             [C("flag", "<%= getvar('flag') %>|{{getvar::flag}}")], [T()], variables={"flat": {"flag": True}, "tree": {}}),
        case("render_bool_full_engine", "the same entry with the full engine",
             [C("flag", "<%= getvar('flag') %>|{{getvar::flag}}")], [T()], variables={"flat": {"flag": True}, "tree": {}},
             full_ejs=True),
        case("macros_in_content", "ST macros in entry content: user name, game clock, scripted random and roll",
             [C("m", "{{user}} at {{time}} draws {{random::ace::king::queen}} and rolls {{roll:1d20}}. {{// hidden}}{{unknown}}")],
             [T(macro_script=[1], rolls={"1d20": 17})], macros={"names": {"user": "Alice"}, "clock_time": "1926-03-15 22:00"}),
        case("macros_without_clock", "no game clock: {{time}} passes through; no user name: {{user}} passes through",
             [C("m", "{{time}} {{user}} {{char}}")], [T()]),
        case("frontend_residue_scrubbed", "status-bar macros and emptied wrappers are scrubbed at render", [
            C("mixed", "开场规则照旧。\n<status_current_variables>{{format_message_variable::stat_data}}</status_current_variables>\n结尾提示。")],
             [T()]),
        case("activewi_extra_pass", "activewi() force-activates another entry by title (one additive pass)", [
            C("director", "<% activewi('hidden room') %>Director."),
            K("hidden room", ["never-matches"], "A hidden room."),
            K("chain", ["never-matches"], "<% activewi('director') %>chain"),
        ], [T()], full_ejs=True),
        case("activewi_respects_viewer_and_enabled", "activewi honors secrecy for players and skips disabled entries", [
            C("director", "<% activewi('secret room'); activewi('off room'); activewi('nope') %>D."),
            K("secret room", ["zz"], "Secret.", secret=True),
            K("off room", ["zz"], "Off.", enabled=False),
        ], [T(viewer="player"), T(viewer="keeper")], full_ejs=True),
        case("activewi_no_recursion", "an entry pulled in by activewi does not chain further", [
            C("a", "<% activewi('b') %>A"),
            K("b", ["zz"], "<% activewi('c') %>B"),
            K("c", ["zz"], "C"),
        ], [T()], full_ejs=True),
        case("getwi_reads_disabled_entry", "getwi() reads any entry's content, including a disabled one", [
            C("controller", "Mode: <%- getwi('variant-b') %>"),
            K("variant-b", [], "Brutal mode.", enabled=False),
        ], [T()], full_ejs=True),
        case("template_writes_flow_to_next_turn", "template setvar() writes flush to the MVU tree after the turn and gate the next turn", [
            C("counter", "<% incvar('visits') %>visits so far: <%= getvar('visits') %>"),
            C("gate", "@@if visits >= 2\nThe house remembers you."),
        ], [T(), T(), T()], variables={"flat": {}, "tree": {"visits": 0}}, full_ejs=True),
        case("sticky", "sticky N keeps an entry active N more turns without its keys",
             [K("omen", ["ritual"], sticky=2)],
             [T("the ritual begins"), T("quiet day"), T("quiet day"), T("quiet day")]),
        case("cooldown", "cooldown N blocks re-firing for N turns", [K("once", ["ritual"], cooldown=2)],
             [T("ritual!"), T("ritual!"), T("ritual!"), T("ritual!"), T("ritual!")]),
        case("sticky_then_cooldown", "the cooldown window starts after the sticky window ends",
             [K("both", ["ritual"], sticky=1, cooldown=2)],
             [T("ritual"), T("ritual"), T("ritual"), T("ritual"), T("ritual"), T("ritual")]),
        case("delay", "delay N: not eligible until the turn counter reaches N", [C("late", delay=3)],
             [T(), T(), T(), T()]),
        case("delay_with_keyword", "delay applies to keyword entries too", [K("late-key", ["door"], delay=2)],
             [T("door"), T("door"), T("door")]),
        case("browse_does_not_tick", "advance_timers=false neither ticks the counter nor starts windows",
             [C("late", delay=2), K("sticky", ["k"], sticky=3)],
             [T("k", advance_timers=False), T("k", advance_timers=False), T(""), T(""), T("")]),
        case("sticky_skips_probability", "a sticky-active entry does not roll its probability again",
             [K("omen", ["ritual"], sticky=2, probability=50)],
             [T("ritual", script=[10]), T("quiet"), T("quiet"), T("ritual", script=[90]), T("ritual", script=[20])]),
        case("sticky_wins_group", "a sticky-active member of an inclusion group wins outright",
             [K("g-sticky", ["storm"], group="weather", sticky=2), C("g-const", group="weather")],
             [T("storm", script=[0]), T("calm"), T("calm"), T("calm")]),
        case("timers_only_for_chosen", "an entry cut by the budget does not start its timers",
             [C("hog", "x" * 50, insertion_order=9), K("sticky-cut", ["k"], "y" * 40, sticky=2, insertion_order=1)],
             [T("k"), T("")], budget_chars=60),
        case("sticky_secret_player", "a sticky-active secret entry is still filtered for a player viewer",
             [K("s", ["k"], secret=True, sticky=2)], [T("k", viewer="keeper"), T("", viewer="player"), T("", viewer="keeper")]),
        case("char_bound_key", "keys bound from {{char}} at import match the card name",
             [K("about {{char}}", ["{{char}}"], "{{char}} is here.")], [T("I greet 络络")],
             **{"import": {"is_keeper": True, "char_name": "络络"}}),
        case("dict_keyed_world_info", "an ST world-info export (entries keyed by index) activates like a list",
             {"entries": {"0": {"comment": "Dock", "key": ["dock"], "content": "Wet planks."},
                          "1": {"comment": "Bell", "key": ["bell"], "content": "It rings.", "constant": True}}},
             [T("to the dock")]),
        case("initvar_seeds_conditions", "an [InitVar] entry seeds the tree that conditions read", [
            E("[InitVar]", '{"配置": {"难度": "残酷"}}'),
            C("easy", "@@if 配置.难度 == \"轻松\"\nEasy."), C("hard", "@@if 配置.难度 == \"残酷\"\nHard."),
        ], [T()]),
        case("overlay_card_keeper_turn", "synthetic real-shaped book (public fixture) on a quiet keeper turn",
             card_book(), [T()]),
        case("player_import_activation", "the same book imported by a player: no constants, no secrets",
             [C("rules", "R"), K("lore", ["door"], "L"), K("truth", ["door"], "T", secret=True)],
             [T("the door", viewer="player")], **{"import": {"is_keeper": False}}),
    ]
    return cases


async def _run_activation(case: dict[str, Any], i18n: I18n) -> dict[str, Any]:
    from core.documents import DocumentStore

    store = Store(":memory:")
    documents = DocumentStore(store)
    manager = _RecordingWorldbook(store)
    variables = case.get("variables") or {}
    flat = dict(variables.get("flat") or {})
    if variables.get("tree"):
        await mvu_compat.save_mvu(documents, ROOM, copy.deepcopy(variables["tree"]))
    imp = {"is_keeper": True, "char_name": "", "source": "book", **(case.get("import") or {})}
    imported = await manager.import_entries(ROOM, copy.deepcopy(case["lorebook"]), source=imp["source"],
                                            is_keeper=imp["is_keeper"], char_name=imp["char_name"])
    full_ejs = bool(case.get("full_ejs"))
    macro_cfg = case.get("macros") or {}
    limit = case.get("limit", worldbook.KEEPER_TURN_LIMIT)
    budget = case.get("budget_chars", worldbook.KEEPER_TURN_BUDGET_CHARS)
    results = []
    for turn in case["turns"]:
        tree = await mvu_compat.load_mvu(documents, ROOM)
        resolve = build_resolver(flat, tree)
        engine = await build_room_engine(manager, ROOM, enabled=full_ejs, flat_variables=flat, tree=tree)
        rng = ScriptedRng(turn.get("script"))
        macro_rng = ScriptedRng(turn.get("macro_script"))
        roller = ScriptedRoller(turn.get("rolls"))
        macros = ejs_lite.MacroContext(names=dict(macro_cfg.get("names") or {}),
                                       clock_time=str(macro_cfg.get("clock_time") or ""), rng=macro_rng, roll=roller)
        viewer = turn.get("viewer", "keeper")
        advance = turn.get("advance_timers", True)
        manager.last_match, manager.extra_lookups, manager.recording_extra = [], [], False
        text = await worldbook.inject_world_lore_prompt(
            _Ctx(), manager, i18n, role=viewer, recent_context=turn["context"], resolve=resolve, engine=engine,
            macros=macros, rng=rng, advance_timers=advance, limit=limit, budget_chars=budget,
        )
        manager.recording_extra = False
        assert not rng.script and not macro_rng.script, (case["case"], "unused script values")
        result: dict[str, Any] = {
            "activated": [entry.title for entry in manager.last_match],
            "activewi_requested": engine.activated if engine is not None else [],
            "activewi_injected": [entry.title for entry in manager.extra_lookups
                                  if entry.enabled and (viewer == "keeper" or not entry.secret)],
            "injected_text": text,
            "draws": rng.draws,
            "macro_draws": macro_rng.draws + roller.draws,
        }
        if engine is not None:
            writes = engine.pending_writes
            result["template_writes"] = _jsonable(writes)
            if writes:
                for path, value in writes:
                    try:
                        tree = mvu_compat.apply_set(tree, path, value)
                    except (ValueError, TypeError):
                        continue
                await mvu_compat.save_mvu(documents, ROOM, tree)
        timers = await manager._load_timers(ROOM)
        result["turn_counter_after"] = timers["turn"]
        result["mvu_tree_after"] = await mvu_compat.load_mvu(documents, ROOM)
        results.append(result)
    inputs = {key: case[key] for key in ("lorebook", "turns") if key in case}
    inputs["import"] = imp
    inputs["variables"] = {"flat": variables.get("flat") or {}, "tree": variables.get("tree") or {}}
    inputs["full_ejs"] = full_ejs
    inputs["macros"] = {"names": macro_cfg.get("names") or {}, "clock_time": macro_cfg.get("clock_time") or ""}
    inputs["limit"] = limit
    inputs["budget_chars"] = budget
    return {"case": case["case"], "note": case["note"], "input": inputs, "imported_count": imported,
            "stored_entries": [_entry_view(entry) for entry in await manager.list(ROOM)], "turns": results}


async def export_worldbook_activation(i18n: I18n) -> list[dict[str, Any]]:
    rows = []
    for case in _activation_cases():
        if case.get("full_ejs") and not quickjs_available():
            continue
        rows.append(await _run_activation(case, i18n))
    return rows


# ---------------------------------------------------------------------------
# 5. Macros + decorators
# ---------------------------------------------------------------------------


def _macro_cases() -> list[dict[str, Any]]:
    flat = {"好感度": 60, "fear": 3, "flag": True, "off": False, "ratio": 0.1, "big": 1e21, "obj": {"a": 1},
            "list": [1, "x"], "none": None, "empty": "", "name": "user", "whole": 2.0}
    tree = {"理": {"好感度": [33, "affinity"]}, "世界": {"日": 1, "访客": ["甲", "乙"]}}

    def m(case: str, note: str, text: str, *, names: Any = None, ctx: Any = None, script: Any = None,
          rolls: Any = None) -> dict[str, Any]:
        return {"case": case, "note": note, "text": text, "names": names, "macro_context": ctx,
                "script": script, "rolls": rolls}

    full_ctx = {"names": {}, "clock_time": "", "rng": False, "roll": False}
    return [
        m("getvar_basic", "{{getvar::name}} reads a variable", "{{getvar::好感度}}/{{getvar::fear}}"),
        m("getvar_spaces", "whitespace inside the braces is tolerated", "{{ getvar::fear }}|{{getvar:: fear }}"),
        m("getvar_case_sensitive", "the getvar keyword is lower-case only", "{{GETVAR::fear}}|{{GetVar::fear}}"),
        m("getvar_tree_vwd", "tree paths unwrap [value, description] leaves", "{{getvar::理.好感度}} {{getvar::世界.日}}"),
        m("getvar_list_index", "numeric segments index lists", "{{getvar::世界.访客.1}}"),
        m("getvar_root_prefixes", "variables./stat_data. prefixes are stripped",
          "{{getvar::variables.fear}} {{getvar::stat_data.理.好感度}}"),
        m("getvar_missing", "a missing variable renders as empty", "[{{getvar::ghost}}]"),
        m("getvar_python_str", "values render via Python str(): True/False, dict/list repr, None -> ''",
          "{{getvar::flag}} {{getvar::off}} {{getvar::obj}} {{getvar::list}} [{{getvar::none}}] {{getvar::ratio}} {{getvar::big}} {{getvar::whole}}"),
        m("getvar_branch", "reading a branch renders the dict repr", "{{getvar::理}}"),
        m("var_native", "our native {{var:name}} form", "{{var:fear}} {{var: 好感度 }}"),
        m("var_double_colon", "{{var::x}} reads the name ':x' (missing -> empty)", "[{{var::fear}}]"),
        m("user_char_names", "{{user}}/{{char}} from the names argument", "{{user}} meets {{char}}",
          names={"user": "Alice", "char": "络络"}),
        m("user_char_case", "name macros are case-insensitive", "{{USER}} / {{ Char }}",
          names={"user": "Alice", "char": "络络"}),
        m("names_absent", "without names, {{user}}/{{char}} pass through", "{{user}} {{char}}"),
        m("names_empty_value", "an empty replacement keeps the macro", "{{user}} {{char}}", names={"user": "", "char": "C"}),
        m("context_names_win", "MacroContext.names wins over the names argument", "{{user}}/{{char}}",
          names={"user": "old", "char": "keep"}, ctx={**full_ctx, "names": {"user": "new"}}),
        m("comment_stripped", "{{// ...}} comments always strip (even without context)", "a{{// keeper note}}b{{//}}c"),
        m("comment_with_braces_kept", "a comment containing braces is not matched", "a{{// x {y} }}b"),
        m("newline", "{{newline}} becomes a line break (case-insensitive)", "a{{newline}}b{{ NEWLINE }}c"),
        m("time_date_clock", "{{time}}/{{date}} = the GAME clock string", "{{time}} | {{date}} | {{TIME}}",
          ctx={**full_ctx, "clock_time": "1926-03-15 22:00"}),
        m("time_without_clock", "without a clock {{time}} passes through", "{{time}} {{date}}", ctx=full_ctx),
        m("random_comma", "{{random:a,b,c}} picks one (scripted index)", "{{random:a,b,c}}",
          ctx={**full_ctx, "rng": True}, script=[2]),
        m("random_double_colon", "{{random::a::b}} splits on :: and keeps commas", "{{random::a,1::b,2}}",
          ctx={**full_ctx, "rng": True}, script=[0]),
        m("random_trims_and_drops_empty", "options are trimmed; empty options dropped",
          "{{random: grim , , hopeful ,grim}}", ctx={**full_ctx, "rng": True}, script=[2]),
        m("pick_alias", "{{pick::...}} behaves like random", "{{pick::x::y}}", ctx={**full_ctx, "rng": True},
          script=[1]),
        m("random_single_option", "a single option still draws", "{{random:only}}", ctx={**full_ctx, "rng": True},
          script=[0]),
        m("random_empty", "{{random:}} has no options and passes through", "{{random:}}", ctx={**full_ctx, "rng": True}),
        m("random_separators_only", "options that are all empty render ''", "[{{random:,,}}]",
          ctx={**full_ctx, "rng": True}),
        m("random_several", "several random macros draw left to right", "{{random:a,b}}{{random:c,d}}{{RANDOM::e::f}}",
          ctx={**full_ctx, "rng": True}, script=[1, 0, 1]),
        m("random_without_rng", "without an rng the macro passes through", "{{random:a,b}}", ctx=full_ctx),
        m("roll_basic", "{{roll:1d20}} = the real dice engine's total (scripted here)", "Roll: {{roll:1d20}}",
          ctx={**full_ctx, "roll": True}, rolls={"1d20": 17}),
        m("roll_double_colon", "{{roll::2d6+1}}", "{{roll::2d6+1}}", ctx={**full_ctx, "roll": True},
          rolls={"2d6+1": 9}),
        m("roll_bad_expression", "a failing roll passes the macro through", "{{roll:not-dice}}",
          ctx={**full_ctx, "roll": True}, rolls={"not-dice": "raise"}),
        m("roll_space_form_unsupported", "the ST `{{roll 1d6}}` space form is not recognized", "{{roll 1d6}}",
          ctx={**full_ctx, "roll": True}),
        m("roll_without_roller", "without a roller the macro passes through", "{{roll:1d6}}", ctx=full_ctx),
        m("unknown_macros_pass_through", "unknown macros are left untouched",
          "{{setvar::a::1}} {{lastMessage}} {{idle_duration}} {{trim}} {{original}}"),
        m("nested_names_into_random", "names substitute before random, so a nested {{user}} is resolved first",
          "{{random::{{user}}::b}}", names={"user": "Alice"}, ctx={**full_ctx, "rng": True}, script=[0]),
        m("nested_names_into_getvar", "getvar runs before names: {{getvar::{{user}}}} is not resolved",
          "{{getvar::{{user}}}}", names={"user": "fear"}),
        m("getvar_value_is_macro", "a substituted value containing a macro is processed by LATER passes only",
          "{{getvar::macro_value}}", names={"user": "Alice"}),
        m("order_comment_first", "a comment hides macros inside it", "{{// {{user}} }}"),
        m("backslash_not_escape", "there is no escape syntax: a backslash stays and the macro still substitutes",
          "\\{{user}}", names={"user": "Alice"}),
        m("unclosed_braces", "unbalanced braces pass through", "{{user} {{getvar::fear", names={"user": "Alice"}),
        m("everything", "all macro kinds together",
          "{{// note}}{{char}} at {{time}}. Roll: {{roll:1d20}}. Mood: {{random: grim, hopeful, grim}}.{{newline}}Done on {{date}} with {{getvar::好感度}}.",
          names={"char": "络络"}, ctx={"names": {}, "clock_time": "1926-03-15 22:00", "rng": True, "roll": True},
          script=[1], rolls={"1d20": 17}),
    ], flat, tree


def export_macros() -> list[dict[str, Any]]:
    cases, flat, tree = _macro_cases()
    flat = {**flat, "macro_value": "{{user}} and {{getvar::fear}}"}
    resolve = build_resolver(flat, tree)
    rows = []
    for case in cases:
        rng = ScriptedRng(case["script"])
        roller = ScriptedRoller(case["rolls"])
        ctx_cfg = case["macro_context"]
        macros = None
        if ctx_cfg is not None:
            macros = ejs_lite.MacroContext(
                names=dict(ctx_cfg.get("names") or {}), clock_time=str(ctx_cfg.get("clock_time") or ""),
                rng=rng if ctx_cfg.get("rng") else None, roll=roller if ctx_cfg.get("roll") else None,
            )
        out = ejs_lite.substitute_macros(case["text"], resolve, case["names"], macros)
        assert not rng.script, case["case"]
        rows.append({
            "case": case["case"], "note": case["note"],
            "input": {"text": case["text"], "variables": {"flat": flat, "tree": tree}, "names": case["names"],
                      "macro_context": ctx_cfg, "script": case["script"], "rolls": case["rolls"]},
            "output": out, "draws": rng.draws + roller.draws,
        })
    return rows


def export_decorators() -> list[dict[str, Any]]:
    cases = [
        ("if_and_flag", "@@if expression + a flag decorator", "@@if variables.stage === 2\n@@dont_activate\nBody line 1\nBody line 2"),
        ("none", "no decorators: identity", "email @@handle mid-line is not a decorator\nbody"),
        ("blank_between", "blank lines between decorators are skipped once one was seen",
         "@@activate\n\n@@if x > 1\n\nbody"),
        ("blank_first_line", "a blank FIRST line stops parsing (no decorators)", "\n@@if x\nbody"),
        ("if_without_arg", "@@if with no expression maps to True", "@@if\nbody"),
        ("upper_case_name", "decorator names are lower-cased", "@@IF a == 1\n@@Render_After\nbody"),
        ("indented", "leading whitespace on a decorator line is tolerated", "   @@if a\nbody"),
        ("digit_in_name", "names are letters/underscore only: `@@render2` is not a decorator", "@@render2\nbody"),
        ("duplicate_last_wins", "a repeated decorator: the last one wins", "@@if a\n@@if b\nbody"),
        ("crlf", "CRLF lines: the decorator matches, the body keeps its \\r", "@@if a\r\nbody\r\nmore"),
        ("only_decorators", "only decorator lines: empty body", "@@initial_variables"),
        ("flag_with_arg", "a non-if decorator with an argument is still just True", "@@depth 4\nbody"),
        ("double_at_in_body", "decorator lines after the body starts are body text", "body\n@@if a"),
        ("trailing_blank_after_decorators", "blank lines after decorators are consumed before the body",
         "@@if a\n\n\nbody"),
        ("if_extra_spaces", "@@if argument is trimmed", "@@if    a  ==  1   \nbody"),
    ]
    rows = []
    for case, note, text in cases:
        decorators, body = ejs_lite.split_decorators(text)
        rows.append({"case": f"decorators_{case}", "note": note, "input": {"text": text},
                     "decorators": decorators, "body": body})
    return rows


# ---------------------------------------------------------------------------
# 6. MVU variables
# ---------------------------------------------------------------------------

INITVAR_TEXT = """
// MVU 变量初始化
{
  '理': {
    "情绪状态": {
      pleasure: [0.1, "[-1,1] range; updates on emotion change"],
    },
    "好感度": [33, "对主角的好感"],
  },
  "世界": {
    "link": "https://example.com/wiki//page", /* 保持原样 */
    "day": 1,
  },
}
"""

YAML_INITVAR_TEXT = """\
世界:
  日: 1
  时段: 上午  # 注释与数据同行
  今日访客配额: 3
  监控录像: ""
  声望: { 圣哺: 20, 残堇: 20 }
  已登记访客: []
玩家资源:
  精力: { 当前值: 8, 训练经验: 0 }
  _小憩日: -1
  保护准备: false
结局标记: [进行中, "本周目状态"]
"""


def _initvar_route(text: str) -> str | None:
    normalized = mvu_compat._json5_normalize(text) if isinstance(text, str) and text.strip() else None
    if normalized is not None:
        try:
            if isinstance(json.loads(normalized), dict):
                return "json5"
        except (ValueError, RecursionError):
            pass
    return "yaml" if mvu_compat.parse_initvar(text) is not None else None


def export_mvu_initvar() -> list[dict[str, Any]]:
    cases = [
        ("plain_json", "strict JSON object", '{"a": 1, "b": [1, 2]}'),
        ("comments_outside_strings", "// and /* */ comments drop; // inside strings is data",
         '{\n  "link": "https://example.com//page", // trailing comment\n  /* block\n     comment */\n  "笔记": "含//斜杠"\n}'),
        ("trailing_commas", "trailing commas tolerated", '{"a": [1, 2,], "b": {"c": 1,},}'),
        ("single_quotes", "single-quoted strings; \\' unwrapped; embedded double quotes escaped",
         "{'name': 'it\\'s \"fine\"', 'n': 1}"),
        ("bare_keys", "unquoted ASCII identifier keys", '{pleasure: 0.1, _tag$: "x", nested: {inner: true}}'),
        ("real_world_mvu", "comments + single quotes + bare keys + trailing commas + VWD leaves", INITVAR_TEXT),
        ("not_json", "unrecoverable prose", "not json at all"),
        ("top_level_array", "a top-level array is not a tree", "[1, 2]"),
        ("empty", "empty text", ""),
        ("whitespace", "whitespace only", "   \n "),
        ("unterminated_object", "unterminated object (YAML route also fails)", '{"a": 1'),
        ("unterminated_single_quote", "unterminated single-quoted string", "{'unterminated: 1}"),
        ("unterminated_block_comment", "unterminated /* comment", '{"a": 1 /* oops'),
        ("bare_cjk_key_json5", "a bare CJK key is not quoted by the JSON5 route; YAML flow mapping takes it",
         "{好感度: 5, mood: 'ok'}"),
        ("yaml_block_mapping", "2026-era YAML block mapping", YAML_INITVAR_TEXT),
        ("yaml_apostrophe_prose", "a bare apostrophe breaks JSON5 but YAML reads it", "提示: today's visitor knocks\n计数: 2\n"),
        ("yaml_alias_rejected", "anchors/aliases are rejected outright", "a: &x [1, 2]\nb: *x\n"),
        ("yaml_sequence_top", "a YAML sequence is not a tree", "- 1\n- 2\n"),
        ("yaml_scalar_top", "a YAML scalar is not a tree", "just prose\n"),
        ("yaml_tab_indent", "tab indentation is a YAML scanner error", "a:\n\tb: 1\n"),
        ("yaml_11_booleans_and_duplicates", "YAML 1.1: yes/no are booleans; duplicate keys last-win", "开关: yes\n开关: no\n"),
        ("yaml_dates_to_iso", "YAML dates become ISO strings", "下次检查: 2026-08-04\n嵌套: { 时刻: [2026-08-04, 备注] }\n"),
        ("yaml_datetime", "YAML datetimes become ISO strings", "at: 2026-08-04 10:30:00\n"),
        ("yaml_null_and_numbers", "YAML ~ / null / octal-looking / float / exponent", "a: ~\nb: null\nc: 010\nd: 1.5\ne: 1e3\nf: 0x1F\n"),
        ("json_nan_literal", "NaN/Infinity parse in the JSON route (then dropped by normalization)", '{"a": NaN, "b": Infinity, "c": 1}'),
        ("json_deep_nesting", "nesting deeper than 8 is truncated by normalization",
         '{"l1":{"l2":{"l3":{"l4":{"l5":{"l6":{"l7":{"l8":{"l9":1}}}}}}}}}'),
        ("bare_true_value", "bare true/false/null values are not quoted as keys", "{a: true, b: null, c: false}"),
        ("comment_only_then_json", "leading line comment then JSON", "// header\n{\"x\": 1}"),
        ("number_keys", "numeric keys stay strings", '{"1": "one", "2": [2, "two"]}'),
        ("json_with_bom_like_text", "a stray leading BOM char breaks JSON; YAML may still parse",
         "\ufeff{\"a\": 1}"),
    ]
    rows = []
    for case, note, text in cases:
        parsed = mvu_compat.parse_initvar(text)
        rows.append({"op": "parse_initvar", "case": f"initvar_{case}", "note": note, "input": {"text": text},
                     "route": _initvar_route(text), "parsed": _sanitize(parsed),
                     "normalized_tree": mvu_compat.normalize_tree(parsed) if parsed is not None else None})

    name_cases = ["[InitVar]", "「[InitVar]变量初始化」", "MVU INITVAR block", "initvar", "variables", "init var", "", None, 42]
    for name in name_cases:
        rows.append({"op": "is_initvar_entry", "case": f"initvar_name_{len(rows)}", "note": "InitVar title detection",
                     "input": {"name": name}, "result": mvu_compat.is_initvar_entry(name)})
    return rows


def _sanitize(value: Any) -> Any:
    """Make a parsed InitVar JSON-safe: non-finite floats become tagged strings."""
    if isinstance(value, float) and value != value:
        return {"$nonfinite": "NaN"}
    if isinstance(value, float) and value in (float("inf"), float("-inf")):
        return {"$nonfinite": "Infinity" if value > 0 else "-Infinity"}
    if isinstance(value, dict):
        return {key: _sanitize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    return value


NARRATION = """他微微一笑。

<UpdateVariable>
<Analysis>
好感度 33 -> 35，愉快的交谈。
</Analysis>
_.set('理.好感度', 33, 35);//pleasant discussion
_.add('世界.day', 1)
</UpdateVariable>

雨停了。"""

BASE_TREE = {
    "理": {"好感度": [33, "对主角的好感"], "情绪": {"pleasure": [0.1, "[-1,1]"]}},
    "世界": {"day": 1, "天气": "雨"},
    "hp": 10,
    "alerted": False,
    "armed": [True, "desc"],
    "tags": ["a", "c"],
    "party": [{"name": "甲", "hp": 10}, {"name": "乙", "hp": 8}],
    "info": {"k": 1},
    "vwd_list": [["x"], "desc"],
    "inv": {"sword": [1, "count"]},
    "stash": {},
    "s": "str",
}


def _blk(*lines: str) -> str:
    return "<UpdateVariable>\n" + "\n".join(lines) + "\n</UpdateVariable>"


def export_mvu_update() -> list[dict[str, Any]]:
    cases: list[tuple[str, str, Any, str]] = [
        ("real_world_narration", "set with expected-old + add; Analysis discarded; text tidied", BASE_TREE, NARRATION),
        ("analysis_lines_ignored", "command-like lines inside <Analysis> are not applied", BASE_TREE,
         "<UpdateVariable>\n<Analysis>\n_.set('hp', 1)\n</Analysis>\n_.set('hp', 2)\n</UpdateVariable>"),
        ("multiple_blocks_attributes", "several blocks in order; attributes and case-insensitive tag names", BASE_TREE,
         "a\n<UpdateVariable>_.set('hp', 1)</UpdateVariable>\nmid\n<UPDATEVARIABLE foo=\"1\">_.add('hp', 2)</UpdateVariable>\nz"),
        ("fenced_block", "a block fenced in triple backticks is unwrapped", BASE_TREE,
         "before\n```\n<UpdateVariable>\n_.set('hp', 1)\n</UpdateVariable>\n```\nafter"),
        ("fenced_with_lang", "a fence with a language tag", BASE_TREE,
         "x\n```xml\n<UpdateVariable>_.set('hp', 3)</UpdateVariable>\n```\ny"),
        ("rich_arguments", "strings with commas/escapes, true/null, negative floats, JSON chunks", BASE_TREE, _blk(
            "_.set('msg', \"he said \\\"hi\\\", ok\")", "_.set('flag', true)", "_.set('none', null)",
            "_.set('num', -2.5)", "_.insert('tags', ['a', 'b'])", "_.set('obj', {\"k\": [1, 2]})",
            "_.set('nl', 'line1\\nline2\\ttab\\x')", "_.set('exp', 1e3)", "_.set('upper', TRUE)")),
        ("garbage_lines_skipped", "unparseable lines are skipped, never fatal", BASE_TREE, _blk(
            "random prose line", "_.explode('a')", "_.set('a'", "_.set(42, 1)", "_.delete('a', 'b', 'c')",
            "_.set('a.b', 1)", "_.add('hp')", "_.move('hp')", "_.set('x', +5)", "_.set('x', .5)",
            "_.set('x', undefined)", "  _ . set ( 'spaced' , 1 )  ")),
        ("no_block", "no block: the original text comes back byte-identical and nothing applies", BASE_TREE,
         "just narration // with a stray ``` fence and <Analysis>text</Analysis>"),
        ("unclosed_block", "an unclosed block is not a block", BASE_TREE, "a <UpdateVariable>_.set('hp', 1) b"),
        ("one_command_per_line", "only the FIRST command on a line is parsed", BASE_TREE,
         _blk("_.set('hp', 1);_.set('s', 'two');")),
        ("reason_forms", "trailing `;//reason`, `// reason`, and junk after the call", BASE_TREE, _blk(
            "_.set('hp', 1);//first", "_.add('hp', 1) // second", "_.add('hp', 1); trailing junk")),
        ("set_vwd_keeps_description", "set on a VWD leaf updates index 0 and keeps the description", BASE_TREE,
         _blk("_.set('理.好感度', 50)")),
        ("set_vwd_with_vwd_value", "setting a VWD-shaped value replaces the whole leaf", BASE_TREE,
         _blk("_.set('理.好感度', [1, \"new desc\"])")),
        ("set_expected_old_advisory", "a mismatching expected-old value is NOT rejected", BASE_TREE,
         _blk("_.set('理.好感度', 999, 35)")),
        ("set_autocreates", "set creates missing intermediate dicts (CJK path)", BASE_TREE,
         _blk("_.set('新章节.进度.阶段', 0)")),
        ("set_list_index", "numeric segments address list items", BASE_TREE, _blk("_.set('party.1.hp', 6)")),
        ("set_list_index_vwd", "a VWD inside a list keeps its description", {"l": [[1, "d"], 2]}, _blk("_.set('l.0', 5)")),
        ("set_bad_paths", "bad paths: empty segment, out of range, non-numeric index, scalar mid-path", BASE_TREE, _blk(
            "_.set('', 1)", "_.set('a..b', 1)", "_.set('tags.5', 2)", "_.set('tags.x', 3)", "_.set('hp.b', 2)",
            "_.set('tags.-1', 0)")),
        ("set_replaces_branch", "set on a branch replaces the whole subtree", BASE_TREE, _blk("_.set('世界', '残酷')")),
        ("set_path_whitespace", "path segments are trimmed", BASE_TREE, _blk("_.set(' 世界 . day ', 9)")),
        ("insert_append_and_index", "list append; index insert; negative/out-of-range clamp like list.insert", BASE_TREE, _blk(
            "_.insert('tags', 'd')", "_.insert('tags', 1, 'b')", "_.insert('tags', '0', 'first')",
            "_.insert('tags', 99, 'last')", "_.insert('tags', -1, 'neg')")),
        ("insert_dict_and_wrapped", "dict insert needs a key; inserting through a VWD-wrapped container", BASE_TREE, _blk(
            "_.insert('info', 'j', 2)", "_.insert('info', 3, 'num-key')", "_.insert('vwd_list', 'y')")),
        ("insert_errors", "insert errors: dict without key, missing path, scalar target, non-numeric list index",
         BASE_TREE, _blk("_.insert('info', 1)", "_.insert('missing', 1)", "_.insert('s', 1)",
                         "_.insert('tags', 'nope', 'x')", "_.insert('tags', true, 'x')")),
        ("delete_node", "delete the node at a path (dict key / list index)", BASE_TREE,
         _blk("_.delete('世界.天气')", "_.delete('tags.0')")),
        ("delete_with_key", "delete FROM a container: dict key, int index, '2' index, value match", BASE_TREE, _blk(
            "_.delete('info', 'k')", "_.delete('tags', 1)", "_.delete('tags', 'a')")),
        ("delete_value_vs_index", "an int-like string key is an index, not a value", {"l": ["0", "1", "2"]},
         _blk("_.delete('l', '2')", "_.delete('l', '0')")),
        ("delete_errors", "delete errors: missing key, index out of range, value not found, scalar target", BASE_TREE,
         _blk("_.delete('info.zzz')", "_.delete('tags', 9)", "_.delete('tags', 'nope')", "_.delete('hp', 'x')",
              "_.delete('tags', -1)")),
        ("add_numbers", "add a delta; through a VWD keeping its description; floats", BASE_TREE, _blk(
            "_.add('hp', -3)", "_.add('理.情绪.pleasure', 0.2)", "_.add('理.好感度', 5)")),
        ("add_toggles", "add on a bool toggles regardless of delta; a bool delta toggles a number to a bool",
         BASE_TREE, _blk("_.add('alerted', 1)", "_.add('armed', 5)", "_.add('hp', true)")),
        ("add_toggle_false_delta", "add(path, false) still toggles", {"b": True, "n": 0}, _blk("_.add('b', false)", "_.add('n', false)")),
        ("add_errors", "add errors: missing path, non-numeric target, non-numeric delta, string toggle", BASE_TREE,
         _blk("_.add('missing', 1)", "_.add('s', 1)", "_.add('hp', 'lots')", "_.add('s', true)", "_.add('tags', 1)")),
        ("add_list_item", "add on a list element", {"l": [1, 2]}, _blk("_.add('l.1', 10)")),
        ("move_node", "move detaches and re-attaches the node with its wrapper", BASE_TREE,
         _blk("_.move('inv.sword', 'stash.sword')")),
        ("move_list_append", "moving to index == length appends", {"a": {"x": 1}, "l": [0]}, _blk("_.move('a.x', 'l.1')")),
        ("move_errors", "move never auto-creates; missing source fails", BASE_TREE,
         _blk("_.move('inv.ghost', 'inv.other')", "_.move('hp', 'no.such.place')")),
        ("move_failed_destination_keeps_source", "a failed move leaves the tree unchanged", {"a": 1},
         _blk("_.move('a', 'b.c')")),
        ("errors_dont_block", "a failing command is recorded; later commands still apply", {"hp": 10}, _blk(
            "_.set('hp', 5)", "_.delete('ghost')", "_.add('hp', 2)")),
        ("cjk_and_quotes", "double-quoted CJK paths and values", BASE_TREE,
         _blk("_.set(\"世界.天气\", \"晴\");//天晴了")),
        ("json_chunk_single_quotes", "a JSON chunk with single quotes goes through the JSON5 normalizer", BASE_TREE,
         _blk("_.set('obj', {'k': 'v', n: 1,})")),
        ("json_chunk_bad", "an unparseable JSON chunk skips the line", BASE_TREE, _blk("_.set('obj', {k: v})")),
        ("json_chunk_nested_brackets_in_string", "brackets inside strings in a chunk", BASE_TREE,
         _blk("_.set('obj', [\"a]b\", \"{c\"])")),
        ("empty_initial_tree", "commands against an empty tree", {}, _blk("_.set('a.b', 1)", "_.add('a.b', 1)", "_.insert('a', 'c', [])")),
        ("non_dict_initial_tree", "a non-dict stored tree loads as {}", [1, 2], _blk("_.set('a', 1)")),
        ("all_fail_nothing_persisted", "when every command fails nothing is persisted", {"hp": 10},
         _blk("_.delete('ghost')", "_.add('s', 1)")),
        ("whitespace_tidy", "trailing spaces before newlines and 3+ blank lines are tidied", BASE_TREE,
         "line one   \n\n\n\n<UpdateVariable>_.set('hp', 1)</UpdateVariable>\n\n\n\nline two  \n"),
        ("block_mid_line", "a block in the middle of a line", BASE_TREE,
         "He nods <UpdateVariable>_.set('hp', 2)</UpdateVariable> and leaves."),
        ("analysis_outside_block_kept", "an <Analysis> outside any block stays in the text", BASE_TREE,
         "<Analysis>keep me</Analysis>\n<UpdateVariable>_.set('hp', 2)</UpdateVariable>"),
        ("closing_tag_with_space", "a closing tag with trailing whitespace", BASE_TREE,
         "<UpdateVariable>_.set('hp', 4)</UpdateVariable  >tail"),
        ("updatevariables_plural_not_matched", "`<UpdateVariables>` (plural) is not the tag", BASE_TREE,
         "<UpdateVariables>_.set('hp', 4)</UpdateVariables>"),
    ]
    rows = []
    for case, note, initial, text in cases:
        tree = mvu_compat.normalize_tree(copy.deepcopy(initial))
        commands, cleaned = mvu_compat.parse_update_blocks(text)
        if commands:
            new_tree, applied, errors = mvu_compat.apply_commands(tree, commands)
        else:
            new_tree, applied, errors = tree, [], []
        rows.append({
            "case": f"mvu_{case}", "note": note,
            "input": {"tree": initial, "text": text},
            "loaded_tree": tree,
            "commands": commands,
            "cleaned_text": cleaned,
            "applied": applied,
            "errors": errors,
            "persisted": bool(applied),
            "tree_after": new_tree if applied else tree,
        })
    return rows


def export_mvu_tree() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    flat_tree = {"a": {"x": [1, "desc"], "y": [1, 2, 3]}, "b": "str", "c": [{"k": 1}, 2], "d": {}, "e": []}
    for case, note, tree, limit in [
        ("flatten_order", "depth-first insertion order; VWD unwrap; scalar lists as values; container lists recurse",
         flat_tree, 200),
        ("flatten_limit", "traversal stops at the limit", {f"k{i}": i for i in range(10)}, 3),
        ("flatten_cjk", "CJK paths", {"理": {"好感度": [33, "d"], "情绪": {"pleasure": 0.1}}}, 200),
        ("flatten_ambiguous_pair", "a two-element [x, 'str'] list is read as a VWD leaf", {"pair": ["a", "b"]}, 200),
    ]:
        rows.append({"op": "flatten_leaves", "case": case, "note": note, "input": {"tree": tree, "limit": limit},
                     "result": mvu_compat.flatten_leaves(tree, limit)})

    deep: dict[str, Any] = {}
    node = deep
    for depth in range(10):
        node[f"d{depth}"] = {}
        node = node[f"d{depth}"]
    node["leaf"] = 1
    for case, note, raw in [
        ("normalize_non_dict", "a non-dict degrades to {}", [1, 2]),
        ("normalize_depth", "containers deeper than 8 are dropped", deep),
        ("normalize_nodes", "past 512 nodes the rest is dropped", {f"k{i}": i for i in range(520)}),
        ("normalize_mixed", "scalars, VWD, nested lists survive", {"a": [1, [2, [3]]], "b": None, "c": True, "d": 1.5}),
        ("normalize_list_depth", "lists count toward depth too", {"l": [[[[[[[[["deep"]]]]]]]]]}),
    ]:
        rows.append({"op": "normalize_tree", "case": case, "note": note, "input": {"tree": raw},
                     "result": mvu_compat.normalize_tree(raw)})

    for path, prefixes in [
        ("悟空.好感度", ["悟空"]), ("悟空二号.好感度", ["悟空"]), ("a.b", ["*"]), ("a.b", []), ("a", ["a.b"]),
        ("a.b.c", ["a.b"]), ("a.bc", ["a.b"]),
    ]:
        rows.append({"op": "path_is_exposed", "case": f"exposed_{len(rows)}",
                     "note": "segment-aligned prefix exposure; '*' exposes all; [] exposes nothing",
                     "input": {"path": path, "prefixes": prefixes},
                     "result": mvu_compat.path_is_exposed(path, prefixes)})

    prune_tree = {"悟空": {"好感度": [50, "d"], "秘密": "x"}, "悟空二号": {"hp": 3}, "party": [{"hp": 1}, {"hp": 2}],
                  "tags": ["a", "b"], "flag": True}
    for case, prefixes in [("prune_branch", ["悟空"]), ("prune_leaf", ["悟空.好感度"]), ("prune_all", ["*"]),
                           ("prune_none", []), ("prune_list_items", ["party.1", "tags"])]:
        rows.append({"op": "prune_tree_to_exposed", "case": case,
                     "note": "the player-visible tree with shape intact (what the EJS sandbox sees for players)",
                     "input": {"tree": prune_tree, "prefixes": prefixes},
                     "result": mvu_compat.prune_tree_to_exposed(prune_tree, prefixes)})
    return rows


# ---------------------------------------------------------------------------
# 7. Full EJS (QuickJS) + the subset renderer on the same templates
# ---------------------------------------------------------------------------

EJS_FLAT = {"fear": 7, "mood": "tense", "flag": True, "count": 4}
EJS_TREE = {"理": {"好感度": [33, "affinity"], "情绪": {"pleasure": 0.1}}, "世界": {"日": 1, "访客": ["甲", "乙"]}}
EJS_WI = {"chapel": "The chapel is locked at night.", "variant-b": "Brutal mode."}


def _ejs_cases() -> list[dict[str, Any]]:
    def c(case: str, note: str, templates: list[str] | str, **kw: Any) -> dict[str, Any]:
        out = {"case": case, "note": note, "templates": [templates] if isinstance(templates, str) else templates}
        out.update(kw)
        return out

    return [
        c("plain_text", "plain text passes through", "Just a normal entry — 中文也一样。"),
        c("output_getvar", "<%= getvar() %> reads flat then tree (VWD unwrapped)",
          "<%= getvar('fear') %>/<%= getvar('理.好感度') %>/<%= getvar('世界.访客.1') %>"),
        c("output_bare_identifier", "a bare identifier: subset resolves it; full EJS has no such global",
          "fear=<%= fear %>"),
        c("output_raw_vs_escaped", "<%= and <%- both output unescaped text", "<%= '<b>' %>|<%- '<b>' %>"),
        c("output_missing", "a missing value renders empty / undefined", "[<%= getvar('missing') %>]"),
        c("output_bool", "booleans: Python 'True' in the subset vs JS 'true'", "<%= getvar('flag') %>"),
        c("output_arith", "arithmetic and division", "<%= 7 / 2 %>|<%= 4 / 2 %>|<%= 0.1 + 0.2 %>|<%= 7 % 3 %>"),
        c("output_string_concat", "string concatenation", "<%= 'a' + 'b' %>|<%= getvar('mood') + '!' %>"),
        c("if_else_chain", "if / else if / else", [
            "<% if (getvar('fear') >= 8) { %>PANIC<% } else if (getvar('fear') >= 4) { %>uneasy<% } else { %>calm<% } %>"]),
        c("if_else_chain_vars", "the same chain over each fear value",
          ["<% if (fear >= 8) { %>PANIC<% } else if (fear >= 4) { %>uneasy<% } else { %>calm<% } %>"],
          flat_overrides=[{"fear": 9}, {"fear": 5}, {"fear": 1}]),
        c("nested_if", "nested conditionals", "<% if (getvar('fear') > 1) { %>A<% if (getvar('count') > 10) { %>B<% } %><% } %>"),
        c("comment_tag", "<%# %> is dropped", "x<%# secret note %>y"),
        c("dash_trim", "-%> swallows the following newline", "<%= 'a' -%>\nb"),
        c("underscore_trim", "<%_ and _%> whitespace slurping", "a   <%_ if (true) { _%>   \n  b  <%_ } _%>  \nc"),
        c("escape_block", "the <#escape-ejs> passthrough block (subset feature)", "<#escape-ejs>literal <%% if %%> text<#/escape-ejs>"),
        c("literal_percent", "<%% outputs a literal <% in real EJS", "a <%% b %%> c"),
        c("setvar_incvar_decvar", "setvar / incvar / decvar buffer writes in call order",
          "<% setvar('理.好感度', 40); incvar('fear', 2); decvar('fear') %>after: <%= getvar('fear') %>"),
        c("setvar_then_read", "a template reads its own write back via getvar; `variables` is a pre-render snapshot",
          "<% setvar('mood', 'calm') %><%= getvar('mood') %>|<%= variables.mood %>"),
        c("setvar_prefix_stripped", "variables./stat_data. prefixes are stripped from write paths",
          "<% setvar('variables.a', 1); setvar('stat_data.b.c', 2) %>ok"),
        c("incvar_non_numeric", "incvar on a non-number starts from 0", "<% incvar('mood') %><%= getvar('mood') %>"),
        c("writes_capped", "at most 64 template writes are kept", "<% for (const i of _.range(70)) { setvar('k' + i, i) } %>done"),
        c("loops_lodash_await", "loops, lodash and await", "<% for (const i of _.range(2)) { %>[<%= i %>]<% } %><%= await Promise.resolve('async') %>"),
        c("lodash_chain", "lodash chains", "<%= _.chain([3, 1, 2]).sortBy().map(x => x * 2).join(',').value() %>"),
        c("stat_data_raw_pair", "stat_data exposes the raw tree (VWD pairs intact); SafeGetValue unwraps",
          "<%= JSON.stringify(stat_data.理.好感度) %>|<%= SafeGetValue(stat_data.理.好感度) %>|<%= data.stat_data.世界.日 %>"),
        c("variables_object", "variables = tree merged with flat", "<%= variables.mood %>|<%= variables.世界.日 %>"),
        c("getvar_defaults", "getvar(name, {defaults}) for missing values", "<%= getvar('missing', {defaults: 'dflt'}) %>|<%= getvar('fear', {defaults: 0}) %>"),
        c("getwi", "getwi() returns an entry's content or ''", "<%- getwi('chapel') %>|[<%= getwi('nope') %>]"),
        c("activewi", "activewi() records names for the worldbook's extra pass", "<% activewi('chapel'); activewi('chapel') %>ok"),
        c("inject_prompt", "injectPrompt / getPromptsInjected round trip", "<% injectPrompt('cot', 'think'); injectPrompt('cot', 'more') %><%= getPromptsInjected('cot') %>"),
        c("define_persists_in_engine", "define() persists across renders on ONE engine", ["<% define('carried', 'over') %>", "<%= carried %>"]),
        c("print_is_identity", "print() returns its value but does not output (differs from ST)", "a<% print('x') %>b<%= print('y') %>"),
        c("getchar_getchat", "getchar()/getchat() read the char/chat snapshots", "<%= getchar('name') %>|<%= getchat('id') %>|<%= getchar('missing') %>",
          char={"name": "络络"}, chat={"id": "c1"}),
        c("execvar", "execvar() evaluates a string variable as code", "<%= execvar('code') %>", flat_extra={"code": "1 + 2"}),
        c("faker_stubbed", "faker is stubbed with a warning", "[<%= faker.person.firstName() %>]"),
        c("template_literal_and_functions", "template literals and local functions",
          "<% function greet(n) { return `hi ${n}`; } %><%= greet(getvar('mood')) %>"),
        c("async_function", "async functions and await", "<% const f = async () => 5; %><%= await f() %>"),
        c("runtime_error", "an undefined name throws (caller falls back to the subset)", "<%= definitely_not_defined_anywhere %>"),
        c("syntax_error", "invalid JavaScript inside a tag", "<% if ( { %>x"),
        c("unclosed_tag", "an unclosed tag", "a <%= getvar('fear') "),
        c("infinite_loop", "while(true) hits the time limit", "<% while(true){} %>"),
        c("thrown_value", "a thrown string", "<% throw 'boom' %>"),
        c("rejected_promise", "an awaited rejection", "<%= await Promise.reject(new Error('nope')) %>"),
        c("unbalanced_subset", "unbalanced block: the subset strips tags and keeps text", "<% if (getvar('fear')) { %>hello"),
        c("stray_close", "a stray closing brace", "hello<% } %>world"),
        c("broken_condition_subset", "an expression only the subset rejects", "<% if (1 ~ 2) { %>X<% } %>ok"),
        c("unsupported_statement_subset", "a statement the subset does not know", "<% await getwi('chapel') %>ok"),
        c("safegetvalue_subset", "SafeGetValue() is not in the subset grammar", "a<%= SafeGetValue(stat_data.理.好感度) %>b"),
        c("getvar_extra_args_subset", "getvar(name, opts) — the subset ignores extra arguments", "<%= getvar('fear', {defaults: 0}) %>"),
        c("cjk_identifiers", "CJK identifiers in expressions (subset) / property access (JS)",
          "<% if (stat_data.理.好感度[0] > 30) { %>fond<% } %>"),
        c("deep_nesting_17", "17 nested ifs exceed the subset's depth limit",
          "".join("<% if (true) { %>" for _ in range(17)) + "deep" + "".join("<% } %>" for _ in range(17))),
        c("oversized", "a template over 20000 chars is left verbatim by the subset", "<%= 1 %>" + "x" * 20_001),
        c("conditions", "eval_condition: JS conditions against the bridge scope", [], conditions=[
            "variables.fear >= 5", "stat_data.理.好感度[0] === 33", "[1,2,3].some(x => x > 2)",
            "getvar('mood') === 'calm'", "nonexistent.deep.path > 1", "fear > 1", "1", "'yes'", "", "null",
            "while(true){}", "getvar('理.好感度') == 33", "_.includes(['a'], 'a')"]),
    ]


def _classify_ejs_error(message: str) -> str:
    lowered = message.lower()
    if "interrupted" in lowered:
        return "timeout"
    if "while compiling ejs" in lowered or "could not find matching close tag" in lowered or "syntaxerror" in lowered:
        return "syntax"
    return "runtime"


def _lite_render(template: str, flat: dict[str, Any], tree: dict[str, Any]) -> dict[str, Any]:
    readonly = ejs_lite.render(template, build_resolver(flat, tree))
    values = dict(flat)
    writes: list[list[Any]] = []

    def setter(name: str, value: Any) -> None:
        writes.append([name, value])
        values[name] = value

    with_setter = ejs_lite.render(template, build_resolver(values, tree), setter)
    return {
        "text": readonly.text, "warnings": readonly.warnings,
        "with_setter": {"text": with_setter.text, "warnings": with_setter.warnings, "writes": writes},
    }


def export_ejs() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    full_rows: list[dict[str, Any]] = []
    lite_rows: list[dict[str, Any]] = []
    have_js = quickjs_available()
    for case in _ejs_cases():
        variants = case.get("flat_overrides") or [None]
        for index, override in enumerate(variants):
            flat = {**EJS_FLAT, **(case.get("flat_extra") or {}), **(override or {})}
            name = case["case"] if override is None else f"{case['case']}_{index}"
            inputs = {"flat": flat, "tree": EJS_TREE, "worldinfo": EJS_WI, "char": case.get("char") or {},
                      "chat": case.get("chat") or {}, "templates": case["templates"]}
            if have_js:
                engine = create_full_engine(flat_variables=flat, tree=copy.deepcopy(EJS_TREE), worldinfo=EJS_WI,
                                            char=case.get("char"), chat=case.get("chat"))
                assert engine is not None
                renders = []
                for template in case["templates"]:
                    try:
                        result = engine.render(template)
                        renders.append({"ok": True, "text": result.text, "warnings": result.warnings})
                    except EjsFullError as exc:
                        renders.append({"ok": False, "error_class": _classify_ejs_error(str(exc)),
                                        "error_message": str(exc)})
                conditions = [{"expression": expr, "result": engine.eval_condition(expr)}
                              for expr in case.get("conditions") or []]
                full_inputs = dict(inputs)
                if case.get("conditions"):
                    full_inputs["conditions"] = case["conditions"]
                full_rows.append({
                    "case": f"full_{name}", "note": case["note"], "input": full_inputs, "renders": renders,
                    "conditions": conditions, "pending_writes": _jsonable(engine.pending_writes),
                    "activated": engine.activated,
                })
            for t_index, template in enumerate(case["templates"]):
                lite_rows.append({
                    "case": f"lite_{name}" + (f"_{t_index}" if len(case["templates"]) > 1 else ""),
                    "note": case["note"],
                    "input": {"flat": flat, "tree": EJS_TREE, "template": template},
                    **_lite_render(template, flat, EJS_TREE),
                })
    return full_rows, lite_rows


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def _export_async() -> list[tuple[str, int, str]]:
    i18n = I18n("en", base_dir=REPO / "locales")
    written = [
        _write("st_card_parse", export_card_parse()),
        _write("st_card_split", await export_card_split()),
        _write("st_worldbook_import", await export_worldbook_import()),
        _write("st_worldbook_activation", await export_worldbook_activation(i18n)),
        _write("st_macros", export_macros()),
        _write("st_decorators", export_decorators()),
        _write("st_mvu_initvar", export_mvu_initvar()),
        _write("st_mvu_update", export_mvu_update()),
        _write("st_mvu_tree", export_mvu_tree()),
    ]
    full_rows, lite_rows = export_ejs()
    if full_rows:
        written.append(_write("st_ejs_full", full_rows))
    written.append(_write("st_ejs_lite", lite_rows))
    return written


def export() -> list[tuple[str, int, str]]:
    """Write every `st_*` reference file; returns (filename, rows, sha256) per file."""
    import logging

    logging.disable(logging.WARNING)
    try:
        return asyncio.run(_export_async())
    finally:
        logging.disable(logging.NOTSET)


if __name__ == "__main__":
    for filename, count, digest in export():
        print(f"{filename}\t{count}\t{digest}")
