"""The imported-preset style layer in `agent.prompt_builder`: folded when a room enables
a preset, absent otherwise, and NEVER able to break the build on a broken file."""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.prompt_builder import build_system_prompt
from agent.services import build_services
from core.preset_store import presets_dir, save_preset_text
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

_PRESET_TEXT = json.dumps(
    {
        "prompts": [
            {
                "identifier": "main",
                "name": "Main",
                "content": "Narrate in terse, concrete sentences.",
                "role": "system",
                "enabled": True,
            },
            {"identifier": "worldInfoBefore", "name": "WI", "content": "", "marker": True},
            {
                "identifier": "style",
                "name": "Style",
                "content": "Prefer dialogue over description.",
                "role": "system",
                "enabled": True,
            },
        ],
        "prompt_order": [
            {
                "character_id": 100001,
                "order": [
                    {"identifier": "main", "enabled": True},
                    {"identifier": "worldInfoBefore", "enabled": True},
                    {"identifier": "style", "enabled": True},
                ],
            }
        ],
    },
    ensure_ascii=False,
)


def _services(tmp_path):
    return build_services(
        Settings(data_dir=str(tmp_path)), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )


def _ctx(room: str) -> AgentCtx:
    return AgentCtx(chat_key=room, user_id="keeper-1", locale="en")


async def test_enabled_preset_folds_one_style_section(tmp_path):
    services = _services(tmp_path)
    save_preset_text(tmp_path, "terse", _PRESET_TEXT)
    await services.store.set(store_key="preset_enabled.preset-room", value="terse")

    prompt = await build_system_prompt(_ctx("preset-room"), services)

    assert "Narrate in terse, concrete sentences." in prompt
    assert "Prefer dialogue over description." in prompt
    header_index = prompt.index("Imported style preset")
    # The style layer sits before the skills layer would (nothing enabled here) and
    # after the interaction-style section: it must not be the prompt's opening.
    assert header_index > 0


async def test_no_preset_enabled_contributes_nothing(tmp_path):
    services = _services(tmp_path)
    save_preset_text(tmp_path, "terse", _PRESET_TEXT)  # installed but not enabled

    prompt = await build_system_prompt(_ctx("silent-room"), services)

    assert "Imported style preset" not in prompt


async def test_broken_or_missing_preset_never_breaks_the_turn(tmp_path):
    services = _services(tmp_path)
    await services.store.set(store_key="preset_enabled.broken-room", value="ghost")
    prompt = await build_system_prompt(_ctx("broken-room"), services)
    assert "Imported style preset" not in prompt

    (presets_dir(tmp_path) / "bad.json").parent.mkdir(parents=True, exist_ok=True)
    (presets_dir(tmp_path) / "bad.json").write_text("not json", encoding="utf-8")
    await services.store.set(store_key="preset_enabled.broken-room", value="bad")
    prompt = await build_system_prompt(_ctx("broken-room"), services)
    assert "Imported style preset" not in prompt
