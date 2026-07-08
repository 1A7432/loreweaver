#!/usr/bin/env bun
// Live-render entry used ONLY to capture real README/site screenshots with tmux +
// screenshot-render.py (see capture-screenshots.sh). Unlike preview.tsx (plain-text
// test renderer), this drives the ACTUAL OpenTUI renderer so the frame carries the
// real lamplight colors, then stays alive so a terminal-capture tool can grab it.
//   SHOT_LANG=en|zh SHOT_SCREEN=game|connect|menu|character|skills  bun run src/screenshot.tsx
// Runtime-only: no test-utils imports — every screen is driven with a hand-rolled
// mock client and (for `character`) real keystrokes sent by the capture script.
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import {
  FrameType,
  type AdminForgeKind,
  type AdminSkillInfo,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { GameView, type GameClient } from "./GameView"
import { ConnectScreen } from "./screens/ConnectScreen"
import { MainMenu } from "./screens/MainMenu"
import { CharacterScreen } from "./screens/CharacterScreen"
import { KeeperSkills } from "./screens/KeeperSkills"
import type { SavedServer } from "./connectMemory"
import { themes } from "./themes"

const ZH = process.env.SHOT_LANG === "zh"
const LOCALE = ZH ? "zh" : "en"
const SCREEN = process.env.SHOT_SCREEN ?? "game"
const theme = themes.lamplight

// Shared room identity for the official bundled module (tests/fixtures/module_zh.txt /
// adapters/cli/demo_module_en.txt): the Blackmoor Lighthouse, starting at the Salt &
// Anchor Inn. Historical setting date is the same across locales — only the prose
// is translated.
const ROOM = ZH ? "黑沼" : "blackmoor"
const PLAYER_NAME = ZH ? "张伟" : "Alex"
// A distinct display name for the keeper-role identity (not the literal role
// label) so the menu header doesn't read as a redundant "Keeper · Keeper".
const KEEPER_NAME = ZH ? "罗宛" : "Rowan"
const COMPANION_NAME = ZH ? "沈墨" : "Silas"
const OFFLINE_NAME = ZH ? "阿健" : "Gil"
const SCENE_NAME = ZH ? "盐锚酒馆" : "Salt & Anchor Inn"
const CLOCK_TIME = "1926-03-15 22:14"

class MockClient implements GameClient {
  protected listeners = new Set<(f: ServerFrame) => void>()
  onMessage(cb: (f: ServerFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  sendInput(): void {}
  push(f: ServerFrame): void {
    for (const l of this.listeners) l(f)
  }
}

// Narrow admin-capable mock for the keeper-only screens (KeeperSkills): the
// component only ever calls these three methods, all no-ops here — the screen's
// content comes entirely from frames this script `push()`es in.
class AdminMockClient extends MockClient {
  adminListSkills(): void {}
  adminEnableSkill(_id: string, _on: boolean): void {}
  adminGenerate(_kind: AdminForgeKind, _description: string): void {}
}

const renderer = await createCliRenderer()
process.stdout.write("\x1b]2;Loreweaver\x07")
const root = createRoot(renderer)

function welcomeFor(role: "player" | "keeper", room = ROOM): WelcomeFrame {
  return {
    type: FrameType.Welcome,
    protocol: "1.1",
    room,
    you: { id: role === "keeper" ? "k1" : "p1", name: role === "keeper" ? KEEPER_NAME : PLAYER_NAME, role },
    locale: LOCALE,
    server: "demo",
  }
}

// `headerOnline` feeds `StateFrame.online` (the header's "N online" line + the bottom
// StatusBar); per-member roster dots come from each member's own `online` flag.
function partyState(headerOnline: number, round?: number): StateFrame {
  return {
    type: FrameType.State,
    character: {
      name: PLAYER_NAME,
      system: "coc7",
      hp: 11,
      hpmax: 13,
      mp: 8,
      mpmax: 10,
      san: 55,
      sanmax: 70,
      attributes: { STR: 60, DEX: 65, INT: 70, POW: 55 },
      status_effects: [ZH ? "惊惧" : "shaken"],
    },
    party: [
      { name: PLAYER_NAME, online: true, active: true, initiative: 14, hp: 11, hpMax: 13, mp: 8, mpMax: 10, san: 55, sanMax: 70 },
      { name: COMPANION_NAME, online: true, active: false, initiative: 9, ai: true, hp: 8, hpMax: 10, mp: 7, mpMax: 10, san: 48, sanMax: 60 },
      { name: OFFLINE_NAME, online: false, active: false, hp: 3, hpMax: 9 },
    ],
    scene: { name: SCENE_NAME },
    clock: round ? { time: CLOCK_TIME, round } : { time: CLOCK_TIME },
    initiative: [
      { name: PLAYER_NAME, value: 14, current: true },
      { name: COMPANION_NAME, value: 9, current: false },
    ],
    online: headerOnline,
    usage: {
      context_tokens: 18500,
      context_window: 65536,
      input_tokens: 42300,
      output_tokens: 9800,
      cache_hit_tokens: 31200,
      cache_miss_tokens: 11100,
    },
  }
}

if (SCREEN === "game") {
  const welcome = welcomeFor("player")
  const client = new MockClient()
  root.render(<GameView client={client} welcome={welcome} theme={theme} themeName="lamplight" connectionStatus="online" />)

  // The two HeaderBar layout collisions this harness once had to dodge (status light +
  // online count needing a 3rd row; usage squeezing the scene/clock into a wrap) are
  // fixed in the component itself — the light and the count share one line now, and the
  // center column truncates instead of wrapping — so the hero shot shows the full state.
  const state = partyState(2, 1)

  const EN_FRAMES: ServerFrame[] = [
    { type: FrameType.Narrative, id: "n1", speaker: "kp", format: "markdown", text: "The Salt & Anchor Inn is dim and smoke-stained. Martha eyes you warily while the patrons fall silent at the lighthouse's name." },
    { type: FrameType.Narrative, id: "n2", speaker: "npc", name: "Martha", format: "markdown", text: "You'll be wanting the lighthouse. Folk who ask about it don't come back." },
    { type: FrameType.Narrative, id: "n3", speaker: "player", name: "Alex", format: "plain", text: "I search the desk for clues." },
    { type: FrameType.Dice, actor: "Spot Hidden", kind: "check", expr: "1d100", rolls: [43], total: 43, target: 70, rank: 2, level: "HARD SUCCESS", success: true },
    { type: FrameType.Narrative, id: "n4", speaker: "kp", format: "markdown", text: "Behind the water-stained map, a scratched tide table — three dates circled in a shaky hand." },
    state,
  ]

  const ZH_FRAMES: ServerFrame[] = [
    { type: FrameType.Narrative, id: "n1", speaker: "kp", format: "markdown", text: "盐锚酒馆里烟熏昏暗,老板娘玛莎警惕地打量着你们——一提到灯塔的名字,满座的客人都沉默下来。" },
    { type: FrameType.Narrative, id: "n2", speaker: "npc", name: "玛莎", format: "markdown", text: "你们是要打听那灯塔的事?问起它的人,大多有去无回。" },
    { type: FrameType.Narrative, id: "n3", speaker: "player", name: "张伟", format: "plain", text: "我翻找柜台后的抽屉,寻找线索。" },
    { type: FrameType.Dice, actor: "侦查", kind: "check", expr: "1d100", rolls: [43], total: 43, target: 70, rank: 2, level: "困难成功", success: true },
    { type: FrameType.Narrative, id: "n4", speaker: "kp", format: "markdown", text: "地图背后藏着一张被水渍浸透的潮汐表——三个日期被人用颤抖的手圈了出来。" },
    state,
  ]

  setTimeout(() => {
    for (const f of ZH ? ZH_FRAMES : EN_FRAMES) client.push(f)
  }, 250)
} else if (SCREEN === "connect") {
  const savedServers: SavedServer[] = [
    {
      host: "endpointaahnc72q6gbx6gizd54glgrthgqqhenhot2gy4q47vu",
      key: "lw-invite-9f2a7c31",
      name: ROOM,
    },
  ]
  root.render(
    <ConnectScreen
      theme={theme}
      defaults={{ localServerHome: ZH ? "D:\\Loreweaver\\server-state" : "~/.loreweaver" }}
      connecting={false}
      locale={LOCALE}
      savedServers={savedServers}
      onLocaleChange={() => {}}
      onHostLocal={() => {}}
      onSubmit={() => {}}
      onForgetServer={() => {}}
      onQuit={() => {}}
    />,
  )
} else if (SCREEN === "menu") {
  const welcome = welcomeFor("keeper")
  root.render(
    <MainMenu
      welcome={welcome}
      theme={theme}
      themeName="lamplight"
      // The keeper's own identity ("Keeper"/"守秘人") isn't one of the party's PCs, so
      // the side CHARACTER panel is left empty here rather than confusingly showing
      // Alex's sheet under a "Keeper" nameplate.
      stateFrame={{ ...partyState(2, 1), character: undefined }}
      onEnterGame={() => {}}
      onCharacter={() => {}}
      onSettings={() => {}}
      onKeeperKeys={() => {}}
      onKeeperModule={() => {}}
      onKeeperModel={() => {}}
      onKeeperRules={() => {}}
      onKeeperSkills={() => {}}
      onQuit={() => {}}
    />,
  )
} else if (SCREEN === "character") {
  const welcome = welcomeFor("player")
  const client = new MockClient()
  // No `character` on the state frame -> CharacterScreen's `mode` initializes to
  // "create" directly (`hasCharacter ? "view" : "create"`), landing on the create
  // form without any click. The capture script then sends real keystrokes (Down +
  // Enter to pick the "manual" method, Tab, type the name, Tab again) so the shot
  // shows both the four creation methods AND the point-budget line at once —
  // "roll" (the default method) never renders a budget line by itself.
  const state: StateFrame = { type: FrameType.State, party: [], initiative: [], online: 1 }
  root.render(
    <CharacterScreen client={client} theme={theme} themeName="lamplight" welcome={welcome} stateFrame={state} onBack={() => {}} />,
  )
} else if (SCREEN === "skills") {
  const welcome = welcomeFor("keeper")
  const client = new AdminMockClient()
  const state: StateFrame = { type: FrameType.State, party: [], initiative: [], online: 2 }
  root.render(<KeeperSkills client={client} theme={theme} themeName="lamplight" welcome={welcome} stateFrame={state} onBack={() => {}} />)

  const skills: AdminSkillInfo[] = ZH
    ? [
        { id: "mature-mode", name: "成人模式", description: "成熟主题的内容与基调闸门", content_rating: "mature", enabled: true },
        { id: "romance-relationships", name: "恋爱与人际关系", description: "吸引力、张力与需双方同意的亲密情节", content_rating: "mature", enabled: false },
        { id: "survival-horror-forge", name: "生存恐怖锻造", description: "自生成的匮乏感与恐惧节奏技能", content_rating: "general", enabled: true },
      ]
    : [
        { id: "mature-mode", name: "Mature mode", description: "Content & tone gate for mature themes", content_rating: "mature", enabled: true },
        { id: "romance-relationships", name: "Romance & relationships", description: "Attraction, tension, and consent-gated intimacy beats", content_rating: "mature", enabled: false },
        { id: "survival-horror-forge", name: "Survival horror forge", description: "Self-authored dread-and-scarcity pacing skill", content_rating: "general", enabled: true },
      ]

  setTimeout(() => {
    client.push({ type: FrameType.AdminSkills, skills })
  }, 250)
}

// Stay alive so the capture tool can grab a real terminal frame.
await new Promise(() => {})
