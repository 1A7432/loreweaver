from __future__ import annotations

from agent.context import AgentCtx, LocalFs
from agent.services import build_services
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
    ) -> str:
        self.calls.append(
            {
                "services": self._services,
                "ctx": ctx,
                "file_path": file_path,
                "doc_type": doc_type,
                "custom_filename": custom_filename,
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
    assert call["ctx"].chat_key == "cli:dm:module"
    assert call["ctx"].user_id == "keeper"
    assert call["ctx"].locale == "en"
    assert call["ctx"].fs is fs


async def test_module_command_without_path_returns_usage(monkeypatch):
    _FakeDocumentTools.calls = []
    monkeypatch.setattr("agent.kp_tools_knowledge.DocumentTools", _FakeDocumentTools)
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key="cli:dm:module", user_id="keeper", locale="en")

    reply = await router.dispatch(ctx, ".module")

    assert reply == services.i18n.with_locale("en").t("commands.module.usage")
    assert _FakeDocumentTools.calls == []
