"""Module actions (`defineAction` → the Keeper's `module_action` tool) through the real turn
loop: offered only when the turn's hook engine has actions, answered INSIDE the turn (the
next round reads the booked result), effects applied through the existing hook paths and
reported like any other hook write, vetoable, capped, serialized, seeded and traced.
Skipped as a module without the `ejs` extra (hooks are inert then)."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("quickjs")

from agent.context import AgentCtx  # noqa: E402
from agent.hook_actions import module_action_schemas  # noqa: E402
from agent.hook_runtime import HOOK_STATE_PREFIX, install_room_hooks, load_room_hook_engine  # noqa: E402
from agent.loop import _concurrency_groups, run_kp_turn  # noqa: E402
from agent.services import build_services  # noqa: E402
from agent.tools import Toolset, tool  # noqa: E402
from core.dice_engine import seed_dice  # noqa: E402
from core.hooks import MAX_ACTION_CALLS_PER_TURN, MODULE_ACTION_TOOL  # noqa: E402
from core.modvars import build_spec, define_modvar, load_modvars  # noqa: E402
from infra.config import Settings  # noqa: E402
from infra.embeddings import FakeEmbeddings  # noqa: E402
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call  # noqa: E402

LEDGER = (
    "defineAction('book_hour', {description: 'Book one march hour of the crossing', params: '{pace: \"fast\"|\"slow\"}',"
    " rolls: {march: '8d10'}}, (args, ev) => {"
    "  const booked = (getstate('crossed') ?? 0) + ev.rolls.march.total;"
    "  setstate('crossed', booked); setvar('crossed_count', booked);"
    "  emitUI([{kind: 'stat', label: 'Crossed', value: booked}]);"
    "  return 'Hour booked (' + args.pace + '): ' + booked + ' across.';"
    "});"
)


def _services(llm=None, **settings):
    return build_services(Settings(locale="en", **settings), llm=llm or FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _ctx(chat_key: str) -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale="en")


def _tool_messages(messages: list[dict]) -> list[str]:
    return [str(message.get("content")) for message in messages if message.get("role") == "tool"]


def _tool_names(tools) -> list[str]:
    return [schema["function"]["name"] for schema in tools or []]


async def test_the_tool_is_offered_only_when_the_turn_has_actions():
    plain = FakeLLM(responder=lambda messages, tools: assistant_text("ok"))
    services = _services(plain)
    ctx = _ctx("actions-offered")
    await install_room_hooks(services, ctx.chat_key, "test", ["on('turn_start', () => {});"])
    await run_kp_turn(ctx, services, Toolset(), "hello")
    assert MODULE_ACTION_TOOL not in _tool_names(plain.calls[0][1])

    await install_room_hooks(services, ctx.chat_key, "test", [LEDGER])
    await run_kp_turn(ctx, services, Toolset(), "hello again")
    tools = plain.calls[-1][1]
    assert MODULE_ACTION_TOOL in _tool_names(tools)
    schema = next(item for item in tools if item["function"]["name"] == MODULE_ACTION_TOOL)["function"]
    assert schema["parameters"]["properties"]["action"]["enum"] == ["book_hour"]
    assert '- book_hour — Book one march hour of the crossing [{pace: "fast"|"slow"}]' in schema["description"]


async def test_no_action_tool_when_hooks_are_disabled():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("ok"))
    services = _services(llm, enable_full_ejs=False)
    ctx = _ctx("actions-disabled")
    await install_room_hooks(services, ctx.chat_key, "test", [LEDGER])

    await run_kp_turn(ctx, services, Toolset(), "hello")

    assert MODULE_ACTION_TOOL not in _tool_names(llm.calls[0][1])


async def test_the_schema_is_identical_turn_after_turn():
    """The tool list sits in the cached prefix: same scripts, same bytes."""
    services = _services()
    ctx = _ctx("actions-stable")
    await install_room_hooks(services, ctx.chat_key, "test", [LEDGER])
    first = module_action_schemas(await load_room_hook_engine(services, ctx))
    await services.store.state_set(ctx.chat_key, HOOK_STATE_PREFIX + "crossed", "300")  # state moves...
    second = module_action_schemas(await load_room_hook_engine(services, ctx))
    assert json.dumps(first) == json.dumps(second)  # ...the schema does not


async def test_the_next_round_of_the_same_turn_reads_the_booked_result():
    seed_dice(11)
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call(MODULE_ACTION_TOOL, action="book_hour", args={"pace": "fast"})),
            assistant_text("The column crosses."),
        ]
    )
    services = _services(llm)
    ctx = _ctx("actions-same-turn")
    await install_room_hooks(services, ctx.chat_key, "test", [LEDGER])

    result = await run_kp_turn(ctx, services, Toolset(), "we march")

    booked = await services.store.state_get(ctx.chat_key, HOOK_STATE_PREFIX + "crossed")
    assert booked is not None
    assert _tool_messages(llm.calls[1][0]) == [f"Hour booked (fast): {booked} across."]
    assert result.ui_frames == [{"blocks": [{"kind": "stat", "label": "Crossed", "value": int(booked)}], "panel": "inline"}]
    # Real dice, rolled by the engine before the handler ran, surfaced as a dice frame.
    dice = result.tool_trace[0]["dice_payloads"]
    assert dice[0]["kind"] == "subsystem" and dice[0]["subsystem"] == "module_action:book_hour"
    assert dice[0]["total"] == int(booked) and len(dice[0]["detail"]["rolls"]["march"]["dice"]) == 8


async def test_pre_rolled_dice_follow_the_test_seed():
    async def booked_with(seed: int) -> str:
        seed_dice(seed)
        llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="book_hour", args={"pace": "slow"})),
                              assistant_text("ok")])
        services = _services(llm)
        ctx = _ctx(f"actions-seeded-{seed}")
        await install_room_hooks(services, ctx.chat_key, "test", [LEDGER])
        await run_kp_turn(ctx, services, Toolset(), "march")
        return _tool_messages(llm.calls[1][0])[0]

    assert await booked_with(5) == await booked_with(5)


async def test_an_action_without_rolls_emits_no_dice_frame():
    llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="ping")), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-no-dice")
    await install_room_hooks(services, ctx.chat_key, "test", ["defineAction('ping', {description: 'p'}, () => {});"])

    result = await run_kp_turn(ctx, services, Toolset(), "go")

    assert "dice_payloads" not in result.tool_trace[0] or not result.tool_trace[0]["dice_payloads"]
    assert _tool_messages(llm.calls[1][0]) == ["Module action ping: done."]


class _Stats:
    """The two MVU tree tools, so a Keeper write and a Keeper read sit around the action."""

    def __init__(self, services):
        from agent.kp_tools_vars import MvuStatTools

        self._inner = MvuStatTools(services)

    @tool
    async def get_stat(self, ctx: AgentCtx, path: str = "") -> str:
        """Read a tree path."""
        return await self._inner.get_stat(ctx, path)

    @tool
    async def set_stat(self, ctx: AgentCtx, path: str, value: str) -> str:
        """Write a tree path."""
        return await self._inner.set_stat(ctx, path, value)


async def test_writes_are_visible_to_later_tools_and_actions_in_the_same_turn():
    llm = FakeLLM(
        script=[
            assistant_tools(tool_call("set_stat", path="weather", value="storm")),
            assistant_tools(tool_call(MODULE_ACTION_TOOL, action="mark", args={"n": 1})),
            assistant_tools(tool_call(MODULE_ACTION_TOOL, action="mark", args={"n": 2})),
            assistant_tools(tool_call("get_stat", path="marks")),
            assistant_text("done"),
        ]
    )
    services = _services(llm)
    ctx = _ctx("actions-visibility")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "defineAction('mark', {description: 'm'}, (args) => {"
            "  const seen = getvar('weather') + '/' + (getstate('count') ?? 0) + '/' + getvar('marks');"
            "  setstate('count', (getstate('count') ?? 0) + args.n); setvar('marks', args.n);"
            "  return seen; });"
        ],
    )

    await run_kp_turn(ctx, services, Toolset(_Stats(services)), "go")

    results = _tool_messages(llm.calls[-1][0])
    # The first action sees the Keeper's mid-turn write; the second sees the first's writes.
    assert results[1] == "storm/0/undefined"
    assert results[2] == "storm/1/1"
    assert "2" in results[3]  # the Keeper's own read sees the action's setvar
    assert await services.store.state_get(ctx.chat_key, HOOK_STATE_PREFIX + "count") == "3"


async def test_action_writes_join_hook_writes_and_variables_changed():
    llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="raise_fear")), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-hook-writes")
    await define_modvar(services.documents, ctx.chat_key, build_spec("fear", "number", minimum=0, maximum=10))
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "on('turn_start', () => setvar('omen', 1));"
            "defineAction('raise_fear', {description: 'f'}, () => { setvar('fear', 99); return 'ok'; });"
            "on('variables_changed', (e) => narrate('changed:' + e.writes.map((w) => w.path).join(',')));"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "go")

    assert result.hook_writes == ["omen", "fear"]  # turn_start, then the action, in order
    assert "changed:omen,fear" in result.reply
    assert (await load_modvars(services.documents, ctx.chat_key))["values"]["fear"] == 10  # validated by real code


async def test_the_scribe_leaves_action_written_variables_alone():
    from agent.scribe import run_scribe

    llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="book")), assistant_text("过环四百五十。")])
    services = _services(llm)
    services.settings.scribe.enabled = True
    ctx = _ctx("actions-scribe")
    await define_modvar(services.documents, ctx.chat_key, build_spec("crossed", "number", minimum=0, maximum=1000))
    await install_room_hooks(
        services, ctx.chat_key, "test", ["defineAction('book', {description: 'b'}, () => { setvar('crossed', 475); return '475'; });"]
    )
    result = await run_kp_turn(ctx, services, Toolset(), "march")
    assert result.hook_writes == ["crossed"]

    services.llm = FakeLLM(
        responder=lambda messages, tools: assistant_text(
            json.dumps({"ops": [{"op": "set", "id": "crossed", "value": 450, "evidence": "过环四百五十"}], "whispers": []})
        )
    )
    await run_scribe(services, ctx, "march", result.reply, [], result.turn, hook_writes=result.hook_writes)

    assert (await load_modvars(services.documents, ctx.chat_key))["values"]["crossed"] == 475


async def test_a_tool_use_hook_can_veto_an_action():
    llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="book")), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-veto")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "defineAction('book', {description: 'b'}, () => { setstate('ran', true); return 'ran'; });"
            "on('tool_use', (e) => { if (e.tool === 'module_action' && e.arguments.action === 'book') denyTool('not now'); });"
        ],
    )

    await run_kp_turn(ctx, services, Toolset(), "go")

    assert "not now" in _tool_messages(llm.calls[1][0])[0]
    assert await services.store.state_get(ctx.chat_key, HOOK_STATE_PREFIX + "ran") is None


@pytest.mark.parametrize("body", ["throw new Error('ledger jammed')", "while (true) {}"])
async def test_a_failed_action_applies_nothing(body):
    llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="book")), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-failure")
    await install_room_hooks(
        services,
        ctx.chat_key,
        "test",
        [
            "defineAction('book', {description: 'b'}, () => { setvar('crossed', 1); setstate('ran', true);"
            " emitUI([{kind:'badge', label:'x'}]); " + body + "; });"
        ],
    )

    result = await run_kp_turn(ctx, services, Toolset(), "go")

    message = _tool_messages(llm.calls[1][0])[0]
    assert message.startswith("Module action book failed:") and "Nothing was applied" in message
    if "ledger" in body:
        assert "ledger jammed" in message
    assert result.hook_writes == [] and result.ui_frames == []
    assert await services.store.state_list(ctx.chat_key, prefix=HOOK_STATE_PREFIX) == []


async def test_bad_calls_get_localized_errors():
    llm = FakeLLM(
        script=[
            assistant_tools(
                tool_call(MODULE_ACTION_TOOL, action="nope"),
                tool_call(MODULE_ACTION_TOOL, action="book", args=["not", "an", "object"]),
                tool_call(MODULE_ACTION_TOOL, action="book", args={"blob": "x" * 9000}),
                tool_call(MODULE_ACTION_TOOL, action="book", args=json.dumps({"n": 4})),
            ),
            assistant_text("ok"),
        ]
    )
    services = _services(llm)
    ctx = _ctx("actions-bad-calls")
    await install_room_hooks(services, ctx.chat_key, "test", ["defineAction('book', {description: 'b'}, (a) => 'n=' + a.n);"])

    await run_kp_turn(ctx, services, Toolset(), "go")

    unknown, not_object, too_big, stringified = _tool_messages(llm.calls[1][0])
    assert 'Unknown module action "nope"' in unknown and "book" in unknown
    assert "must be a JSON object" in not_object and "must be a JSON object" in too_big
    assert stringified == "n=4"  # a JSON-encoded object string is accepted


async def test_the_per_turn_call_cap():
    calls = [tool_call(MODULE_ACTION_TOOL, action="tick") for _ in range(MAX_ACTION_CALLS_PER_TURN + 2)]
    llm = FakeLLM(script=[assistant_tools(*calls), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-cap")
    await install_room_hooks(
        services, ctx.chat_key, "test",
        ["defineAction('tick', {description: 't'}, () => { setstate('n', (getstate('n') ?? 0) + 1); return 'tick'; });"],
    )

    await run_kp_turn(ctx, services, Toolset(), "go")

    results = _tool_messages(llm.calls[1][0])
    assert results[:MAX_ACTION_CALLS_PER_TURN] == ["tick"] * MAX_ACTION_CALLS_PER_TURN
    assert all("narrate with the results" in result.lower() for result in results[MAX_ACTION_CALLS_PER_TURN:])
    assert await services.store.state_get(ctx.chat_key, HOOK_STATE_PREFIX + "n") == str(MAX_ACTION_CALLS_PER_TURN)


async def test_a_call_when_not_offered_is_refused_like_an_unknown_tool():
    llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="book")), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-not-offered")

    await run_kp_turn(ctx, services, Toolset(), "go")

    expected = services.i18n.with_locale("en").t("agent.tools.unknown_tool", name=MODULE_ACTION_TOOL)
    assert _tool_messages(llm.calls[1][0]) == [expected]


def test_module_action_calls_are_always_a_barrier():
    from infra.llm import ToolCall

    class _ReadOnly:
        @tool(read_only=True)
        async def look(self, ctx: AgentCtx) -> str:
            """Look."""
            return ""

    toolset = Toolset(_ReadOnly())
    calls = [
        ToolCall(id="1", name="look", arguments={}),
        ToolCall(id="2", name=MODULE_ACTION_TOOL, arguments={"action": "a"}),
        ToolCall(id="3", name=MODULE_ACTION_TOOL, arguments={"action": "b"}),
        ToolCall(id="4", name="look", arguments={}),
    ]
    groups = _concurrency_groups(toolset, calls)
    assert [[call.id for call in group] for group in groups] == [["1"], ["2"], ["3"], ["4"]]


async def test_event_seed_is_stable_for_the_same_room_and_turn():
    async def seeds() -> list[str]:
        llm = FakeLLM(
            script=[
                assistant_tools(tool_call(MODULE_ACTION_TOOL, action="seed"), tool_call(MODULE_ACTION_TOOL, action="seed")),
                assistant_text("ok"),
            ]
        )
        services = _services(llm)
        ctx = _ctx("actions-seed-room")
        await install_room_hooks(
            services, ctx.chat_key, "test",
            ["defineAction('seed', {description: 's'}, (a, ev) => String(ev.seed));"
             "on('reply_ready', (e) => narrate('reply-seed:' + e.seed));"],
        )
        result = await run_kp_turn(ctx, services, Toolset(), "go")
        return [*_tool_messages(llm.calls[1][0]), result.reply.rsplit("reply-seed:", 1)[-1]]

    first, second = await seeds(), await seeds()
    assert first == second  # same room, same turn in flight, same streams: same seeds
    assert len(set(first)) == 3  # every dispatch its own stream
    assert all(0 <= int(seed) < 2**53 for seed in first)


async def test_the_tool_trace_records_module_action_calls(tmp_path):
    from agent.tool_trace import enable_tool_trace

    llm = FakeLLM(script=[assistant_tools(tool_call(MODULE_ACTION_TOOL, action="ping")), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-traced")
    await install_room_hooks(services, ctx.chat_key, "test", ["defineAction('ping', {description: 'p'}, () => 'pong');"])
    path = tmp_path / "trace" / "tools.jsonl"
    try:
        enable_tool_trace(path)
        await run_kp_turn(ctx, services, Toolset(), "go")
    finally:
        enable_tool_trace(None)
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert [entry["tool"] for entry in lines] == [MODULE_ACTION_TOOL]
    assert lines[0]["result"] == "pong" and lines[0]["room"] == "actions-traced"


def test_a_rulepack_subsystem_may_not_take_the_reserved_name():
    from core.subsystems import SubsystemError, parse_subsystems

    with pytest.raises(SubsystemError, match="reserved"):
        parse_subsystems("demo", {MODULE_ACTION_TOOL: {"template": "table_draw", "tables": []}})


# ---------------------------------------------------------------------------
# The reply phases start from the store (Part A follow-up)
# ---------------------------------------------------------------------------


class _NestedWriter:
    """Stands in for a nested companion turn: it persists hook state through another path
    (its own engine, in real life) while this turn's engine holds an older snapshot."""

    def __init__(self, services):
        self._services = services

    @tool
    async def companion_stub(self, ctx: AgentCtx) -> str:
        """Pretend a companion acted."""
        await self._services.store.state_set(ctx.chat_key, HOOK_STATE_PREFIX + "count", "10")
        return "the companion acted"


async def test_the_reply_phases_see_state_written_mid_turn_by_another_engine():
    llm = FakeLLM(script=[assistant_tools(tool_call("companion_stub")), assistant_text("ok")])
    services = _services(llm)
    ctx = _ctx("actions-refresh")
    await install_room_hooks(
        services, ctx.chat_key, "test", ["on('reply_ready', () => setstate('count', (getstate('count') ?? 0) + 1));"]
    )

    await run_kp_turn(ctx, services, Toolset(_NestedWriter(services)), "go")

    # Without the refresh the stale snapshot (absent) would have written 1 over the 10.
    assert await services.store.state_get(ctx.chat_key, HOOK_STATE_PREFIX + "count") == "11"
