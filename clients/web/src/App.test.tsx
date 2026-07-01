import { act } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"
import type { ServerFrame, WelcomeFrame } from "@trpg-kp/protocol"
import App, { type AppClient } from "./App"

class MockClient implements AppClient {
  connect = vi.fn((_url: string) => Promise.resolve())
  join = vi.fn((_key: string, _name?: string) => {})
  sendInput = vi.fn((_text: string) => {})
  adminGetConfig = vi.fn(() => {})
  adminSetModel = vi.fn((_provider: string, _chatModel?: string) => {})
  adminListKeys = vi.fn(() => {})
  adminMintKey = vi.fn((_room: string, _name?: string, _role?: string) => {})
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

describe("App connect screen", () => {
  test("submitting the form connects + joins, then welcome shows GameView", async () => {
    const client = new MockClient()
    const user = userEvent.setup()
    render(<App client={client} />)

    await user.type(screen.getByLabelText("Deployer key"), "sekret")
    await user.type(screen.getByLabelText("Display name"), "Ada")
    await user.click(screen.getByRole("button", { name: /connect/i }))

    // connect() is awaited before join(); the default url is pre-filled.
    await waitFor(() => expect(client.connect).toHaveBeenCalledWith("ws://127.0.0.1:8787/"))
    await waitFor(() => expect(client.join).toHaveBeenCalledWith("sekret", "Ada"))

    // Still on the connect screen until the server welcomes us.
    expect(screen.queryByText(/joined arkham/i)).toBeNull()

    client.push(WELCOME)

    // GameView is now mounted: the room name appears in the header.
    expect(await screen.findByText(/joined arkham/i)).toBeTruthy()
    expect(screen.getByLabelText("Command input")).toBeTruthy()
  })

  test("admin mode routes to the admin panel after welcome", async () => {
    const client = new MockClient()
    const user = userEvent.setup()
    render(<App client={client} admin />)

    await user.type(screen.getByLabelText("Deployer key"), "keeper-key")
    await user.click(screen.getByRole("button", { name: /connect/i }))
    await waitFor(() => expect(client.connect).toHaveBeenCalled())

    client.push({
      type: "welcome",
      protocol: "1.1",
      room: "arkham",
      you: { id: "k1", name: "Keeper", role: "keeper" },
      locale: "en",
      server: "mock",
    })

    // The admin panel mounted (not the game command bar), and it pulled config.
    expect(await screen.findByText("LLM CONFIG")).toBeTruthy()
    expect(screen.queryByLabelText("Command input")).toBeNull()
    expect(client.adminGetConfig).toHaveBeenCalled()
  })

  test("a bad_key error frame is surfaced on the connect screen", async () => {
    const client = new MockClient()
    const user = userEvent.setup()
    render(<App client={client} />)

    await user.type(screen.getByLabelText("Deployer key"), "nope")
    await user.click(screen.getByRole("button", { name: /connect/i }))
    await waitFor(() => expect(client.connect).toHaveBeenCalled())

    client.push({ type: "error", code: "bad_key", message: "Unknown key" })

    expect(await screen.findByText("Unknown key")).toBeTruthy()
    // Did not navigate to the game view.
    expect(screen.queryByLabelText("Command input")).toBeNull()
  })
})
