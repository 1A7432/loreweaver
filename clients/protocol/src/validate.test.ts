import { describe, expect, test } from "bun:test"
import { isServerFrame } from "./client"
import {
  ADMIN_ERROR_CODES,
  ERROR_CODES,
  FrameType,
  type AdminConfigFrame,
  type AdminKeysFrame,
  type AdminModelsFrame,
  type AdminRulesFrame,
  type AdminSkillsFrame,
  type AudioStateFrame,
  type PackCardsFrame,
  type PresenceFrame,
  type StateFrame,
  type UiManifestFrame,
  type WelcomeFrame,
} from "./types"

/**
 * Engine-shaped positive fixtures. Field sets match what `net.session.welcome_frame`,
 * `net.state.build_room_state`, `gateway.audio.audio_state_frame`,
 * `core.panels.wire_panel`, and `net.admin` actually emit — not the shallow
 * `{type, party:[], …}` stubs the old validator treated as sufficient.
 */
const ENGINE_WELCOME: WelcomeFrame = {
  type: "welcome",
  protocol: "2.3",
  features: ["media", "audio"],
  room: "demo",
  you: { id: "tui:abc123", name: "Alice", role: "player" },
  locale: "en",
  server: "loreweaver",
  version: "2.3.2",
}

const ENGINE_STATE: StateFrame = {
  type: "state",
  character: {
    name: "Nora Vance",
    system: "coc7",
    resources: [
      { id: "hp", label: "HP", value: 10, max: 10 },
      { id: "san", label: "SAN", value: 50, max: 99 },
      { id: "mp", label: "MP", value: 10, max: 10 },
    ],
    attributes: { STR: 50, DEX: 60 },
    status_effects: [],
    avatar: { hash: "a".repeat(64), mime: "image/png", size: 12, name: "nora.png" },
  },
  party: [
    {
      name: "Nora Vance",
      online: true,
      active: true,
      initiative: 12,
      resources: [{ id: "hp", label: "HP", value: 10, max: 10 }],
      ai: false,
    },
  ],
  scene: { name: "The Salt & Anchor", focus: "the tide table" },
  clock: { time: "Night 1, 22:00", round: 2 },
  initiative: [{ name: "Nora Vance", value: 12, current: true }],
  online: 1,
  usage: {
    context_tokens: 1200,
    context_window: 8192,
    input_tokens: 800,
    output_tokens: 400,
    cache_hit_tokens: 100,
    cache_miss_tokens: 700,
  },
  variables: [{ id: "suspicion", label: "Suspicion", kind: "number", value: 3, min: 0, max: 10 }],
  pregens: [{ name: "Mira Vane", claimed_by: "player-1" }],
  systems: [{ id: "coc7", make_char: "coc" }],
}

const ENGINE_AUDIO_STATE: AudioStateFrame = {
  type: "audio_state",
  layers: [
    { layer: "ambience", playing: false },
    { layer: "bgm", playing: true, hash: "b".repeat(64), mime: "audio/mpeg", name: "theme.mp3", volume: 0.7, loop: true },
    { layer: "sfx", playing: false },
  ],
}

const ENGINE_PACK_CARDS: PackCardsFrame = {
  type: "pack_cards",
  cards: [
    { ref: "harbour/cards/pilot.json", pack: "harbour", name: "pilot", kind: "character" },
    { ref: "harbour/cards/world.json", pack: "harbour", name: "world", kind: "world" },
  ],
}

const ENGINE_MANIFEST: UiManifestFrame = {
  type: "ui_manifest",
  panels: [
    {
      id: "harbour/board",
      title: { en: "Board" },
      slot: "sidebar",
      tier: 1,
      blocks: [
        { kind: "meter", label: { en: "Fear" }, value: { $var: "fear" }, min: 0, max: 10 },
        { kind: "divider" },
      ],
    },
    {
      id: "harbour/map",
      title: { en: "Map" },
      slot: "modal",
      tier: 2,
      entry: { hash: "c".repeat(64), size: 128 },
      assets: [{ path: "app.js", hash: "d".repeat(64), size: 64, mime: "text/javascript" }],
      fallback: null,
    },
  ],
}

const ENGINE_PRESENCE: PresenceFrame = {
  type: "presence",
  players: [{ id: "tui:abc123", name: "Alice", online: true }],
  online: 1,
}

const ENGINE_ADMIN_CONFIG: AdminConfigFrame = {
  type: "admin_config",
  provider: "openai",
  chat_model: "gpt-4o",
  base_url: "",
  api_key_masked: "",
  providers: ["openai", "deepseek"],
  saved_providers: ["openai"],
  override_active: false,
}

const ENGINE_ADMIN_MODELS: AdminModelsFrame = {
  type: "admin_models",
  provider: "openai",
  models: ["gpt-4o", "gpt-4o-mini"],
}

const ENGINE_ADMIN_KEYS: AdminKeysFrame = {
  type: "admin_keys",
  keys: [
    {
      id: "kid-1",
      key_masked: "lw-…abc",
      room: "arkham",
      name: "Ada",
      role: "keeper",
      purpose: "join",
      expires_at: null,
    },
  ],
}

const ENGINE_ADMIN_SKILLS: AdminSkillsFrame = {
  type: "admin_skills",
  skills: [
    { id: "mature-mode", name: "Mature mode", description: "…", content_rating: "explicit", enabled: false },
  ],
}

const ENGINE_ADMIN_RULES: AdminRulesFrame = {
  type: "admin_rules",
  systems: [
    { id: "coc7", built_in: true },
    { id: "dnd5e", built_in: true },
  ],
}

describe("isServerFrame deep validation", () => {
  test("the reproduced crashers — null entries in load-bearing arrays — drop", () => {
    expect(isServerFrame({ type: "ui_manifest", panels: [null] })).toBe(false)
    expect(isServerFrame({ type: "audio_state", layers: [null] })).toBe(false)
    expect(isServerFrame({ type: "state", party: [null], initiative: [], online: 1 })).toBe(false)
  })

  test("engine-shaped frames of every previously-shallow array pass", () => {
    for (const frame of [
      ENGINE_WELCOME,
      ENGINE_STATE,
      ENGINE_AUDIO_STATE,
      ENGINE_PACK_CARDS,
      ENGINE_MANIFEST,
      ENGINE_PRESENCE,
      ENGINE_ADMIN_CONFIG,
      ENGINE_ADMIN_MODELS,
      ENGINE_ADMIN_KEYS,
      ENGINE_ADMIN_SKILLS,
      ENGINE_ADMIN_RULES,
    ]) {
      expect(isServerFrame(frame)).toBe(true)
    }
  })

  test("welcome.you requires id/name/role; unknown roles drop", () => {
    expect(isServerFrame({ ...ENGINE_WELCOME, you: { name: "Alice", role: "player" } })).toBe(false)
    expect(isServerFrame({ ...ENGINE_WELCOME, you: { id: "p1", name: "Alice", role: "admin" } })).toBe(false)
    expect(isServerFrame({ ...ENGINE_WELCOME, you: null })).toBe(false)
    expect(isServerFrame({ ...ENGINE_WELCOME, you: "Alice" })).toBe(false)
  })

  test("audio_state.layers rejects null, primitives, and missing required fields", () => {
    const base = { type: FrameType.AudioState }
    expect(isServerFrame({ ...base, layers: [null] })).toBe(false)
    expect(isServerFrame({ ...base, layers: ["bgm"] })).toBe(false)
    expect(isServerFrame({ ...base, layers: [{ playing: true }] })).toBe(false)
    expect(isServerFrame({ ...base, layers: [{ layer: "voice", playing: true }] })).toBe(false)
    expect(isServerFrame({ ...base, layers: [{ layer: "bgm" }] })).toBe(false)
  })

  test("audio_control rejects unknown action/layer so clients cannot index arbitrary keys", () => {
    expect(isServerFrame({ type: "audio_control", id: "a1", action: "play", layer: "voice" })).toBe(false)
    expect(isServerFrame({ type: "audio_control", id: "a1", action: "seek", layer: "bgm" })).toBe(false)
    expect(isServerFrame({ type: "audio_control", id: "a1", action: "play", layer: "bgm" })).toBe(true)
  })

  test("media / audio refs reject a missing hash/mime/size", () => {
    const media = {
      type: "media",
      id: "m1",
      hash: "e".repeat(64),
      mime: "image/png",
      size: 4,
      name: "a.png",
      from: "Ada",
      ts: 1,
    }
    expect(isServerFrame(media)).toBe(true)
    expect(isServerFrame({ ...media, hash: 1 })).toBe(false)
    expect(isServerFrame({ type: "media_accept", upload_id: "u1", media: { ...media, type: "media", hash: null } })).toBe(
      false,
    )
    expect(isServerFrame({ type: "media_accept", upload_id: "u1", media: { ...media, type: "media" } })).toBe(true)
  })

  test("pack_cards.cards rejects null, primitives, and missing ref/pack/name", () => {
    const base = { type: FrameType.PackCards }
    expect(isServerFrame({ ...base, cards: [null] })).toBe(false)
    expect(isServerFrame({ ...base, cards: ["harbour/cards/pilot.json"] })).toBe(false)
    expect(isServerFrame({ ...base, cards: [{ pack: "harbour", name: "pilot" }] })).toBe(false)
    expect(isServerFrame({ ...base, cards: [{ ref: "x", pack: "p", name: "n", kind: "npc" }] })).toBe(false)
    expect(isServerFrame({ ...base, cards: [{ ref: "x", pack: "p", name: "n" }] })).toBe(true)
  })

  test("ui_manifest.panels rejects null, primitives, and missing id/title/slot/tier", () => {
    const base = { type: FrameType.UiManifest }
    expect(isServerFrame({ ...base, panels: [null] })).toBe(false)
    expect(isServerFrame({ ...base, panels: ["harbour/board"] })).toBe(false)
    expect(isServerFrame({ ...base, panels: [{ title: { en: "Board" }, slot: "sidebar", tier: 1, blocks: [] }] })).toBe(
      false,
    )
    expect(isServerFrame({ ...base, panels: [{ id: "p", title: "Board", slot: "sidebar", tier: 1 }] })).toBe(false)
    expect(isServerFrame({ ...base, panels: [{ id: "p", title: { en: "Board" }, slot: "popup", tier: 1 }] })).toBe(
      false,
    )
    expect(isServerFrame({ ...base, panels: [{ id: "p", title: { en: "Board" }, slot: "sidebar", tier: 3 }] })).toBe(
      false,
    )
    expect(isServerFrame({ ...base, panels: [{ id: "p", title: { en: "Board" }, slot: "sidebar", tier: 1, blocks: [null] }] })).toBe(
      false,
    )
    expect(
      isServerFrame({
        ...base,
        panels: [{ id: "p", title: { en: "Board" }, slot: "sidebar", tier: 2, assets: [null] }],
      }),
    ).toBe(false)
  })

  test("a single-level panel repeat with a kind inner block passes", () => {
    expect(
      isServerFrame({
        type: FrameType.UiManifest,
        panels: [
          {
            id: "harbour/clues",
            title: { en: "Clues" },
            slot: "sidebar",
            tier: 1,
            blocks: [
              {
                repeat: {
                  prefix: "clue.",
                  block: { kind: "badge", label: { $leaf: "label" } },
                },
              },
            ],
          },
        ],
      }),
    ).toBe(true)
  })

  test("nested and thousand-deep panel repeats drop without walking the tree", () => {
    const basePanel = { id: "p", title: { en: "Board" }, slot: "sidebar", tier: 1 }
    const nested = {
      repeat: {
        prefix: "outer.",
        block: { repeat: { prefix: "inner.", block: { kind: "divider" } } },
      },
    }
    expect(
      isServerFrame({ type: FrameType.UiManifest, panels: [{ ...basePanel, blocks: [nested] }] }),
    ).toBe(false)
    expect(
      isServerFrame({
        type: FrameType.UiManifest,
        panels: [{ ...basePanel, tier: 2, fallback: [nested] }],
      }),
    ).toBe(false)

    let deep: unknown = { kind: "divider" }
    for (let i = 0; i < 8000; i++) {
      deep = { repeat: { prefix: `p${i}.`, block: deep } }
    }
    expect(() =>
      isServerFrame({ type: FrameType.UiManifest, panels: [{ ...basePanel, blocks: [deep] }] }),
    ).not.toThrow()
    expect(
      isServerFrame({ type: FrameType.UiManifest, panels: [{ ...basePanel, blocks: [deep] }] }),
    ).toBe(false)
  })

  test("ui / panel blocks: null and primitives drop; unknown kinds pass if they are objects", () => {
    expect(isServerFrame({ type: "ui", panel: "inline", blocks: [null] })).toBe(false)
    expect(isServerFrame({ type: "ui", panel: "inline", blocks: ["meter"] })).toBe(false)
    expect(isServerFrame({ type: "ui", panel: "inline", blocks: [{ kind: "meter", label: "Fear" }] })).toBe(false)
    expect(isServerFrame({ type: "ui", panel: "inline", blocks: [{ kind: "future_kind", extra: 1 }] })).toBe(true)
    expect(isServerFrame({ type: "ui", panel: "hud", blocks: [] })).toBe(false)
  })

  test("state nested arrays reject null, primitives, and missing required fields", () => {
    const empty: StateFrame = { type: "state", party: [], initiative: [], online: 1 }
    expect(isServerFrame(empty)).toBe(true)
    expect(isServerFrame({ ...empty, party: [null] })).toBe(false)
    expect(isServerFrame({ ...empty, party: ["Nora"] })).toBe(false)
    expect(isServerFrame({ ...empty, party: [{ name: "Nora" }] })).toBe(false)
    expect(isServerFrame({ ...empty, initiative: [null] })).toBe(false)
    expect(isServerFrame({ ...empty, initiative: [{ name: "Nora", value: 12 }] })).toBe(false)
    expect(isServerFrame({ ...empty, character: { name: "Nora", system: "coc7" } })).toBe(false)
    expect(
      isServerFrame({
        ...empty,
        character: { name: "Nora", system: "coc7", resources: [null], attributes: {}, status_effects: [] },
      }),
    ).toBe(false)
    expect(isServerFrame({ ...empty, variables: [null] })).toBe(false)
    expect(isServerFrame({ ...empty, variables: [{ id: "fear", label: "Fear" }] })).toBe(false)
    expect(isServerFrame({ ...empty, pregens: [null] })).toBe(false)
    expect(isServerFrame({ ...empty, pregens: [{ name: "Mira" }] })).toBe(false)
    expect(isServerFrame({ ...empty, systems: [null] })).toBe(false)
    expect(isServerFrame({ ...empty, systems: [{ make_char: "coc" }] })).toBe(false)
    expect(isServerFrame({ ...empty, usage: { context_tokens: 1 } })).toBe(false)
  })

  test("presence.players rejects null, primitives, and missing id/name/online", () => {
    const base = { type: FrameType.Presence, online: 1 }
    expect(isServerFrame({ ...base, players: [null] })).toBe(false)
    expect(isServerFrame({ ...base, players: ["Alice"] })).toBe(false)
    expect(isServerFrame({ ...base, players: [{ name: "Alice", online: true }] })).toBe(false)
    expect(isServerFrame({ ...base, players: [{ id: "p1", name: "Alice", online: true }] })).toBe(true)
  })

  test("admin providers/models/keys/skills/rules arrays reject null and primitives", () => {
    expect(isServerFrame({ ...ENGINE_ADMIN_CONFIG, providers: [null] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_CONFIG, providers: [1] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_MODELS, models: [null] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_KEYS, keys: [null] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_KEYS, keys: [{ id: "k1" }] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_SKILLS, skills: [null] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_SKILLS, skills: [{ id: "s1" }] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_RULES, systems: [null] })).toBe(false)
    expect(isServerFrame({ ...ENGINE_ADMIN_RULES, systems: [{ id: "coc7" }] })).toBe(false)
  })

  test("closed semantic fields reject values that are not in the current protocol enums", () => {
    expect(isServerFrame({ type: "narrative", id: "n1", speaker: "chorus", text: "hi", format: "markdown" })).toBe(
      false,
    )
    expect(isServerFrame({ type: "system", level: "error", text: "boom" })).toBe(false)
    expect(isServerFrame({ type: "dice", actor: "Ada", kind: "luck", expr: "1d6", rolls: [4], total: 4 })).toBe(false)
    expect(isServerFrame({ type: "admin_room_op", action: "clone", room: "r", keys: 0, store_rows: 0, vector_points: 0 })).toBe(
      false,
    )
    expect(isServerFrame({ type: "admin_generated", kind: "card", ok: true })).toBe(false)
    expect(
      isServerFrame({
        type: "state",
        party: [],
        initiative: [],
        online: 1,
        variables: [{ id: "x", label: "X", kind: "list", value: "[]" }],
      }),
    ).toBe(false)
  })

  test("unknown extra fields and unknown frame types stay additive", () => {
    expect(isServerFrame({ ...ENGINE_WELCOME, extra_flag: true, you: { ...ENGINE_WELCOME.you, nickname: "Al" } })).toBe(
      true,
    )
    expect(isServerFrame({ type: "future_additive_frame", value: 1 })).toBe(false)
    expect(isServerFrame({ type: "ui", panel: "inline", blocks: [{ kind: "spotlight", title: "Act II" }] })).toBe(true)
  })

  test("ERROR_CODES / ADMIN_ERROR_CODES are non-empty runtime arrays the unions derive from", () => {
    expect(ERROR_CODES).toContain("demo_unavailable")
    expect(ADMIN_ERROR_CODES).toContain("last_keeper")
    expect(ERROR_CODES.length).toBeGreaterThan(10)
  })
})
