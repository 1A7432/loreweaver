"""Iron rule #5, made structural: every model call site declares its LANE.

The rule's letter used to read "no other module may put text into the model's
context", while the code has — correctly — six independent callers: the Keeper turn,
four knowledge-SCOPED actors that must assemble their own prompt from their own record
(that scoping IS information isolation, iron rule #3), memory folding and authoring.
The invariant worth pinning is narrower and sharper:

* the KEEPER's context has exactly ONE assembler, `agent.prompt_builder`, and exactly
  ONE caller, the turn loop — no other module builds or extends what the Keeper sees;
* every other call site is a scoped actor, a memory fold or an authoring/prep lane,
  each with its own scoped assembler and NO access to the keeper pool beyond what its
  lane is entitled to;
* `core/` makes no model calls at all (iron rule #1 — the deterministic engine).

A new `.chat(...)` call site anywhere in production code fails this test until it is
added to `MODEL_CALL_LANES` with its lane named — which is the moment to ask whether it
should exist. A listed file that stops calling the model fails too, so the table never
rots. Plumbing wrappers (retry, provider mux) are listed so the scan stays exact.
"""

from __future__ import annotations

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_TOPS = ("core", "infra", "agent", "gateway", "net", "adapters")

KEEPER = "keeper"  # THE Keeper turn: context assembled by agent.prompt_builder alone
SCOPED_ACTOR = "scoped-actor"  # its own prompt from its own record (NPC, companion, Director, Scribe)
MEMORY = "memory"  # the chronicle fold — summarizes player-grade records
AUTHORING = "authoring"  # prep/offline generation: forge, module analysis, RAG answers, persona→sheet
PLUMBING = "plumbing"  # transport wrappers that forward a call unchanged

MODEL_CALL_LANES: dict[str, str] = {
    "agent/loop.py": KEEPER,
    "agent/npc_actor.py": SCOPED_ACTOR,
    "agent/companion_actor.py": SCOPED_ACTOR,
    "agent/stage_director.py": SCOPED_ACTOR,
    "agent/scribe.py": SCOPED_ACTOR,
    "agent/chronicle.py": MEMORY,
    "agent/forge.py": AUTHORING,
    "agent/module_initializer.py": AUTHORING,
    "agent/document_manager.py": AUTHORING,
    "agent/char_from_persona.py": AUTHORING,
    "infra/llm_retry.py": PLUMBING,
    "infra/providers.py": PLUMBING,
}


def _chat_call_sites() -> dict[str, list[int]]:
    sites: dict[str, list[int]] = {}
    for top in PRODUCTION_TOPS:
        for path in sorted((REPO_ROOT / top).rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            lines = [
                node.lineno
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "chat"
            ]
            if lines:
                sites[path.relative_to(REPO_ROOT).as_posix()] = lines
    return sites


def test_every_model_call_site_declares_its_lane() -> None:
    sites = _chat_call_sites()
    undeclared = sorted(set(sites) - set(MODEL_CALL_LANES))
    assert not undeclared, (
        f"new model call site(s) {undeclared}: add each to MODEL_CALL_LANES with its lane "
        "(keeper / scoped-actor / memory / authoring / plumbing) — and ask whether it should exist"
    )
    stale = sorted(set(MODEL_CALL_LANES) - set(sites))
    assert not stale, f"MODEL_CALL_LANES lists {stale}, which no longer call the model — remove them"


def test_the_keeper_has_one_assembler_and_one_caller() -> None:
    keeper_callers = sorted(path for path, lane in MODEL_CALL_LANES.items() if lane == KEEPER)
    assert keeper_callers == ["agent/loop.py"], keeper_callers

    # The Keeper's context comes from agent.prompt_builder and nowhere else: no other
    # production module may import the assembler (a second importer would be a second
    # place Keeper context is shaped).
    importers: list[str] = []
    for top in PRODUCTION_TOPS:
        for path in sorted((REPO_ROOT / top).rglob("*.py")):
            if path.name == "prompt_builder.py":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                module = node.module if isinstance(node, ast.ImportFrom) else None
                names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else []
                if module == "agent.prompt_builder" or "agent.prompt_builder" in names:
                    importers.append(path.relative_to(REPO_ROOT).as_posix())
    assert importers == ["agent/loop.py"], importers


def test_core_makes_no_model_calls() -> None:
    """Iron rule #1: core/ is the deterministic engine. The three generative modules
    that used to live there (module analysis, RAG answers, persona→sheet) moved to
    agent/ on 2026-08-19; nothing may move back."""
    offenders = [path for path in _chat_call_sites() if path.startswith("core/")]
    assert not offenders, f"core/ must not call the model: {offenders}"
