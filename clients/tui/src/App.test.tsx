import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type ServerFrame } from "@trpg-kp/protocol"
import App, { type AppClient } from "./App"

class MockClient implements AppClient {
  sent: string[] = []
  private listeners = new Set<(frame: ServerFrame) => void>()

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  sendInput(text: string): void {
    this.sent.push(text)
  }

  push(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame)
  }
}

describe("App", () => {
  test("renders protocol frames and submits command input", async () => {
    const client = new MockClient()
    // testRender wraps createTestRenderer + createRoot and flushes the initial
    // mount inside act(), matching how @opentui/react's own test-utils expect
    // a ConcurrentRoot to be driven under bun:test.
    const { renderer, flush, waitForFrame, mockInput } = await testRender(<App client={client} />, {
      width: 110,
      height: 34,
    })
    await flush()

    // App's boot sequence fires a few setTimeout-driven setState calls; let them
    // settle inside an active act() scope so they don't warn as un-batched updates.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    await flush()

    // State updates delivered outside of React event handlers still need to be
    // wrapped in act() so the renderer commit (and its requestRender()) happens
    // synchronously before we assert on the rendered frame.
    act(() => {
      client.push({
        type: FrameType.Welcome,
        protocol: "1",
        room: "arkham",
        you: { id: "p1", name: "Ada", role: "player" },
        locale: "en",
        server: "mock",
      })
      client.push({
        type: FrameType.Narrative,
        id: "n1",
        speaker: "kp",
        text: "**The library exhales dust.**",
        format: "markdown",
      })
      client.push({
        type: FrameType.Narrative,
        id: "n2",
        speaker: "npc",
        name: "Martha",
        text: "Keep your voice down.",
        format: "markdown",
      })
      client.push({
        type: FrameType.Dice,
        actor: "Spot Hidden",
        kind: "check",
        expr: "07",
        rolls: [7],
        total: 7,
        target: 65,
        rank: 2,
        level: "HARD SUCCESS",
        success: true,
      })
      client.push({
        type: FrameType.State,
        character: {
          name: "Ada",
          system: "coc7",
          hp: 11,
          hpmax: 13,
          mp: 8,
          mpmax: 10,
          san: 55,
          sanmax: 70,
          attributes: { str: 45, dex: 60 },
          status_effects: [],
        },
        party: [{ name: "Ada", online: true, active: true, initiative: 12 }],
        scene: { name: "Library" },
        clock: { time: "23:10", round: 2 },
        initiative: [{ name: "Ada", value: 12, current: true }],
        online: 1,
      })
    })

    const frame = await waitForFrame((text) => {
      return (
        text.includes("library exhales dust") &&
        text.includes("[Martha]: Keep your voice down.") &&
        text.includes("HARD SUCCESS") &&
        text.includes("HP")
      )
    })

    expect(frame).toContain("library exhales dust")
    expect(frame).toContain("[Martha]: Keep your voice down.")
    expect(frame).toContain("HARD SUCCESS")
    expect(frame).toContain("HP")

    await act(async () => {
      await mockInput.typeText("i search")
      mockInput.pressEnter()
    })
    await flush()

    expect(client.sent).toContain("i search")
    act(() => {
      renderer.destroy()
    })
  })
})
