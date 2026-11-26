// The byte channel on in-memory streams: who may use it as a session's life goes on, and a
// chunk larger than asked for is not trusted.
import { afterEach, expect, test } from "bun:test";

import { decodeByteReply, encodeByteLine } from "loreweaver-protocol/v3";

import { ByteChannel, type ByteSink, type ByteSource } from "../../src/net/bytes.ts";
import { KEYS, RoomBench } from "../gateway/room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((b) => b.close()));
});

/** A stream whose peer sends `chunks` and then finishes; what the server wrote back, as text. */
function stream(chunks: Uint8Array[]): { source: ByteSource; sink: ByteSink; written: () => string; stopped: () => boolean } {
  const queue = [...chunks];
  const out: Uint8Array[] = [];
  let stopped = false;
  return {
    source: {
      read: () => Promise.resolve(queue.shift() ?? null),
      stop: () => {
        stopped = true;
      },
    },
    sink: {
      write: (bytes) => {
        out.push(bytes.slice());
        return Promise.resolve();
      },
      finish: () => Promise.resolve(),
    },
    written: () => Buffer.concat(out).toString("utf8"),
    stopped: () => stopped,
  };
}

function reply(text: string): unknown {
  return decodeByteReply(JSON.parse(text.slice(0, text.indexOf("\n"))));
}

test("a session's byte access: none before hello, the member while joined, none once it ended", () => {
  const b = new RoomBench({ media: true });
  benches.push(b);
  const wire = b.join(KEYS.ada);
  expect(wire.session.byteAccess()?.member.name).toBe("Ada");
  wire.session.closed();
  expect(wire.session.byteAccess()).toBeNull();
  const refused = b.join("no-such-key");
  expect(refused.session.byteAccess()).toBeNull();
});

test("no access: refused as not open, in the connection's language, and the peer is told to stop", async () => {
  const channel = new ByteChannel(() => null, () => "zh");
  const s = stream([encodeByteLine({ op: "get", hash: "a".repeat(64) })]);
  await channel.serve(s.source, s.sink);
  expect(reply(s.written())).toEqual({ ok: false, code: "not_open", message: "这个连接还没有加入房间，或已经结束。" });
  expect(s.stopped()).toBe(true);
  expect(channel.open).toBe(0);
});

test("a chunk larger than the read asked for is refused, not written past the offered size", async () => {
  const b = new RoomBench({ media: true });
  benches.push(b);
  const wire = b.join(KEYS.ada);
  const access = wire.session.byteAccess();
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const { createHash } = await import("node:crypto");
  wire.receive({ type: "call", rid: "o", method: "media.offer", params: { name: "a.png", mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
  const offered = wire.sent.find((frame) => frame.type === "result" && frame.rid === "o");
  const id = offered?.type === "result" && offered.ok ? (offered.data as { upload_id: string }).upload_id : "";
  const channel = new ByteChannel(() => access, () => "en");
  // The header alone, then one chunk carrying the whole body and more.
  const s = stream([encodeByteLine({ op: "put", upload_id: id }), new Uint8Array([...bytes, 9, 9])]);
  await channel.serve(s.source, s.sink);
  expect(reply(s.written())).toMatchObject({ ok: false, code: "media_size_mismatch" });
});
