from adapters.cli.adapter import CliAdapter
from adapters.cli.selfplay import run_script
from agent.services import build_services
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _services():
    return build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


async def test_cli_adapter_send_prints(capsys):
    adapter = CliAdapter()

    result = await adapter.send(SessionSource(platform="cli", chat_id="local"), "hello")

    assert result.ok
    assert capsys.readouterr().out == "hello\n"


async def test_run_script_rolls_bare_cli_command():
    replies = await run_script(["r 1d1+1"], _services())

    assert replies
    assert "2" in replies[0]


async def test_run_script_help_and_bot_commands_work():
    replies = await run_script([".help", ".bot off"], _services())

    assert len(replies) == 2
    assert "Commands:" in replies[0]
    assert replies[1] == "Bot disabled."
