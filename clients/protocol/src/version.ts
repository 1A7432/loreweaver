// The MAJOR version is the compatibility contract (docs/protocol.md): a client and a
// server must agree on it, minors within a major are purely additive. This module is the
// client half of that contract — the check every consumer of `loreweaver-protocol` gets
// for free, so a third-party client never has to remember to write it.
//
// It WARNS, it does not refuse: the connection stays up, frames keep flowing, and the
// operator is told, loudly, which two versions are talking past each other. Refusing is
// the caller's prerogative (`client.close()` from the handler) and real negotiation waits
// for a second implementation to negotiate with.
import { PROTOCOL_VERSION } from "./types.js"

export interface ProtocolMismatch {
  /** The protocol version THIS package was built against. */
  client: string
  /** The version the server announced in its `welcome` frame. */
  server: string
}

/** Where a mismatch is reported. Defaults to `console.warn` — see `WsClientOptions`. */
export type ProtocolMismatchHandler = (message: string, mismatch: ProtocolMismatch) => void

/**
 * The major component of a `major.minor` version string, normalized ("02.1" → "2").
 *
 * Returns `undefined` for anything that does not announce a readable major — absent,
 * empty, non-string, or otherwise malformed. The wire is untrusted; a banner we cannot
 * read is not evidence of disagreement, so it must not be reported as one.
 */
export function protocolMajor(version: unknown): string | undefined {
  if (typeof version !== "string") return undefined
  const match = /^\s*(\d+)(?:\.|\s*$)/.exec(version)
  if (!match) return undefined
  return String(Number(match[1]))
}

/**
 * The mismatch between an announced protocol version and this package's, or `undefined`
 * when the two agree on the major (or the announcement is unreadable).
 */
export function protocolMismatch(
  announced: unknown,
  client: string = PROTOCOL_VERSION,
): ProtocolMismatch | undefined {
  const serverMajor = protocolMajor(announced)
  if (serverMajor === undefined) return undefined
  if (serverMajor === protocolMajor(client)) return undefined
  return { client, server: announced as string }
}

/** The operator-facing sentence. Names both versions — that is the whole point of it. */
export function protocolMismatchMessage(mismatch: ProtocolMismatch): string {
  return (
    `loreweaver-protocol: the server speaks protocol ${mismatch.server}, but this client was ` +
    `built against ${mismatch.client}. The major version is the compatibility contract, so ` +
    `frames may be rejected or misread — update whichever side is behind. See docs/protocol.md.`
  )
}
