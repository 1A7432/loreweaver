import { act } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"
import type { ServerFrame, WelcomeFrame } from "@trpg-kp/protocol"
import { GameView, type GameClient } from "./GameView"

class MockClient implements GameClient {
  sendInput = vi.fn((_text: string) => {})
  private listeners = new Set<(frame: ServerFrame) => void>()

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  push(frame: ServerFrame): void {
    act(() => {
      for (const listener of this.listeners) listener(frame)
    })
  }
}

const WELCOME: WelcomeFrame = {
  type: "welcome",
  protocol: "1",
  room: "arkham",
  you: { id: "p1", name: "Ada", role: "player" },
  locale: "en",
  server: "mock",
}

function renderGame() {
  const client = new MockClient()
  const utils = render(<GameView client={client} welcome={WELCOME} />)
  return { client, ...utils }
}

describe("GameView", () => {
  test("renders KP markdown narration as styled text", () => {
    const { client } = renderGame()
    client.push({
      type: "narrative",
      id: "n1",
      speaker: "kp",
      text: "**The library exhales dust.**",
      format: "markdown",
    })
    // The ** markers are stripped; the inner text renders inside <strong>.
    const bold = screen.getByText("The library exhales dust.")
    expect(bold.tagName).toBe("STRONG")
  })

  test("renders an NPC as a distinct named line", () => {
    const { client, container } = renderGame()
    client.push({
      type: "narrative",
      id: "n2",
      speaker: "npc",
      name: "Martha",
      text: "Keep your voice down.",
      format: "plain",
    })
    const npcLine = container.querySelector(".narrative-line.npc")
    expect(npcLine).not.toBeNull()
    expect(npcLine?.textContent).toContain("Martha")
    expect(npcLine?.textContent).toContain("Keep your voice down.")
  })

  test("renders a dice frame as a rank-colored chip", () => {
    const { client, container } = renderGame()
    client.push({
      type: "dice",
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
    const chip = container.querySelector(".dice-chip.hard-success")
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain("HARD SUCCESS")
  })

  test("renders character stat bars and the party roster from a state frame", () => {
    const { client, container } = renderGame()
    client.push({
      type: "state",
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
      party: [{ name: "Bob", online: true, active: false, initiative: 12 }],
      scene: { name: "Library" },
      clock: { time: "23:10", round: 2 },
      initiative: [{ name: "Bob", value: 12, current: true }],
      online: 2,
    })

    const hpBar = container.querySelector(".stat-bar.hp")
    expect(hpBar).not.toBeNull()
    expect(hpBar?.getAttribute("aria-valuenow")).toBe("11")
    expect(screen.getByText("11/13")).toBeTruthy()
    // Party roster shows the distinct member name.
    expect(screen.getByText("Bob")).toBeTruthy()
    expect(screen.getByText("Library")).toBeTruthy()
  })

  test("submitting the command form calls sendInput", async () => {
    const { client } = renderGame()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText("Command input"), "i search")
    await user.click(screen.getByRole("button", { name: /send/i }))

    await waitFor(() => expect(client.sendInput).toHaveBeenCalledWith("i search"))
    // The input clears after submit.
    expect((screen.getByLabelText("Command input") as HTMLInputElement).value).toBe("")
  })
})
