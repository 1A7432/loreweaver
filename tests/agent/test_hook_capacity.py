"""2.6.1 hook capacity: a large module's hook kernel (up to 8M characters) ships in a native
bundle and reaches a room, and the engine builds that are not needed are skipped. Skipped
as a module without the `ejs` extra (hooks are inert then)."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.hook_runtime import install_room_hooks, load_room_hook_engine  # noqa: E402
from agent.kp_tools_charcard import _parse_any_card_file  # noqa: E402
from agent.services import build_services  # noqa: E402
from core.charcard import MAX_CARD_FILE_BYTES  # noqa: E402
from core.lorecard import LORECARD_FORMAT, MAX_LORECARD_FILE_BYTES, parse_lorecard_bytes  # noqa: E402
from core.pack import PackError, _validate_card_bytes  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM  # noqa: E402


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _kernel_bundle(target_bytes: int) -> bytes:
    """A native world bundle whose hook scripts carry CJK-heavy data past the ST card cap."""
    chunk = "const T = JSON.parse('" + "潮" * 300_000 + "');\non('turn_start', () => {});\n"
    hooks, size = [], 0
    while size < target_bytes:
        hooks.append(chunk)
        size += len(chunk.encode("utf-8"))
    bundle = {"format": LORECARD_FORMAT, "format_version": 1, "name": "Kernel", "hooks": hooks}
    return json.dumps(bundle, ensure_ascii=False).encode("utf-8")


def test_a_native_bundle_may_pass_the_sillytavern_card_cap():
    assert MAX_LORECARD_FILE_BYTES == 2 * MAX_CARD_FILE_BYTES
    data = _kernel_bundle(MAX_CARD_FILE_BYTES + 1024 * 1024)
    assert MAX_CARD_FILE_BYTES < len(data) < MAX_LORECARD_FILE_BYTES

    bundle = parse_lorecard_bytes(data, "kernel.lorecard.json")
    assert len(bundle.hooks) >= 1 and sum(len(code) for code in bundle.hooks) > 5_000_000
    _validate_card_bytes("cards/kernel.lorecard.json", data)  # the pack build accepts it


def test_a_sillytavern_card_keeps_its_cap_in_a_pack_and_on_import(tmp_path):
    oversized = json.dumps({"name": "Big", "description": "x" * (MAX_CARD_FILE_BYTES + 10)}).encode("utf-8")
    with pytest.raises(PackError):
        _validate_card_bytes("cards/big.json", oversized)
    path = tmp_path / "big.json"
    path.write_bytes(oversized)
    with pytest.raises(ValueError):
        _parse_any_card_file(path)


def test_import_reads_a_large_native_bundle_as_a_native_bundle(tmp_path):
    path = tmp_path / "kernel.lorecard.json"
    path.write_bytes(_kernel_bundle(MAX_CARD_FILE_BYTES + 1024 * 1024))

    card, lorecard = _parse_any_card_file(path)

    assert lorecard is not None and card.name == "Kernel"


async def test_the_scribe_lane_skips_the_build_when_no_script_names_tool_use():
    services = _services()
    ctx = AgentCtx(chat_key="capacity-scribe")
    await install_room_hooks(services, ctx.chat_key, "test", ["on('reply_ready', () => {});"])
    assert await load_room_hook_engine(services, ctx, lane="scribe-hooks", require_event="tool_use") is None
    assert await load_room_hook_engine(services, ctx) is not None  # the turn still gets its engine

    await install_room_hooks(services, ctx.chat_key, "test", ["on('tool_use', () => {});"])
    assert await load_room_hook_engine(services, ctx, lane="scribe-hooks", require_event="tool_use") is not None


async def test_listing_player_actions_builds_no_engine(monkeypatch):
    import agent.hook_actions as hook_actions
    from agent.hook_actions import run_player_action

    services = _services()
    ctx = AgentCtx(chat_key="capacity-act-list", user_id="p1")
    await install_room_hooks(
        services, ctx.chat_key, "test", ["defineAction('rest', {description: 'Sit by the fire', player: true}, () => 'ok');"]
    )

    async def no_build(*args, **kwargs):  # pragma: no cover - failing is the assertion
        raise AssertionError("`.act` alone must list from the cached manifest")

    monkeypatch.setattr(hook_actions, "load_room_hook_engine", no_build)
    reply = await run_player_action(services, ctx, "", actor_name="P1")

    assert "rest" in reply.text and reply.private
