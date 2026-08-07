"""Application settings, loaded from environment variables and `.env`.

Env prefix ``TRPG_``, nested delimiter ``__`` (e.g. ``TRPG_LLM__API_KEY``
sets ``Settings().llm.api_key``). All fields have defaults so ``Settings()``
works with no environment configured at all, which keeps tests hermetic.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

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


class ScribeSettings(BaseModel):
    """The post-turn bookkeeping Scribe (`agent.scribe`) — 书记官.

    ON by default. It runs one extra LLM call after each AI-KP turn to reconcile
    the deterministic state layer (module trackers, and reminder whispers for the
    KP), so a SMALL/CHEAP model is the recommended configuration: set the
    `TRPG_SCRIBE__*` fields to point at one. With every field left blank it
    reuses the main `TRPG_LLM__*` client (correct, but you are paying flagship
    prices for ledger work)."""

    enabled: bool = True
    provider: str = ""  # "" -> reuse the main LLM client
    api_key: str = ""
    base_url: str = ""
    chat_model: str = ""
    reasoning_effort: str = ""  # "" = provider default; "low" is plenty for ledger work


class DirectorSettings(BaseModel):
    """The Stage Director (`agent.stage_director`) — 演出导演.

    The player-side presentation actor: on BEATS (not every turn — the Scribe's
    场记 lane classifies them) it decides what the table SEES and HEARS. Beats are
    rare, so unlike the Scribe this defaults to the main `TRPG_LLM__*` client:
    presentation is a taste judgment, and a cheap model shows it. Point the
    `TRPG_DIRECTOR__*` fields at another model to override.

    Image generation is additionally gated by three things, all of which must
    agree: `images` here, a configured `TRPG_IMAGEGEN__*` endpoint, and the
    module's own presentation kit (an author may declare `generation: pack_only`
    — 宁缺毋滥 — and no config can overrule that veto).
    """

    enabled: bool = True
    provider: str = ""  # "" -> reuse the main LLM client
    api_key: str = ""
    base_url: str = ""
    chat_model: str = ""
    reasoning_effort: str = ""  # "" = provider default

    images: bool = True
    # Per-ROOM lifetime cap on generated art (a campaign, not a session — rooms are
    # long-lived). Reached, the Director keeps staging with pack art and pre-generated
    # subjects; it simply stops spending.
    max_images: int = 24
    # Warm at most this many subjects per beat (慢菜先备): latency hides between beats
    # instead of in front of one.
    pregen_per_beat: int = 2


class ChronicleSettings(BaseModel):
    """The campaign chronicle (M18, `core.chronicle` + `agent.chronicle`) — 战役编年史.

    ON by default. The fold is an occasional extra LLM call: when the assembled
    prompt's fullness (the per-turn `usage_stats` meter) reaches `fold_trigger`
    of the room model's context window, the oldest chronicle records fold into
    the rolling `campaign_summary` in batches until the projection reaches
    `fold_floor`; at `fold_emergency` the fold runs before the next model call.
    Ratios, not absolute tokens, so every window size behaves uniformly
    (`TRPG_CHRONICLE__FOLD_TRIGGER` etc.). The trailing `lag_turns` turns always
    stay raw — the no-future guard: the in-flight scene is not summarizable
    history yet. The fold call reuses the main `TRPG_LLM__*` client (same
    posture as the session recap; summarizing narrative is core KP work).
    """

    enabled: bool = True
    fold_trigger: float = 0.60
    fold_floor: float = 0.40
    fold_emergency: float = 0.85
    lag_turns: int = 4
    # Hard char ceiling on the rolling campaign summary (the codebase's prompt
    # budgets are char-based; ~4000 chars ≈ 1-2k tokens depending on language).
    summary_max_chars: int = 4000


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
    # Keeper-triggered in-place self-update. A keeper updates the server from the client's
    # "Rooms & invites" page: the server runs THIS command and then re-execs into the new
    # code. The default matches the documented git-checkout deployment (docs/deploy.md) —
    # `--ff-only` refuses to run if the checkout diverged, and the re-exec handles the
    # restart, so no `systemctl restart` is needed here. It is always the OPERATOR's command,
    # never anything a client supplies; override it for a non-git deployment (docker/pip/
    # binary), or set it BLANK to disable the feature entirely (the button then never shows).
    update_command: str = "git pull --ff-only && uv sync"  # i18n-exempt: shell command default, not UI text


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
    # The rule system a room plays before any character binds one (a rulepack id).
    default_rulepack: str = "coc7"
    # Full SillyTavern EJS template compatibility (real JS in imported card/worldbook content,
    # run in the QuickJS sandbox — see core/ejs_full.py). Takes effect when the `ejs` extra is
    # installed; without the extra the safe built-in subset (core/ejs_lite.py) renders instead.
    # Self-hosted trust decision: card templates are as trusted as the cards you import.
    enable_full_ejs: bool = True
    llm: LLMSettings = LLMSettings()
    imagegen: ImageGenSettings = ImageGenSettings()
    tui: TuiSettings = TuiSettings()
    censor: CensorSettings = CensorSettings()
    scribe: ScribeSettings = ScribeSettings()
    director: DirectorSettings = DirectorSettings()
    chronicle: ChronicleSettings = ChronicleSettings()

    def __init__(self, **values: Any) -> None:
        env_file = values.pop("_env_file", os.environ.get("TRPG_ENV_FILE") or ".env")
        super().__init__(_env_file=env_file, **values)

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
