"""Application settings, loaded from environment variables and `.env`.

Env prefix ``TRPG_``, nested delimiter ``__`` (e.g. ``TRPG_LLM__API_KEY``
sets ``Settings().llm.api_key``). All fields have defaults so ``Settings()``
works with no environment configured at all, which keeps tests hermetic.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class LLMSettings(BaseModel):
    provider: str = "openai"
    api_key: str = ""
    base_url: str = ""
    chat_model: str = "gpt-4o"
    embedding_model: str = "text-embedding-3-small"
    embedding_dim: int = 1536
    analysis_model: str = ""  # large-context model for full-module analysis; falls back to chat_model
    npc_model: str = ""  # model for AI-played NPC sub-actors (agent.npc_actor.voice_npc); falls back to chat_model
    temperature: float = 0.7


class Settings(BaseSettings):
    locale: str = "en"  # default en (see infra/i18n.py)
    data_dir: str = "./data"
    db_path: str = ""  # empty -> <data_dir>/loreweaver.db; file-backed store = progress persists across restarts
    enable_vector_db: bool = True
    enable_critical_effects: bool = True
    llm: LLMSettings = LLMSettings()
    # platform sub-settings (qq/telegram/discord/feishu) added in M3

    model_config = SettingsConfigDict(
        env_prefix="TRPG_",
        env_nested_delimiter="__",
        env_file=".env",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """Cached process-wide Settings singleton.

    Tests that need a fresh/isolated instance should construct
    ``Settings()`` directly instead of going through this cache.
    """
    return Settings()
