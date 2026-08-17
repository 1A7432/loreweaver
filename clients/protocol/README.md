# loreweaver-protocol

Typed frames and a reconnecting WebSocket client for the open, versioned wire
protocol of [Loreweaver](https://github.com/1A7432/loreweaver) — a self-hosted
AI Game Master / Keeper for tabletop RPGs. The package version tracks the
protocol version (currently **v2.2**); the protocol document itself lives at
[`docs/protocol.md`](https://github.com/1A7432/loreweaver/blob/main/docs/protocol.md).

## Install

```sh
npm install loreweaver-protocol   # or: bun add loreweaver-protocol
```

## What you get

- **`FrameType` + every frame shape** (`ServerFrame` / `ClientFrame` unions):
  `welcome`, `narrative`, `dice`, `ui`, `state`, `presence`, media/audio, the
  keeper-gated `admin_*` family, …
- **`WsClient`** — a small reconnecting WebSocket client with per-type frame
  validation (malformed frames are dropped, never crash a consumer), typed
  `on(FrameType.X, handler)` subscriptions, media upload/download helpers, and
  auto re-`join` after a drop. The WebSocket carrier is the loopback/test one;
  the production carrier is Iroh p2p, which shares these exact frame types.
- **`stripControlChars`** — the terminal-safety sanitizer every Loreweaver
  client runs over server-supplied text (strips C0/C1 escape introducers).
- **A major-version mismatch warning** — `WsClient` compares the `welcome`
  frame's `protocol` against `PROTOCOL_VERSION` and warns once (naming both
  versions) when the majors differ, so every client built on this package gets
  the check for free. The pure helpers behind it — `protocolMajor`,
  `protocolMismatch`, `protocolMismatchMessage` — are exported for clients that
  do their own connecting.

## Usage

```ts
import { FrameType, PROTOCOL_VERSION, WsClient } from "loreweaver-protocol"

const client = new WsClient()
await client.connect("ws://127.0.0.1:8787/")
client.join("your-invite-key")

client.on(FrameType.Narrative, (frame) => console.log(frame.speaker, frame.text))
client.on(FrameType.Dice, (frame) => console.log(frame.expr, frame.total, frame.level))
client.sendInput(".ra Spot Hidden")
```

## Versioning

The **major** version is the compatibility contract; minors within a major are
additive, so clients should ignore unknown server frame types and unknown fields.
A different major means the two sides may reject or misread each other's frames,
so `WsClient` says so — loudly, once, through `console.warn` by default:

```ts
const client = new WsClient({
  onProtocolMismatch: (message, { client: mine, server }) => {
    banner(message)            // or refuse the session yourself: client.close()
    console.log(mine, server)  // e.g. "2.1", "3.0"
  },
})
```

It is a warning, not a refusal: the `welcome` frame is still delivered and the
socket stays open. Hanging up (or not) is your call.

## License

MIT — see [LICENSE](./LICENSE).
