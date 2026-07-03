"""Embedded, brute-force cosine-similarity vector store.

No native vector-search dependency: candidates are scored with numpy dot
products. `path=None` keeps everything in memory (the common/test case);
passing a file path additionally mirrors every mutation into a small SQLite
table so state survives across `VectorStore` instances, with the exact same
brute-force search code path either way.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from infra.i18n import t


@dataclass
class VectorHit:
    id: str
    score: float
    payload: dict


def _matches(payload: dict, filter: dict | None) -> bool:
    """Equality match on `payload` fields; no filter (None/{}) matches everything."""
    if not filter:
        return True
    return all(payload.get(key) == value for key, value in filter.items())


def _cosine_batch(matrix: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Cosine similarity of `query` against every row of `matrix`, vectorized."""
    query_norm = np.linalg.norm(query)
    row_norms = np.linalg.norm(matrix, axis=1)
    denom = row_norms * query_norm
    dots = matrix @ query
    return np.divide(dots, denom, out=np.zeros_like(dots), where=denom > 0)


class VectorStore:
    """Brute-force cosine similarity store; `path=None` -> in-memory only."""

    def __init__(self, dim: int, path: str | Path | None = None) -> None:
        self._dim = dim
        self._path = str(path) if path is not None else None
        self._lock = asyncio.Lock()
        self._conn: sqlite3.Connection | None = None
        self._vectors: dict[str, np.ndarray] = {}
        self._payloads: dict[str, dict] = {}
        if self._path is not None:
            self._load_from_disk()

    @property
    def dim(self) -> int:
        return self._dim

    def close(self) -> None:
        """Close the underlying SQLite connection, if one has been opened."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS vectors (
                id TEXT PRIMARY KEY,
                vector TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        conn.commit()
        return conn

    def _ensure_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = self._connect()
        return self._conn

    def _load_from_disk(self) -> None:
        conn = self._ensure_conn()
        for point_id, vector_json, payload_json in conn.execute("SELECT id, vector, payload FROM vectors"):
            self._vectors[point_id] = np.asarray(json.loads(vector_json), dtype=np.float64)
            self._payloads[point_id] = json.loads(payload_json)

    def _as_vector(self, values: list[float]) -> np.ndarray:
        arr = np.asarray(values, dtype=np.float64)
        if arr.ndim != 1 or arr.shape[0] != self._dim:
            actual = arr.shape[0] if arr.ndim == 1 else arr.size
            raise ValueError(t("infra.vector.dimension_mismatch", expected=self._dim, actual=actual))
        return arr

    async def upsert(self, points: list[tuple[str, list[float], dict]]) -> None:
        async with self._lock:
            conn = self._ensure_conn() if self._path is not None else None
            for point_id, vector, payload in points:
                arr = self._as_vector(vector)
                payload_copy = dict(payload)
                self._vectors[point_id] = arr
                self._payloads[point_id] = payload_copy
                if conn is not None:
                    conn.execute(
                        "INSERT OR REPLACE INTO vectors (id, vector, payload) VALUES (?, ?, ?)",
                        (point_id, json.dumps(arr.tolist()), json.dumps(payload_copy)),
                    )
            if conn is not None:
                conn.commit()

    async def search(self, vector: list[float], *, limit: int = 5, filter: dict | None = None) -> list[VectorHit]:
        async with self._lock:
            query = self._as_vector(vector)
            candidate_ids = [pid for pid, payload in self._payloads.items() if _matches(payload, filter)]
            if not candidate_ids:
                return []
            matrix = np.stack([self._vectors[pid] for pid in candidate_ids])
            scores = _cosine_batch(matrix, query)
            order = np.argsort(-scores, kind="stable")[:limit]
            return [
                VectorHit(id=candidate_ids[i], score=float(scores[i]), payload=dict(self._payloads[candidate_ids[i]]))
                for i in order
            ]

    async def delete(self, ids: list[str]) -> None:
        async with self._lock:
            conn = self._ensure_conn() if self._path is not None else None
            for point_id in ids:
                self._vectors.pop(point_id, None)
                self._payloads.pop(point_id, None)
                if conn is not None:
                    conn.execute("DELETE FROM vectors WHERE id = ?", (point_id,))
            if conn is not None:
                conn.commit()

    async def delete_by_filter(self, *, filter: dict | None = None) -> int:
        """Delete every point matching ``filter``; return the number removed."""
        async with self._lock:
            point_ids = [pid for pid, payload in self._payloads.items() if _matches(payload, filter)]
            if not point_ids:
                return 0
            conn = self._ensure_conn() if self._path is not None else None
            for point_id in point_ids:
                self._vectors.pop(point_id, None)
                self._payloads.pop(point_id, None)
                if conn is not None:
                    conn.execute("DELETE FROM vectors WHERE id = ?", (point_id,))
            if conn is not None:
                conn.commit()
            return len(point_ids)

    async def dump(self, *, filter: dict | None = None, limit: int = 100_000) -> list[dict]:
        """Return raw vector points matching ``filter`` for backup/import."""
        async with self._lock:
            points = []
            for point_id, payload in self._payloads.items():
                if not _matches(payload, filter):
                    continue
                points.append(
                    {
                        "id": point_id,
                        "vector": self._vectors[point_id].tolist(),
                        "payload": dict(payload),
                    }
                )
                if len(points) >= limit:
                    break
            return points

    async def scroll(self, *, filter: dict | None = None, limit: int = 1000) -> list[VectorHit]:
        async with self._lock:
            hits = [
                VectorHit(id=pid, score=0.0, payload=dict(payload))
                for pid, payload in self._payloads.items()
                if _matches(payload, filter)
            ]
            return hits[:limit]

    async def count(self, *, filter: dict | None = None) -> int:
        async with self._lock:
            return sum(1 for payload in self._payloads.values() if _matches(payload, filter))
