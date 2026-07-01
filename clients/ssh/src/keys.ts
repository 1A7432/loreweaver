// SSH key store: parse an `ssh_keys.toml` mapping player SSH public keys to
// {room, ws_key, name}, key it by SHA256 fingerprint, and authorize an offered
// key during ssh2 publickey auth.
import { readFileSync } from "node:fs"
import crypto from "node:crypto"
import ssh2 from "ssh2"

const { utils } = ssh2

/** Public fields declared in `ssh_keys.toml` for one player. */
export interface SshKeyEntry {
  room: string
  wsKey: string
  name: string
}

/** An authorized key: the public entry plus the parsed key material we need to
 * verify signatures during auth. */
export interface AuthorizedKey extends SshKeyEntry {
  fingerprint: string
  /** ssh2 ParsedKey — used for signature verification. */
  parsed: any
  /** Raw public-SSH blob (`getPublicSSH()`), used for constant-time matching. */
  blob: Buffer
}

export type SshKeyMap = Map<string, AuthorizedKey>

/** OpenSSH-style SHA256 fingerprint of a raw public-SSH blob. */
export function fingerprintOf(blob: Buffer): string {
  const digest = crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")
  return `SHA256:${digest}`
}

/** Parse an `ssh-ed25519 AAAA... comment` line into its parsed key, raw blob and
 * fingerprint. Throws on malformed input. */
export function parsePublicKey(pubkey: string): { parsed: any; blob: Buffer; fingerprint: string } {
  const result = utils.parseKey(pubkey)
  if (result instanceof Error) {
    throw new Error(`invalid ssh public key: ${result.message}`)
  }
  const parsed: any = Array.isArray(result) ? result[0] : result
  const blob: Buffer = parsed.getPublicSSH()
  return { parsed, blob, fingerprint: fingerprintOf(blob) }
}

function parseKeysFile(path: string, text: string): any {
  if (path.endsWith(".json")) return JSON.parse(text)
  // Bun ships a native TOML parser; typed loosely to avoid bun-types coupling.
  return (Bun as any).TOML.parse(text)
}

/** Load `ssh_keys.toml` (or `.json`) into a fingerprint -> AuthorizedKey map. */
export function loadSshKeys(path: string): SshKeyMap {
  const text = readFileSync(path, "utf8")
  const data = parseKeysFile(path, text)
  const users: any[] = Array.isArray(data?.user) ? data.user : []
  const map: SshKeyMap = new Map()
  for (const user of users) {
    if (!user || typeof user.pubkey !== "string") continue
    const { parsed, blob, fingerprint } = parsePublicKey(user.pubkey)
    map.set(fingerprint, {
      room: String(user.room ?? ""),
      wsKey: String(user.ws_key ?? user.wsKey ?? ""),
      name: String(user.name ?? ""),
      fingerprint,
      parsed,
      blob,
    })
  }
  return map
}

/** Normalize whatever the caller offers (Buffer, ParsedKey, ssh2 auth ctx.key,
 * or an `ssh-ed25519 ...` string) into a raw public-SSH blob. */
function toBlob(offered: any): Buffer | null {
  if (!offered) return null
  if (Buffer.isBuffer(offered)) return offered
  if (typeof offered.getPublicSSH === "function") return offered.getPublicSSH()
  if (offered.data && Buffer.isBuffer(offered.data)) return offered.data
  if (typeof offered === "string") {
    try {
      return parsePublicKey(offered).blob
    } catch {
      return null
    }
  }
  return null
}

/** Return the authorized entry for an offered public key, or null if unknown.
 * Matches by fingerprint, then constant-time compares the raw blob. This only
 * proves the key is *listed*; ssh2 still verifies the signature separately. */
export function authorize(keys: SshKeyMap, offered: unknown): AuthorizedKey | null {
  const blob = toBlob(offered)
  if (!blob) return null
  const entry = keys.get(fingerprintOf(blob))
  if (!entry) return null
  if (entry.blob.length !== blob.length) return null
  if (!crypto.timingSafeEqual(entry.blob, blob)) return null
  return entry
}
