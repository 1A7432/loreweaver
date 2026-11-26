// The byte channel end to end over the real loopback transport: offers on the control
// stream, the bytes on streams of their own, the table told, fetches bounded by what the
// member may see, and every limit answered with a coded line that leaves the connection up.
import { afterEach, describe, expect, test } from "bun:test";

import { encodeByteLine, MAX_BYTE_HEADER_BYTES, MAX_BYTE_STREAMS, type ResultFrame, type ServerFrame } from "loreweaver-protocol/v3";

import type { MediaLimits } from "../../src/infra/media/index.ts";
import { dial, IrohServer, type IrohLink } from "../../src/net/iroh.ts";
import { memberId } from "../../src/net/keystore.ts";
import { jsonFile, plainCard, sha256, upload } from "../gateway/card_files.ts";
import { KEYS, ROOM, RoomBench } from "../gateway/room_bench.ts";

const OTHER_KEY = "oz-key";

interface Served {
  readonly b: RoomBench;
  readonly server: IrohServer;
  readonly ticket: string;
}

interface Client {
  readonly link: IrohLink;
  readonly frames: ServerFrame[];
  until(want: (frame: ServerFrame) => boolean): Promise<ServerFrame>;
  call(method: string, params: Record<string, unknown>): Promise<ResultFrame>;
  input(text: string): Promise<ResultFrame>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function serve(options: { readonly media?: Partial<MediaLimits>; readonly stallMs?: number } = {}): Promise<Served> {
  const b = new RoomBench({ media: options.media ?? true });
  b.keystore.add(OTHER_KEY, { room: "elsewhere", name: "Oz", role: "player" });
  const server = new IrohServer({ keystore: b.keystore, room: (id) => b.hub.room(id) }, { mode: "local", ...(options.stallMs === undefined ? {} : { byteStallMs: options.stallMs }) });
  const ticket = await server.start();
  cleanups.push(async () => {
    await server.close();
    await b.close();
  });
  return { b, server, ticket };
}

let rids = 0;

async function connect(ticket: string, key: string | null, locale = "en"): Promise<Client> {
  const link = await dial(ticket, { mode: "local" });
  cleanups.push(() => link.close());
  const frames: ServerFrame[] = [];
  let waiters: { want: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }[] = [];
  void (async () => {
    for (;;) {
      let frame: ServerFrame;
      try {
        frame = await link.next();
      } catch {
        return;
      }
      frames.push(frame);
      waiters = waiters.filter((waiter) => {
        if (!waiter.want(frame)) return true;
        waiter.resolve(frame);
        return false;
      });
    }
  })();
  const until = (want: (frame: ServerFrame) => boolean): Promise<ServerFrame> => {
    const found = frames.find(want);
    return found !== undefined ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ want, resolve }));
  };
  const answer = async (rid: string): Promise<ResultFrame> => (await until((frame) => frame.type === "result" && frame.rid === rid)) as ResultFrame;
  const client: Client = {
    link,
    frames,
    until,
    call: (method, params) => {
      const rid = `r${++rids}`;
      link.send({ type: "call", rid, method, params });
      return answer(rid);
    },
    input: (text) => {
      const rid = `r${++rids}`;
      link.send({ type: "input", rid, text });
      return answer(rid);
    },
  };
  if (key !== null) {
    link.send({ type: "hello", protocol: "3.0", key, locale, client: { name: "test", version: "0" }, caps: [] });
    await until((frame) => frame.type === "welcome");
  }
  return client;
}

/** A PNG-signed file of `size` bytes, distinct per tag. */
function picture(tag: string, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const label = new TextEncoder().encode(tag);
  for (let at = 8; at < size; at++) bytes[at] = label[at % label.length] ?? 0;
  return bytes;
}

function offerOf(bytes: Uint8Array, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "map.png", mime: "image/png", size: bytes.length, sha256: sha256(bytes), ...extra };
}

async function uploadId(client: Client, bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await client.call("media.offer", offerOf(bytes, extra));
  if (!result.ok) throw new Error(`offer refused: ${result.error.code}`);
  const id = (result.data as { upload_id?: unknown }).upload_id;
  if (typeof id !== "string") throw new Error("no upload id");
  return id;
}

function codeOf(result: ResultFrame): string {
  return result.ok ? "ok" : result.error.code;
}

describe("the byte channel", () => {
  test("offer, put, the media event at the table, a get by another member byte for byte; the same bytes again are `existing`", async () => {
    const { ticket } = await serve();
    const ada = await connect(ticket, KEYS.ada);
    const bao = await connect(ticket, KEYS.bao, "zh");
    // Large enough to cross several transport chunks.
    const bytes = picture("harbor", 300_000);
    const put = await ada.link.put(await uploadId(ada, bytes), bytes);
    expect(put).toEqual({ ok: true, file: { hash: sha256(bytes), size: bytes.length, mime: "image/png", name: "map.png" }, bytes: new Uint8Array(0) });
    const event = await bao.until((frame) => frame.type === "event" && frame.kind === "media");
    expect(event).toMatchObject({ kind: "media", data: { hash: sha256(bytes), mime: "image/png", size: bytes.length, name: "map.png", from: memberId(KEYS.ada) } });

    const got = await bao.link.get(sha256(bytes));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.file).toEqual({ hash: sha256(bytes), size: bytes.length, mime: "image/png", name: "map.png" });
    expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true);

    const again = await bao.call("media.offer", offerOf(bytes, { name: "again.png" }));
    expect(again).toMatchObject({ ok: true, data: { existing: { hash: sha256(bytes), name: "map.png", from: memberId(KEYS.ada) } } });
  });

  test("offers refused on the control stream, each with the store's code in the member's language", async () => {
    const { ticket } = await serve({ media: { image: { maxFileBytes: 4096, roomQuotaBytes: 6000 }, uploadsPerMinute: 100 } });
    const ada = await connect(ticket, KEYS.ada, "zh");
    const eve = await connect(ticket, KEYS.eve);
    const root = await connect(ticket, KEYS.root);
    expect(await eve.call("media.offer", offerOf(picture("e")))).toMatchObject({ ok: false, error: { code: "observer_upload" } });
    expect(await ada.call("media.offer", offerOf(picture("t"), { mime: "text/plain" }))).toMatchObject({ ok: false, error: { code: "media_bad_mime", message: "这里不能上传这种类型的文件。" } });
    expect(codeOf(await ada.call("media.offer", offerOf(picture("big", 5000))))).toBe("media_too_large");
    expect(codeOf(await ada.call("media.offer", offerOf(picture("h"), { sha256: "nope" })))).toBe("media_bad_hash");
    expect(codeOf(await ada.call("media.offer", offerOf(picture("p"), { purpose: "gift" })))).toBe("invalid_params");
    expect(codeOf(await ada.call("media.offer", offerOf(picture("n"), { name: "x".repeat(256) })))).toBe("invalid_params");
    expect(codeOf(await ada.call("media.offer", offerOf(picture("j"), { mime: "application/json" })))).toBe("media_bad_mime");
    // The quota: 4000 bytes stored, 3000 more would not fit.
    const first = picture("q1", 4000);
    expect((await ada.link.put(await uploadId(ada, first), first)).ok).toBe(true);
    expect(codeOf(await ada.call("media.offer", offerOf(picture("q2", 3000))))).toBe("media_quota_exceeded");
    // The switch.
    expect((await root.input(".uploads off")).ok).toBe(true);
    expect(codeOf(await ada.call("media.offer", offerOf(picture("off"))))).toBe("media_disabled");
  });

  test("the member's upload rate", async () => {
    const { ticket } = await serve({ media: { uploadsPerMinute: 2 } });
    const ada = await connect(ticket, KEYS.ada);
    expect(codeOf(await ada.call("media.offer", offerOf(picture("1"))))).toBe("ok");
    expect(codeOf(await ada.call("media.offer", offerOf(picture("2"))))).toBe("ok");
    expect(codeOf(await ada.call("media.offer", offerOf(picture("3"))))).toBe("media_rate_limited");
  });

  test("puts refused on the stream: wrong hash, more bytes than offered, fewer then close, an unknown id, a second use", async () => {
    const { ticket } = await serve();
    const ada = await connect(ticket, KEYS.ada);
    const bytes = picture("real", 1000);

    const forged = picture("fake", 1000);
    expect(await ada.link.put(await uploadId(ada, bytes), forged)).toMatchObject({ ok: false, code: "media_hash_mismatch" });

    const more = await uploadId(ada, bytes);
    expect(await ada.link.put(more, new Uint8Array([...bytes, 1, 2, 3]))).toMatchObject({ ok: false, code: "media_size_mismatch" });
    // An offer whose bytes did not arrive whole is used up.
    expect(await ada.link.put(more, bytes)).toMatchObject({ ok: false, code: "media_unknown_upload" });

    expect(await ada.link.put(await uploadId(ada, bytes), bytes.subarray(0, 600))).toMatchObject({ ok: false, code: "media_size_mismatch" });
    expect(await ada.link.put("no-such-upload", bytes)).toMatchObject({ ok: false, code: "media_unknown_upload", message: "No upload is waiting under that id: offer the file again." });

    const once = await uploadId(ada, bytes);
    expect((await ada.link.put(once, bytes)).ok).toBe(true);
    expect(await ada.link.put(once, bytes)).toMatchObject({ ok: false, code: "media_unknown_upload" });
    // Another member cannot use an upload id that is not theirs.
    const bao = await connect(ticket, KEYS.bao);
    const adas = await uploadId(ada, picture("adas"));
    expect(await bao.link.put(adas, picture("adas"))).toMatchObject({ ok: false, code: "media_unknown_upload" });
  });

  test("a get answers only what the member may see: another room's hash and an admin-only file read exactly like a missing one", async () => {
    const { b, ticket } = await serve();
    const ada = await connect(ticket, KEYS.ada);
    const root = await connect(ticket, KEYS.root);
    const oz = await connect(ticket, OTHER_KEY);
    const shared = picture("shared");
    expect((await ada.link.put(await uploadId(ada, shared), shared)).ok).toBe(true);
    const card = jsonFile(plainCard("Secret"));
    expect(await upload(b.uploads!, ROOM, { id: memberId(KEYS.root), role: "admin" }, card, "application/json")).toMatchObject({ audience: "admin" });

    const missing = await ada.link.get("c".repeat(64));
    expect(missing).toEqual({ ok: false, code: "media_not_found", message: "No such file." });
    expect(await oz.link.get(sha256(shared))).toEqual(missing);
    expect(await ada.link.get(sha256(card))).toEqual(missing);
    const own = await root.link.get(sha256(card));
    expect(own.ok && Buffer.from(own.bytes).equals(Buffer.from(card))).toBe(true);
    // An admin's import upload offered over the channel is announced to nobody.
    const second = jsonFile(plainCard("Other"));
    const imported = await root.link.put(await uploadId(root, second, { purpose: "import", mime: "application/json", name: "c.json" }), second);
    expect(imported.ok).toBe(true);
    expect(ada.frames.filter((frame) => frame.type === "event" && frame.kind === "media")).toHaveLength(1);
    expect(await ada.link.get(sha256(second))).toEqual(missing);
  });

  test("limits: too many streams at once, a header that never ends, a request it does not know — the control stream answers throughout", async () => {
    const { ticket } = await serve();
    const ada = await connect(ticket, KEYS.ada);
    const bytes = picture("slow", 2000);
    // MAX_BYTE_STREAMS transfers that have begun and then wait.
    const hanging = [];
    for (let i = 0; i < MAX_BYTE_STREAMS; i++) {
      const stream = await ada.link.stream();
      await stream.write(encodeByteLine({ op: "put", upload_id: await uploadId(ada, bytes) }));
      await stream.write(bytes.subarray(0, 100));
      hanging.push(stream);
    }
    // The control stream is not blocked by any of them.
    expect((await ada.input(".r 1d6")).ok).toBe(true);
    ada.link.send({ type: "ping", t: 7 });
    expect(await ada.until((frame) => frame.type === "pong")).toEqual({ type: "pong", t: 7 });
    const extra = await ada.link.stream();
    await extra.write(encodeByteLine({ op: "get", hash: "d".repeat(64) }));
    await extra.finish();
    expect(await extra.answer()).toMatchObject({ ok: false, code: "too_many_streams" });
    // One of them completes; the next stream is served again.
    await hanging[0]!.write(bytes.subarray(100));
    await hanging[0]!.finish();
    expect(await hanging[0]!.answer()).toMatchObject({ ok: true });
    const tooLong = await ada.link.stream();
    await tooLong.write(new Uint8Array(MAX_BYTE_HEADER_BYTES + 10).fill(0x61));
    expect(await tooLong.answer()).toMatchObject({ ok: false, code: "header_too_long" });
    const unknown = await ada.link.stream();
    await unknown.write(new TextEncoder().encode('{"op":"delete","hash":"x"}\n'));
    await unknown.finish();
    expect(await unknown.answer()).toMatchObject({ ok: false, code: "bad_request" });
    expect((await ada.input(".r 1d4")).ok).toBe(true);
  });

  test("a body that stops arriving is closed as stalled, and the offer is used up", async () => {
    const { ticket } = await serve({ stallMs: 150 });
    const ada = await connect(ticket, KEYS.ada);
    const bytes = picture("stall", 2000);
    const id = await uploadId(ada, bytes);
    const stream = await ada.link.stream();
    await stream.write(encodeByteLine({ op: "put", upload_id: id }));
    await stream.write(bytes.subarray(0, 500));
    expect(await stream.answer()).toMatchObject({ ok: false, code: "stalled" });
    expect(await ada.link.put(id, bytes)).toMatchObject({ ok: false, code: "media_unknown_upload" });
    // The connection is still up.
    expect((await ada.input(".r 1d6")).ok).toBe(true);
  });

  test("a stream opened before hello is refused, and the connection can still say hello", async () => {
    const { ticket } = await serve();
    const early = await connect(ticket, null);
    expect(await early.link.get("e".repeat(64))).toMatchObject({ ok: false, code: "not_open", message: "This connection has not joined a room, or it has ended." });
    early.link.send({ type: "hello", protocol: "3.0", key: KEYS.ada, locale: "en", client: { name: "test", version: "0" }, caps: [] });
    expect(await early.until((frame) => frame.type === "welcome")).toMatchObject({ type: "welcome" });
    expect(await early.link.get("e".repeat(64))).toMatchObject({ ok: false, code: "media_not_found" });
  });
});
