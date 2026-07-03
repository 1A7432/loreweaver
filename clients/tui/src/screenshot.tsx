#!/usr/bin/env bun
// Live-render entry used ONLY to capture real README screenshots with tmux + aha
// (see scripts capture pipeline). Unlike preview.tsx (plain-text test renderer), this
// drives the ACTUAL OpenTUI renderer so the frame carries the real lamplight colors,
// then stays alive so a terminal-capture tool can grab a real frame.
//   SHOT_LANG=en|zh  bun run src/screenshot.tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { FrameType, type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { GameView, type GameClient } from "./GameView"
import { themes } from "./themes"

class MockClient implements GameClient {
  private listeners = new Set<(f: ServerFrame) => void>()
  onMessage(cb: (f: ServerFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  sendInput(): void {}
  push(f: ServerFrame): void {
    for (const l of this.listeners) l(f)
  }
}

const ZH = process.env.SHOT_LANG === "zh"

const WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1",
  room: ZH ? "歌舞伎町" : "blackmoor",
  you: { id: "p1", name: ZH ? "漱雪" : "Nora", role: "player" },
  locale: ZH ? "zh" : "en",
  server: "demo",
}

const client = new MockClient()
const renderer = await createCliRenderer()
process.stdout.write("\x1b]2;Loreweaver\x07")
createRoot(renderer).render(
  <GameView client={client} welcome={WELCOME} theme={themes.lamplight} themeName="lamplight" />,
)

const EN_FRAMES: ServerFrame[] = [
  { type: FrameType.Narrative, id: "n1", speaker: "kp", format: "markdown", text: "The Salt & Anchor Inn is dim and smoke-stained. Martha eyes you warily while the patrons fall silent at the lighthouse's name." },
  { type: FrameType.Narrative, id: "n2", speaker: "npc", name: "Martha", format: "markdown", text: "You'll be wanting the lighthouse. Folk who ask about it don't come back." },
  { type: FrameType.Narrative, id: "n3", speaker: "player", name: "Nora", format: "plain", text: "I search the desk for clues." },
  { type: FrameType.Dice, actor: "Spot Hidden", kind: "check", expr: "1d100", rolls: [7], total: 7, target: 65, rank: 2, level: "HARD SUCCESS", success: true },
  { type: FrameType.Narrative, id: "n4", speaker: "kp", format: "markdown", text: "Behind the water-stained map, a scratched tide table — three dates circled in a shaky hand." },
  {
    type: FrameType.State,
    character: { name: "Nora Vance", system: "coc7", hp: 11, hpmax: 13, mp: 8, mpmax: 10, san: 55, sanmax: 70, attributes: { STR: 60, DEX: 65, INT: 70, POW: 55 }, status_effects: ["shaken"] },
    party: [
      { name: "Nora Vance", online: true, active: true, initiative: 14, hp: 11, hpMax: 13, mp: 8, mpMax: 10, san: 55, sanMax: 70 },
      { name: "Silas", online: true, active: false, initiative: 9, ai: true, hp: 8, hpMax: 10, mp: 7, mpMax: 10, san: 48, sanMax: 60 },
      { name: "Gil", online: false, active: false, hp: 3, hpMax: 9 },
    ],
    scene: { name: "Salt & Anchor Inn" },
    clock: { time: "1926-03-15 22:14", round: 1 },
    initiative: [ { name: "Nora", value: 14, current: true }, { name: "Silas", value: 9, current: false } ],
    online: 2,
  },
]

const ZH_FRAMES: ServerFrame[] = [
  { type: FrameType.Narrative, id: "n1", speaker: "kp", format: "markdown", text: "人偶屋里灯影昏黄,樟木和旧漆的气味压得人喘不过气。玫姐指间夹着烟,目光在你脸上来回打量。" },
  { type: FrameType.Narrative, id: "n2", speaker: "npc", name: "玫姐", format: "markdown", text: "「你要找的那批『货』,不是随便什么人都碰得的。」" },
  { type: FrameType.Narrative, id: "n3", speaker: "player", name: "漱雪", format: "plain", text: "我借手机的光,凑近玻璃柜里那具人偶。" },
  { type: FrameType.Dice, actor: "侦查", kind: "check", expr: "1d100", rolls: [43], total: 43, target: 70, rank: 2, level: "困难成功", success: true },
  { type: FrameType.Narrative, id: "n4", speaker: "kp", format: "markdown", text: "人偶的瓷眼里嵌着一点极小的红——不是漆,是干涸的血。" },
  {
    type: FrameType.State,
    character: { name: "漱雪", system: "coc7", hp: 11, hpmax: 13, mp: 8, mpmax: 10, san: 55, sanmax: 70, attributes: { STR: 60, DEX: 65, INT: 70, POW: 55 }, status_effects: ["惊惧"] },
    party: [
      { name: "漱雪", online: true, active: true, initiative: 14, hp: 11, hpMax: 13, mp: 8, mpMax: 10, san: 55, sanMax: 70 },
      { name: "沈墨", online: true, active: false, initiative: 9, ai: true, hp: 8, hpMax: 10, mp: 7, mpMax: 10, san: 48, sanMax: 60 },
      { name: "阿健", online: false, active: false, hp: 3, hpMax: 9 },
    ],
    scene: { name: "人偶屋" },
    clock: { time: "1988-11-03 22:14", round: 1 },
    initiative: [ { name: "漱雪", value: 14, current: true }, { name: "沈墨", value: 9, current: false } ],
    online: 2,
  },
]

setTimeout(() => {
  for (const f of ZH ? ZH_FRAMES : EN_FRAMES) client.push(f)
}, 250)

// Stay alive so the capture tool can grab a real terminal frame.
await new Promise(() => {})
