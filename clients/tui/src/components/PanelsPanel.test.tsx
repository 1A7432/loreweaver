import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { PanelEntry } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { GameView } from "../GameView"
import { panelViews } from "../hooks"
import { FakeServer, liveRender, pump, waitFor, waitForScreen } from "../testkit"
import { themes } from "../themes"
import { panelSections, PanelsPanel } from "./PanelsPanel"

const destroy: Array<() => void> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const done of destroy.splice(0)) act(done)
})

const TIDE: PanelEntry = {
  id: "harbor/tide",
  title: "The tide",
  slot: "sidebar",
  kind: "template",
  views: [{ as: "tide", view: "harbor/tide" }, { as: "me", view: "me" }],
  source: { kind: "pack", id: "harbor" },
  blocks: [
    { kind: "meter", label: "Tide", value: { $view: "tide.level" }, min: 0, max: 10 },
    { kind: "text", text: "Flood warning!", style: "warning", visible_when: "tide.level >= 8" },
    { kind: "choices", prompt: "Ring the bell?", options: [{ id: "ring", label: "Ring it", command: "harbor/ring", args: { times: 2 } }] },
  ],
}
const CHART: PanelEntry = {
  id: "harbor/chart",
  title: "Sea chart",
  slot: "modal",
  kind: "page",
  views: [{ as: "tide", view: "harbor/tide" }],
  source: { kind: "pack", id: "harbor" },
  page: { hash: "a".repeat(64), size: 10, mime: "text/html" },
  fallback: [{ kind: "stat", label: "Chart level", value: { $view: "tide.level" } }],
}
const NOTES: PanelEntry = { ...CHART, id: "harbor/notes", title: "Notes", fallback: null }

describe("panel sections", () => {
  test("a template's blocks, a page's fallback, the rich-client line; an all-hidden panel is left out", () => {
    const values = new Map<string, unknown>([["harbor/tide", { level: 3 }]])
    const sections = panelSections([TIDE, CHART, NOTES], values)
    expect(sections.map((section) => [section.id, section.blocks?.map((block) => block.kind) ?? null])).toEqual([
      ["harbor/tide", ["meter", "choices"]],
      ["harbor/chart", ["stat"]],
      ["harbor/notes", null],
    ])
    const bare = { ...TIDE, blocks: [{ kind: "stat" as const, label: "L", value: { $view: "tide.none" } }] }
    expect(panelSections([bare], values)).toEqual([])
  })

  test("the views to subscribe to beyond the client's own", () => {
    expect(panelViews([TIDE, CHART])).toEqual(["harbor/tide"])
  })

  test("renders titles, blocks and the one line for a page without a fallback", async () => {
    const sections = panelSections([TIDE, NOTES], new Map([["harbor/tide", { level: 9 }]]))
    const { renderer, flush, captureCharFrame } = await testRender(<PanelsPanel sections={sections} theme={themes.lamplight} locale="en" />, { width: 60, height: 14 })
    destroy.push(() => renderer.destroy())
    await flush()
    const frame = captureCharFrame()
    expect(frame).toContain("The tide")
    expect(frame).toContain("Tide")
    expect(frame).toContain("9/10")
    expect(frame).toContain("⚠ Flood warning!")
    expect(frame).toContain("Notes")
    expect(frame).toContain("Needs a rich client (Studio)")
  })
})

describe("panels in the game view", () => {
  test("drawn from the panels view and the views they read, updated when a view changes; a choice runs its command", async () => {
    const server = new FakeServer()
    server.views.set("panels", { panels: [TIDE, CHART, NOTES] })
    server.views.set("harbor/tide", { level: 4 })
    const connection = server.connect({ mediaCacheDir: await mkdtemp(join(tmpdir(), "loreweaver-cache-")) })
    connections.push(connection)
    await connection.start()
    await waitFor("the welcome", () => connection.session.status === "online")
    const harness = await liveRender(<GameView connection={connection} locale="en" theme={themes.lamplight} themeName="lamplight" platform="linux" />, { width: 120, height: 48 })
    destroy.push(() => harness.renderer.destroy())
    const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)

    // The module view is subscribed because a panel reads it.
    await waitFor("the panel's view", () => server.current.calls("view.subscribe").some((call) => (call.params.names as string[]).includes("harbor/tide")))
    let frame = await screen("the panels", (text) => text.includes("The tide") && text.includes("4/10") && text.includes("Chart level: 4"))
    expect(frame).toContain("Needs a rich client (Studio)")
    expect(frame).not.toContain("Flood warning!")

    // A view changes: the panel follows, a gated block appears.
    server.view("harbor/tide", { level: 9 })
    frame = await screen("the update", (text) => text.includes("9/10") && text.includes("Flood warning!"))
    expect(frame).toContain("Chart level: 9")

    // Tab to the panel's choices (input -> panel), Enter runs the command as this member.
    harness.mockInput.pressTab()
    await pump()
    harness.mockInput.pressEnter()
    await waitFor("the command call", () => server.current.calls("command.run").length === 1)
    expect(server.current.calls("command.run")[0]?.params).toEqual({ id: "harbor/ring", args: { times: 2 } })

    // The panel is switched off: the view it read is dropped.
    server.view("panels", { panels: [] })
    await screen("no panels", (text) => !text.includes("The tide"))
    await waitFor("the unsubscribe", () => server.current.calls("view.unsubscribe").some((call) => (call.params.names as string[]).includes("harbor/tide")))
  })
})
