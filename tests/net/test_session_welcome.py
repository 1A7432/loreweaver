from types import SimpleNamespace

from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.session import guided_demo_available, is_guided_demo_action, uses_demo_llm, welcome_frame

_FIELDS = {
    "id": "tui:demo",
    "name": "Keeper",
    "role": "keeper",
    "room": "demo",
    "locale": "en",
}


def test_welcome_advertises_guided_demo_as_an_additive_feature():
    frame = welcome_frame(_FIELDS, imagegen=True, demo=True)

    assert frame["features"] == ["media", "audio", "imagegen", "demo"]


def test_demo_capability_tracks_mutable_llm_fallback_state():
    active = SimpleNamespace(llm=SimpleNamespace(using_fallback=True))
    configured = SimpleNamespace(llm=SimpleNamespace(using_fallback=False))
    legacy = SimpleNamespace(llm=object())

    assert uses_demo_llm(active) is True
    assert uses_demo_llm(configured) is False
    assert uses_demo_llm(legacy) is False


def test_guided_action_matches_both_client_locales():
    assert is_guided_demo_action("Start the built-in sample adventure")
    assert is_guided_demo_action("开始内置示例冒险")
    assert not is_guided_demo_action("start this existing campaign")


async def test_guided_demo_requires_an_empty_room(tmp_path):
    services = build_services(
        Settings(data_dir=str(tmp_path)),
        llm=FakeLLM(),
        embeddings=FakeEmbeddings(16),
    )
    services.llm = SimpleNamespace(using_fallback=True)
    chat_key = "tui:group:demo"

    assert await guided_demo_available(services, chat_key) is True

    await services.store.set(
        user_key="",
        store_key=f"session_record.{chat_key}.current",
        value='{"name":"existing"}',
    )
    assert await guided_demo_available(services, chat_key) is False


async def test_guided_demo_requires_vector_support(tmp_path):
    services = build_services(
        Settings(data_dir=str(tmp_path), enable_vector_db=False),
        llm=FakeLLM(),
        embeddings=FakeEmbeddings(16),
    )
    services.llm = SimpleNamespace(using_fallback=True)

    assert await guided_demo_available(services, "tui:group:demo") is False
