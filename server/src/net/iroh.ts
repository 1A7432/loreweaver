// The iroh carrier: peer-to-peer QUIC, dialled by ticket. Control frames are
// newline-delimited JSON on one long-lived bidirectional stream per connection.
import {
  Endpoint,
  EndpointAddr,
  EndpointTicket,
  presetMinimal,
  presetN0,
  RelayMode,
  type Connection as IrohConnection,
  type RecvStream,
  type SendStream,
} from "@number0/iroh";
import { PROTOCOL_MAJOR, type ClientFrame, type ServerFrame } from "loreweaver-protocol/v3";

import { encodeLine, LineReader } from "./lines.ts";
import { Session, type SessionDeps } from "./session.ts";

/** The ALPN carries the protocol major: a 2.x client fails to connect instead of misreading. */
export const ALPN = `loreweaver/${PROTOCOL_MAJOR}`;

const READ_CHUNK = 64 * 1024;

function bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

export interface IrohOptions {
  /** `n0`: the public relays, for real use. `local`: loopback only, no relay — tests. */
  readonly mode: "n0" | "local";
  readonly secretKey?: Uint8Array;
}

async function bind(options: IrohOptions, accept: boolean): Promise<Endpoint> {
  const builder = Endpoint.builder();
  if (options.mode === "n0") {
    presetN0(builder);
  } else {
    presetMinimal(builder);
    builder.relayMode(RelayMode.disabled());
    builder.bindAddr("127.0.0.1:0");
  }
  if (accept) builder.alpns([bytes(ALPN)]);
  if (options.secretKey) builder.secretKey(Array.from(options.secretKey));
  return builder.bind();
}

/** Serialise writes to one send stream: frames go out whole and in order. */
class Writer {
  readonly #send: SendStream;
  #tail: Promise<void> = Promise.resolve();

  constructor(send: SendStream) {
    this.#send = send;
  }

  write(value: unknown): void {
    const line = Array.from(encodeLine(value));
    this.#tail = this.#tail.then(() => this.#send.writeAll(line)).catch(() => undefined);
  }

  async finish(): Promise<void> {
    await this.#tail;
    await this.#send.finish().catch(() => undefined);
  }
}

async function pump(recv: RecvStream, reader: LineReader): Promise<void> {
  for (;;) {
    let chunk: number[];
    try {
      chunk = await recv.read(READ_CHUNK);
    } catch {
      return;
    }
    if (chunk.length === 0) return;
    reader.push(Uint8Array.from(chunk));
  }
}

export class IrohServer {
  readonly #deps: SessionDeps;
  readonly #options: IrohOptions;
  readonly #connections = new Set<IrohConnection>();
  #endpoint: Endpoint | null = null;
  #accepting: Promise<void> | null = null;

  constructor(deps: SessionDeps, options: IrohOptions) {
    this.#deps = deps;
    this.#options = options;
  }

  /** Bind and start accepting. Returns the ticket a client dials. */
  async start(): Promise<string> {
    const endpoint = await bind(this.#options, true);
    this.#endpoint = endpoint;
    if (this.#options.mode === "n0") await endpoint.online();
    const addr =
      this.#options.mode === "local"
        ? new EndpointAddr(endpoint.id(), null, endpoint.boundSockets())
        : endpoint.addr();
    this.#accepting = this.#acceptLoop(endpoint);
    return EndpointTicket.fromAddr(addr).toString();
  }

  /** Stop accepting, drop every connection, and wait for the endpoint to be gone. */
  async close(): Promise<void> {
    const endpoint = this.#endpoint;
    if (!endpoint) return;
    this.#endpoint = null;
    for (const connection of this.#connections) connection.close(0n, bytes("server closing"));
    await endpoint.close();
    await this.#accepting;
  }

  async #acceptLoop(endpoint: Endpoint): Promise<void> {
    for (;;) {
      const incoming = await endpoint.acceptNext().catch(() => null);
      if (incoming === null) return;
      void this.#serve(incoming).catch(() => undefined);
    }
  }

  async #serve(incoming: NonNullable<Awaited<ReturnType<Endpoint["acceptNext"]>>>): Promise<void> {
    const connection = await (await incoming.accept()).connect();
    this.#connections.add(connection);
    try {
      const stream = await connection.acceptBi();
      const writer = new Writer(stream.send);
      let open = true;
      const session = new Session(this.#deps, {
        send: (frame: ServerFrame) => {
          if (open) writer.write(frame);
        },
        close: () => {
          if (!open) return;
          open = false;
          void writer.finish().then(() => {
            connection.close(0n, bytes("closed"));
          });
        },
      });
      const reader = new LineReader(
        (value) => {
          session.receive(value);
        },
        () => {
          session.receive(null);
        },
      );
      await pump(stream.recv, reader);
      open = false;
      session.closed();
    } finally {
      this.#connections.delete(connection);
      connection.close(0n, bytes("closed"));
    }
  }
}

/** A dialled connection: the client half, used by tests and the self-test. */
export interface IrohLink {
  send(frame: ClientFrame): void;
  /** Resolves with the next frame; rejects if the stream ends first. */
  next(): Promise<ServerFrame>;
  close(): Promise<void>;
}

export async function dial(ticket: string, options: IrohOptions): Promise<IrohLink> {
  const endpoint = await bind(options, false);
  const connection = await endpoint.connect(EndpointTicket.fromString(ticket.trim()).endpointAddr(), bytes(ALPN));
  const stream = await connection.openBi();
  const writer = new Writer(stream.send);
  const inbox: ServerFrame[] = [];
  const waiters: { resolve: (frame: ServerFrame) => void; reject: (error: Error) => void }[] = [];
  let ended = false;
  const reader = new LineReader(
    (value) => {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value as ServerFrame);
      else inbox.push(value as ServerFrame);
    },
    () => undefined,
  );
  void pump(stream.recv, reader).then(() => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("the connection ended"));
  });
  return {
    send: (frame) => {
      writer.write(frame);
    },
    next: () => {
      const ready = inbox.shift();
      if (ready) return Promise.resolve(ready);
      if (ended) return Promise.reject(new Error("the connection ended"));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close: async () => {
      await writer.finish();
      connection.close(0n, bytes("bye"));
      await endpoint.close();
    },
  };
}
