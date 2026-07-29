"""Integration tests for the full-EJS path through build_system_prompt: real-JS worldbook
content renders in the lore section, arbitrary-JS conditions gate injection, template setvar
writes flush to the MVU tree (and the prompt's variable section shows post-write state), and
disabling the flag falls back to the subset renderer.

Skipped as a module when the `ejs` extra (quickjs) is not installed."""

from __future__ import annotations

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.prompt_builder import build_system_prompt  # noqa: E402
from agent.services import build_services  # noqa: E402
from core.mvu_compat import MvuManager  # noqa: E402
from core.worldbook import LoreEntry  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM  # noqa: E402


def _services(**settings_overrides):
    return build_services(
        Settings(**settings_overrides), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )


def _ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale="en")


def _entry(**overrides) -> LoreEntry:
    base = dict(id="", title="t", content="body", constant=True, scope="session")
    base.update(overrides)
    return LoreEntry.from_dict(base)


async def test_real_js_worldbook_content_renders_in_the_lore_section():
    services = _services()
    ctx = _ctx("chat-ejs-full-1")
    await services.worldbook.add(
        ctx.chat_key,
        _entry(title="omens", content="Omens:<% for (const i of _.range(3)) { %> sign<%= i %><% } %>"),
    )

    prompt = await build_system_prompt(ctx, services)

    assert "Omens: sign0 sign1 sign2" in prompt
    assert "<%" not in prompt


async def test_arbitrary_js_condition_gates_injection():
    services = _services()
    ctx = _ctx("chat-ejs-full-2")
    await MvuManager(services.store).init_from_initvar(ctx.chat_key, {"stage": [1, "story stage"]})
    condition = "[1,2,3].filter(x => x <= stat_data.stage[0]).length >= 2"
    await services.worldbook.add(ctx.chat_key, _entry(title="late-game", content="LATEGAME LORE", condition=condition))

    early = await build_system_prompt(ctx, services)
    await MvuManager(services.store).save(ctx.chat_key, {"stage": [2, "story stage"]})
    late = await build_system_prompt(ctx, services)

    assert "LATEGAME LORE" not in early
    assert "LATEGAME LORE" in late


async def test_template_setvar_flushes_to_the_mvu_tree_and_prompt_shows_post_write_state():
    services = _services()
    ctx = _ctx("chat-ejs-full-3")
    await MvuManager(services.store).init_from_initvar(ctx.chat_key, {"visits": [0, "chapel visits"]})
    await services.worldbook.add(
        ctx.chat_key, _entry(title="counter", content="<% incvar('visits') %>The chapel looms.")
    )

    prompt = await build_system_prompt(ctx, services)

    tree = await MvuManager(services.store).load(ctx.chat_key)
    assert tree["visits"][0] == 1
    assert "- visits = 1" in prompt  # the card-variables section shows post-template state


async def test_flag_off_falls_back_to_the_subset_renderer():
    services = _services(enable_full_ejs=False)
    ctx = _ctx("chat-ejs-full-4")
    await services.worldbook.add(
        ctx.chat_key,
        _entry(title="mixed", content="<% for (const i of _.range(3)) { %>LOOP<% } %>plain <%= 1 + 1 %>"),
    )

    prompt = await build_system_prompt(ctx, services)

    # The subset can't parse the JS for-loop, so the whole entry degrades to tags-stripped
    # plain text: the loop body appears ONCE as literal text (it never executed) and no raw
    # template syntax leaks into the prompt.
    assert "LOOPplain" in prompt
    assert "LOOPLOOPLOOP" not in prompt
    assert "<%" not in prompt
