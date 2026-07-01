"""End-to-end AI-KP self-play (acceptance criterion #1, loop level).

Drives the real function-calling loop with a scripted FakeLLM acting as the
Keeper: upload module -> analyze -> open -> player action -> REAL seeded dice
skill check -> session report. The whole time the Keeper reads keeper-only
material (get_module_summary) but must NEVER quote the hidden truth sentinel to
players. The leak assertion is the red line.

Everything is offline & deterministic: FakeLLM responder + FakeEmbeddings +
seeded dice.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.context import AgentCtx, LocalFs
from agent.kp_tools import build_kp_toolset
from agent.loop import run_kp_turn
from agent.services import build_services
from core.dice_engine import seed_dice
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"

# Keeper-only analysis: the sentinel lives ONLY in an NPC secret and a truth,
# both of which _build_knowledge_pools strips from the player pool.
ANALYSIS = {
    "summary": "Investigators probe three disappearances tied to the Blackmoor lighthouse.",
    "background": "Three sailors vanished this month; the lighthouse still burns each night.",
    "scenes": [
        {
            "name": "The Salt & Anchor Inn",
            "focus": "investigation",
            "description": "A dim, smoke-stained tavern where villagers fall silent about the lighthouse.",
            "keeper_notes": "Martha will admit the light 'changed color' if pressed.",
            "npcs_present": ["Martha"],
            "clues": [
                {
                    "name": "Tide table",
                    "description": "Three dates circled behind the harbor map.",
                    "discovery_method": "Spot Hidden",
                }
            ],
        }
    ],
    "npcs": [
        {
            "name": "Martha",
            "description": "A wary innkeeper who has seen too much.",
            "secret": "She glimpsed the keeper's rotting face. " + SENTINEL,
            "role": "innkeeper",
        },
        {
            "name": "Elias Crane",
            "description": "The reclusive lighthouse keeper, rarely seen in the village.",
            "secret": "Drowned two years ago; now a Deep One thrall.",
            "role": "antagonist",
        },
    ],
    "clues": [
        {
            "name": "Tide table",
            "description": "Three circled dates match the deaths.",
            "location": "inn",
            "leads_to": "lighthouse",
        }
    ],
    "timeline": [{"time": "Night 1", "event": "The lighthouse light turns a sickly green.", "involved": ["Elias"]}],
    "threats": [
        {
            "name": "Deep One thrall",
            "type": "monster",
            "description": "A drowned thing wearing a human face.",
            "stats": {"HP": "13", "STR": "80"},
            "attacks": ["claw 1d6+db"],
            "san_loss": "1/1d8",
            "special_abilities": "drag underwater",
            "location": "lighthouse",
        }
    ],
    "truths": [
        {
            "name": "The Truth of the Light",
            "description": SENTINEL + " — the light lures boats onto the rocks so the Deep Ones can feed.",
            "revealed_by": "the lamp room full of teeth",
        }
    ],
    "opening_facts": ["Three sailors vanished this month.", "The lighthouse burns every night."],
}

# Player-safe narrations — deliberately contain NO sentinel text.
OPENING = (
    "The Salt & Anchor Inn is dim and smoke-stained. Martha the innkeeper eyes you warily "
    "while the other patrons fall silent at the mention of the lighthouse. What do you do?"
)
SEARCH_HIT = (
    "Behind the water-stained harbor map your fingers find a scratched tide table — three "
    "dates circled in a shaky hand. A chill settles over you. What next?"
)
SEARCH_MISS = (
    "You run your hands along the desk and the wall but the smoky gloom hides whatever might "
    "be here. Martha watches you a little too closely. What next?"
)


def _tools_called_this_turn(messages: list[dict]) -> list[str]:
    """Tool names the assistant has already invoked since the last user message."""
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=0)
    called: list[str] = []
    for m in messages[last_user + 1 :]:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            called.extend(tc["function"]["name"] for tc in m["tool_calls"])
    return called


def _last_tool_result(messages: list[dict]) -> str:
    for m in reversed(messages):
        if m.get("role") == "tool":
            return str(m.get("content", ""))
    return ""


def kp_responder(messages, tools):
    """Scripted Keeper brain. Also answers the module-analysis call (which arrives
    as a single user message with no system prompt)."""
    if messages and messages[0].get("role") == "user" and "system" not in {m.get("role") for m in messages}:
        # module analysis request from ModuleInitializer
        return assistant_text(json.dumps(ANALYSIS))

    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=0)
    user_text = str(messages[last_user].get("content", "")).lower()
    called = _tools_called_this_turn(messages)

    if "begin" in user_text or "start" in user_text:
        if "get_module_summary" not in called:
            return assistant_tools(tool_call("get_module_summary"))
        return assistant_text(OPENING)

    if "search" in user_text or "desk" in user_text or "look" in user_text:
        if "skill_check" not in called:
            return assistant_tools(tool_call("skill_check", skill_name="Spot Hidden"))
        result = _last_tool_result(messages).lower()
        narration = SEARCH_MISS if ("fail" in result or "fumble" in result) else SEARCH_HIT
        return assistant_text(narration)

    return assistant_text("The lantern gutters low. Tell me what you do next.")


@pytest.mark.asyncio
async def test_kp_selfplay_en_no_leak():
    seed_dice(20240701)
    settings = Settings(locale="en")
    llm = FakeLLM(responder=kp_responder)
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(dim=64))
    toolset = build_kp_toolset(services)

    ctx = AgentCtx(
        chat_key="cli:dm:selfplay",
        user_id="cli:player1",
        platform="cli",
        locale="en",
        fs=LocalFs(str(FIXTURES)),
    )

    player_visible: list[str] = []

    # 1) Upload + analyze the module through the real tool path.
    up = await toolset.dispatch("upload_document", ctx, {"file_path": "module_en.txt", "doc_type": "module"})
    assert isinstance(up, str) and up
    status = await services.store.get(store_key=f"module_init_status.{ctx.chat_key}")
    assert status == "ready"
    keeper_pool = await services.store.get(store_key=f"module_keeper_pool.{ctx.chat_key}")
    player_pool = await services.store.get(store_key=f"module_player_pool.{ctx.chat_key}")
    assert SENTINEL in (keeper_pool or ""), "keeper pool must hold the hidden truth"
    assert SENTINEL not in (player_pool or ""), "player pool must NOT hold the hidden truth"

    # 2) Character + session setup (deterministic, no LLM).
    await toolset.dispatch("create_character", ctx, {"name": "Nora Vance", "system": "coc7"})
    await toolset.dispatch("update_character_skill", ctx, {"skill_name": "Spot Hidden", "value": 65})
    await toolset.dispatch("start_session_recording", ctx, {"session_name": "The Blackmoor Lighthouse"})

    # 3) Opening turn: KP consults keeper-only material then narrates safely.
    r1 = await run_kp_turn(ctx, services, toolset, "Let's begin the game.")
    player_visible.append(r1.reply)
    assert r1.reply.strip()
    keeper_calls = [t for t in r1.tool_trace if t["keeper_only"]]
    assert any(t["name"] == "get_module_summary" for t in keeper_calls), "KP should read the keeper summary"
    assert SENTINEL not in r1.reply

    # 4) Player action -> REAL seeded dice skill check.
    r2 = await run_kp_turn(ctx, services, toolset, "I search the desk and walls for hidden clues.")
    player_visible.append(r2.reply)
    checks = [t for t in r2.tool_trace if t["name"] == "skill_check"]
    assert checks, "a real skill_check must have happened"
    assert any(ch.isdigit() for ch in checks[0]["result"]), "the check result must carry a real rolled number"
    assert SENTINEL not in r2.reply

    # 5) Session report.
    report = await toolset.dispatch("generate_session_report", ctx, {})
    assert isinstance(report, str) and report.strip()
    player_visible.append(report)

    # 6) RED LINE: the hidden truth never reached the players, anywhere.
    everything_players_saw = "\n\n".join(player_visible)
    assert SENTINEL not in everything_players_saw
    # ...and prove the Keeper genuinely accessed the secret material (so this isn't a vacuous pass).
    assert keeper_pool and SENTINEL in keeper_pool


@pytest.mark.asyncio
async def test_kp_selfplay_is_deterministic():
    """Same seed -> same skill-check roll, proving the dice are real & reproducible."""

    async def run_once() -> int:
        seed_dice(42)
        services = build_services(
            Settings(locale="en"), llm=FakeLLM(responder=kp_responder), embeddings=FakeEmbeddings(dim=64)
        )
        toolset = build_kp_toolset(services)
        ctx = AgentCtx(chat_key="cli:dm:det", user_id="u", platform="cli", locale="en", fs=LocalFs(str(FIXTURES)))
        await toolset.dispatch("upload_document", ctx, {"file_path": "module_en.txt", "doc_type": "module"})
        await toolset.dispatch("create_character", ctx, {"name": "Nora", "system": "coc7"})
        await toolset.dispatch("update_character_skill", ctx, {"skill_name": "Spot Hidden", "value": 65})
        r = await run_kp_turn(ctx, services, toolset, "I search the desk.")
        check = next(t for t in r.tool_trace if t["name"] == "skill_check")
        digits = "".join(ch for ch in check["result"] if ch.isdigit())
        return int(digits[:3]) if digits else -1

    assert await run_once() == await run_once()
