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
    # Left unset by default: don't hand-tune temperature — send nothing and let the provider
    # use its own default (DeepSeek = 1.0, which is also what it recommends for thinking mode;
    # a low temperature can collapse a reasoning model's trace). Callers may still pass one.
    temperature: float | None = None
    reasoning_effort: str = ""  # "high"/"max" for DeepSeek thinking mode / o-series. "" = off. When set, temperature is not sent (thinking mode ignores it).


class CensorSettings(BaseModel):
    """Content-moderation wordlist for `gateway.ops.Censor`.

    OFF by default: Loreweaver ships NO built-in profanity/slur list (a
    concrete wordlist is a maintenance burden and a policy/locale choice the
    deployer should own, not something baked into the engine). With both
    fields left blank, `Censor` is an explicit no-op -- see `docs/deploy.md`
    ("Content moderation") for the full picture, including the current scope
    (it only screens the AI Keeper's own narration, not player input).

    Set ONE (or both) to turn it on:
    - `wordlist_path`: a JSON file, `{"word": level, ...}` -- `level` is an
      int 1-5 matching `gateway.ops.CensorLevel` (missing/invalid -> NOTICE).
    - `wordlist`: an inline `word[:level],word2[:level2],...` list -- handy
      for a single env var (`TRPG_CENSOR__WORDLIST`) with no file needed.
    Both may be set together; `wordlist` entries win on a key collision.
    """

    wordlist_path: str = ""
    wordlist: str = ""


class TuiSettings(BaseModel):
    """`net.tui_server.TuiServer` availability + transport-security knobs.

    See `docs/deploy.md` (Configuration / TLS) for the deployer-facing writeup
    of these.
    """

    # Join-handshake timeout, in seconds. The first frame an unauthenticated connection
    # sends MUST be `join`; if it doesn't arrive within this window the server closes the
    # socket. Without this an unauthenticated peer could open many half-open connections
    # that never send `join` and exhaust server coroutines/fds -- the rate limiter only
    # applies AFTER auth (`TuiServer.dispatch_input`), so this is the pre-auth backstop.
    join_timeout: float = 10.0
    # Global cap on concurrent WebSocket connections (across all rooms). A connection
    # accepted over the cap is refused (`error too_many_connections`) and closed immediately,
    # before authentication. <= 0 disables the cap (unlimited).
    max_connections: int = 200
    # OPTIONAL native TLS: set BOTH to a PEM certificate chain / private key path to have
    # `websockets.serve` terminate TLS itself (wss://) instead of plaintext ws://. Leave both
    # blank (default) for local dev over plaintext ws://. For production, prefer terminating
    # TLS at a reverse proxy (nginx/Caddy/traefik) in front of the server -- see
    # docs/deploy.md -- this pair is a fallback for deployments without one.
    tls_cert_path: str = ""
    tls_key_path: str = ""
    # Media transfer limits. Media bytes are stored server-side and forwarded on demand;
    # only metadata rides the JSON control stream.
    media_max_file_bytes: int = 8 * 1024 * 1024
    media_room_quota_bytes: int = 512 * 1024 * 1024
    media_uploads_per_minute: int = 10
    audio_max_file_bytes: int = 128 * 1024 * 1024
    audio_room_quota_bytes: int = 2 * 1024 * 1024 * 1024


class ImageGenSettings(BaseModel):
    provider: str = ""
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    size: str = "1024x1024"
    per_room_per_hour: int = 10


class Settings(BaseSettings):
    locale: str = "en"  # default en (see infra/i18n.py)
    data_dir: str = "./data"
    db_path: str = ""  # empty -> <data_dir>/loreweaver.db; file-backed store = progress persists across restarts
    enable_vector_db: bool = True
    enable_critical_effects: bool = True
    llm: LLMSettings = LLMSettings()
    imagegen: ImageGenSettings = ImageGenSettings()
    tui: TuiSettings = TuiSettings()
    censor: CensorSettings = CensorSettings()
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
