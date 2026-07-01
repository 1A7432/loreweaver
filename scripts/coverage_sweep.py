"""Deterministic full-feature coverage sweep — does every player-facing feature work?

Enumerates EVERY registered command (via router._specs) and dispatches each with a
real alias + a sensible example argument, through the REAL CommandRouter, with a
FakeLLM (fast + deterministic — this checks the plumbing, not model quality; the LLM
play in scripts/playtest.py checks Keeper behaviour). A character is created first so
checks have a sheet. Nothing may crash the run; every failure is recorded, and the end
summary reports any command left uncovered.

  .venv/bin/python scripts/coverage_sweep.py [--log playtest/coverage.jsonl]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent.context import AgentCtx, LocalFs  # noqa: E402
from agent.services import build_services  # noqa: E402
from gateway.commands import CommandRouter  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import LocalEmbeddings  # noqa: E402
from infra.llm import ChatResult, FakeLLM  # noqa: E402


def _responder(messages, tools):
    return ChatResult(content="The lamplight flickers; you press on.", tool_calls=[], raw={})


# One representative argument per command canonical (empty = the bare command).
EXAMPLE_ARGS = {
    "roll": "3d6+2",
    "hidden_roll": "侦查",
    "check": "侦查",
    "opposed": "侦查",
    "sc": "1/1d6",
    "sheet": "show",
    "growth": "侦查",
    "init": "",
    "coc": "",
    "dnd": "",
    "setcoc": "2",
    "rename": "阿岚",
    "jrrp": "",
    "draw": "",
    "bot": "",
    "report": "",
    "party": "list",
    "lore": "list",
    "import": "cards/companion_shenmo.json companion",
    "room": "",
    "model": "",
    "help": "",
}

# Extra multi-argument variants a real player would type (run after the enumeration).
EXTRA = [
    ".st 力量60 敏捷55 意志60 侦查70 图书馆60 说服50 聆听55 心理学45 闪避40 手枪45",
    ".ra 困难 图书馆",
    ".ra 侦查 奖励",
    ".r 4d6kh3",
    ".r 1d20+5 优势",
    ".sc 1/1d6",
    ".report detailed",
    ".lore add 盐镇 一个被浓雾笼罩的海边小镇，居民对每年的上供讳莫如深。",
    ".lore query 盐镇",
    ".model list",
    ".model set deepseek deepseek-chat",
    ".jrrp",
    ".init",
    ".r 侦查",
    ".rh 图书馆",
    ".r 3d6x5",
]


def _classify(reply):
    if reply is None:
        return "UNMATCHED"
    if not str(reply).strip():
        return "EMPTY"
    return "OK"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default="playtest/coverage.jsonl")
    args = ap.parse_args()

    services = build_services(Settings(), llm=FakeLLM(responder=_responder), embeddings=LocalEmbeddings(64))
    router = CommandRouter(services)
    fs = LocalFs(str(ROOT))
    ctx = AgentCtx(chat_key="coverage:room", user_id="player:1", platform="cli", locale="zh", fs=fs)

    log_path = ROOT / args.log
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fh = log_path.open("w", encoding="utf-8")

    def rec(**f):
        fh.write(json.dumps(f, ensure_ascii=False) + "\n")

    tally = {"OK": 0, "EMPTY": 0, "UNMATCHED": 0, "ERROR": 0}
    hit: set[str] = set()

    async def fire(label, text):
        try:
            resolved = router.resolve(text, ctx.locale)
            if resolved is not None:
                hit.add(getattr(resolved[0], "canonical", "?"))
            reply = await router.dispatch(ctx, text)
            status = _classify(reply)
            tally[status] += 1
            rec(kind="cmd", label=label, input=text, status=status, reply=(str(reply)[:500] if reply else None))
            flag = "" if status == "OK" else "  <-- REVIEW"
            print(f"  [{status:9}] {label:16} {text[:46]}{flag}")
        except Exception as exc:
            tally["ERROR"] += 1
            rec(kind="cmd", label=label, input=text, status="ERROR",
                error=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc()[-900:])
            print(f"  [ERROR    ] {label:16} {text[:46]}  ({type(exc).__name__}: {exc})")

    # 1) make a character first (checks/sanity need a sheet)
    await fire("setup/coc", ".coc")
    await fire("setup/skills", EXTRA[0])

    # 2) enumerate EVERY registered command with a real alias + example arg
    specs = list(getattr(router, "_specs", []))
    for spec in specs:
        canonical = getattr(spec, "canonical", "?")
        token = next((k for k, v in router._alias_maps["zh"].items() if v is spec), None) \
            or next((k for k, v in router._alias_maps["en"].items() if v is spec), canonical)
        arg = EXAMPLE_ARGS.get(canonical, "")
        await fire(f"cmd/{canonical}", f".{token} {arg}".strip())

    # 3) realistic multi-arg variants
    for text in EXTRA[1:]:
        await fire("extra", text)

    all_specs = {getattr(s, "canonical", "?") for s in specs}
    uncovered = sorted(all_specs - hit)
    rec(kind="summary", **tally, commands_total=len(all_specs), commands_covered=len(hit), uncovered=uncovered)
    fh.close()

    print(f"\ncoverage sweep: OK={tally['OK']} EMPTY={tally['EMPTY']} UNMATCHED={tally['UNMATCHED']} "
          f"ERROR={tally['ERROR']} | commands {len(hit)}/{len(all_specs)} exercised")
    if uncovered:
        print("  UNCOVERED:", ", ".join(uncovered))
    problems = tally["EMPTY"] + tally["UNMATCHED"] + tally["ERROR"]
    print(f"  {'ALL FEATURES RESPOND OK' if problems == 0 else str(problems) + ' inputs need review'} | log -> {args.log}")


if __name__ == "__main__":
    asyncio.run(main())
