"""The Scribe's tracker writes answer to a room hook's `tool_use` veto, like the Keeper's
`set_variable` / `adjust_variable` calls do. Born from the 2026-09-24 《安土》 Studio run:
the crossing ledger is hook-owned while the column marches, and the Scribe overwrote the
hook's booked number with the one the Keeper had guessed in its narration. Skipped
without the `ejs` extra (hooks are inert then)."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.hook_runtime import install_room_hooks  # noqa: E402
from agent.scribe import run_scribe  # noqa: E402
from agent.services import build_services  # noqa: E402
from core.modvars import build_spec, define_modvar, load_modvars, set_modvar  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM, assistant_text  # noqa: E402

CHAT = "scribe-veto-room"

# The shape of the 《安土》 guard: ledger writes are refused while the column marches.
_GUARD = (
    "on('tool_use', (e) => {"
    "  if (e.tool !== 'set_variable' && e.tool !== 'adjust_variable') return;"
    "  if (e.arguments.var_id === 'crossed' && getvar('marching') === true)"
    "    denyTool('the ledger is hook-owned while the column marches');"
    "});"
)


def _services(reply_json: str):
    llm = FakeLLM(responder=lambda messages, tools: assistant_text(reply_json))
    services = build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(64))
    services.settings.scribe.enabled = True
    return services


async def _room(services, *, marching: bool) -> None:
    await define_modvar(services.documents, CHAT, build_spec("crossed", "number", minimum=0, maximum=1000))
    await define_modvar(services.documents, CHAT, build_spec("morale", "number", minimum=0, maximum=10))
    await define_modvar(services.documents, CHAT, build_spec("marching", "bool"))
    await set_modvar(services.documents, CHAT, "crossed", 475)
    await set_modvar(services.documents, CHAT, "marching", marching)
    await install_room_hooks(services, CHAT, "test", [_GUARD])


_REPLY = "The column holds. 过环四百五十。Morale rose by one."
_OPS = json.dumps(
    {
        "ops": [
            {"op": "set", "id": "crossed", "value": 450, "evidence": "过环四百五十"},
            {"op": "adjust", "id": "crossed", "delta": -25, "evidence": "过环四百五十"},
            {"op": "adjust", "id": "morale", "delta": 1, "evidence": "Morale rose by one"},
        ],
        "whispers": [],
    }
)


async def test_a_hook_refused_write_keeps_the_hooks_number():
    services = _services(_OPS)
    await _room(services, marching=True)

    await run_scribe(services, AgentCtx(chat_key=CHAT, user_id="kp", locale="en"), "march on", _REPLY, [])

    values = (await load_modvars(services.documents, CHAT))["values"]
    assert values["crossed"] == 475  # both the set and the adjust were refused
    assert values["morale"] == 1  # an unguarded tracker still writes


async def test_the_same_write_lands_when_the_hook_allows_it():
    services = _services(_OPS)
    await _room(services, marching=False)

    await run_scribe(services, AgentCtx(chat_key=CHAT, user_id="kp", locale="en"), "march on", _REPLY, [])

    values = (await load_modvars(services.documents, CHAT))["values"]
    assert values["crossed"] == 425  # set to 450, then adjusted by -25
