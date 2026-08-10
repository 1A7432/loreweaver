"""M20 small items: the tool-result cap, concurrent read-only dispatch, and the hook veto.

Three unrelated-looking fixes with one thing in common — they all sit on the path a tool
call takes through `agent.loop._dispatch_and_record`, and each one is a place where the
loop had been taking something on trust.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.loop import MAX_TOOL_RESULT_CHARS, run_kp_turn
from agent.services import build_services
from agent.tools import Toolset, tool
from core.hooks import HookOutcome
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call


class _Provider:
    """One huge reader, two small readers, and a writer."""

    def __init__(self) -> None:
        self.order: list[str] = []

    @tool(read_only=True)
    async def read_library(self, ctx: AgentCtx) -> str:
        """Return the whole library."""
        return "x" * (MAX_TOOL_RESULT_CHARS * 2)

    @tool(read_only=True)
    async def read_a(self, ctx: AgentCtx) -> str:
        """Read A."""
        import asyncio

        await asyncio.sleep(0.02)
        self.order.append("a")
        return "A"

    @tool(read_only=True)
    async def read_b(self, ctx: AgentCtx) -> str:
        """Read B."""
        self.order.append("b")
        return "B"

    @tool
    async def write_thing(self, ctx: AgentCtx, value: str) -> str:
        """Write something."""
        self.order.append(f"w:{value}")
        return "written"


def _services(llm):
    return build_services(Settings(locale="en"), llm=llm, embeddings=FakeEmbeddings(64))


def _ctx(chat: str = "guards-room") -> AgentCtx:
    return AgentCtx(chat_key=chat, user_id="u1", locale="en")


# ---------------------------------------------------------------------------
# The result cap
# ---------------------------------------------------------------------------


async def test_an_enormous_tool_result_is_capped_and_says_so():
    """A knowledge/worldbook return was fed back verbatim and then replayed for every
    remaining round of the turn. The cut is announced, because a model that cannot tell it
    was truncated will happily answer from half a document."""
    provider = _Provider()
    llm = FakeLLM(script=[assistant_tools(tool_call("read_library")), assistant_text("The shelves are long.")])
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(provider), "What is in the library?")

    recorded = result.tool_trace[0]["result"]
    assert len(recorded) < MAX_TOOL_RESULT_CHARS * 2
    assert recorded.startswith("x" * 100)
    assert str(MAX_TOOL_RESULT_CHARS) in recorded, "the notice names how much survived"


async def test_an_ordinary_result_is_untouched():
    provider = _Provider()
    llm = FakeLLM(script=[assistant_tools(tool_call("read_a")), assistant_text("Noted.")])
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(provider), "Read A.")

    assert result.tool_trace[0]["result"] == "A"


# ---------------------------------------------------------------------------
# Read-only concurrency
# ---------------------------------------------------------------------------


async def test_a_round_of_readers_runs_concurrently():
    """`read_a` sleeps before recording itself; under serial dispatch it would still land
    first. Finishing second is what proves they overlapped."""
    provider = _Provider()
    llm = FakeLLM(
        script=[assistant_tools(tool_call("read_a"), tool_call("read_b")), assistant_text("Both read.")]
    )
    services = _services(llm)

    result = await run_kp_turn(_ctx(), services, Toolset(provider), "Read both.")

    assert provider.order == ["b", "a"], "the slow reader finished last — they ran together"
    assert [entry["name"] for entry in result.tool_trace] == ["read_a", "read_b"], "trace order follows the CALL order"
    assert [entry["result"] for entry in result.tool_trace] == ["A", "B"], "results stay bound to their call"


async def test_one_writer_in_the_round_makes_the_whole_round_serial():
    """The flag is per tool, but the decision is per round: two writers racing on one
    document is a lost update, not a speedup, so any writer present serializes everything.
    """
    provider = _Provider()
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("read_a"), tool_call("write_thing", value="1")),
            assistant_text("Done."),
        ]
    )
    services = _services(llm)

    await run_kp_turn(_ctx(), services, Toolset(provider), "Read then write.")

    assert provider.order == ["a", "w:1"], "the sleeping reader still finished before the writer started"


def test_the_flag_is_opt_in_and_never_inferred():
    """It cannot be derived from a signature, and getting it wrong is a lost update — so
    the default is False, and a tool the toolset has never heard of is not read-only."""
    toolset = Toolset(_Provider())

    assert toolset.is_read_only("read_a")
    assert not toolset.is_read_only("write_thing")
    assert not toolset.is_read_only("a_tool_that_does_not_exist")


async def test_the_nested_model_call_tools_are_never_read_only():
    """`speak_as_npc` and `companion_act` drive whole sub-turns. Concurrency there would
    interleave two actors' writes and two model calls holding one room's state."""
    from agent.kp_tools import build_kp_toolset

    services = _services(FakeLLM())
    toolset = build_kp_toolset(services)

    assert not toolset.is_read_only("speak_as_npc")
    assert not toolset.is_read_only("companion_act")


# ---------------------------------------------------------------------------
# The hook veto
# ---------------------------------------------------------------------------


class _Engine:
    """A stand-in hook engine: `fire` returns whatever the test wants, or explodes."""

    def __init__(self, *, deny: str | None = None, explode: bool = False) -> None:
        self.deny = deny
        self.explode = explode
        self.events: list[str] = []

    def fire(self, event_type: str, payload: dict) -> HookOutcome:
        self.events.append(event_type)
        if self.explode:
            raise RuntimeError("quickjs time limit")
        return HookOutcome(deny=self.deny)


async def _dispatch_with(engine, provider) -> list[dict]:
    from agent.loop import _dispatch_and_record

    trace: list[dict] = []
    await _dispatch_and_record(
        Toolset(provider),
        _ctx(),
        _services(FakeLLM()),
        assistant_tools(tool_call("write_thing", value="1")),
        [],
        trace,
        hook_engine=engine,
    )
    return trace


async def test_a_hook_can_refuse_a_tool_call_and_the_reason_reaches_the_model():
    provider = _Provider()

    trace = await _dispatch_with(_Engine(deny="the door is warded"), provider)

    assert provider.order == [], "the tool never ran"
    assert trace[0]["suppressed"] is True
    assert "the door is warded" in trace[0]["result"], "the reason is fed back, not swallowed"


async def test_a_hook_that_says_nothing_allows_the_call():
    provider = _Provider()

    await _dispatch_with(_Engine(), provider)

    assert provider.order == ["w:1"]


async def test_a_broken_or_timed_out_hook_allows_the_call():
    """THE guardrail. Every hook failure is internally harmless today — a broken handler
    loses its effects and the turn continues. The moment hooks can VETO, the same failure
    could instead DENY, so a failed dispatch must leave the call allowed. A hook that
    cannot run does not get to stop the game."""
    provider = _Provider()

    await _dispatch_with(_Engine(explode=True), provider)

    assert provider.order == ["w:1"]


async def test_a_room_with_no_hooks_pays_nothing():
    provider = _Provider()

    await _dispatch_with(None, provider)

    assert provider.order == ["w:1"]


def test_a_failed_dispatch_clears_the_denial_inside_the_engine_too():
    """Belt and braces at the source: `HookEngine.fire` swallows its own exceptions, so the
    fail-open decision is made there as well as at the call site."""
    from core.hooks import HookEngine

    engine = HookEngine.__new__(HookEngine)
    engine._context = None  # type: ignore[attr-defined]  # forces the except path

    outcome = HookEngine.fire(engine, "tool_use", {"tool": "x"})

    assert outcome.deny is None
    assert outcome.warnings
