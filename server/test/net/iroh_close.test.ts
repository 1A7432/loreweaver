// The transport's two clocks: a connection that never says hello is told so and closed;
// and after the server's last word — a fatal error — the client reads that word before the
// connection goes, instead of seeing a dropped link.
import { afterEach, expect, test } from "bun:test";

import type { ClientFrame, ServerFrame } from "loreweaver-protocol/v3";

import { dial, IrohServer, type IrohOptions } from "../../src/net/iroh.ts";
import { Keystore } from "../../src/net/keystore.ts";

const servers: IrohServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(options: Partial<IrohOptions> = {}): Promise<string> {
  // An empty keystore: every key is unknown, so no room is ever asked for.
  const server = new IrohServer(
    {
      keystore: new Keystore(),
      room: () => {
        throw new Error("no room is reached in these tests");
      },
    },
    { mode: "local", ...options },
  );
  servers.push(server);
  return server.start();
}

const HELLO: ClientFrame = { type: "hello", protocol: "3.0", key: "no-such-key", locale: "en", client: { name: "test", version: "0" }, caps: [] };

test("a fatal error is read by the client before the connection goes, every time", async () => {
  const ticket = await serve();
  for (let round = 0; round < 20; round += 1) {
    const link = await dial(ticket, { mode: "local" });
    link.send(HELLO);
    // Before the grace period existed the server closed the connection right behind this
    // line, and QUIC may drop what is still in flight on close: the client then saw a
    // dropped link and would have redialled with a key that can never work.
    const frame: ServerFrame = await link.next();
    expect([round, frame]).toEqual([round, { type: "error", code: "bad_key", message: expect.any(String), fatal: true }]);
    await link.close();
  }
}, 30_000);

test("a client that does not hang up after the server's last word is cut off when the grace period ends", async () => {
  const ticket = await serve({ closeGraceMs: 150 });
  const link = await dial(ticket, { mode: "local" });
  link.send(HELLO);
  expect(await link.next()).toMatchObject({ code: "bad_key", fatal: true });
  const started = Date.now();
  // The client keeps its side open; the server ends the connection by itself.
  await expect(link.next()).rejects.toThrow("the connection ended");
  expect(Date.now() - started).toBeLessThan(5_000);
  await link.close().catch(() => undefined);
}, 15_000);

test("a connection that never says hello is told so and closed", async () => {
  const ticket = await serve({ helloTimeoutMs: 150, closeGraceMs: 150 });
  const link = await dial(ticket, { mode: "local" });
  // (the stream exists for the server only once something is written on it)
  link.send({ type: "ping", t: 1 });
  expect(await link.next()).toEqual({ type: "pong", t: 1 });
  expect(await link.next()).toEqual({ type: "error", code: "hello_timeout", message: "No hello arrived in time.", fatal: true });
  await expect(link.next()).rejects.toThrow("the connection ended");
  await link.close().catch(() => undefined);
}, 15_000);

test("a line that never ends is not buffered for ever: the server says so and closes", async () => {
  const ticket = await serve({ closeGraceMs: 150 });
  const link = await dial(ticket, { mode: "local" });
  // 9 MiB of a JSON string with no newline, on the control stream, before any hello.
  const junk = `{"type":"hello","key":"${"x".repeat(1024 * 1024)}`;
  for (let sent = 0; sent < 9; sent += 1) link.sendRaw(junk);
  expect(await link.next()).toEqual({ type: "error", code: "line_too_long", message: "A line of the control stream may be at most 8 MiB.", fatal: true });
  await expect(link.next()).rejects.toThrow("the connection ended");
  await link.close().catch(() => undefined);
}, 30_000);
