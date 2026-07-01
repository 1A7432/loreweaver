import { act } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"
import type { ServerFrame, WelcomeFrame } from "@trpg-kp/protocol"
import { AdminPanel, type AdminClient } from "./AdminPanel"

class MockAdminClient implements AdminClient {
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

const KEEPER_WELCOME: WelcomeFrame = {
  type: "welcome",
  protocol: "1.1",
  room: "arkham",
  you: { id: "k1", name: "Keeper", role: "keeper" },
  locale: "en",
  server: "mock",
}

const CONFIG: ServerFrame = {
  type: "admin_config",
  provider: "openai",
  chat_model: "gpt-4o",
  base_url: "",
  api_key_masked: "sk-1...cdef",
  providers: ["openai", "deepseek", "anthropic"],
  override_active: false,
}

describe("AdminPanel", () => {
  test("requests config + keys on mount and renders the current config", async () => {
    const client = new MockAdminClient()
    render(<AdminPanel client={client} welcome={KEEPER_WELCOME} />)

    // On mount it pulls the current config + key list.
    expect(client.adminGetConfig).toHaveBeenCalled()
    expect(client.adminListKeys).toHaveBeenCalled()

    client.push(CONFIG)
    client.push({
      type: "admin_keys",
      keys: [{ key_masked: "abcd...wxyz", room: "arkham", name: "Keeper", role: "keeper" }],
    })

    expect(await screen.findByText("gpt-4o")).toBeTruthy()
    expect(screen.getByText("sk-1...cdef")).toBeTruthy()
    // masked key from the list is shown
    expect(screen.getByText(/abcd\.\.\.wxyz/)).toBeTruthy()
  })

  test("submitting the model form sends admin_set_model with the chosen values", async () => {
    const client = new MockAdminClient()
    const user = userEvent.setup()
    render(<AdminPanel client={client} welcome={KEEPER_WELCOME} />)
    client.push(CONFIG)

    // Switch provider + type a chat model, then save.
    await user.selectOptions(screen.getByLabelText("Provider"), "deepseek")
    const modelInput = screen.getByLabelText("Chat model")
    await user.clear(modelInput)
    await user.type(modelInput, "deepseek-chat")
    await user.click(screen.getByRole("button", { name: /save model/i }))

    expect(client.adminSetModel).toHaveBeenCalledWith("deepseek", "deepseek-chat")
  })

  test("minting a key sends admin_mint_key and reveals the cleartext key once", async () => {
    const client = new MockAdminClient()
    const user = userEvent.setup()
    render(<AdminPanel client={client} welcome={KEEPER_WELCOME} />)
    client.push(CONFIG)

    await user.type(screen.getByLabelText("Room"), "dunwich")
    await user.type(screen.getByLabelText("Key name"), "Ada")
    await user.selectOptions(screen.getByLabelText("Role"), "keeper")
    await user.click(screen.getByRole("button", { name: /mint key/i }))

    expect(client.adminMintKey).toHaveBeenCalledWith("dunwich", "Ada", "keeper")

    // The server echoes the fresh key once, in cleartext.
    client.push({
      type: "admin_keys",
      keys: [{ key_masked: "dddd...eeee", room: "dunwich", name: "Ada", role: "keeper" }],
      minted: { key: "the-full-secret-key", room: "dunwich", name: "Ada", role: "keeper" },
    })
    expect(await screen.findByText("the-full-secret-key")).toBeTruthy()
  })

  test("an admin_error frame is surfaced inline", async () => {
    const client = new MockAdminClient()
    render(<AdminPanel client={client} welcome={KEEPER_WELCOME} />)

    client.push({ type: "admin_error", code: "forbidden", message: "Admin actions require a keeper key." })

    await waitFor(() =>
      expect(screen.getByText("Admin actions require a keeper key.")).toBeTruthy(),
    )
  })
})
