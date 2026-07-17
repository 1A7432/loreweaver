"""Tests for agent.forge's module generator (Layer B.3b -- `docs/plugins.md` "Layer B").

Unlike the skill/rulepack generators (a global, discovery-based user data-dir), a generated module
installs PER-ROOM through the EXISTING module-ingestion pipeline
(`agent.kp_tools_knowledge.DocumentTools.upload_document`), so this exercises TWO scripted `FakeLLM`
responses in order: the module-authoring call (`generate_and_install_module`'s own `services.llm.chat`)
and the full-text analysis call `upload_document` triggers via `services.module_init.initialize` --
mirroring `tests/agent/test_kp_tools_knowledge.py`'s "sentinel never leaks to the player pool"
pattern to confirm the room's REAL knowledge-pool pipeline ran, not some parallel bespoke path.

Covers: (a) happy path -- the generated Markdown is written to a confined file under a tmp
`_USER_MODULE_DIR` and the room (`ctx.chat_key`)'s module knowledge pools end up populated by the
scripted analysis; (b) an empty LLM response / an unsluggable title+description is rejected with
`ok=False` and nothing written; (c) path/id confinement holds for a traversal-shaped title; (d)
with no `_USER_MODULE_DIR` configured at all, generation fails cleanly instead of raising.

Every test that swaps `agent.forge._USER_MODULE_DIR` restores it in a `finally` block -- never
leaking a tmp path into another test's module-forge generation.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import agent.forge as forge_module
from agent.context import AgentCtx, LocalFs
from agent.forge import generate_and_install_module
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, Usage, assistant_text

CHAT_KEY = "module-forge-chat"
SENTINEL = "THE FERRYMAN IS THE FEY BOUND TO THE OLD PACT"

GENERATED_MODULE_MD = f"""# The Salt Marsh Vanishing

## Player-facing premise
Fisherfolk have gone missing near the marsh town of Greyreed. The only way across
the marsh at night is the ferryman's boat.

## KEEPER-ONLY
{SENTINEL}: the ferryman who rows travelers across the marsh is himself the culprit,
bound centuries ago into a pact he must now feed to survive.
"""


def _versioned_module(version: str) -> str:
    return f"""---
id: stable-marsh-module
---
# The Salt Marsh Vanishing

Runtime source version: {version}.
"""


def _versioned_analysis(version: str) -> str:
    return json.dumps(
        {
            "scenes": [{"name": f"Scene {version}", "description": f"Pool version {version}"}],
            "summary": f"Catalog version {version}",
        }
    )


def _scripted_analysis_json() -> str:
    """A minimal well-formed module-analysis JSON (the shape `module.analysis_prompt` asks the LLM
    to emit) whose keeper-only NPC secret carries the sentinel -- `core.module_initializer`
    normalizes any missing list/str fields, so this doesn't need every field populated."""
    return json.dumps(
        {
            "npcs": [
                {
                    "name": "The Ferryman",
                    "description": "A quiet old man who never speaks above a whisper.",
                    "secret": SENTINEL,
                    "role": "antagonist",
                }
            ],
            "summary": "Investigators uncover the truth behind the marsh disappearances.",
        }
    )


def _services(authoring_text: str) -> object:
    """Two scripted responses in order: the module-authoring call, then the analysis call
    `upload_document` triggers via `services.module_init.initialize`."""
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text(authoring_text), assistant_text(_scripted_analysis_json())]),
        embeddings=FakeEmbeddings(8),
    )


def _ctx(fs_base: Path) -> AgentCtx:
    return AgentCtx(chat_key=CHAT_KEY, user_id="kp", locale="en", fs=LocalFs(base_dir=fs_base))


# ---------------------------------------------------------------------------
# (a) Happy path: written to a confined file, installed into THIS room via the existing pipeline.
# ---------------------------------------------------------------------------


async def test_happy_path_writes_and_installs_into_the_calling_room(tmp_path: Path) -> None:
    services = _services(GENERATED_MODULE_MD)
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        result = await generate_and_install_module(services, ctx, "a marsh-town disappearance mystery")

        assert result.ok, result.error
        assert result.skill_id == "the-salt-marsh-vanishing"
        assert result.name == "The Salt Marsh Vanishing"
        assert Path(result.path).is_file()
        assert Path(result.path).parent == (tmp_path / "modules").resolve()
        assert result.detail  # upload_document's own confirmation, the "room summary"

        # The EXISTING module pipeline actually ran for THIS room's chat_key.
        status = await services.store.get(user_key="", store_key=f"module_init_status.{CHAT_KEY}")
        assert status == "ready"

        keeper_raw = await services.store.get(user_key="", store_key=f"module_keeper_pool.{CHAT_KEY}")
        player_raw = await services.store.get(user_key="", store_key=f"module_player_pool.{CHAT_KEY}")
        assert SENTINEL in keeper_raw
        assert SENTINEL not in player_raw  # red line: the secret never reaches the player pool
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


async def test_repeat_description_short_circuits_without_regeneration(tmp_path: Path) -> None:
    services = _services(GENERATED_MODULE_MD)
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        first = await generate_and_install_module(
            services,
            ctx,
            "A Marsh-Town   Disappearance Mystery",
        )
        repeated = await generate_and_install_module(
            services,
            ctx,
            "  a marsh-town disappearance mystery  ",
        )

        assert first.ok
        assert repeated.ok
        assert repeated.reused is True
        assert repeated.skill_id == first.skill_id
        assert repeated.path == first.path
        assert len(services.llm.calls) == 2  # one authoring call and one analysis call

        record_raw = await services.store.get(
            user_key="",
            store_key=f"forge_module_last.{CHAT_KEY}",
        )
        record = json.loads(record_raw)
        assert record["installed_id"] == first.skill_id
        assert record["description_hash"]
        assert record["timestamp"] > 0
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


async def test_reinstall_same_room_id_overwrites_one_consistent_content_version(tmp_path: Path) -> None:
    version_1 = _versioned_module("v1")
    version_2 = _versioned_module("v2")
    services = build_services(
        Settings(locale="en"),
        llm=FakeLLM(
            script=[
                assistant_text(version_1),
                assistant_text(_versioned_analysis("v1")),
                assistant_text(version_2),
                assistant_text(_versioned_analysis("v2")),
            ]
        ),
        embeddings=FakeEmbeddings(8),
    )
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        first = await generate_and_install_module(services, ctx, "first source request")
        second = await generate_and_install_module(services, ctx, "revised source request")

        assert first.ok and second.ok
        assert first.skill_id == second.skill_id == "stable-marsh-module"
        assert first.path == second.path
        assert sorted(path.name for path in (tmp_path / "modules").glob("*.md")) == [
            "stable-marsh-module.md"
        ]
        assert Path(second.path).read_text(encoding="utf-8") == version_2.strip()

        fulltext = await services.store.get(
            user_key="",
            store_key=f"module_fulltext.{CHAT_KEY}",
        )
        keeper = await services.store.get(
            user_key="",
            store_key=f"module_keeper_pool.{CHAT_KEY}",
        )
        player = await services.store.get(
            user_key="",
            store_key=f"module_player_pool.{CHAT_KEY}",
        )
        catalog = await services.store.get(
            user_key="",
            store_key=f"module_catalog.{CHAT_KEY}",
        )
        assert fulltext == version_2.strip()
        assert "v2" in keeper and "v1" not in keeper
        assert "v2" in player and "v1" not in player
        assert catalog == keeper
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


# ---------------------------------------------------------------------------
# (b) Invalid output -- rejected, nothing written, room untouched.
# ---------------------------------------------------------------------------


async def test_empty_llm_response_is_rejected(tmp_path: Path) -> None:
    services = _services("   ")
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        result = await generate_and_install_module(services, ctx, "anything")

        assert not result.ok
        assert result.error == "empty_response"
        assert not (tmp_path / "modules").exists() or list((tmp_path / "modules").iterdir()) == []

        status = await services.store.get(user_key="", store_key=f"module_init_status.{CHAT_KEY}")
        assert not status  # the room's module pipeline never ran
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


async def test_cjk_title_without_usable_id_gets_stable_content_hash_id(tmp_path: Path) -> None:
    generated = "# 黄泉归影\n\n一场发生在黄泉渡口的调查。"
    expected_id = f"module-{hashlib.sha256(generated.encode('utf-8')).hexdigest()[:8]}"
    services = _services(generated)
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        result = await generate_and_install_module(services, ctx, "黄泉渡口的怪谈")

        assert result.ok, result.error
        assert result.skill_id == expected_id
        assert result.name == "黄泉归影"
        assert Path(result.path).is_file()
        assert len(services.llm.calls) == 2  # authoring + analysis, never a second generation
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


async def test_cjk_title_uses_explicit_ascii_id_without_regeneration(tmp_path: Path) -> None:
    generated = """---
id: echoes-from-yellow-springs
---
# 黄泉归影

一场发生在黄泉渡口的调查。
"""
    services = _services(generated)
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        result = await generate_and_install_module(services, ctx, "黄泉渡口的怪谈")

        assert result.ok, result.error
        assert result.skill_id == "echoes-from-yellow-springs"
        assert result.name == "黄泉归影"
        assert len(services.llm.calls) == 2
        system_prompt = services.llm.calls[0][0][0]["content"]
        assert "ASCII" in system_prompt
        assert "id:" in system_prompt
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


async def test_module_forge_and_analysis_usage_are_both_recorded(tmp_path: Path) -> None:
    llm = FakeLLM(
        script=[
            ChatResult(
                content=GENERATED_MODULE_MD,
                tool_calls=[],
                usage=Usage(prompt_tokens=40, completion_tokens=10, total_tokens=50),
            ),
            ChatResult(
                content=_scripted_analysis_json(),
                tool_calls=[],
                usage=Usage(prompt_tokens=80, completion_tokens=20, total_tokens=100),
            ),
        ]
    )
    services = build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(8))
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        result = await generate_and_install_module(services, ctx, "a marsh-town disappearance mystery")

        assert result.ok, result.error
        stats = json.loads(await services.store.get(user_key="", store_key=f"usage_stats.{CHAT_KEY}"))
        assert stats["session"]["turns"] == 2
        assert stats["session"]["prompt"] == 120
        assert stats["session"]["completion"] == 30
        assert stats["last"]["prompt"] == 80
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


# ---------------------------------------------------------------------------
# (c) Security: path/id confinement for a traversal-shaped title.
# ---------------------------------------------------------------------------


async def test_traversal_title_is_sanitized_to_a_safe_id_never_a_path(tmp_path: Path) -> None:
    traversal_md = GENERATED_MODULE_MD.replace("The Salt Marsh Vanishing", "../../etc/passwd")
    services = _services(traversal_md)
    ctx = _ctx(tmp_path / "fs")

    original_user_dir = forge_module._USER_MODULE_DIR
    forge_module._USER_MODULE_DIR = tmp_path / "modules"
    try:
        result = await generate_and_install_module(services, ctx, "anything")

        if result.ok:
            assert "/" not in result.skill_id
            assert ".." not in result.skill_id
            written = Path(result.path).resolve()
            assert written.is_relative_to((tmp_path / "modules").resolve())
        else:
            assert not result.error.startswith("path_escape")
    finally:
        forge_module._USER_MODULE_DIR = original_user_dir


# ---------------------------------------------------------------------------
# (d) No data dir configured at all.
# ---------------------------------------------------------------------------


async def test_no_data_dir_configured_fails_cleanly(tmp_path: Path) -> None:
    services = _services(GENERATED_MODULE_MD)
    ctx = _ctx(tmp_path / "fs")
    assert forge_module._USER_MODULE_DIR is None  # the default in every test unless opted in

    result = await generate_and_install_module(services, ctx, "anything")

    assert not result.ok
    assert result.error == "no_data_dir"
    assert result.skill_id == ""
    assert result.path == ""
