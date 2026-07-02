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

  test("submitting a line shows it exactly once (no client-side duplicate echo)", async () => {
    // Regression: `submit()` used to append an optimistic local `{speaker:"player"}`
    // frame IN ADDITION TO the server's own `player_action` broadcast (the TUI
    // server always echoes the sender's own turn back — `echo_exclude=None`,
    // gateway/turn.py) — so every submitted line rendered twice. `submit()` must
    // now rely solely on the server's echo round-tripping back through `onMessage`.
    const client = new MockClient()
    const { renderer, flush, waitForFrame, captureCharFrame, mockInput } = await renderGame(client)
    await flush()

    await act(async () => {
      await mockInput.typeText("i search the shelf")
      mockInput.pressEnter()
    })
    await flush()
    expect(client.sent).toContain("i search the shelf")

    // Nothing rendered yet from the client itself — only once the server's echo
    // lands does the line show up at all (no optimistic local frame).
    expect(captureCharFrame()).not.toContain("i search the shelf")

    act(() => {
      client.push({
        type: FrameType.Narrative,
        id: "echo-1",
        speaker: "player",
        name: "Ada",
        text: "i search the shelf",
        format: "plain",
      })
    })
    await flush()

    const frame = await waitForFrame((text) => text.includes("i search the shelf"))
    const occurrences = frame.split("i search the shelf").length - 1
    expect(occurrences).toBe(1)

    // Settle the turn (clears `kpWorking`'s trailing spinner) before teardown so its
    // ~110ms interval can't tick — un-acted — into a later test.
    act(() => {
      client.push({ type: FrameType.Narrative, id: "kp-echo-1", speaker: "kp", text: "The shelf creaks open.", format: "markdown" })
    })
    await flush()

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

  const ADA_STATE: ServerFrame = {
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
    party: [{ name: "Ada", online: true, active: true }],
    initiative: [],
    online: 1,
  }

  describe("merged party roster", () => {
    test("renders the own character collapsed (simplified bars, no full detail)", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame } = await renderGame(client)
      await flush()

      act(() => client.push(ADA_STATE))
      await flush()

      const frame = await waitForFrame((t) => t.includes("队伍 / PARTY"))
      expect(frame).toContain("队伍 / PARTY")
      expect(frame).toContain("▸") // collapsed affordance
      expect(frame).toContain("Ada")
      expect(frame).toContain("HP")
      expect(frame).toContain("SAN")
      // The full per-attribute CharacterPanel detail (its "CHARACTER" heading) is
      // NOT embedded while collapsed — only the compact bar summary is.
      expect(frame).not.toContain("CHARACTER")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })

    test("own character expands to full CharacterPanel detail via Enter once Tab-focused, and collapses again", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame, mockInput } = await renderGame(client)
      await flush()

      act(() => client.push(ADA_STATE))
      await flush()
      await waitForFrame((t) => t.includes("▸"))

      // Tab moves focus from the chat input to the roster's own-character row;
      // Enter then toggles it (rather than submitting the — empty — chat input).
      await act(async () => {
        mockInput.pressTab()
      })
      await flush()
      await act(async () => {
        mockInput.pressEnter()
      })
      await flush()

      const expanded = await waitForFrame((t) => t.includes("▾"))
      expect(expanded).toContain("▾") // expanded affordance
      expect(expanded).toContain("CHARACTER") // the embedded full CharacterPanel
      expect(client.sent).toEqual([]) // Enter never leaked through as a chat submit

      // Enter again (still roster-focused) collapses it back.
      await act(async () => {
        mockInput.pressEnter()
      })
      await flush()
      const collapsedAgain = await waitForFrame((t) => t.includes("▸"))
      expect(collapsedAgain).not.toContain("CHARACTER")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })

    test("own character expands to full CharacterPanel detail via a mouse click, and collapses again", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame, mockMouse } = await renderGame(client)
      await flush()

      act(() => client.push(ADA_STATE))
      await flush()

      const collapsed = await waitForFrame((t) => t.includes("▸"))
      const lines = collapsed.split("\n")
      const rowY = lines.findIndex((line) => line.includes("Ada"))
      // The click X MUST be read off THIS row (not e.g. the title row above it):
      // a captured char-frame row's string index only equals its true terminal
      // column when nothing wide (CJK glyphs, which occupy two cells but one
      // string char) precedes it on THAT SAME row — the narrative log's left
      // column has "等待 Keeper 叙事…" on this row, so indices from a differently-
      // padded row would land off by however many wide glyphs preceded them there.
      const clickX = lines[rowY].indexOf("Ada")
      expect(rowY).toBeGreaterThan(0)

      await act(async () => {
        await mockMouse.click(clickX, rowY)
      })
      await flush()

      const expanded = await waitForFrame((t) => t.includes("CHARACTER"))
      expect(expanded).toContain("▾")
      expect(expanded).toContain("CHARACTER")

      // Clicking the (now expanded) row again collapses it.
      await act(async () => {
        await mockMouse.click(clickX, rowY)
      })
      await flush()
      const collapsedAgain = await waitForFrame((t) => t.includes("▸"))
      expect(collapsedAgain).not.toContain("CHARACTER")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })

    test("shows a hint and no expand affordance when the player has no character yet", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame } = await renderGame(client)
      await flush()

      act(() => {
        client.push({
          type: FrameType.State,
          party: [{ name: "Bob", online: true, active: false }],
          initiative: [],
          online: 1,
        })
      })
      await flush()

      const frame = await waitForFrame((t) => t.includes("队伍 / PARTY"))
      expect(frame).toContain("尚未创建角色")
      expect(frame).toContain("Bob")
      expect(frame).not.toContain("▸")
      expect(frame).not.toContain("▾")
      expect(frame).not.toContain("CHARACTER")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })

    test("lists other roster members with an AI badge and online/offline dots", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame } = await renderGame(client)
      await flush()

      act(() => {
        client.push({
          type: FrameType.State,
          party: [
            { name: "Silas", online: true, active: false, ai: true },
            { name: "Bob", online: false, active: false },
          ],
          initiative: [],
          online: 1,
        })
      })
      await flush()

      const frame = await waitForFrame((t) => t.includes("Silas"))
      const lines = frame.split("\n")
      const silasLine = lines.find((line) => line.includes("Silas"))
      const bobLine = lines.find((line) => line.includes("Bob"))
      expect(silasLine).toContain("[AI]")
      expect(silasLine).toContain("●")
      expect(bobLine).not.toContain("[AI]")
      expect(bobLine).toContain("○")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })

    test("renders other members with compact vitals and expands their details on click", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame, mockMouse } = await renderGame(client)
      await flush()

      act(() => {
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
          party: [
            { name: "Ada", online: true, active: true },
            {
              name: "Bob",
              online: true,
              active: false,
              hp: 4,
              hpMax: 8,
              mp: 3,
              mpMax: 6,
              san: 42,
              sanMax: 60,
            },
          ],
          initiative: [],
          online: 2,
        })
      })
      await flush()

      const collapsed = await waitForFrame((t) => t.includes("Bob") && t.includes("HP ▓▓▓░░░ 4/8"))
      expect(collapsed).toContain("▸ ● Bob")
      expect(collapsed).toContain("MP ▓▓▓░░░ 3/6")
      expect(collapsed).toContain("SAN ████░░ 42/60")

      const lines = collapsed.split("\n")
      const rowY = lines.findIndex((line) => line.includes("Bob"))
      const clickX = lines[rowY].indexOf("Bob")
      expect(rowY).toBeGreaterThan(0)

      await act(async () => {
        await mockMouse.click(clickX, rowY)
      })
      await flush()

      const expanded = await waitForFrame((t) => t.includes("▾ ● Bob") && t.includes("HP ▓▓▓▓▓░░░░░ 4/8"))
      expect(expanded).toContain("MP ▓▓▓▓▓░░░░░ 3/6")
      expect(expanded).toContain("SAN ███████░░░ 42/60")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })

    test("empty party + no character still renders gracefully", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame } = await renderGame(client)
      await flush()

      act(() => {
        client.push({ type: FrameType.State, party: [], initiative: [], online: 0 })
      })
      await flush()

      const frame = await waitForFrame((t) => t.includes("队伍 / PARTY"))
      expect(frame).toContain("尚未创建角色")
      expect(frame).toContain("No roster")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })
  })
})
