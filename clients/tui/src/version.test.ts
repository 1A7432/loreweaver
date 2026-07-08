import { describe, expect, test } from "bun:test"
import { clientInfo, resolveClientVersion } from "./version"

describe("client version", () => {
  test("prefers the release/build injected version", () => {
    expect(resolveClientVersion({ TRPG_CLIENT_VERSION: " 0.5.1.dev29+g0cf542b " })).toBe("0.5.1.dev29+g0cf542b")
  })

  test("falls back to the release version env var", () => {
    expect(resolveClientVersion({ TRPG_RELEASE_VERSION: "0.5.1.dev29+g0cf542b" })).toBe("0.5.1.dev29+g0cf542b")
  })

  test("reports the TUI client name with the resolved version", () => {
    expect(clientInfo({ TRPG_CLIENT_VERSION: "1.2.3" })).toEqual({ name: "loreweaver-tui", version: "1.2.3" })
  })
})
