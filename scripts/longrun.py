"""Long-run / context-edge play-test.

Drives ONE persistent campaign for many turns to surface long-session degradation the
short runs can't: the Keeper only ever sees the last ~20 replayed messages (agent.loop
_HISTORY_CAP) plus fixed module pools and a summary of *prior archived* sessions -- there
is no running summary of the CURRENT session. So the real failure mode over hundreds of
turns is amnesia / contradiction, not a context-overflow crash (context is bounded).

This harness plants memorable ANCHOR facts in the opening turns, then PROBES them at
growing distances and checks whether the Keeper still remembers -- coherence-over-distance.
It also tracks per-turn latency, leaks, empty replies and errors. It is RESUMABLE: state
lives in a file-backed store (data/longrun.db) + a turn counter, so re-running continues the
same campaign (which also exercises the auto-save/restore feature over a long horizon). Each
invocation self-limits to a wall-clock budget so it fits the shell timeout; re-run to add more.

  .venv/bin/python scripts/longrun.py --module modules/shuxue.md --max-turns 300 --budget 520
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except Exception:
    pass

from agent.context import AgentCtx, LocalFs  # noqa: E402
from agent.kp_tools import build_kp_toolset  # noqa: E402
from agent.services import build_services  # noqa: E402
from core.charcard import parse_card_file  # noqa: E402
from gateway.commands import CommandRouter  # noqa: E402
from gateway.hub import RoomHub  # noqa: E402
from gateway.turn import run_turn  # noqa: E402
from infra.config import get_settings  # noqa: E402
from infra.embeddings import LocalEmbeddings  # noqa: E402

CHAT_KEY = "longrun:campaign"
# (anchor id, the player line that establishes it, the phrase the KP should still recall)
ANCHORS = [
    ("oak", "Before we go in, I carve the initials K.V. deep into the third oak by the gate. Remember that mark.", "K.V."),
    ("key", "I hide the brass key under the loose floorboard just inside the front door, and tell everyone.", "floorboard"),
    ("dog", "I name the scruffy stray dog that keeps following us 'Boomer'.", "Boomer"),
    ("vow", "I swear aloud, so all can hear: I will never enter the cellar alone.", "cellar"),
]


async def _chat(services, prompt, temperature=0.9):
    try:
        r = await services.llm.chat([{"role": "user", "content": prompt}], temperature=temperature)
        return (r.content or "").strip()
    except Exception:
        return ""


async def _gen_action(services, recent):
    p = ("You are a cautious Call of Cthulhu investigator (a PLAYER, not the Keeper). Recent play:\n"
         f"{recent[-1600:]}\n\nSay in ONE short first-person line what you do or say next; occasionally attempt "
         "something needing a skill check. Output only the line.")
    return (await _chat(services, p)).splitlines()[0][:220] if True else ""


async def _setup(services, ts, module_path, companion_path, rec):
    fs = LocalFs(str(ROOT))
    ctx = AgentCtx(chat_key=CHAT_KEY, user_id="longrun:setup", platform="cli", locale="en", fs=fs)
    if await services.store.get(store_key=f"longrun.setup_done.{CHAT_KEY}"):
        keeper = (await services.store.get(store_key=f"module_keeper_pool.{CHAT_KEY}")) or ""
        return keeper
    text = module_path.read_text(encoding="utf-8")
    await services.store.set(store_key=f"module_fulltext.{CHAT_KEY}", value=text)
    await services.module_init.initialize(CHAT_KEY)
    keeper = (await services.store.get(store_key=f"module_keeper_pool.{CHAT_KEY}")) or ""
    if companion_path and companion_path.exists():
        try:
            card = parse_card_file(companion_path)
            await ts.dispatch("import_character", ctx, {"file_path": str(companion_path), "system": "coc7", "as_": "companion"})
            rec(kind="companion", name=card.name)
        except Exception as exc:
            rec(kind="companion_error", error=str(exc))
    await ts.dispatch("create_character", AgentCtx(chat_key=CHAT_KEY, user_id="pc:Nora", platform="cli", locale="en", fs=fs),
                      {"name": "Nora", "system": "coc7"})
    await services.store.set(store_key=f"longrun.setup_done.{CHAT_KEY}", value="1")
    rec(kind="setup", keeper_pool_chars=len(keeper))
    return keeper


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--module", default="modules/shuxue.md")
    ap.add_argument("--companion", default="cards/companion_shenmo.json")
    ap.add_argument("--max-turns", type=int, default=300)
    ap.add_argument("--probe-every", type=int, default=25)
    ap.add_argument("--budget", type=int, default=520, help="wall-clock seconds this invocation may run")
    ap.add_argument("--log", default="playtest/longrun.jsonl")
    args = ap.parse_args()

    settings = get_settings()
    services = build_services(settings, embeddings=LocalEmbeddings(64), db_path=str(ROOT / "data" / "longrun.db"))
    ts = build_kp_toolset(services)
    router = CommandRouter(services)
    hub = RoomHub()
    fs = LocalFs(str(ROOT))

    log_path = ROOT / args.log
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fh = log_path.open("a", encoding="utf-8")

    def rec(**f):
        fh.write(json.dumps(f, ensure_ascii=False) + "\n")
        fh.flush()

    keeper = await _setup(services, ts, ROOT / args.module, ROOT / args.companion, rec)
    secret_lines = [ln.strip() for ln in keeper.splitlines() if len(ln.strip()) > 40][:60]

    done = int(await services.store.get(store_key=f"longrun.turns_done.{CHAT_KEY}") or 0)
    rec(kind="resume", turns_already_done=done, target=args.max_turns)
    ctx = AgentCtx(chat_key=CHAT_KEY, user_id="pc:Nora", platform="cli", locale="en", fs=fs)

    # Plant anchors as the very first turns of the campaign.
    transcript: list[str] = []
    start = time.time()
    lat: list[float] = []
    leaks = errors = empty = probes_ok = probes_total = 0

    async def do_turn(turn_no, action, is_probe=False, anchor_phrase=None):
        nonlocal leaks, errors, empty, probes_ok, probes_total
        transcript.append(f">>> {action}")
        t0 = time.time()
        try:
            res = await run_turn(hub, services, ctx, action, command_router=router, toolset=ts, actor_name="Nora")
            reply = (getattr(res, "reply", "") or "")
        except Exception as exc:
            errors += 1
            rec(kind="TURN_ERROR", turn=turn_no, action=action, error=f"{type(exc).__name__}: {exc}",
                trace=traceback.format_exc()[-800:])
            return
        dt = time.time() - t0
        lat.append(dt)
        transcript.append(f"[KP] {reply[:300]}")
        leaked = next((s for s in secret_lines if s and s in reply), None)
        if leaked:
            leaks += 1
            rec(kind="LEAK", turn=turn_no, secret=leaked[:100], reply=reply[:200])
        if not reply.strip():
            empty += 1
        if is_probe:
            probes_total += 1
            ok = bool(anchor_phrase and anchor_phrase.lower() in reply.lower())
            probes_ok += int(ok)
            rec(kind="PROBE", turn=turn_no, anchor=anchor_phrase, remembered=ok, reply=reply[:200])
        rec(kind="turn", turn=turn_no, latency=round(dt, 2), tools=[t.get("name") for t in getattr(res, "tool_trace", [])],
            leaked=bool(leaked), empty=(not reply.strip()), action=action[:120], kp_reply=reply[:200])

    turn = done
    # opening: plant anchors (only if this is a fresh campaign)
    if done == 0:
        for _id, line, _phrase in ANCHORS:
            turn += 1
            await do_turn(turn, line)

    while turn < args.max_turns and (time.time() - start) < args.budget:
        turn += 1
        if turn % args.probe_every == 0:
            _id, _line, phrase = ANCHORS[(turn // args.probe_every) % len(ANCHORS)]
            probe = f"Quick memory check for the group — remind me exactly: what about the {_id}? (I set this up much earlier.)"
            await do_turn(turn, probe, is_probe=True, anchor_phrase=phrase)
        else:
            action = await _gen_action(services, "\n".join(transcript[-14:]))
            await do_turn(turn, action or "I stay alert and press on.")
        if turn % 20 == 0:
            avg = sum(lat) / len(lat) if lat else 0
            rec(kind="checkpoint", turn=turn, avg_latency=round(avg, 2),
                max_latency=round(max(lat), 2) if lat else 0, leaks=leaks, errors=errors,
                empty=empty, probes_ok=probes_ok, probes_total=probes_total)

    await services.store.set(store_key=f"longrun.turns_done.{CHAT_KEY}", value=str(turn))
    avg = sum(lat) / len(lat) if lat else 0
    first10 = sum(lat[:10]) / max(1, len(lat[:10]))
    last10 = sum(lat[-10:]) / max(1, len(lat[-10:]))
    rec(kind="run_end", turns_now=turn, target=args.max_turns, this_invocation=len(lat), leaks=leaks, errors=errors,
        empty=empty, probes_ok=probes_ok, probes_total=probes_total, avg_latency=round(avg, 2),
        latency_first10=round(first10, 2), latency_last10=round(last10, 2))
    fh.close()
    print(f"longrun: campaign at turn {turn}/{args.max_turns} (+{len(lat)} this run) | leaks={leaks} errors={errors} "
          f"empty={empty} | coherence probes {probes_ok}/{probes_total} remembered | "
          f"latency avg={avg:.1f}s first10={first10:.1f}s last10={last10:.1f}s | log -> {args.log}")
    if turn < args.max_turns:
        print(f"  budget/timeout reached — RE-RUN the same command to continue from turn {turn}.")


if __name__ == "__main__":
    asyncio.run(main())
