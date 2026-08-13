"""M23 WS3: whatever reaches the model must be reconstructable from persisted state.

Two model-visible inputs used to exist only in process memory: `hooks.js` injections
(stashed on `ctx.extra` and read straight back) and the worldbook's `{{random}}`/
`{{pick}}` macros plus its `probability` rolls, which drew from an unseeded
`random.Random()`. Undo replay, join replay, playtest forensics and the behavioural
evals were all silently missing part of what the model actually saw.

This is not byte-identity worship — it is an explicit contract with a short, written
exemption list. A new prompt segment has to answer "how does this replay?" to get past
CI, and "it doesn't, because X" is a legitimate answer as long as X is written down.

The scan looks for the three ways a prompt input escapes persistence:

1. **unseeded randomness** — every generator in the assembler must be seeded from
   persisted state (`agent.prompt_builder.turn_rng`);
2. **the wall clock** — a prompt that reads real time cannot be rebuilt tomorrow;
3. **process-memory handoffs** — anything read off `ctx.extra` must name the row that
   records it, or be exempt with a reason.
"""

from __future__ import annotations

import ast
from pathlib import Path

PROMPT_BUILDER = Path(__file__).resolve().parents[2] / "agent" / "prompt_builder.py"

# Every `ctx.extra` key the assembler reads, and where a replay gets it back from.
# A key with no entry here fails the build.
EXTRA_KEY_SOURCES: dict[str, str] = {
    "hook_injections": (
        "persisted per turn by `agent.hook_runtime.record_hook_injections` into the "
        "`hook_injections` ring, in full text; the row is the record, and whoever needs "
        "to read it back reads it from there"
    ),
}

# Keys that are model-visible and NOT reconstructed from a row, with the reason. Kept
# separate from the map above so an exemption is a decision someone made, not an omission.
EXTRA_KEY_EXEMPTIONS: dict[str, str] = {
    "user_message": (
        "it IS this turn's input rather than a derived segment — the caller hands it in, "
        "and it lands in the history tree as the turn's user message when the turn commits"
    ),
}

# Prompt inputs the scan cannot see, recorded here so the contract stays honest about
# what it does and does not cover.
DOCUMENTED_EXEMPTIONS: dict[str, str] = {
    "vector top-k ordering": (
        "document and chronicle retrieval return semantically equivalent neighbours whose "
        "ORDER can shift between index builds; pinning it would mean freezing the index, "
        "and the segments it produces are equivalent, not identical"
    ),
}

_CLOCK_CALLS = {("datetime", "now"), ("datetime", "utcnow"), ("time", "time"), ("time", "monotonic")}


def _tree() -> ast.Module:
    return ast.parse(PROMPT_BUILDER.read_text(encoding="utf-8"))


def _attribute_path(node: ast.AST) -> tuple[str, ...]:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return tuple(reversed(parts))


def test_the_assembler_seeds_every_generator_it_builds():
    """`random.Random()` with no seed is a prompt segment nobody can rebuild."""
    unseeded: list[str] = []
    for node in ast.walk(_tree()):
        if not isinstance(node, ast.Call):
            continue
        path = _attribute_path(node.func)
        if path == ("random", "Random") and not node.args:
            unseeded.append(f"line {node.lineno}: random.Random() with no seed")
        elif path[:1] == ("random",) and path[1:] and path[1] != "Random":
            unseeded.append(f"line {node.lineno}: module-level random.{path[1]}()")
    assert not unseeded, (
        "prompt inputs that cannot be replayed:\n  "
        + "\n  ".join(unseeded)
        + "\nSeed from persisted state with `turn_rng(chat_key, turn, stream)`."
    )


def test_the_assembler_never_reads_the_wall_clock():
    """A prompt built from real time is a prompt that cannot be rebuilt tomorrow.

    The GAME clock is a different thing entirely: it is a persisted room_state row, and
    reading it is exactly what replay-ability means.
    """
    clock_reads = [
        f"line {node.lineno}: {'.'.join(_attribute_path(node.func))}()"
        for node in ast.walk(_tree())
        if isinstance(node, ast.Call) and _attribute_path(node.func)[-2:] in _CLOCK_CALLS
    ]
    assert not clock_reads, "the assembler reads the wall clock:\n  " + "\n  ".join(clock_reads)


def test_every_ctx_extra_key_the_assembler_reads_names_its_persisted_source():
    keys: set[str] = set()
    for node in ast.walk(_tree()):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
            if isinstance(node.func.value, ast.Name) and node.func.value.id == "extra" and node.args:
                if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    keys.add(node.args[0].value)
        elif isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "extra":
            if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
                keys.add(node.slice.value)

    assert keys, "positive control: the scan found no `ctx.extra` reads at all"
    unexplained = keys - set(EXTRA_KEY_SOURCES) - set(EXTRA_KEY_EXEMPTIONS)
    assert not unexplained, (
        f"prompt segments handed over in process memory with no persisted source: {sorted(unexplained)}. "
        "Record where a replay reads them back, or add a reasoned exemption."
    )


def test_every_recorded_exemption_carries_a_written_reason():
    """An exemption without a rationale is an omission wearing a costume."""
    for name, reason in (*EXTRA_KEY_EXEMPTIONS.items(), *DOCUMENTED_EXEMPTIONS.items()):
        assert len(reason.split()) >= 8, f"{name}: an exemption has to say why"


def test_the_row_the_manifest_names_is_the_row_the_writer_writes():
    """The manifest above says `hook_injections`; the writer must agree, or the contract
    documents a row nobody fills."""
    from agent.hook_runtime import INJECTION_RING_KEY, record_hook_injections

    assert INJECTION_RING_KEY in EXTRA_KEY_SOURCES["hook_injections"]
    assert callable(record_hook_injections)
