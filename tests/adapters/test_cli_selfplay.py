import re

from adapters.cli.adapter import CLI_CHAT_ID
from adapters.cli.demo import DEMO_SENTINEL, demo_kp_responder
from adapters.cli.selfplay import run_script
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _fixture_lines() -> list[str]:
    with open("tests/fixtures/selfplay_en.txt", encoding="utf-8") as handle:
        return [line.strip() for line in handle if line.strip()]


async def test_cli_selfplay_demo_no_keeper_secret_leak():
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(responder=demo_kp_responder),
        embeddings=FakeEmbeddings(64),
    )

    replies = await run_script(_fixture_lines(), services, seed=20240701)

    assert len(replies) == 4
    assert all(reply.strip() for reply in replies)
    combined = "\n\n".join(replies)
    assert DEMO_SENTINEL not in combined
    assert not re.search(r"[\u4e00-\u9fff]", combined)

    keeper_pool = await services.store.get(store_key=f"module_keeper_pool.cli:dm:{CLI_CHAT_ID}")
    assert keeper_pool and DEMO_SENTINEL in keeper_pool
