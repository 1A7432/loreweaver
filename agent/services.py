"""Service bundle wiring — the single integration point that assembles the
deterministic core + infra services the AI-KP tools and loop depend on.

`Services` is a plain container; `build_services()` constructs the real graph
(injectable `llm`/`embeddings` so tests can pass FakeLLM/FakeEmbeddings and run
fully offline)."""

from __future__ import annotations

from dataclasses import dataclass

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
from infra.llm import LLMClient
from infra.providers import MutableLLM
from infra.runtime_config import RuntimeConfig
from infra.store import Store
from infra.vector import VectorStore


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
    embeddings: Embeddings
    runtime_config: RuntimeConfig


def build_services(
    settings: Settings | None = None,
    *,
    llm: LLMClient | None = None,
    embeddings: Embeddings | None = None,
    i18n: I18n | None = None,
    store: Store | None = None,
    db_path: str = ":memory:",
    vector_path: str | None = None,
) -> Services:
    """Wire the full service graph. Inject `llm`/`embeddings` (e.g. FakeLLM /
    FakeEmbeddings) to run offline; otherwise the OpenAI-backed clients are built
    from `settings.llm`."""
    settings = settings or get_settings()
    i18n = i18n or get_i18n(settings.locale)
    store = store or Store(db_path)
    runtime_config = RuntimeConfig(store)
    embeddings = embeddings or OpenAIEmbeddings(settings.llm)
    # An injected `llm` (e.g. FakeLLM in tests) is used verbatim and left
    # UNWRAPPED so those paths stay byte-compatible. Otherwise wrap in a
    # `MutableLLM` whose provider/model the `.model` admin command can hot-swap,
    # and apply any persisted runtime overrides at startup. `build_llm` (inside
    # MutableLLM) honors settings.llm.provider + PRESETS (OpenAI/Anthropic/Gemini/
    # OpenAI-compatible).
    if llm is None:
        mutable = MutableLLM(settings)
        persisted = runtime_config.load_sync()
        if persisted:
            mutable.apply(persisted)
        llm = mutable

    # keep the deterministic-core crit toggle in sync with config
    dice_config.ENABLE_CRITICAL_EFFECTS = settings.enable_critical_effects
    dice = DiceRoller()

    characters = CharacterManager(store)
    battles = BattleReportManager(store)
    vector_store = VectorStore(embeddings.dim, path=vector_path)
    vector_db = VectorDatabaseManager(embeddings, vector_store, i18n, llm=llm)
    module_init = ModuleInitializer(store, vector_db, llm, settings, i18n)
    # WorldbookManager talks the raw `infra.vector.VectorStore` upsert/search/delete
    # API (its own "worldbook" collection), so it takes `vector_store` directly --
    # not the higher-level `VectorDatabaseManager`, which exposes a different surface.
    worldbook = WorldbookManager(store, vector_db=vector_store, embeddings=embeddings)

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
        embeddings=embeddings,
        runtime_config=runtime_config,
    )
