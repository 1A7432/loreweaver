import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, type ServerFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import { GameView, type GameClient } from "./GameView"
import { SPINNER_FRAMES } from "./components/Spinner"
import { themes } from "./themes"

class MockClient implements GameClient {
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

const WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: "1",
  room: "arkham",
  you: { id: "p1", name: "Ada", role: "player" },
  locale: "en",
  server: "mock",
}

function renderGame(client: MockClient) {
  return testRender(<GameView client={client} welcome={WELCOME} theme={themes.lamplight} themeName="lamplight" />, {
    width: 110,
    height: 34,
  })
}

describe("GameView", () => {
  test("renders protocol frames and submits command input", async () => {
    const client = new MockClient()
    // testRender wraps createTestRenderer + createRoot and flushes the initial
    // mount inside act(), matching how @opentui/react's own test-utils expect
    // a ConcurrentRoot to be driven under bun:test.
    const { renderer, flush, waitForFrame, mockInput } = await renderGame(client)
    await flush()

    // The boot sequence fires a few setTimeout-driven setState calls; let them
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

  test("strips terminal escape sequences from untrusted server text + names", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderGame(client)
    await flush()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    await flush()

    // A hostile NPC line: OSC title-set + OSC-52 clipboard write + ED (erase
    // display), plus an ESC-bearing speaker name. If the client rendered these
    // raw, the ESC/BEL introducers would reach the real terminal.
    act(() => {
      client.push({
        type: FrameType.Narrative,
        id: "inj",
        speaker: "npc",
        name: "Mar\x1b]0;PWNEDTITLE\x07tha",
        text: "look\x1b]52;c;cGF5bG9hZA==\x07here\x1b[2Jgone",
        format: "plain",
      })
    })

    const frame = await waitForFrame((text) => text.includes("here"))

    // OpenTUI styles with CSI (ESC "["); the injected attacks are OSC (ESC "]")
    // title / clipboard writes. The ESC + BEL introducers must be gone so the
    // sequences are inert (never an active escape) at the terminal.
    expect(frame).not.toContain("\x1b]0;") // no OSC window-title set survives
    expect(frame).not.toContain("\x1b]52;") // no OSC-52 clipboard write survives
    expect(frame).not.toContain("\x07") // no BEL terminators survive
    // The visible narrative text itself is preserved (only control bytes drop).
    expect(frame).toContain("look")
    expect(frame).toContain("here")

    act(() => {
      renderer.destroy()
    })
  })

  // A self-ticking spinner's interval outlives a concurrent-root unmount (its passive
  // cleanup is deferred), so any test that leaves a spinner ACTIVE at teardown would
  // leak an interval that ticks — un-acted — into later tests. Landing a frame first
  // unmounts the empty-state spinner within an act()ed commit, clearing its interval,
  // exactly as CharacterScreen stops its roll timer before the test ends.
  const settleSpinner: ServerFrame = { type: FrameType.System, level: "info", text: "· connected ·" }

  test("header renders cleanly: `joined <room>` + terminal dims, no CONNECTING bleed-through", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await renderGame(client)
    await flush()

    const frame = captureCharFrame()
    // The room and terminal dims read as clean, well-spaced text beside the logo...
    expect(frame).toContain("joined arkham")
    expect(frame).toContain("110x34")
    // ...and the old permanent "CONNECTING TO KEEPER…" label — which used to collide
    // with the dims/room line on the header's single inner row — is gone entirely.
    expect(frame).not.toContain("CONNECTING")

    act(() => client.push(settleSpinner))
    await flush()
    act(() => renderer.destroy())
  })

  test("empty log shows an animated placeholder, not a dead static string", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await renderGame(client)
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("等待 Keeper 叙事")
    // A spinner glyph proves it's animated (alive), not the old static placeholder.
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(true)

    act(() => client.push(settleSpinner))
    await flush()
    act(() => renderer.destroy())
  })

  test("shows the working indicator after a submit and clears it once the Keeper replies", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, captureCharFrame, mockInput } = await renderGame(client)
    await flush()

    // Submitting a turn flips kpWorking on: the trailing "构思中" spinner appears.
    await act(async () => {
      await mockInput.typeText("i listen")
      mockInput.pressEnter()
    })
    await flush()
    expect(client.sent).toContain("i listen")

    // Read the committed frame synchronously (not via a polling waitForFrame): the
    // "构思中" spinner is already active here, and a poll spanning its ~110ms tick
    // would fire an un-acted update.
    const working = captureCharFrame()
    expect(working).toContain("构思中")
    expect(SPINNER_FRAMES.some((glyph) => working.includes(glyph))).toBe(true)

    // The Keeper's (non-streaming) reply lands → the working indicator clears (ending
    // with no active spinner, so nothing leaks into the next test).
    act(() => {
      client.push({ type: FrameType.Narrative, id: "kp1", speaker: "kp", text: "A floorboard groans overhead.", format: "markdown" })
    })
    await flush()
    const replied = await waitForFrame((t) => t.includes("floorboard groans"))
    expect(replied).toContain("floorboard groans")
    expect(replied).not.toContain("构思中")

    act(() => renderer.destroy())
  })

  test("keeps the working indicator up while the reply streams, clearing on the done chunk", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame, mockInput } = await renderGame(client)
    await flush()

    await act(async () => {
      await mockInput.typeText("open the door")
      mockInput.pressEnter()
    })
    // The "构思中" spinner stays active across the whole stream, so its flushes are
    // wrapped in act(): a tick landing during a bare flush would be an un-acted update.
    await act(async () => {
      await flush()
    })
    expect(captureCharFrame()).toContain("构思中")

    // A streaming chunk that isn't `done`: the Keeper is visibly producing text, but
    // it's still in flight — the indicator must stay up.
    await act(async () => {
      client.push({ type: FrameType.Narrative, id: "s1", speaker: "kp", text: "The hinge ", format: "markdown", stream: true, done: false })
      await flush()
    })
    expect(captureCharFrame()).toContain("构思中")

    // The terminal `done` chunk clears it (ends with no active spinner).
    act(() => {
      client.push({ type: FrameType.Narrative, id: "s1", speaker: "kp", text: "shrieks.", format: "markdown", stream: true, done: true })
    })
    await flush()
    expect(captureCharFrame()).not.toContain("构思中")

    act(() => renderer.destroy())
  })
})
