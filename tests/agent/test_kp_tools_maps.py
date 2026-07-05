import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import t
from infra.llm import FakeLLM


class _Hub:
    def __init__(self) -> None:
        self.events = []

    async def publish(self, session_key, event, *, exclude=None):
        self.events.append((session_key, event, exclude))


def _services(tmp_path):
    return build_services(Settings(locale="en", data_dir=str(tmp_path)), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))


def test_draw_svg_map_is_gated(tmp_path):
    toolset = build_kp_toolset(_services(tmp_path))

    locked = {schema["function"]["name"] for schema in toolset.schemas()}
    unlocked = {schema["function"]["name"] for schema in toolset.schemas(unlocked={"draw_svg_map"})}

    assert "draw_svg_map" not in locked
    assert "draw_svg_map" in unlocked


async def test_draw_svg_map_dispatch_generates_media_history_and_event(tmp_path):
    services = _services(tmp_path)
    hub = _Hub()
    toolset = build_kp_toolset(services, hub=hub)
    ctx = AgentCtx(chat_key="chat-map", user_id="kp", locale="en")

    locked = await toolset.dispatch("draw_svg_map", ctx, {"title": "Locked", "areas_json": "[]"})
    assert locked == t("agent.tools.tool_not_available", locale="en", name="draw_svg_map")

    result = await toolset.dispatch(
        "draw_svg_map",
        ctx,
        {
            "title": "Old Chapel",
            "areas_json": json.dumps([{"id": "chapel", "name": "Chapel"}]),
        },
        unlocked={"draw_svg_map"},
    )

    assert "old-chapel.svg" in result
    raw = await services.store.get(user_key="", store_key="media_history.chat-map")
    history = json.loads(raw or "[]")
    assert history[-1]["mime"] == "image/svg+xml"
    assert history[-1]["name"] == "old-chapel.svg"
    assert hub.events[-1][1].kind == "media"
