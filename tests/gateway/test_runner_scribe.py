"""The standalone (CLI) channel runs the SAME post-turn Scribe pass as the hub path.

k3's pipeline playtest (D2) caught the gap live: 12+ AI-KP turns through the CLI left
zero chronicle records — the pass was only ever scheduled on the hub path, so the one
channel a module author lives in (the offline test loop) silently lost auto-chronicle,
tracker reconciliation and habits. The standalone path now AWAITS the pass inline
(`gateway.turn.run_scribe_pass`): a one-shot ``--exec`` process has no later moment to
hide the latency in, and a fire-and-forget task would die with the process.
"""

from __future__ import annotations

import json

from agent.chronicle import CHRONICLE_DOC_TYPE
from agent.context import AgentCtx
from agent.services import build_services
from gateway.runner import GatewayRunner
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM

RECORD = "The party rang the chapel bell and the tide answered."


def _services(tmp_path):
    def responder(messages, tools):
        if tools:  # the KP turn call carries the toolset; the Scribe's ledger call does not
            return ChatResult(content="The bell tolls once.", tool_calls=[])
        return ChatResult(content=json.dumps({"ops": [], "whispers": [], "chronicle": RECORD}), tool_calls=[])

    services = build_services(
        Settings(_env_file=None, data_dir=str(tmp_path / "data")),
        llm=FakeLLM(responder=responder),
        embeddings=FakeEmbeddings(64),
    )
    # The suite-wide conftest turns both off; this lane is their intersection.
    services.settings.scribe.enabled = True
    services.settings.chronicle.enabled = True
    return services


async def test_standalone_turn_runs_the_scribe_pass_inline(tmp_path):
    services = _services(tmp_path)
    runner = GatewayRunner(services, [])
    ctx = AgentCtx(chat_key="cli:solo:scribe", user_id="u1", platform="cli", locale="en")

    reply = await runner._answer_standalone(ctx, "we ring the bell")

    assert reply is not None and reply.text
    # No draining, no sleeping: by the time the reply returns, the record exists —
    # that is the inline-await contract.
    docs = await services.documents.list("cli:solo:scribe", CHRONICLE_DOC_TYPE)
    assert len(docs) == 1
    assert docs[0].data["text"] == RECORD
