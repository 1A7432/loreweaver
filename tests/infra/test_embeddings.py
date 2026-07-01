"""Tests for infra.embeddings: FakeEmbeddings' determinism and cosine
ordering (the "no network in tests" workhorse for retrieval tests), plus
OpenAIEmbeddings' request/response mapping against a network-free double.
"""

from __future__ import annotations

import math
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from infra.config import LLMSettings
from infra.embeddings import FakeEmbeddings, OpenAIEmbeddings


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    return dot / (norm_a * norm_b)


# ---------------------------------------------------------------------------
# FakeEmbeddings
# ---------------------------------------------------------------------------


def test_fakeembeddings_default_dim_is_64():
    embeddings = FakeEmbeddings()
    assert embeddings.dim == 64


def test_fakeembeddings_dim_is_configurable():
    embeddings = FakeEmbeddings(dim=16)
    assert embeddings.dim == 16


async def test_fakeembeddings_vectors_have_the_configured_length():
    embeddings = FakeEmbeddings(dim=16)
    [vector] = await embeddings.embed(["the lighthouse keeper"])
    assert len(vector) == 16


async def test_fakeembeddings_empty_text_list_returns_empty_list():
    embeddings = FakeEmbeddings()
    assert await embeddings.embed([]) == []


async def test_fakeembeddings_same_text_yields_the_same_vector():
    embeddings = FakeEmbeddings()
    text = "the lighthouse keeper hides a terrible secret"

    first, second = await embeddings.embed([text, text])

    assert first == second


async def test_fakeembeddings_same_text_is_stable_across_instances():
    text = "the investigators search the study"

    [from_a] = await FakeEmbeddings(dim=32).embed([text])
    [from_b] = await FakeEmbeddings(dim=32).embed([text])

    assert from_a == from_b


async def test_fakeembeddings_vectors_are_l2_normalized():
    embeddings = FakeEmbeddings(dim=32)
    [vector] = await embeddings.embed(["a fairly ordinary sentence about clues"])

    norm = math.sqrt(sum(component * component for component in vector))
    assert norm == pytest.approx(1.0, abs=1e-9)


async def test_fakeembeddings_overlapping_tokens_score_higher_than_disjoint():
    embeddings = FakeEmbeddings(dim=64)
    anchor = "the lighthouse keeper is hiding a terrible secret"
    overlapping = "the lighthouse keeper hides a secret in the fog"
    disjoint = "goblins raid the merchant caravan at dawn"

    [anchor_vec, overlap_vec, disjoint_vec] = await embeddings.embed([anchor, overlapping, disjoint])

    overlap_score = _cosine(anchor_vec, overlap_vec)
    disjoint_score = _cosine(anchor_vec, disjoint_vec)
    assert overlap_score > disjoint_score


async def test_fakeembeddings_is_case_insensitive():
    embeddings = FakeEmbeddings()

    [lower, upper] = await embeddings.embed(["the lighthouse keeper", "THE LIGHTHOUSE KEEPER"])

    assert lower == upper


async def test_fakeembeddings_different_text_usually_differs():
    embeddings = FakeEmbeddings()

    [a, b] = await embeddings.embed(["the lighthouse keeper", "goblins raid the caravan"])

    assert a != b


# ---------------------------------------------------------------------------
# OpenAIEmbeddings — real implementation, `openai.AsyncOpenAI` swapped
# ---------------------------------------------------------------------------


class _FakeAsyncOpenAI:
    """Stand-in for `openai.AsyncOpenAI`'s embeddings resource; no network."""

    def __init__(self, **kwargs) -> None:
        self.init_kwargs = kwargs
        self.create = AsyncMock()
        self.embeddings = SimpleNamespace(create=self.create)


@pytest.fixture
def fake_async_openai(monkeypatch):
    monkeypatch.setattr("infra.embeddings.AsyncOpenAI", _FakeAsyncOpenAI)


def test_openaiembeddings_dim_comes_from_settings_not_hardcoded(fake_async_openai):
    embeddings = OpenAIEmbeddings(LLMSettings(api_key="sk-test", embedding_dim=256))
    assert embeddings.dim == 256


def test_openaiembeddings_forwards_api_key_and_base_url(fake_async_openai):
    settings = LLMSettings(api_key="sk-test", base_url="https://api.deepseek.com/v1")
    embeddings = OpenAIEmbeddings(settings)

    assert embeddings._client.init_kwargs == {"api_key": "sk-test", "base_url": "https://api.deepseek.com/v1"}


async def test_openaiembeddings_empty_input_short_circuits_without_a_call(fake_async_openai):
    embeddings = OpenAIEmbeddings(LLMSettings(api_key="sk-test"))

    result = await embeddings.embed([])

    assert result == []
    embeddings._client.create.assert_not_called()


async def test_openaiembeddings_maps_response_data_to_vectors(fake_async_openai):
    settings = LLMSettings(api_key="sk-test", embedding_model="text-embedding-3-small", embedding_dim=3)
    embeddings = OpenAIEmbeddings(settings)
    embeddings._client.create.return_value = SimpleNamespace(
        data=[SimpleNamespace(embedding=[0.1, 0.2, 0.3]), SimpleNamespace(embedding=[0.4, 0.5, 0.6])]
    )

    result = await embeddings.embed(["first", "second"])

    assert result == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
    kwargs = embeddings._client.create.call_args.kwargs
    assert kwargs["model"] == "text-embedding-3-small"
    assert kwargs["input"] == ["first", "second"]
    assert kwargs["dimensions"] == 3
