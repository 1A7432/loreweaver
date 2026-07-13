"""Tests for `core.document_manager`: `DocumentProcessor` text extraction/chunking
(pure logic, PDF/DOCX libs deliberately absent in this environment) and
`VectorDatabaseManager` (chunk/embed/store/search/delete/list) driven against
`infra.embeddings.FakeEmbeddings` + `infra.vector.VectorStore` — no network,
no Qdrant, matching the M1 spec's "no network in tests" rule.

`tests/fixtures/module_en.txt` (a tiny CoC one-room module, well under the
4000-char default chunk size) is the shared sample document.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core.document_manager import DOCX_AVAILABLE, PDF_AVAILABLE, DocumentProcessor, VectorDatabaseManager
from infra.embeddings import FakeEmbeddings
from infra.i18n import I18n, t
from infra.llm import FakeLLM, assistant_text
from infra.vector import VectorStore

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
MODULE_TEXT = (FIXTURES_DIR / "module_en.txt").read_text(encoding="utf-8")
SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"
RULES_TEXT = "Combat uses opposed rolls between the attacker and the defender; higher total wins the exchange."

assert SENTINEL in MODULE_TEXT  # sanity: the fixture actually carries the keeper-only secret


def _manager(dim: int = 64, llm=None) -> tuple[VectorDatabaseManager, VectorStore]:
    embeddings = FakeEmbeddings(dim=dim)
    vector_store = VectorStore(dim=dim)
    manager = VectorDatabaseManager(embeddings, vector_store, I18n(), llm=llm)
    return manager, vector_store


# ---------------------------------------------------------------------------
# DocumentProcessor.extract_text_from_txt
# ---------------------------------------------------------------------------


def test_extract_text_from_txt_decodes_utf8():
    assert DocumentProcessor.extract_text_from_txt("hello world — 你好".encode()) == "hello world — 你好"


def test_extract_text_from_txt_falls_back_through_encodings_for_gbk_bytes():
    gbk_bytes = "你好，世界".encode("gbk")
    assert DocumentProcessor.extract_text_from_txt(gbk_bytes) == "你好，世界"


# ---------------------------------------------------------------------------
# DocumentProcessor.extract_text_from_pdf / extract_text_from_docx
# (pypdf / python-docx are NOT installed in this environment)
# ---------------------------------------------------------------------------


def test_pdf_library_is_not_installed_in_this_environment():
    """Sanity-check the premise of the guarded-import tests below."""
    assert PDF_AVAILABLE is False


def test_docx_library_is_not_installed_in_this_environment():
    assert DOCX_AVAILABLE is False


def test_extract_text_from_pdf_raises_localized_error_when_lib_missing():
    with pytest.raises(ValueError) as exc_info:
        DocumentProcessor.extract_text_from_pdf(b"%PDF-1.4 fake bytes")

    assert str(exc_info.value) == t("document.error.pdf_unavailable")


def test_extract_text_from_docx_raises_localized_error_when_lib_missing():
    with pytest.raises(ValueError) as exc_info:
        DocumentProcessor.extract_text_from_docx(b"PK fake docx bytes")

    assert str(exc_info.value) == t("document.error.docx_unavailable")


# ---------------------------------------------------------------------------
# DocumentProcessor.extract_text_by_extension
# ---------------------------------------------------------------------------


def test_extract_text_by_extension_dispatches_txt():
    content = b"plain text content"
    assert DocumentProcessor.extract_text_by_extension("notes.TXT", content) == "plain text content"


def test_extract_text_by_extension_dispatches_markdown_as_plain_text():
    content = "# Module\n\nPlain markdown content".encode()
    assert DocumentProcessor.extract_text_by_extension("module.MD", content) == "# Module\n\nPlain markdown content"
    assert DocumentProcessor.extract_text_by_extension("module.markdown", content) == "# Module\n\nPlain markdown content"


def test_extract_text_by_extension_dispatches_pdf_to_the_guarded_pdf_path():
    with pytest.raises(ValueError) as exc_info:
        DocumentProcessor.extract_text_by_extension("scan.pdf", b"fake")
    assert str(exc_info.value) == t("document.error.pdf_unavailable")


def test_extract_text_by_extension_dispatches_docx_and_doc_to_the_guarded_docx_path():
    for filename in ("report.docx", "report.doc"):
        with pytest.raises(ValueError) as exc_info:
            DocumentProcessor.extract_text_by_extension(filename, b"fake")
        assert str(exc_info.value) == t("document.error.docx_unavailable")


def test_extract_text_by_extension_raises_localized_error_for_unsupported_format():
    with pytest.raises(ValueError) as exc_info:
        DocumentProcessor.extract_text_by_extension("archive.zip", b"fake")

    assert str(exc_info.value) == t("document.error.unsupported_format", extension="zip")


# ---------------------------------------------------------------------------
# DocumentProcessor.chunk_text
# ---------------------------------------------------------------------------


def test_chunk_text_returns_a_single_chunk_when_under_the_chunk_size():
    text = "short text"
    assert DocumentProcessor.chunk_text(text) == [text]


def test_chunk_text_default_chunk_size_and_overlap_are_4000_and_800():
    text = "y" * 4000
    assert DocumentProcessor.chunk_text(text) == [text]  # exactly at the boundary: still one chunk

    text = "y" * 4001
    chunks = DocumentProcessor.chunk_text(text)
    assert len(chunks) > 1


def test_chunk_text_breaks_at_the_nearest_sentence_boundary():
    text = ("a" * 40) + "。" + ("b" * 40) + "。" + ("c" * 40)

    chunks = DocumentProcessor.chunk_text(text, chunk_size=50, overlap=10)

    assert chunks == [("a" * 40) + "。", ("b" * 40) + "。", "c" * 40]
    assert "".join(chunks) == text  # no characters lost or duplicated


def test_chunk_text_splits_on_raw_chunk_size_when_no_break_point_is_available():
    text = "x" * 100

    chunks = DocumentProcessor.chunk_text(text, chunk_size=30, overlap=10)

    assert [len(c) for c in chunks] == [30, 30, 30, 10]
    assert "".join(chunks) == text


# ---------------------------------------------------------------------------
# VectorDatabaseManager.store_document
# ---------------------------------------------------------------------------


async def test_store_document_chunks_embeds_and_returns_the_chunk_count():
    manager, vector_store = _manager()

    count = await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")

    assert count == 1  # the fixture is well under the 4000-char default chunk size
    assert count == len(DocumentProcessor.chunk_text(MODULE_TEXT))
    assert await vector_store.count() == 1


async def test_store_document_payload_shape_matches_the_source_schema():
    manager, vector_store = _manager()

    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")

    [hit] = await vector_store.scroll()
    assert set(hit.payload) == {
        "document_id",
        "filename",
        "chunk_index",
        "text",
        "chat_key",
        "document_type",
        "created_at",
    }
    assert hit.payload["document_id"] == "doc-1"
    assert hit.payload["filename"] == "module_en.txt"
    assert hit.payload["chunk_index"] == 0
    assert hit.payload["text"] == MODULE_TEXT
    assert hit.payload["chat_key"] == "room-1"
    assert hit.payload["document_type"] == "module"
    assert isinstance(hit.payload["created_at"], str) and hit.payload["created_at"]


async def test_store_document_point_id_is_deterministic_document_id_colon_chunk_index():
    manager, vector_store = _manager()

    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")

    [hit] = await vector_store.scroll()
    assert hit.id == "doc-1:0"


async def test_store_document_same_document_id_overwrites_rather_than_duplicates():
    manager, vector_store = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")

    await manager.store_document("doc-1", "module_en_v2.txt", MODULE_TEXT, "room-1")

    assert await vector_store.count() == 1
    [hit] = await vector_store.scroll()
    assert hit.payload["filename"] == "module_en_v2.txt"


async def test_store_document_removes_legacy_aliases_and_stale_chunks():
    manager, vector_store = _manager()
    legacy_payload = {
        "document_id": "doc-1",
        "filename": "old.txt",
        "chunk_index": 0,
        "text": "old",
        "chat_key": "room-1",
        "document_type": "module",
    }
    stale_payload = {**legacy_payload, "chunk_index": 9}
    await vector_store.upsert(
        [
            ("room-1:backup:legacy", [0.1] * 64, legacy_payload),
            ("doc-1:9", [0.2] * 64, stale_payload),
        ]
    )

    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")

    hits = await vector_store.scroll(filter={"document_id": "doc-1", "chat_key": "room-1"})
    assert [hit.id for hit in hits] == ["doc-1:0"]
    assert hits[0].payload["filename"] == "module_en.txt"


async def test_store_document_uses_embeddings_dim_not_a_hardcoded_1536():
    """Regression guard: the source hardcoded `embedding_dim = 1536`; the port
    must size vectors from `embeddings.dim` so a non-default dim still works."""
    manager, vector_store = _manager(dim=32)

    count = await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")

    assert count == 1
    assert await vector_store.count() == 1


async def test_store_document_raises_if_vector_store_dim_does_not_match_embeddings_dim():
    """Companion to the above: proves the dim really is forwarded from `embeddings`,
    rather than some hardcoded constant that happens to coincidentally match."""
    embeddings = FakeEmbeddings(dim=32)
    mismatched_store = VectorStore(dim=1536)
    manager = VectorDatabaseManager(embeddings, mismatched_store, I18n())

    with pytest.raises(ValueError):
        await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")


# ---------------------------------------------------------------------------
# VectorDatabaseManager.search_documents
# ---------------------------------------------------------------------------


async def test_search_documents_finds_the_relevant_chunk_with_chat_key_and_type_filter():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    # decoys: same room but a different document_type, and the same document_type in a different room.
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")
    await manager.store_document("doc-3", "other_room.txt", MODULE_TEXT, "room-2", document_type="module")

    results = await manager.search_documents("lighthouse keeper murderer", "room-1", document_type="module", limit=5)

    assert len(results) == 1
    [result] = results
    assert result["document_id"] == "doc-1"
    assert result["filename"] == "module_en.txt"
    assert result["document_type"] == "module"
    assert result["chunk_index"] == 0
    assert SENTINEL in result["text"]
    assert isinstance(result["score"], float)


async def test_search_documents_without_type_filter_searches_across_all_types():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")

    results = await manager.search_documents("lighthouse OR combat", "room-1", limit=5)

    assert {r["document_id"] for r in results} == {"doc-1", "doc-2"}


async def test_search_documents_returns_empty_list_for_a_room_with_no_documents():
    manager, _ = _manager()

    assert await manager.search_documents("anything", "empty-room") == []


# ---------------------------------------------------------------------------
# VectorDatabaseManager.list_documents
# ---------------------------------------------------------------------------


async def test_list_documents_returns_one_entry_per_document_with_a_preview():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")

    documents = await manager.list_documents("room-1")

    assert {d["document_id"] for d in documents} == {"doc-1", "doc-2"}
    module_doc = next(d for d in documents if d["document_id"] == "doc-1")
    rules_doc = next(d for d in documents if d["document_id"] == "doc-2")
    assert module_doc["filename"] == "module_en.txt"
    assert module_doc["document_type"] == "module"
    assert module_doc["preview"] == MODULE_TEXT[:100] + "..."  # truncated: MODULE_TEXT is over 100 chars
    assert rules_doc["preview"] == RULES_TEXT  # not truncated: RULES_TEXT is under 100 chars


async def test_list_documents_filters_by_document_type():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")

    documents = await manager.list_documents("room-1", document_type="rule")

    assert [d["document_id"] for d in documents] == ["doc-2"]


async def test_list_documents_scoped_to_chat_key():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")
    await manager.store_document("doc-2", "module_en.txt", MODULE_TEXT, "room-2")

    assert [d["document_id"] for d in await manager.list_documents("room-1")] == ["doc-1"]
    assert [d["document_id"] for d in await manager.list_documents("room-2")] == ["doc-2"]


# ---------------------------------------------------------------------------
# VectorDatabaseManager.delete_document
# ---------------------------------------------------------------------------


async def test_delete_document_removes_all_its_chunks_but_leaves_others():
    manager, vector_store = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1")

    deleted = await manager.delete_document("doc-1", "room-1")

    assert deleted is True
    assert await vector_store.count() == 1
    remaining = await manager.list_documents("room-1")
    assert [d["document_id"] for d in remaining] == ["doc-2"]


async def test_delete_document_does_not_delete_chunks_from_a_different_chat_key():
    manager, vector_store = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")

    # doc-1 only exists in room-1: "deleting" it while scoped to room-2 must be a no-op.
    deleted = await manager.delete_document("doc-1", "room-2")

    assert deleted is True
    assert await vector_store.count() == 1  # room-1's chunk is untouched


async def test_delete_document_missing_id_is_a_noop_returning_true():
    manager, _ = _manager()

    assert await manager.delete_document("does-not-exist", "room-1") is True


# ---------------------------------------------------------------------------
# VectorDatabaseManager.list_all_chunks
# ---------------------------------------------------------------------------


async def test_list_all_chunks_returns_full_payload_plus_id():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")

    [chunk] = await manager.list_all_chunks("room-1")

    assert chunk["id"] == "doc-1:0"
    assert chunk["document_id"] == "doc-1"
    assert chunk["chat_key"] == "room-1"
    assert chunk["text"] == MODULE_TEXT


async def test_list_all_chunks_scoped_to_chat_key_across_document_types():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")
    await manager.store_document("doc-3", "module_en.txt", MODULE_TEXT, "room-2", document_type="module")

    chunks = await manager.list_all_chunks("room-1")

    assert {c["document_id"] for c in chunks} == {"doc-1", "doc-2"}


# ---------------------------------------------------------------------------
# VectorDatabaseManager.get_document_context
# ---------------------------------------------------------------------------


async def test_get_document_context_returns_empty_string_for_a_room_with_no_documents():
    manager, _ = _manager()

    assert await manager.get_document_context("anything", "empty-room") == ""


async def test_get_document_context_returns_empty_string_when_even_the_smallest_chunk_exceeds_max_length():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")

    context = await manager.get_document_context("lighthouse combat", "room-1", max_context_length=50)

    assert context == ""


async def test_get_document_context_includes_exactly_one_chunk_when_max_length_fits_only_one():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")

    # Sized so exactly one chunk header (whichever ranks first) fits, but not both.
    context = await manager.get_document_context("lighthouse combat", "room-1", max_context_length=1850)

    assert context != ""
    assert len(context) <= 1850
    assert ("module_en.txt" in context) != ("rules.txt" in context)  # exactly one, not both


async def test_get_document_context_concatenates_every_chunk_under_a_generous_max_length():
    manager, _ = _manager()
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1", document_type="module")
    await manager.store_document("doc-2", "rules.txt", RULES_TEXT, "room-1", document_type="rule")

    context = await manager.get_document_context("lighthouse combat", "room-1", max_context_length=8000)

    assert len(context) <= 8000
    assert "module_en.txt" in context
    assert "rules.txt" in context
    assert SENTINEL in context


# ---------------------------------------------------------------------------
# VectorDatabaseManager.answer_question
# ---------------------------------------------------------------------------


async def test_answer_question_returns_localized_message_when_no_context_is_found():
    manager, _ = _manager()

    answer = await manager.answer_question("anything", "empty-room")

    assert answer == t("document.answer.no_context")


async def test_answer_question_returns_localized_message_when_no_llm_is_configured():
    manager, _ = _manager()  # llm=None by default
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")

    answer = await manager.answer_question("Who is the lighthouse keeper?", "room-1")

    assert answer == t("document.answer.no_llm")


async def test_answer_question_uses_the_llm_over_the_retrieved_context():
    llm = FakeLLM(script=[assistant_text("Elias Crane is not what he seems.")])
    manager, _ = _manager(llm=llm)
    await manager.store_document("doc-1", "module_en.txt", MODULE_TEXT, "room-1")

    answer = await manager.answer_question("Who is the lighthouse keeper?", "room-1")

    assert answer == "Elias Crane is not what he seems."
    assert len(llm.calls) == 1
    [(messages, _tools)] = llm.calls
    assert "Who is the lighthouse keeper?" in messages[0]["content"]
    assert SENTINEL in messages[0]["content"]  # the retrieved context was actually included
