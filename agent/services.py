"""Service bundle wiring — the single integration point that assembles the
deterministic core + infra services the AI-KP tools and loop depend on.

`Services` is a plain container; `build_services()` constructs the real graph
(injectable `llm`/`embeddings` so tests can pass FakeLLM/FakeEmbeddings and run
fully offline)."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from core.battle_report import BattleReportManager
from core.character_manager import CharacterManager
from core.dice_engine import DiceRoller
from core.dice_engine import config as dice_config
from core.document_manager import VectorDatabaseManager
from core.module_initializer import ModuleInitializer
from core.worldbook import WorldbookManager
from infra.config import Settings, get_settings
from infra.embeddings import Embeddings, OpenAIEmbeddings
from infra.i18n import I18n, get_i18n
from infra.imagegen import ImageGen, apply_imagegen_overrides, build_imagegen
from infra.llm import LLMClient
from infra.providers import MutableLLM
from infra.runtime_config import CredentialBook, ImageGenCredentialBook, ImageGenRuntimeConfig, RuntimeConfig
from infra.store import Store
from infra.vector import VectorStore

logger = logging.getLogger(__name__)


@dataclass
class Services:
    """Everything a KP turn needs. Room/user scope comes from the AgentCtx, not here."""

    settings: Settings
    store: Store
    i18n: I18n
    dice: DiceRoller
    characters: CharacterManager
    battles: BattleReportManager
    vector_db: VectorDatabaseManager
    module_init: ModuleInitializer
    worldbook: WorldbookManager
    llm: LLMClient
    imagegen: ImageGen | None
    embeddings: Embeddings
    runtime_config: RuntimeConfig
    llm_credentials: CredentialBook
    imagegen_runtime_config: ImageGenRuntimeConfig
    imagegen_credentials: ImageGenCredentialBook
    # One deployment-wide mutation lock shared by TUI admin frames, chat `.model`
    # commands, and subscription refresh publication. Room turn locks remain separate.
    config_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


def build_services(
    settings: Settings | None = None,
    *,
    llm: LLMClient | None = None,
    fallback_llm: LLMClient | None = None,
    embeddings: Embeddings | None = None,
    i18n: I18n | None = None,
    store: Store | None = None,
    db_path: str = ":memory:",
    vector_path: str | None = None,
) -> Services:
    """Wire the full service graph. Inject `llm`/`embeddings` (e.g. FakeLLM /
    FakeEmbeddings) to run offline; otherwise the configured client is built
    from `settings.llm`. ``fallback_llm`` remains inside ``MutableLLM`` so an
    initially offline app can hot-switch when credentials arrive."""
    settings = settings or get_settings()
    i18n = i18n or get_i18n(settings.locale)
    store = store or Store(db_path)
    runtime_config = RuntimeConfig(store)
    llm_credentials = CredentialBook(store)
    imagegen_runtime_config = ImageGenRuntimeConfig(store)
    imagegen_credentials = ImageGenCredentialBook(store)
    imagegen_overrides = imagegen_runtime_config.load_sync()
    if imagegen_overrides:
        settings = apply_imagegen_overrides(settings, imagegen_overrides)
    embeddings = embeddings or OpenAIEmbeddings(settings.llm)
    # An injected `llm` (e.g. FakeLLM in tests) is used verbatim and left
    # UNWRAPPED so those paths stay byte-compatible. Otherwise wrap in a
    # `MutableLLM` whose provider/model the `.model` admin command can hot-swap,
    # and apply any persisted runtime overrides at startup. `build_llm` (inside
    # MutableLLM) honors settings.llm.provider + PRESETS (OpenAI/Anthropic/Gemini/
    # OpenAI-compatible).
    if llm is None:
        # Warm the credential book cache so subscription providers can resolve
        # OAuth tokens at build_llm time (sync path).
        llm_credentials.load_sync()
        mutable_kwargs = {"credentials": llm_credentials}
        if fallback_llm is not None:
            mutable_kwargs["fallback_llm"] = fallback_llm
        mutable = MutableLLM(settings, **mutable_kwargs)
        persisted = runtime_config.load_sync()
        if persisted:
            # A persisted override that no longer builds (e.g. a native provider whose optional SDK
            # or key went missing) must NOT brick boot. Fall back to the env/`Settings` baseline the
            # `MutableLLM` was constructed with, and log it, instead of raising out of build_services.
            # The baseline itself is covered one layer down: when a `fallback_llm` is configured
            # (`app.py` always supplies one on this path), `MutableLLM.__init__` degrades to it
            # rather than raising, so neither path can take the server down and leave `.model set`
            # -- the repair interface -- unreachable. Without a fallback there is nothing to
            # degrade to and the build error still propagates.
            try:
                mutable.apply(persisted)
            except Exception:
                logger.warning(
                    "Ignoring unusable persisted LLM override for provider=%r model=%r; using base config",
                    persisted.get("provider"),
                    persisted.get("chat_model"),
                    exc_info=True,
                )
                try:
                    mutable.apply({})  # restore the pristine env/Settings baseline
                except Exception:
                    # The baseline is unbuildable too (MutableLLM already degraded to the
                    # offline fallback at construction and warned). Restoring it can only
                    # re-raise the same failure, and boot must survive that as well.
                    logger.warning("Base LLM config is unusable too; staying on the offline fallback")
        llm = mutable

    # keep the deterministic-core crit toggle in sync with config
    dice_config.ENABLE_CRITICAL_EFFECTS = settings.enable_critical_effects
    dice = DiceRoller()

    characters = CharacterManager(store)
    battles = BattleReportManager(store)
    vector_store = VectorStore(embeddings.dim, path=vector_path)
    vector_db = VectorDatabaseManager(embeddings, vector_store, i18n, llm=llm)
    module_init = ModuleInitializer(store, vector_db, llm, settings, i18n, battles=battles)
    # WorldbookManager talks the raw `infra.vector.VectorStore` upsert/search/delete
    # API (its own "worldbook" collection), so it takes `vector_store` directly --
    # not the higher-level `VectorDatabaseManager`, which exposes a different surface.
    worldbook = WorldbookManager(store, vector_db=vector_store, embeddings=embeddings)
    imagegen = build_imagegen(settings, llm_credentials=llm_credentials)

    return Services(
        settings=settings,
        store=store,
        i18n=i18n,
        dice=dice,
        characters=characters,
        battles=battles,
        vector_db=vector_db,
        module_init=module_init,
        worldbook=worldbook,
        llm=llm,
        imagegen=imagegen,
        embeddings=embeddings,
        runtime_config=runtime_config,
        llm_credentials=llm_credentials,
        imagegen_runtime_config=imagegen_runtime_config,
        imagegen_credentials=imagegen_credentials,
    )
