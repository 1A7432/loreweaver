import { describe, expect, test } from "bun:test"
import { isIrohTicket } from "./irohClient"

// The transport picker (clients/tui/src/client.ts) routes on this: a ws(s):// URL keeps the
// zero-dep WebSocket path; anything else is treated as an Iroh ticket. Getting this wrong
// sends a ticket to WsClient (or a URL to iroh), so it is worth pinning.
describe("isIrohTicket", () => {
  test("ws/wss URLs are NOT tickets — route to WebSocket", () => {
    expect(isIrohTicket("ws://127.0.0.1:8787")).toBe(false)
    expect(isIrohTicket("wss://1a7432.site/ws")).toBe(false)
    expect(isIrohTicket("WSS://Host/ws")).toBe(false) // scheme match is case-insensitive
    expect(isIrohTicket("  ws://host  ")).toBe(false) // leading/trailing space is trimmed
  })

  test("a base32 endpoint ticket IS a ticket — route to Iroh", () => {
    expect(isIrohTicket("endpointaagjr2rmbvc2sxr5rvnp45ul2iiqi26wzuvmi767mfihikiqjnqvwba")).toBe(true)
  })
})
