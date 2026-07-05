import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from core.character_manager import CharacterSheet
from gateway.commands import CommandRouter
from gateway.imagegen import reset_imagegen_limiters
from infra.config import ImageGenSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import t
from infra.imagegen import FakeImageGen
from infra.llm import FakeLLM


class _Hub:
    def __init__(self) -> None:
        self.events = []

    async def publish(self, session_key, event, *, exclude=None):
        self.events.append((session_key, event, exclude))

    def members(self, session_key):
        return []


def _services(tmp_path, *, per_hour: int = 10):
    settings = Settings(
        locale="en",
        data_dir=str(tmp_path),
        imagegen=ImageGenSettings(provider="fake", api_key="fake", model="fake", per_room_per_hour=per_hour),
    )
    services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    services.imagegen = FakeImageGen()
    return services


def test_generate_image_is_gated(tmp_path):
    toolset = build_kp_toolset(_services(tmp_path))

    locked = {schema["function"]["name"] for schema in toolset.schemas()}
    unlocked = {schema["function"]["name"] for schema in toolset.schemas(unlocked={"generate_image"})}

    assert "generate_image" not in locked
    assert "generate_image" in unlocked


async def test_generate_image_fake_end_to_end_records_media_history_and_event(tmp_path):
    reset_imagegen_limiters()
    services = _services(tmp_path)
    hub = _Hub()
    toolset = build_kp_toolset(services, hub=hub)
    ctx = AgentCtx(chat_key="chat-image", user_id="kp", locale="en")

    result = await toolset.dispatch(
        "generate_image",
        ctx,
        {"prompt": "misty chapel", "kind": "scene", "caption": "The chapel"},
        unlocked={"generate_image"},
    )

    assert "scene-misty-chapel.png" in result
    raw = await services.store.get(user_key="", store_key="media_history.chat-image")
    history = json.loads(raw or "[]")
    assert history[-1]["mime"] == "image/png"
    assert history[-1]["name"] == "scene-misty-chapel.png"
    assert hub.events[-1][1].kind == "media"


async def test_generate_image_unconfigured_returns_i18n_text(tmp_path):
    services = build_services(Settings(locale="en", data_dir=str(tmp_path)), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    toolset = build_kp_toolset(services)
    ctx = AgentCtx(chat_key="chat-image", user_id="kp", locale="en")

    result = await toolset.dispatch(
        "generate_image",
        ctx,
        {"prompt": "misty chapel"},
        unlocked={"generate_image"},
    )

    assert result == t("kp_tools.image.generate.not_configured", locale="en")


async def test_generate_image_shares_rate_limit_with_avatar_command(tmp_path):
    reset_imagegen_limiters()
    services = _services(tmp_path, per_hour=1)
    hub = _Hub()
    router = CommandRouter(services, hub=hub)
    toolset = build_kp_toolset(services, hub=hub)
    ctx = AgentCtx(chat_key="chat-avatar", user_id="player-1", locale="en")
    await services.characters.save_character("player-1", "chat-avatar", CharacterSheet("Nora", "CoC"))

    avatar_result = await router.dispatch(ctx, ".avatar gen dark hair and a green coat")
    assert "Avatar set for Nora" in avatar_result

    image_result = await toolset.dispatch(
        "generate_image",
        ctx,
        {"prompt": "a handout"},
        unlocked={"generate_image"},
    )
    assert image_result == t("kp_tools.image.generate.rate_limited", locale="en")
