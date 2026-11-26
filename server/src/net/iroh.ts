// The iroh carrier: peer-to-peer QUIC, dialled by ticket. Control frames are
// newline-delimited JSON on one long-lived bidirectional stream per connection — the first
// one the client opens. Every further bidirectional stream on the connection is one
// operation of the byte channel (`bytes.ts`), served beside the control stream, never in
// its way.
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
import {
  type ByteFile,
  decodeByteReply,
  encodeByteLine,
  HeaderReader,
  MAX_BYTE_HEADER_BYTES,
  PROTOCOL_MAJOR,
  type ClientFrame,
  type ServerFrame,
} from "loreweaver-protocol/v3";

import { BYTE_CHUNK, ByteChannel, type ByteSink, type ByteSource } from "./bytes.ts";
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
  /** A server's byte-stream stall timeout (default the protocol's `BYTE_STALL_MS`); tests shorten it. */
  readonly byteStallMs?: number;
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

/** One iroh stream as the byte channel reads and writes it. */
function byteSource(recv: RecvStream): ByteSource {
  return {
    read: async (max) => {
      try {
        const chunk = await recv.read(max);
        return chunk.length === 0 ? null : Uint8Array.from(chunk);
      } catch {
        return null;
      }
    },
    stop: () => {
      void recv.stop(0n).catch(() => undefined);
    },
  };
}

function byteSink(send: SendStream): ByteSink {
  return {
    write: (bytes) => send.writeAll(Array.from(bytes)),
    finish: () => send.finish(),
  };
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
      const channel = new ByteChannel(
        () => session.byteAccess(),
        () => session.locale,
        this.#options.byteStallMs === undefined ? {} : { stallMs: this.#options.byteStallMs },
      );
      void this.#acceptBytes(connection, channel);
      await pump(stream.recv, reader);
      open = false;
      session.closed();
    } finally {
      this.#connections.delete(connection);
      connection.close(0n, bytes("closed"));
    }
  }

  /** Every further stream of the connection is a byte-channel operation, served on its own. */
  async #acceptBytes(connection: IrohConnection, channel: ByteChannel): Promise<void> {
    for (;;) {
      let stream: Awaited<ReturnType<IrohConnection["acceptBi"]>>;
      try {
        stream = await connection.acceptBi();
      } catch {
        return;
      }
      void channel.serve(byteSource(stream.recv), byteSink(stream.send));
    }
  }
}

/** What one byte stream answered: the reply header and, for a GET, the body. */
export type ByteAnswer =
  | { readonly ok: true; readonly file: ByteFile; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** One raw byte stream of a dialled connection (tests drive misbehaving peers with it). */
export interface RawByteStream {
  write(bytes: Uint8Array): Promise<void>;
  /** Finish the client's side: the server sees the end of the body. */
  finish(): Promise<void>;
  /** The server's answer: one header line, and for a GET exactly `size` bytes after it. */
  answer(): Promise<ByteAnswer>;
}

/** A dialled connection: the client half, used by tests and the self-test. */
export interface IrohLink {
  send(frame: ClientFrame): void;
  /** Resolves with the next frame; rejects if the stream ends first. */
  next(): Promise<ServerFrame>;
  /** Open a byte stream of this connection. */
  stream(): Promise<RawByteStream>;
  /** GET a file by its content hash. */
  get(hash: string): Promise<ByteAnswer>;
  /** PUT the bytes of an accepted offer. */
  put(uploadId: string, bytes: Uint8Array): Promise<ByteAnswer>;
  close(): Promise<void>;
}

/** Read a byte stream's answer as a client does: the header line, then the GET body, bounded by its size. */
async function readAnswer(recv: RecvStream): Promise<ByteAnswer> {
  const reader = new HeaderReader(MAX_BYTE_HEADER_BYTES);
  let header: { value: unknown; rest: Uint8Array } | null = null;
  while (header === null) {
    const chunk = await recv.read(BYTE_CHUNK);
    if (chunk.length === 0) throw new Error("the stream ended before its answer");
    const step = reader.push(Uint8Array.from(chunk));
    if (step.state === "too_long") throw new Error("the answer's header is too long");
    if (step.state === "line") header = step;
  }
  const reply = decodeByteReply(header.value);
  if (reply === null) throw new Error("the answer could not be read");
  if (!reply.ok) return reply;
  const { op: _op, ok: _ok, ...file } = reply;
  if (reply.op === "put") return { ok: true, file, bytes: new Uint8Array(0) };
  const body = new Uint8Array(file.size);
  if (header.rest.length > file.size) throw new Error("the server sent more than it announced");
  body.set(header.rest);
  let filled = header.rest.length;
  while (filled < file.size) {
    const chunk = await recv.read(Math.min(BYTE_CHUNK, file.size - filled));
    if (chunk.length === 0) throw new Error("the stream ended before the body did");
    body.set(chunk, filled);
    filled += chunk.length;
  }
  return { ok: true, file, bytes: body };
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
  const openStream = async (): Promise<RawByteStream> => {
    const bi = await connection.openBi();
    return {
      write: (bytes) => bi.send.writeAll(Array.from(bytes)),
      finish: () => bi.send.finish(),
      answer: () => readAnswer(bi.recv),
    };
  };
  const writeChunked = async (raw: RawByteStream, bytes: Uint8Array): Promise<void> => {
    for (let at = 0; at < bytes.length; at += BYTE_CHUNK) await raw.write(bytes.subarray(at, at + BYTE_CHUNK));
  };
  return {
    stream: openStream,
    get: async (hash) => {
      const raw = await openStream();
      await raw.write(encodeByteLine({ op: "get", hash }));
      await raw.finish();
      return raw.answer();
    },
    put: async (uploadId, bytes) => {
      const raw = await openStream();
      await raw.write(encodeByteLine({ op: "put", upload_id: uploadId }));
      await writeChunked(raw, bytes);
      await raw.finish();
      return raw.answer();
    },
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
