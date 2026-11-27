# loreweaver-protocol

The client half of the open wire protocol of
[Loreweaver](https://github.com/1A7432/loreweaver), a self-hosted AI Game Master /
Keeper for tabletop RPGs: typed frames and views, a decoder for everything a server
sends, and a client session that does no I/O. The package's `major.minor` is the
protocol's (currently **3.0**); the protocol itself is described, completely, in
[`docs/protocol.md`](https://github.com/1A7432/loreweaver/blob/main/docs/protocol.md).

Protocol 3.0 shares nothing with 2.x: the frames, the handshake and the carrier's
ALPN are all different, and this package no longer contains the 2.x types or the
WebSocket client. A 2.x client stays on `loreweaver-protocol@2`.

## Install

```sh
npm install loreweaver-protocol   # or: bun add loreweaver-protocol
```

## What you get

- **The frames** — `ClientFrame` / `ServerFrame`, the event kinds (`narrative`, `dice`,
  `blocks`, `media`, `rewind`, `reset`), the signals (`draft`, `turn`, `notice`,
  `audio`), the limits (`RESUME_LIMIT`, `PAGE_LIMIT`, `HELLO_TIMEOUT_MS`, …).
- **The built-in views**, typed, each with its schema: `me`, `party`, `scene`,
  `variables`, `characters`, `commands`, `room`, `usage`, `packs`, `panels`, `audio`,
  and the admin views.
- **`decodeServerFrame`** — structural validation of whatever arrives: an unknown frame
  type or kind is ignored, an unknown field dropped, a malformed frame reported and
  never thrown.
- **`Session`** — the client's whole state as one immutable snapshot: the room's log,
  the bubbles being streamed, the turn status, the views you subscribed. It is
  transport-agnostic: you hand it a link and the frames that arrive. It owns `hello`,
  resuming after a drop, request ids and their one result each.
- **The byte channel's lines** — `encodeByteLine`, `decodeByteReply`, `HeaderReader` and the
  limits: content-addressed GET and PUT on streams beside the control stream.
- **`panelBlocks` / `instantiate`** — the one evaluation of panel templates every client
  shares, so a panel looks the same everywhere.
- **`stripControlChars`** — the sanitiser a terminal client runs over text from a server.
- **`evaluate` / `isVisible`** — the condition language of panels, for authoring tools.

## Usage

```ts
import { Session } from "loreweaver-protocol"

const session = new Session({ key, locale: "en", client: { name: "my-client", version: "1.0" } })

// A link is anything that can send one frame; you feed back what it receives.
const attachment = session.attach({ send: (frame) => stream.write(JSON.stringify(frame) + "\n") })
onLine((line) => attachment.receive(JSON.parse(line)))
onClose(() => attachment.closed("stream closed"))

session.subscribe(() => render(session.getSnapshot()))   // or React's useSyncExternalStore
await session.viewSubscribe(["me", "party", "commands"]) // subscribed again on every reconnect
const result = await session.input("I open the door.")   // one result per request
await session.runCommand("roll", { expr: "2d6" })
```

The carrier is [iroh](https://iroh.computer) (peer-to-peer QUIC, ALPN `loreweaver/3`):
control frames are newline-delimited JSON on the first bidirectional stream, and every
further stream is one operation of the byte channel. This package does not dial; the
terminal client's
[`irohLink.ts`](https://github.com/1A7432/loreweaver/blob/main/clients/tui/src/irohLink.ts)
and
[`connection.ts`](https://github.com/1A7432/loreweaver/blob/main/clients/tui/src/connection.ts)
are a complete, small example of the link and of the object that owns it (pings, redial).

After a drop, dial again and `attach` the new link: the session resumes from the log it
kept (`resume {epoch, after}`), subscribes its views again, and reports a gap the server
could not replay (`snapshot.gap`, filled by `loadOlder()`). When `session.canRedial` is
false — a fatal `error`: a bad key, another protocol major — do not dial again.

`loreweaver-protocol/v3` is the same entry under the protocol's own name.

## Versioning

The **major** is the compatibility contract: a client and a server must agree on it, and
a server refuses another major with a fatal `protocol_mismatch`. Minors within a major
are additive — a client ignores frame types, kinds, fields and enum values it does not
know, and this package's decoder does that for you.

## License

MIT — see [LICENSE](./LICENSE).
