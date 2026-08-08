// Static preview: render one rich frame of the TUI game view to stdout (no server
// needed). Run: bun run preview     (from clients/tui)
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, PROTOCOL_VERSION, type ServerFrame, type WelcomeFrame } from "loreweaver-protocol"
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

const WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: PROTOCOL_VERSION,
  room: "blackmoor",
  you: { id: "p1", name: "Nora", role: "player" },
  locale: "en",
  server: "demo",
}

const client = new MockClient()
const { flush, waitForFrame, renderer } = await testRender(
  <GameView client={client} welcome={WELCOME} theme={themes.lamplight} themeName="lamplight" />,
  { width: 100, height: 30 },
)
await flush()
await act(async () => {
  await new Promise((r) => setTimeout(r, 450))
})
await flush()

act(() => {
  client.push({ type: FrameType.Narrative, id: "n1", speaker: "kp", format: "markdown", text: "The Salt & Anchor Inn is dim and smoke-stained. Martha eyes you warily while the patrons fall silent at the lighthouse's name." })
  client.push({ type: FrameType.Narrative, id: "n2", speaker: "npc", name: "Martha", format: "markdown", text: "You'll be wanting the lighthouse. Folk who ask about it don't come back." })
  client.push({ type: FrameType.Narrative, id: "n3", speaker: "player", name: "Nora", format: "plain", text: "I search the desk for clues." })
  client.push({ type: FrameType.Dice, actor: "Spot Hidden", kind: "check", expr: "1d100", rolls: [7], total: 7, target: 65, rank: 2, level: "HARD SUCCESS", success: true })
  client.push({ type: FrameType.Narrative, id: "n4", speaker: "kp", format: "markdown", text: "Behind the water-stained map, a scratched tide table — three dates circled in a shaky hand." })
  client.push({
    type: FrameType.State,
    character: { name: "Nora Vance", system: "coc7", resources: [{ id: "hp", label: "HP", value: 11, max: 13 }, { id: "san", label: "SAN", value: 55, max: 70 }, { id: "mp", label: "MP", value: 8, max: 10 }], attributes: { STR: 60, DEX: 65, INT: 70, POW: 55 }, status_effects: ["shaken"] },
    party: [
      { name: "Nora Vance", online: true, active: true, initiative: 14, resources: [{ id: "hp", label: "HP", value: 11, max: 13 }, { id: "mp", label: "MP", value: 8, max: 10 }, { id: "san", label: "SAN", value: 55, max: 70 }] },
      { name: "Silas", online: true, active: false, initiative: 9, ai: true, resources: [{ id: "hp", label: "HP", value: 8, max: 10 }, { id: "mp", label: "MP", value: 7, max: 10 }, { id: "san", label: "SAN", value: 48, max: 60 }] },
      { name: "Gil", online: false, active: false, resources: [{ id: "hp", label: "HP", value: 3, max: 9 }] },
    ],
    scene: { name: "Salt & Anchor Inn" },
    clock: { time: "1926-03-15 22:14", round: 1 },
    initiative: [ { name: "Nora", value: 14, current: true }, { name: "Silas", value: 9, current: false } ],
    online: 2,
  })
})

const frame = await waitForFrame((t) => t.includes("Martha"))
await Bun.write("preview_frame.txt", frame)
console.log(frame)
act(() => renderer.destroy())
process.exit(0)
