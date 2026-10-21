"""Every streaming draft a turn opens is closed by a `narrative` with its id.

A 2026-10-21 Studio playtest showed three half-sentence KP bubbles, each with a live
cursor, stacked above a finished reply. The Keeper had written its scene in a round that
also made a bookkeeping call, so that round's draft was still open when the final round
started streaming. Closing it is an await, and the final round's next slice was already
in flight: it saw the old round too, closed the same draft again and opened a draft of
its own. Each slice became a bubble that no final ever replaced.
"""

from __future__ import annotations

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import ChatResult, FakeLLM, assistant_text, tool_call


class _Member:
    id = "watcher"
    user_key = "watcher"
    transport = "tui"
    name = "Watcher"

    def __init__(self) -> None:
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


class _NullRouter:
    def resolve(self, text: str, locale: str):
        return None

    async def dispatch_reply(self, ctx: AgentCtx, text: str):
        return None


async def test_a_draft_left_open_by_a_bookkeeping_round_does_not_split_the_reply() -> None:
    script = [
        # A scene written beside a call that puts nothing in front of the table, so no
        # tool event closes this round's draft: the next round's first slice has to.
        ChatResult(
            content="档案库里很静，只有翻页的声音。\n裴照把簿子推过来，指着一行。\n",
            tool_calls=[tool_call("kp_note", action="add", category="world_changes", content="裴照出示强迁簿")],
        ),
        assistant_text("裴照把簿子又朝你推回一寸。\n「这一户，」他说，「后来又迁回原坊了。」\n说完他没有再往下讲。"),
    ]
    services = build_services(Settings(locale="zh"), llm=FakeLLM(script=script), embeddings=FakeEmbeddings(16))
    ctx = AgentCtx(chat_key="tui:group:drafts", user_id="nora", platform="tui", locale="zh")
    hub = RoomHub()
    member = _Member()
    await hub.subscribe(ctx.chat_key, member)
    member.events.clear()

    await run_turn(
        hub,
        services,
        ctx,
        "我请裴照把簿子给我看。",
        command_router=_NullRouter(),
        toolset=build_kp_toolset(services),
        actor_name="Nora",
    )

    opened = [e.data["frame_id"] for e in member.events if e.kind == "narrative_delta"]
    closing = [e for e in member.events if e.kind == "narrative" and e.speaker == "kp"]
    closed_ids = {e.data.get("frame_id") for e in closing}
    assert opened and all(frame_id for frame_id in opened)
    # Every draft is closed by a final carrying its id…
    assert set(opened) <= closed_ids
    # …and the reply itself lands as ONE bubble: the bookkeeping round's draft is
    # discarded (empty final) and the final round streamed under a single id.
    shown = [e for e in closing if e.text]
    assert len(shown) == 1
    abandoned = set(opened) - {shown[0].data["frame_id"]}
    assert len(abandoned) == 1
    assert abandoned <= {e.data.get("frame_id") for e in closing if not e.text}
