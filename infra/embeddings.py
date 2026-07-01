"""Text-embedding client abstraction (+ deterministic FakeEmbeddings for tests).

`Embeddings` is a `Protocol`; `OpenAIEmbeddings` wraps `openai.AsyncOpenAI`
(same OpenAI-compatible story as `infra.llm.OpenAILLM`). `FakeEmbeddings` is
a hash-based deterministic stand-in: the same text always yields the same
vector, and texts sharing more tokens land closer together (higher cosine
similarity) than texts sharing none — enough signal for retrieval tests
without any network call.
"""

from __future__ import annotations

import hashlib
import math
from typing import Protocol

from openai import AsyncOpenAI

from infra.config import LLMSettings


class Embeddings(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

    @property
    def dim(self) -> int: ...


class OpenAIEmbeddings:
    """Real `Embeddings`, wrapping `openai.AsyncOpenAI`'s embeddings API."""

    def __init__(self, settings: LLMSettings) -> None:
        self._settings = settings
        self._client = AsyncOpenAI(api_key=settings.api_key or None, base_url=settings.base_url or None)

    @property
    def dim(self) -> int:
        return self._settings.embedding_dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        response = await self._client.embeddings.create(
            model=self._settings.embedding_model,
            input=texts,
            dimensions=self._settings.embedding_dim,
        )
        return [item.embedding for item in response.data]


class FakeEmbeddings:
    """Deterministic hash-based `Embeddings` for tests (no network).

    Each text is lowercased/whitespace-tokenized, and every token votes
    +/-1 on one of `dim` hashed buckets (the classic "hashing trick" for
    bag-of-tokens vectors); the result is L2-normalized. Same text -> same
    vector; two texts sharing more tokens land closer in cosine similarity
    than two texts sharing none.
    """

    def __init__(self, dim: int = 64) -> None:
        self._dim = dim

    @property
    def dim(self) -> int:
        return self._dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self._dim
        for token in text.lower().split() or [""]:
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            bucket = int.from_bytes(digest[:4], "big") % self._dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[bucket] += sign

        norm = math.sqrt(sum(component * component for component in vector))
        if norm == 0.0:
            # All votes cancelled out (or an empty text): fall back to a
            # fixed unit vector so callers can still rely on unit length.
            vector = [0.0] * self._dim
            vector[0] = 1.0
            return vector
        return [component / norm for component in vector]


# Local deterministic hash embedder, usable in production as the DEFAULT
# embedder for any chat-only provider (DeepSeek/Groq/Ollama-chat/...) that has
# no embeddings endpoint. Swap in a dedicated provider for better retrieval.
LocalEmbeddings = FakeEmbeddings
