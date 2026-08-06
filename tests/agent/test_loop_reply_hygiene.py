"""Player-visible reply hygiene: tool-call-shaped machinery a model writes as plain TEXT
never reaches the players (2026-08-06 live playtest: a foreign-harness `<Deep><use>` block
carried keeper-side meta about an NPC straight into the reply)."""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.loop import _strip_text_tool_calls, run_kp_turn
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

LIVE_SAMPLE = (
    "「你要看房子，拿去。用完挂回来。」\n\n"
    "<Deep>\n<use>\n<name>mcp__oc__kp_note</name>\n"
    '<args>{"action": "add", "content": "老周对问题沉默绕开（它不能说谎，只答非所问）。"}</args>\n'
    "</use>\n</Deep>\n\n"
    "那枚钥匙就悬在小窗口，黄纸签被门房的灯照得发脆。"
)


def test_strip_removes_machinery_blocks_and_keeps_narration():
    cleaned = _strip_text_tool_calls(LIVE_SAMPLE)
    assert "<Deep>" not in cleaned and "mcp__" not in cleaned
    assert "不能说谎" not in cleaned  # the keeper meta rode inside the fake call's args
    assert "你要看房子，拿去。用完挂回来。" in cleaned
    assert "黄纸签被门房的灯照得发脆" in cleaned


def test_strip_leaves_plain_and_angle_bracket_free_prose_alone():
    prose = "老周放下抹布。窗外雨声<忽然>密了一层。"  # decorative brackets, no tool markers
    assert _strip_text_tool_calls(prose) == prose


async def test_run_kp_turn_never_ships_text_tool_calls_to_players(tmp_path):
    def responder(messages, tools):
        return assistant_text(LIVE_SAMPLE)

    services = build_services(Settings(locale="zh"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(16))
    ctx = AgentCtx(chat_key="hygiene-room", user_id="p1", locale="zh")

    result = await run_kp_turn(ctx, services, build_kp_toolset(services), "我看着他。")

    assert "<Deep>" not in result.reply and "mcp__" not in result.reply
    assert "钥匙" in result.reply
