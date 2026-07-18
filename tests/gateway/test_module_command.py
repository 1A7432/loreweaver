from __future__ import annotations

import pytest

from agent.context import AgentCtx, LocalFs
from agent.services import build_services
from gateway.attachment_fs import AttachmentFs
from gateway.chat import ChatAttachment
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _services():
    return build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


class _FakeDocumentTools:
    calls: list[dict] = []

    def __init__(self, services) -> None:
        self._services = services

    async def upload_document(
        self,
        ctx: AgentCtx,
        file_path: str,
        doc_type: str = "module",
        custom_filename: str | None = None,
        progress=None,
    ) -> str:
        self.calls.append(
            {
                "services": self._services,
                "ctx": ctx,
                "file_path": file_path,
                "doc_type": doc_type,
                "custom_filename": custom_filename,
                "progress": progress,
            }
        )
        return "module import ok"


async def test_module_command_dispatches_to_upload_document_with_module_doc_type(tmp_path, monkeypatch):
    _FakeDocumentTools.calls = []
    monkeypatch.setattr("agent.kp_tools_knowledge.DocumentTools", _FakeDocumentTools)
    services = _services()
    router = CommandRouter(services)
    fs = LocalFs(tmp_path)
    ctx = AgentCtx(chat_key="cli:dm:module", user_id="keeper", locale="en", fs=fs)

    reply = await router.dispatch(ctx, ".module module.txt")

    assert reply == "module import ok"
    assert len(_FakeDocumentTools.calls) == 1
    call = _FakeDocumentTools.calls[0]
    assert call["services"] is services
    assert call["file_path"] == "module.txt"
    assert call["doc_type"] == "module"
    assert call["custom_filename"] is None
    assert call["progress"] is None  # this router has no hub, so no live progress bar
    assert call["ctx"].chat_key == "cli:dm:module"
    assert call["ctx"].user_id == "keeper"
    assert call["ctx"].locale == "en"
    assert call["ctx"].fs is fs


async def test_module_command_streams_progress_bar_frames_when_the_router_has_a_hub(tmp_path, monkeypatch):
    """A router WITH a hub hands `.module` a live progress reporter that publishes a moving
    progress-bar `system` frame per import stage — so a slow analysis shows advancing
    progress instead of a frozen spinner."""
    _FakeDocumentTools.calls = []
    monkeypatch.setattr("agent.kp_tools_knowledge.DocumentTools", _FakeDocumentTools)

    class _SpyHub:
        def __init__(self) -> None:
            self.published: list = []

        async def publish(self, chat_key, event, **kwargs) -> None:
            self.published.append((chat_key, event, kwargs))

    services = _services()
    hub = _SpyHub()
    router = CommandRouter(services, hub=hub)
    ctx = AgentCtx(chat_key="tui:group:table", user_id="keeper", locale="zh", fs=LocalFs(tmp_path))

    await router.dispatch(ctx, ".module module.txt")

    progress = _FakeDocumentTools.calls[0]["progress"]
    assert progress is not None  # the hub-backed router supplies a real reporter
    await progress("read")
    await progress("analyze")
    await progress("done", "ready_fallback")

    # Progress bars are keeper-only (they carry module identity); everyone else
    # gets exactly ONE spoiler-free notice, sent alongside the first stage.
    bars = [(chat_key, event, kwargs) for chat_key, event, kwargs in hub.published if kwargs.get("only_user")]
    notices = [(chat_key, event, kwargs) for chat_key, event, kwargs in hub.published if kwargs.get("exclude_user")]
    assert len(hub.published) == 4
    assert len(bars) == 3
    assert len(notices) == 1
    for chat_key, event, kwargs in bars:
        assert chat_key == "tui:group:table"
        assert kwargs["only_user"] == "keeper"
        assert event.speaker == "system"
        assert "█" in event.text or "░" in event.text  # a progress bar
    # The bar fills as stages advance: read = 1 filled block, done = all 5.
    assert bars[0][1].text.count("█") == 1
    assert bars[2][1].text.count("█") == 5
    fallback_label = services.i18n.with_locale("zh").t("commands.module.progress.done_fallback")
    assert fallback_label in bars[2][1].text
    notice_chat_key, notice_event, notice_kwargs = notices[0]
    assert notice_chat_key == "tui:group:table"
    assert notice_kwargs["exclude_user"] == "keeper"
    assert notice_event.text == services.i18n.with_locale("zh").t("commands.module.progress.notice")
    assert "█" not in notice_event.text and "module.txt" not in notice_event.text


async def test_module_command_without_path_returns_usage(monkeypatch):
    _FakeDocumentTools.calls = []
    monkeypatch.setattr("agent.kp_tools_knowledge.DocumentTools", _FakeDocumentTools)
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:module", user_id="keeper", locale="en")

    reply = await router.dispatch(ctx, ".module")

    assert reply == services.i18n.with_locale("en").t("commands.module.usage")
    assert _FakeDocumentTools.calls == []


async def test_module_command_uses_the_current_chat_attachment(monkeypatch):
    _FakeDocumentTools.calls = []
    monkeypatch.setattr("agent.kp_tools_knowledge.DocumentTools", _FakeDocumentTools)
    services = _services()
    router = CommandRouter(services)
    fs = AttachmentFs(
        [ChatAttachment(id="hash", name="mystery.md", mime="text/markdown", data=b"# Mystery")]
    )
    ctx = AgentCtx(
        chat_key="cli:dm:module",
        user_id="keeper",
        locale="en",
        fs=fs,
        extra={"attachment_names": ["mystery.md"]},
    )
    try:
        reply = await router.dispatch(ctx, ".module")
        resolved = fs.get_file("mystery.md")
    finally:
        fs.close()

    assert reply == "module import ok"
    assert _FakeDocumentTools.calls[0]["file_path"] == "mystery.md"
    assert resolved.endswith("0-mystery.md")


def test_chat_attachment_filesystem_does_not_publish_temporary_paths() -> None:
    fs = AttachmentFs(
        [ChatAttachment(id="hash", name="mystery.md", mime="text/markdown", data=b"# Mystery")]
    )
    try:
        with pytest.raises(NotImplementedError):
            _ = fs.shared_path
        with pytest.raises(NotImplementedError):
            fs.forward_file("report.md")
    finally:
        fs.close()
