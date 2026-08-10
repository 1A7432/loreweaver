"""ORACLE for M20 F: the prep-phase script hatch, plan-then-apply.

The shape is forced, not chosen. The QuickJS binding cannot combine an execution time
limit with Python callables (the zero-callable bridge the EJS work already hit), so a
script literally cannot call a tool — it emits an operation list and the engine applies
it. That single constraint is what recovers everything the CodeAct exclusion was worried
about, and the tests below are one per recovered property: atomicity of validation,
per-operation permission granularity, and a free dry run.
"""

from __future__ import annotations

import pytest

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from agent.tools import PLAY_PHASE, PREP_PHASE, Toolset, tool
from core.prep_script import MAX_OPERATIONS, MAX_SCRIPT_CHARS, build_plan
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

pytest.importorskip("quickjs", reason="the prep script hatch needs the QuickJS sandbox")

CHAT = "prep-room"


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    @tool
    async def make_thing(self, ctx: AgentCtx, name: str) -> str:
        """Make a thing."""
        self.calls.append(("make_thing", {"name": name}))
        return f"made {name}"

    @tool(gated=True)
    async def locked_thing(self, ctx: AgentCtx) -> str:
        """A gated tool nobody unlocked."""
        self.calls.append(("locked_thing", {}))
        return "should never happen"


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(), embeddings=FakeEmbeddings(64))


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="kp", locale="en")


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------


def test_a_script_can_only_plan_never_call():
    plan = build_plan(
        "for (var i = 1; i <= 3; i++) { plan('make_thing', { name: 'guard ' + i }); }"
    )

    assert plan
    assert [operation["tool"] for operation in plan.operations] == ["make_thing"] * 3
    assert plan.operations[2]["args"] == {"name": "guard 3"}


def test_the_sandbox_has_no_way_out():
    """No callables reach the script, so there is nothing to reach through. A script that
    tries to invoke a tool directly finds no such function."""
    plan = build_plan("try { make_thing({name: 'x'}); } catch (e) { plan('noted', {error: String(e)}); }")

    assert plan
    assert plan.operations[0]["tool"] == "noted"
    assert "make_thing" in plan.operations[0]["args"]["error"]


def test_a_broken_script_reports_instead_of_raising():
    assert not build_plan("this is not javascript ((((")
    assert not build_plan("")
    assert not build_plan("x" * (MAX_SCRIPT_CHARS + 1))


def test_an_infinite_loop_times_out_rather_than_hanging():
    """The time limit arms BEFORE the untrusted source runs."""
    plan = build_plan("while (true) {}")

    assert not plan


def test_a_plan_is_bounded():
    plan = build_plan(f"for (var i = 0; i < {MAX_OPERATIONS + 10}; i++) {{ plan('x', {{}}); }}")

    assert not plan
    assert str(MAX_OPERATIONS) in plan.error


def test_malformed_operations_are_rejected_whole():
    """Validation is atomic: a plan with one bad entry applies NOTHING, which is the
    property the CodeAct exclusion said a scripted lane would lose."""
    assert not build_plan("globalThis.__plan = [{tool: '', args: {}}];")
    assert not build_plan("globalThis.__plan = [{tool: 'ok', args: 'not an object'}];")
    assert not build_plan("globalThis.__plan = ['just a string'];")


# ---------------------------------------------------------------------------
# The apply
# ---------------------------------------------------------------------------


async def _run(provider, script: str, *, apply: bool) -> str:
    from agent.kp_tools_prep import PrepScriptTools

    services = _services()
    hatch = PrepScriptTools(services)
    toolset = Toolset(hatch, provider)
    hatch._toolset_factory = lambda: toolset  # noqa: SLF001 — the same closure build_kp_toolset uses
    return await toolset.dispatch(
        "run_prep_plan", _ctx(), {"script": script, "apply": apply}, set(), phase=PREP_PHASE
    )


async def test_a_dry_run_shows_the_plan_and_changes_nothing():
    """Free, because a plan is data. This is the affordance a direct-call design cannot
    offer at all."""
    provider = _Recorder()

    reply = await _run(provider, "plan('make_thing', {name: 'a lamplighter'});", apply=False)

    assert "make_thing" in reply and "lamplighter" in reply
    assert provider.calls == [], "a preview must not touch the room"


async def test_applying_runs_every_operation_through_the_ordinary_tool_path():
    provider = _Recorder()

    reply = await _run(
        provider, "['a', 'b'].forEach(function (n) { plan('make_thing', {name: n}); });", apply=True
    )

    assert provider.calls == [("make_thing", {"name": "a"}), ("make_thing", {"name": "b"})]
    assert "made a" in reply and "made b" in reply


async def test_gating_is_enforced_per_operation_by_the_same_code():
    """Permission granularity, the other thing CodeAct loses: `keeper_only`/`gated`/
    `prep_only` are enforced because the plan goes through `Toolset.dispatch`, not
    because this module re-implements them."""
    provider = _Recorder()

    reply = await _run(provider, "plan('make_thing', {name: 'a'}); plan('locked_thing', {});", apply=True)

    assert provider.calls == [], "a locked tool in the plan stops the whole plan"
    assert "locked_thing" in reply


async def test_a_plan_that_names_an_unreachable_tool_applies_nothing():
    """ATOMICITY, and the only form of it worth promising: the whole plan is checked before
    anything is applied, so a plan naming a tool that does not exist runs none of itself —
    not the half that happened to come first. Rollback of applied writes is not on offer
    and the wording does not imply one."""
    provider = _Recorder()

    reply = await _run(
        provider,
        "plan('make_thing', {name: 'first'}); plan('no_such_tool', {}); plan('make_thing', {name: 'third'});",
        apply=True,
    )

    assert provider.calls == [], "not even the first operation ran"
    assert "no_such_tool" in reply


# ---------------------------------------------------------------------------
# Where it is reachable from
# ---------------------------------------------------------------------------


def test_the_hatch_exists_in_prep_and_not_in_play():
    """Never in play: every in-play Keeper write is irreversible game state, which is
    exactly where CodeAct's costs land."""
    toolset = build_kp_toolset(_services())

    prep = {schema["function"]["name"] for schema in toolset.schemas(phase=PREP_PHASE)}
    play = {schema["function"]["name"] for schema in toolset.schemas(phase=PLAY_PHASE)}

    assert "run_prep_plan" in prep
    assert "run_prep_plan" not in play


async def test_a_play_phase_call_is_refused_even_when_named_blind():
    services = _services()
    toolset = build_kp_toolset(services)

    refusal = await toolset.dispatch(
        "run_prep_plan", _ctx(), {"script": "plan('x', {})"}, set(), phase=PLAY_PHASE
    )

    assert "run_prep_plan" in refusal and ".phase prep" in refusal


def test_the_card_split_commands_are_outside_the_reachable_surface():
    """拆卡 doctrine: `.import … world` and `.var expose` are keeper COMMANDS, so a plan —
    which can only name tools — cannot reach them. By construction, not by an exclusion
    list someone has to remember to update."""
    toolset = build_kp_toolset(_services())

    names = set(toolset.names())
    assert not any("expose" in name for name in names)
    assert not any(name.startswith("import_world") or name == "import" for name in names)
