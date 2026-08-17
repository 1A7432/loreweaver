import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { FrameType, PROTOCOL_VERSION, type MediaFrame, type MediaPayload, type MediaUpload, type ServerFrame, type WelcomeFrame } from "loreweaver-protocol"
import { appendFrame, GameView, type GameClient, type GameViewProps } from "./GameView"
import { SPINNER_FRAMES } from "./components/Spinner"
import { themes } from "./themes"

class MockClient implements GameClient {
  sent: string[] = []
  uploads: MediaUpload[] = []
  packCardRequests = 0
  private listeners = new Set<(frame: ServerFrame) => void>()

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  sendInput(text: string): void {
    this.sent.push(text)
  }

  uploadMedia(upload: MediaUpload): Promise<MediaFrame | undefined> {
    this.uploads.push(upload)
    return Promise.resolve(undefined)
  }

  getMedia(hash: string): Promise<MediaPayload> {
    return Promise.resolve({ hash, mime: "image/png", name: "cached.png", bytes: new Uint8Array([1, 2, 3]) })
  }

  listPackCards(): void {
    this.packCardRequests += 1
  }

  push(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame)
  }
}

const WELCOME: WelcomeFrame = {
  type: FrameType.Welcome,
  protocol: PROTOCOL_VERSION,
  room: "arkham",
  you: { id: "p1", name: "Ada", role: "player" },
  locale: "en",
  server: "mock",
}

function renderGame(client: MockClient, width = 110, height = 34, props: Partial<GameViewProps> = {}) {
  return testRender(<GameView client={client} welcome={WELCOME} theme={themes.lamplight} themeName="lamplight" {...props} />, {
    width,
    height,
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
        outcome: { id: "hard", label: "HARD SUCCESS", success: true, critical: false, fumble: false, tier: 3 },
      })
      client.push({
        type: FrameType.State,
        character: {
          name: "Ada",
          system: "coc7",
          resources: [
            { id: "hp", label: "HP", value: 11, max: 13 },
            { id: "san", label: "SAN", value: 55, max: 70 },
            { id: "mp", label: "MP", value: 8, max: 10 },
          ],
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

  test("a reset-flagged state frame clears the accumulated chat log", async () => {
    // Regression: after a campaign reset the server wipes chat_history, but the
    // client's local scrollback is not replayed away — the reset-flagged state
    // frame is what tells it to drop the stale log alongside refreshing the panel.
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderGame(client)
    await flush()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    await flush()

    act(() => {
      client.push({
        type: FrameType.Narrative,
        id: "old1",
        speaker: "kp",
        text: "The old campaign's dust settles.",
        format: "markdown",
      })
    })
    await waitForFrame((text) => text.includes("old campaign's dust settles"))

    // A plain state frame refreshes the panel but must NOT touch the log.
    act(() => {
      client.push({ type: FrameType.State, party: [], initiative: [], online: 1 })
    })
    const afterPlain = await waitForFrame((text) => text.includes("old campaign's dust settles"))
    expect(afterPlain).toContain("old campaign's dust settles")

    // The reset-flagged state frame clears the log.
    act(() => {
      client.push({ type: FrameType.State, party: [], initiative: [], online: 1, reset: true })
    })
    const afterReset = await waitForFrame((text) => !text.includes("old campaign's dust settles"))
    expect(afterReset).not.toContain("old campaign's dust settles")

    act(() => {
      renderer.destroy()
    })
  })

  test("header and status bar share one merged online count, last frame wins", async () => {
    // Regression (TUI-PRESENCE-018): the header used to read `stateFrame.online`
    // while the status bar preferred the newer PresenceFrame, so after a
    // disconnect the top said "2 online" and the bottom "1 online" indefinitely.
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderGame(client)
    await flush()

    const counts = (text: string, needle: string) => text.split(needle).length - 1

    act(() => {
      client.push({ type: FrameType.State, party: [], initiative: [], online: 2 })
    })
    await waitForFrame((text) => counts(text, "2 online") === 2)

    // A later presence frame (a disconnect) must update BOTH surfaces.
    act(() => {
      client.push({ type: FrameType.Presence, players: [], online: 1 })
    })
    const afterPresence = await waitForFrame((text) => counts(text, "1 online") === 2)
    expect(counts(afterPresence, "2 online")).toBe(0)

    // And a later state frame wins right back (last writer, either source).
    act(() => {
      client.push({ type: FrameType.State, party: [], initiative: [], online: 3 })
    })
    await waitForFrame((text) => counts(text, "3 online") === 2)

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

  test("/attach reads a local file and uploads it through the media channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-attach-"))
    const path = join(dir, "handout.png")
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const client = new MockClient()
    const { renderer, flush, waitFor, mockInput } = await renderGame(client)
    await flush()

    await act(async () => {
      await mockInput.typeText(`/attach ${path}`)
      mockInput.pressEnter()
    })
    await waitFor(() => client.uploads.length > 0)

    expect(client.sent).toEqual([])
    expect(client.uploads[0].name).toBe("handout.png")
    expect(client.uploads[0].mime).toBe("image/png")
    expect(client.uploads[0].bytes.byteLength).toBe(7)

    act(() => renderer.destroy())
  })

  test("a dropped image path submits as an image upload instead of chat input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-drop-"))
    const path = join(dir, "clue.png")
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5]))
    const client = new MockClient()
    const { renderer, flush, waitFor, mockInput } = await renderGame(client)
    await flush()

    await act(async () => {
      await mockInput.typeText(pathToFileURL(path).toString())
      mockInput.pressEnter()
    })
    await waitFor(() => client.uploads.length > 0)

    expect(client.sent).toEqual([])
    expect(client.uploads[0].name).toBe("clue.png")
    expect(client.uploads[0].mime).toBe("image/png")

    act(() => renderer.destroy())
  })

  test("/audio reads a local file and uploads it through the media channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-audio-"))
    const path = join(dir, "theme.mp3")
    await writeFile(path, new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]))
    const client = new MockClient()
    const { renderer, flush, waitFor, mockInput } = await renderGame(client)
    await flush()

    await act(async () => {
      await mockInput.typeText(`/audio ${path}`)
      mockInput.pressEnter()
    })
    await waitFor(() => client.uploads.length > 0)

    expect(client.sent).toEqual([])
    expect(client.uploads[0].name).toBe("theme.mp3")
    expect(client.uploads[0].mime).toBe("audio/mpeg")

    act(() => renderer.destroy())
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
  // exactly as CharacterScreen stops its roll timer before the test ends. (The idle
  // empty-log placeholder is now static/non-animated — see below — so this is only
  // load-bearing for tests that actually drive `kpWorking` true; it's kept as a
  // harmless no-op teardown step elsewhere for consistency.)
  const settleSpinner: ServerFrame = { type: FrameType.System, level: "info", text: "· connected ·" }

  test("header renders cleanly: `joined <room>` + online count, no dims, no CONNECTING bleed-through", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await renderGame(client)
    await flush()

    const frame = captureCharFrame()
    // The room reads as clean, well-spaced text beside the logo...
    expect(frame).toContain("joined arkham")
    // ...the meaningless terminal-dimensions readout ("110x34") is gone entirely...
    expect(frame).not.toMatch(/\d+x\d+/)
    // ...and the old permanent "CONNECTING TO KEEPER…" label — which used to collide
    // with the dims/room line on the header's single inner row — is gone entirely.
    expect(frame).not.toContain("CONNECTING")

    act(() => client.push(settleSpinner))
    await flush()
    act(() => renderer.destroy())
  })

  test("header shows the online count once state arrives", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderGame(client)
    await flush()

    act(() => {
      client.push({ type: FrameType.State, party: [], initiative: [], online: 2 })
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("2 online"))
    expect(frame).toContain("joined arkham")
    expect(frame).toContain("2 online")
    expect(frame).not.toMatch(/\d+x\d+/)

    act(() => client.push(settleSpinner))
    await flush()
    act(() => renderer.destroy())
  })

  test("header renders a usage statusline (a `%`) once a state frame carries usage", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderGame(client)
    await flush()

    act(() => {
      client.push({
        type: FrameType.State,
        party: [],
        initiative: [],
        online: 1,
        usage: {
          context_tokens: 20000,
          context_window: 128000,
          input_tokens: 5000,
          output_tokens: 900,
          cache_hit_tokens: 3000,
          cache_miss_tokens: 1000,
        },
      })
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("%"))
    expect(frame).toContain("%")
    expect(frame).toContain("joined arkham")

    act(() => client.push(settleSpinner))
    await flush()
    act(() => renderer.destroy())
  })

  test("idle empty log shows a static ready hint, not an animated spinner", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await renderGame(client)
    await flush()

    // Fresh/idle join, nothing in flight (`kpWorking` is false): the placeholder
    // must be a calm, static hint — no spinner glyph — so it can never look like a
    // frozen/hung "spinning forever" state.
    const frame = captureCharFrame()
    expect(frame).toContain("Ready")
    expect(SPINNER_FRAMES.some((glyph) => frame.includes(glyph))).toBe(false)

    // Give the interval a tick's worth of real time; the hint must stay static
    // (no interval was ever started for it).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    await flush()
    const later = captureCharFrame()
    expect(later).toContain("Ready")
    expect(SPINNER_FRAMES.some((glyph) => later.includes(glyph))).toBe(false)

    act(() => renderer.destroy())
  })

  test("submitting into a still-empty log shows the animated working placeholder, not the static hint", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame, mockInput } = await renderGame(client)
    await flush()

    // Submit flips `kpWorking` true; the server's echo hasn't round-tripped yet, so
    // `frames` is still empty here — the empty-state placeholder must switch to the
    // animated "Keeper thinking" spinner, not stay on the idle static hint.
    await act(async () => {
      await mockInput.typeText("look around")
      mockInput.pressEnter()
    })
    await flush()

    const working = captureCharFrame()
    expect(working).toContain("Keeper thinking")
    expect(working).not.toContain("Ready")
    expect(SPINNER_FRAMES.some((glyph) => working.includes(glyph))).toBe(true)

    // Settle so the interval doesn't leak into a later test.
    act(() => {
      client.push({ type: FrameType.Narrative, id: "kp-empty-1", speaker: "kp", text: "Nothing stirs.", format: "markdown" })
    })
    await flush()
    act(() => renderer.destroy())
  })

  test("shows the working indicator after a submit and clears it once the Keeper replies", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, captureCharFrame, mockInput } = await renderGame(client)
    await flush()

    // Submitting a turn flips kpWorking on: the trailing "Keeper thinking" spinner appears.
    await act(async () => {
      await mockInput.typeText("i listen")
      mockInput.pressEnter()
    })
    await flush()
    expect(client.sent).toContain("i listen")

    // Read the committed frame synchronously (not via a polling waitForFrame): the
    // "Keeper thinking" spinner is already active here, and a poll spanning its ~110ms tick
    // would fire an un-acted update.
    const working = captureCharFrame()
    expect(working).toContain("Keeper thinking")
    expect(SPINNER_FRAMES.some((glyph) => working.includes(glyph))).toBe(true)

    // The Keeper's (non-streaming) reply lands → the working indicator clears (ending
    // with no active spinner, so nothing leaks into the next test).
    act(() => {
      client.push({ type: FrameType.Narrative, id: "kp1", speaker: "kp", text: "A floorboard groans overhead.", format: "markdown" })
    })
    await flush()
    const replied = await waitForFrame((t) => t.includes("floorboard groans"))
    expect(replied).toContain("floorboard groans")
    expect(replied).not.toContain("Keeper thinking")

    act(() => renderer.destroy())
  })

  test("a system-authored command reply clears the submit spinner", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame, mockInput } = await renderGame(client)
    await flush()

    await act(async () => {
      await mockInput.typeText(".report detailed")
      mockInput.pressEnter()
    })
    await flush()
    expect(captureCharFrame()).toContain("Keeper thinking")

    act(() => {
      client.push({
        type: FrameType.Narrative,
        id: "report-result",
        speaker: "system",
        text: "Report saved.",
        format: "plain",
      })
    })
    await flush()
    expect(captureCharFrame()).toContain("Report saved.")
    expect(captureCharFrame()).not.toContain("Keeper thinking")

    act(() => renderer.destroy())
  })

  test("a state-only command or muted Keeper turn clears the submit spinner", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame, mockInput } = await renderGame(client)
    await flush()

    await act(async () => {
      await mockInput.typeText(".panel")
      mockInput.pressEnter()
    })
    await flush()
    expect(captureCharFrame()).toContain("Keeper thinking")

    act(() => client.push({ type: FrameType.State, party: [], initiative: [], online: 1 }))
    await flush()
    expect(captureCharFrame()).not.toContain("Keeper thinking")

    act(() => renderer.destroy())
  })

  test("room-wide busy status animates for other participants and idle clears it", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await renderGame(client)
    await flush()

    act(() => client.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" }))
    await flush()
    const busy = captureCharFrame()
    expect(busy).toContain("Keeper resolving Nora")
    expect(SPINNER_FRAMES.some((glyph) => busy.includes(glyph))).toBe(true)

    act(() => client.push({ type: FrameType.TurnStatus, status: "idle" }))
    await flush()
    expect(captureCharFrame()).not.toContain("Keeper resolving Nora")
    expect(SPINNER_FRAMES.some((glyph) => captureCharFrame().includes(glyph))).toBe(false)

    act(() => renderer.destroy())
  })

  test("room-wide busy status has a safety timeout", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await renderGame(client, 110, 34, { busyTimeoutMs: 1_000 })
    await flush()

    act(() => client.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" }))
    await flush()
    expect(captureCharFrame()).toContain("Keeper resolving Nora")

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050))
    })
    await flush()
    expect(captureCharFrame()).not.toContain("Keeper resolving Nora")
    expect(SPINNER_FRAMES.some((glyph) => captureCharFrame().includes(glyph))).toBe(false)

    act(() => renderer.destroy())
  })

  test("chat input exposes the 4000-character boundary and refuses to submit at the cap", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame, mockInput } = await renderGame(client, 80, 24)
    await flush()

    await act(async () => {
      await mockInput.pasteBracketedText("x".repeat(4_500))
    })
    await flush()
    const capped = captureCharFrame()
    expect(capped).toContain("4000/4000")
    expect(capped).toContain("Shorten it before sending")
    expect(capped.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    await act(async () => mockInput.pressEnter())
    await flush()
    expect(client.sent).toEqual([])

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
    // The "Keeper thinking" spinner stays active across the whole stream, so its flushes are
    // wrapped in act(): a tick landing during a bare flush would be an un-acted update.
    await act(async () => {
      await flush()
    })
    expect(captureCharFrame()).toContain("Keeper thinking")

    // A streaming chunk that isn't `done`: the Keeper is visibly producing text, but
    // it's still in flight — the indicator must stay up.
    await act(async () => {
      client.push({ type: FrameType.NarrativeDelta, id: "s1", speaker: "kp", text: "The hinge " })
      await flush()
    })
    expect(captureCharFrame()).toContain("Keeper thinking")

    // The terminal `done` chunk clears it (ends with no active spinner).
    act(() => {
      client.push({ type: FrameType.Narrative, id: "s1", speaker: "kp", text: "The hinge shrieks.", format: "markdown" })
    })
    await flush()
    expect(captureCharFrame()).not.toContain("Keeper thinking")

    act(() => renderer.destroy())
  })

  const ADA_STATE: ServerFrame = {
    type: FrameType.State,
    character: {
      name: "Ada",
      system: "coc7",
      resources: [
        { id: "hp", label: "HP", value: 11, max: 13 },
        { id: "san", label: "SAN", value: 55, max: 70 },
        { id: "mp", label: "MP", value: 8, max: 10 },
      ],
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

      const frame = await waitForFrame((t) => t.includes("Party / PARTY"))
      expect(frame).toContain("Party / PARTY")
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

    test("a characterless player Tab-focuses the roster and Enter claims the first unclaimed pregen", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame, mockInput } = await renderGame(client)
      await flush()

      act(() =>
        client.push({
          type: FrameType.State,
          party: [],
          initiative: [],
          online: 1,
          pregens: [
            { name: "Mary", claimed_by: "p9" },
            { name: "Harvey", claimed_by: "" },
          ],
        }),
      )
      await flush()

      const frame = await waitForFrame((t) => t.includes("PREGENS"))
      expect(frame).toContain("▸ Harvey")
      expect(frame).toContain("✓ Mary")
      expect(frame).toContain("claimed by p9")

      // Without an own character the roster used to be skipped by Tab entirely;
      // an unclaimed pregen makes it a stop, and Enter claims rather than
      // submitting the (empty) chat input.
      await act(async () => {
        mockInput.pressTab()
      })
      await flush()
      await act(async () => {
        mockInput.pressEnter()
      })
      await flush()
      expect(client.sent).toEqual([".pc claim Harvey"])

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
      // column has the ready hint on this row, so indices from a
      // differently-padded row would land off by however many wide glyphs preceded
      // them there.
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

      const frame = await waitForFrame((t) => t.includes("Party / PARTY"))
      expect(frame).toContain("No character yet")
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
            resources: [
              { id: "hp", label: "HP", value: 11, max: 13 },
              { id: "san", label: "SAN", value: 55, max: 70 },
              { id: "mp", label: "MP", value: 8, max: 10 },
            ],
            attributes: { str: 45, dex: 60 },
            status_effects: [],
          },
          party: [
            { name: "Ada", online: true, active: true },
            {
              name: "Bob",
              online: true,
              active: false,
              resources: [
                { id: "hp", label: "HP", value: 4, max: 8 },
                { id: "mp", label: "MP", value: 3, max: 6 },
                { id: "san", label: "SAN", value: 42, max: 60 },
              ],
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

    test("empty party + no character shows one clear empty message, not two stacked", async () => {
      const client = new MockClient()
      const { renderer, flush, waitForFrame } = await renderGame(client)
      await flush()

      act(() => {
        client.push({ type: FrameType.State, party: [], initiative: [], online: 0 })
      })
      await flush()

      const frame = await waitForFrame((t) => t.includes("Party / PARTY"))
      // Regression: this used to render BOTH "No character yet" AND "No roster" — a
      // confusing double empty-state. Now it's a single, clearer line.
      expect(frame).toContain("Party empty")
      expect(frame).not.toContain("No character yet")
      expect(frame).not.toContain("No roster")

      // Settle the log's empty-state spinner before teardown so its ~110ms
      // interval can't tick — un-acted — into a later test (same discipline the
      // outer describe's own tests already follow via `settleSpinner`).
      act(() => client.push(settleSpinner))
      await flush()
      act(() => renderer.destroy())
    })
  })

  test("a state frame with module variables renders the TRACKERS sidebar panel; a later frame without them hides it", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, captureCharFrame } = await renderGame(client)
    await flush()

    // No variables yet (fresh room): the panel is absent entirely, not an empty box.
    expect(captureCharFrame()).not.toContain("TRACKERS")

    act(() => {
      client.push({
        type: FrameType.State,
        party: [],
        initiative: [],
        online: 1,
        variables: [
          { id: "suspicion", label: "Suspicion", kind: "number", value: 3, min: 0, max: 10 },
          { id: "alarm", label: "Alarm", kind: "bool", value: false },
          { id: "phase", label: "Phase", kind: "enum", value: "night" },
        ],
      })
    })
    await flush()

    const frame = await waitForFrame((t) => t.includes("TRACKERS"))
    expect(frame).toContain("Suspicion ▒▒░░░░ 3/10") // bounded: CharacterPanel-style bar
    expect(frame).toContain("Alarm ✗ no") // bool: cross + localized no
    expect(frame).toContain("Phase: night") // enum: label: value one-liner

    // A later state frame WITHOUT the field (server dropped every player-visible
    // variable) removes the whole panel again.
    act(() => client.push({ type: FrameType.State, party: [], initiative: [], online: 1 }))
    const gone = await waitForFrame((t) => !t.includes("TRACKERS"))
    expect(gone).not.toContain("Suspicion")

    act(() => client.push(settleSpinner))
    await flush()
    act(() => renderer.destroy())
  })

  test("connectionStatus prop threads through to the HeaderBar's compact indicator", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await testRender(
      <GameView client={client} welcome={WELCOME} theme={themes.lamplight} themeName="lamplight" connectionStatus="reconnecting" />,
      { width: 110, height: 34 },
    )
    await flush()

    // Single-width dot (color carries the state) + the label, since no online count has
    // claimed the shared liveness line yet in this fresh view.
    const frame = captureCharFrame()
    expect(frame).toContain("●")
    expect(frame).toContain("reconnecting")

    act(() => renderer.destroy())
  })

  test("80 columns collapses PARTY/SCENE by default and F6 toggles a bounded INIT panel", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame, waitForFrame, mockInput } = await renderGame(client, 80, 24)
    await flush()

    act(() => {
      client.push({
        type: FrameType.State,
        character: {
          name: "Ada Investigator With A Deliberately Long Name",
          system: "coc7",
          resources: [
            { id: "hp", label: "HP", value: 11, max: 13 },
            { id: "san", label: "SAN", value: 55, max: 70 },
            { id: "mp", label: "MP", value: 8, max: 10 },
          ],
          attributes: { STR: 45, DEX: 60 },
          status_effects: [],
        },
        party: Array.from({ length: 8 }, (_, index) => ({
          name: index === 0 ? "Ada Investigator With A Deliberately Long Name" : `Dense Combatant ${index}`,
          online: true,
          active: index === 0,
          resources: [
            { id: "hp", label: "HP", value: 8 + index, max: 12 + index },
            { id: "mp", label: "MP", value: 5, max: 10 },
            { id: "san", label: "SAN", value: 50, max: 60 },
          ],
        })),
        scene: { name: "The Extremely Long Library Scene", focus: "search" },
        clock: { time: "23:10", round: 2 },
        initiative: Array.from({ length: 8 }, (_, index) => ({
          name: index === 0 ? "Ada Investigator With A Deliberately Long Name" : `Dense Combatant ${index}`,
          value: 20 - index,
          current: index === 0,
        })),
        online: 2,
      })
    })
    await flush()

    const collapsed = captureCharFrame()
    expect(collapsed).toContain("joined arkham")
    expect(collapsed).toContain("2 online")
    expect(collapsed).toContain("F6 PARTY")
    expect(collapsed).not.toContain("Party / PARTY")
    expect(collapsed.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)

    await act(async () => mockInput.pressKey("F6"))
    await flush()
    const expanded = await waitForFrame((text) => text.includes("Party / PARTY") && text.includes("INIT"))
    expect(expanded).toContain("ROUND 2")
    expect(expanded).toContain("F6 HIDE")
    expect(expanded.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)
    expect(expanded).not.toContain("SAN██████░850/60g Name")
    expect(expanded).not.toContain("ROUND─22:00")

    act(() => renderer.destroy())
  })
})

// Ctrl+S saves the whole log to a file: the counterpart to the Ctrl+C selection copy,
// and the only route to lines that already scrolled out of the viewport.
describe("Ctrl+S transcript export", () => {
  test("writes the log to a file and reports the path in the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-export-"))
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderGame(client, 110, 34, { transcriptDir: dir })
    await flush()

    act(() => {
      client.push({ type: FrameType.Narrative, id: "n1", speaker: "kp", text: "The stairwell breathes.", format: "markdown" })
      client.push({
        type: FrameType.Dice,
        actor: "Ada",
        kind: "check",
        expr: "1d100",
        rolls: [12],
        total: 12,
        target: 65,
        outcome: { id: "hard", label: "HARD SUCCESS", success: true, critical: false, fumble: false, tier: 3 },
      })
    })
    await flush()

    await act(async () => mockInput.pressKey("s", { ctrl: true }))
    const frame = await waitForFrame((text) => text.includes("Session log saved to"))
    expect(frame).toContain("Session log saved to")

    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^arkham-\d{8}-\d{6}\.txt$/)
    const body = await readFile(join(dir, files[0]), "utf8")
    expect(body).toContain("# room: arkham")
    expect(body).toContain("KP: The stairwell breathes.")
    expect(body).toContain("Ada 1d100 12 vs 65 -> HARD SUCCESS")

    act(() => renderer.destroy())
  })

  test("an empty log says so instead of writing a header-only file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-export-empty-"))
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderGame(client, 110, 34, { transcriptDir: dir })
    await flush()

    await act(async () => mockInput.pressKey("s", { ctrl: true }))
    const frame = await waitForFrame((text) => text.includes("Nothing to save yet"))
    expect(frame).toContain("Nothing to save yet")
    expect(await readdir(dir)).toEqual([])

    act(() => renderer.destroy())
  })
})

describe("copy affordances", () => {
  test("a copy confirmation from the shell is surfaced as its own line", async () => {
    const client = new MockClient()
    const { renderer, flush, captureCharFrame } = await renderGame(client, 110, 34, {
      copyNotice: "Copied 42 characters to the clipboard",
    })
    await flush()
    expect(captureCharFrame()).toContain("Copied 42 characters to the clipboard")
    act(() => renderer.destroy())
  })

  test("the help line names the copy gesture the platform actually supports", async () => {
    const client = new MockClient()
    const linux = await renderGame(client, 110, 34, { platform: "linux" })
    await linux.flush()
    await act(async () => linux.mockInput.pressKey("?"))
    const linuxHelp = await linux.waitForFrame((text) => text.includes("Ctrl+C"))
    // Every hint must be fully on screen: the one-line version used to run off the
    // terminal edge and hide the copy/save keys entirely.
    expect(linuxHelp).toContain("Ctrl+S save log")
    expect(linuxHelp).toContain("Ctrl+L clear")
    expect(linuxHelp).toContain("drag to select, Ctrl+C to copy")
    expect(linuxHelp).not.toContain("Cmd+C")
    act(() => linux.renderer.destroy())

    const mac = await renderGame(new MockClient(), 110, 34, { platform: "darwin" })
    await mac.flush()
    await act(async () => mac.mockInput.pressKey("?"))
    const macHelp = await mac.waitForFrame((text) => text.includes("Cmd+C"))
    expect(macHelp).toContain("Option")
    act(() => mac.renderer.destroy())
  })
})

describe("declarative ui frames (v1.7)", () => {
  test("inline blocks join the log and sidebar regions render, latest per id winning", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame } = await renderGame(client)
    await flush()

    act(() => {
      client.push({
        type: FrameType.Ui,
        panel: "inline",
        blocks: [
          { kind: "badge", label: "Chapter 2", tone: "warn" },
          { kind: "meter", label: "Fear", value: 3, min: 0, max: 10 },
          { kind: "text", text: "The bells toll.", style: "quote" },
        ],
      })
      client.push({
        type: FrameType.Ui,
        panel: "sidebar",
        id: "hud",
        blocks: [{ kind: "stat", label: "Doom", value: "rising" }],
      })
      client.push({
        type: FrameType.Ui,
        panel: "sidebar",
        id: "hud",
        replace: true,
        blocks: [{ kind: "stat", label: "Doom", value: "peaking" }],
      })
    })

    const frame = await waitForFrame((text) => text.includes("[Chapter 2]") && text.includes("MODULE PANEL"))
    expect(frame).toContain("[Chapter 2]")
    expect(frame).toContain("Fear")
    expect(frame).toContain("3/10")
    expect(frame).toContain("The bells toll.")
    // The same-id sidebar region was replaced, never stacked.
    expect(frame).toContain("Doom: peaking")
    expect(frame).not.toContain("Doom: rising")
    act(() => renderer.destroy())
  })

  test("Tab focuses the latest choices select and Enter submits the option's input", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, mockInput } = await renderGame(client)
    await flush()

    act(() => {
      client.push({
        type: FrameType.Ui,
        panel: "inline",
        blocks: [
          {
            kind: "choices",
            prompt: "What do you do?",
            options: [
              { id: "listen", label: "Listen at the door", input: ".ra listen" },
              { id: "open", label: "Open it", input: "I open the door" },
            ],
          },
        ],
      })
    })

    const frame = await waitForFrame((text) => text.includes("What do you do?"))
    expect(frame).toContain("Listen at the door")
    expect(frame).toContain("Tab: focus")

    await act(async () => mockInput.pressTab())
    await act(async () => mockInput.pressArrow("down"))
    await act(async () => mockInput.pressEnter())
    await flush()

    expect(client.sent).toEqual(["I open the door"])
    act(() => renderer.destroy())
  })
})

describe("pack-card import picker (v2.2)", () => {
  test("requests the installed-pack card list exactly once on mount", async () => {
    const client = new MockClient()
    const { renderer, flush } = await renderGame(client)
    await flush()

    // Let the boot-sequence timers settle too: the request must not repeat.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    await flush()
    expect(client.packCardRequests).toBe(1)

    act(() => renderer.destroy())
  })

  test("a pack_cards frame renders the sidebar section; an empty one renders nothing", async () => {
    const client = new MockClient()
    const { renderer, flush, waitForFrame, captureCharFrame } = await renderGame(client)
    await flush()

    expect(captureCharFrame()).not.toContain("PACK CARDS")

    act(() => {
      client.push({
        type: FrameType.PackCards,
        cards: [
          { ref: "harbour/cards/pilot.json", pack: "harbour", name: "pilot" },
          { ref: "harbour/cards/medic.png", pack: "harbour", name: "medic" },
        ],
      })
    })
    const frame = await waitForFrame((text) => text.includes("PACK CARDS"))
    expect(frame).toContain("▸ pilot · harbour")
    expect(frame).toContain("▸ medic · harbour")

    // A later empty listing (packs uninstalled) removes the whole section again.
    act(() => {
      client.push({ type: FrameType.PackCards, cards: [] })
    })
    const gone = await waitForFrame((text) => !text.includes("PACK CARDS"))
    expect(gone).not.toContain("pilot")

    act(() => renderer.destroy())
  })
})

describe("appendFrame streaming-narrative semantics", () => {
  const draft = {
    type: FrameType.Narrative,
    id: "s1",
    speaker: "kp",
    text: "雨声",
    format: "markdown",
    draft: true,
  } as const

  test("delta frames sharing an id concatenate into the draft bubble", () => {
    const log = appendFrame([draft], {
      type: FrameType.NarrativeDelta,
      id: "s1",
      speaker: "kp",
      text: "落在窗台。",
    })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ id: "s1", text: "雨声落在窗台。", draft: true })
  })

  test("the closing narrative replaces the draft with the full final text", () => {
    const log = appendFrame([draft], {
      type: FrameType.Narrative,
      id: "s1",
      speaker: "kp",
      text: "雨声落在窗台。（修正后）",
      format: "markdown",
    })
    expect(log).toHaveLength(1)
    // draft === false marks the finished stream (the styled-render path).
    expect(log[0]).toMatchObject({ id: "s1", text: "雨声落在窗台。（修正后）", draft: false })
  })

  test("an empty closing narrative drops an abandoned tool-round draft", () => {
    const log = appendFrame([draft], {
      type: FrameType.Narrative,
      id: "s1",
      speaker: "kp",
      text: "",
      format: "markdown",
    })
    expect(log).toHaveLength(0)
  })

  test("a kp reply with a different id leaves an open draft alone (the server closes every draft it opened)", () => {
    const log = appendFrame([draft], {
      type: FrameType.Narrative,
      id: "n2",
      speaker: "kp",
      text: "另一条完整回复。",
      format: "markdown",
    })
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ id: "s1", draft: true })
    expect(log[1]).toMatchObject({ id: "n2", text: "另一条完整回复。" })
  })

  test("a player line never disturbs an open kp draft", () => {
    const log = appendFrame([draft], {
      type: FrameType.Narrative,
      id: "p1",
      speaker: "player",
      text: "我继续听。",
      format: "plain",
    })
    expect(log).toHaveLength(2)
  })
})
