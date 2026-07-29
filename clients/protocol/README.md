# loreweaver-protocol

Typed frames and a reconnecting WebSocket client for the open, versioned wire
protocol of [Loreweaver](https://github.com/1A7432/loreweaver) — a self-hosted
AI Game Master / Keeper for tabletop RPGs. The package version tracks the
protocol version (currently **v1.7**); the protocol document itself lives at
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

Versioning is additive: clients should ignore unknown server frame types and
treat `welcome.protocol` as an opaque `"1.x"` string.

## License

MIT — see [LICENSE](./LICENSE).
