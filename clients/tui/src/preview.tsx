// Static preview: render one rich frame of the TUI to stdout (no server needed).
// Run: bun run preview     (from clients/tui)
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type ServerFrame } from "@trpg-kp/protocol"
import App, { type AppClient } from "./App"

class MockClient implements AppClient {
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

const client = new MockClient()
const { flush, waitForFrame, renderer } = await testRender(<App client={client} />, { width: 100, height: 30 })
await flush()
await act(async () => {
  await new Promise((r) => setTimeout(r, 450))
})
await flush()

act(() => {
  client.push({ type: FrameType.Welcome, protocol: "1", room: "blackmoor", you: { id: "p1", name: "Nora", role: "player" }, locale: "en", server: "demo" })
  client.push({ type: FrameType.Narrative, id: "n1", speaker: "kp", format: "markdown", text: "The Salt & Anchor Inn is dim and smoke-stained. Martha eyes you warily while the patrons fall silent at the lighthouse's name." })
  client.push({ type: FrameType.Narrative, id: "n2", speaker: "npc", name: "Martha", format: "markdown", text: "You'll be wanting the lighthouse. Folk who ask about it don't come back." })
  client.push({ type: FrameType.Narrative, id: "n3", speaker: "player", name: "Nora", format: "plain", text: "I search the desk for clues." })
  client.push({ type: FrameType.Dice, actor: "Spot Hidden", kind: "check", expr: "1d100", rolls: [7], total: 7, target: 65, rank: 2, level: "HARD SUCCESS", success: true })
  client.push({ type: FrameType.Narrative, id: "n4", speaker: "kp", format: "markdown", text: "Behind the water-stained map, a scratched tide table — three dates circled in a shaky hand." })
  client.push({
    type: FrameType.State,
    character: { name: "Nora Vance", system: "coc7", hp: 11, hpmax: 13, mp: 8, mpmax: 10, san: 55, sanmax: 70, attributes: { STR: 60, DEX: 65, INT: 70, POW: 55 }, status_effects: ["shaken"] },
    party: [ { name: "Nora", online: true, active: true, initiative: 14 }, { name: "Silas", online: true, active: false, initiative: 9 }, { name: "Gil", online: false, active: false } ],
    scene: { name: "Salt & Anchor Inn" },
    clock: { time: "1926-03-15 22:14", round: 1 },
    initiative: [ { name: "Nora", value: 14, current: true }, { name: "Silas", value: 9, current: false } ],
    online: 2,
  })
})

const frame = await waitForFrame((t) => t.includes("Martha") && t.includes("HARD SUCCESS") && t.includes("HP"))
await Bun.write("preview_frame.txt", frame)
act(() => renderer.destroy())
process.exit(0)
