// Persistent ed25519 host key: load it from disk, or generate + persist one
// (creating the parent dir if needed) so the server's identity is stable across
// restarts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import ssh2 from "ssh2"

const { utils } = ssh2

/** Return the OpenSSH private-key PEM for the host key at `path`, generating and
 * persisting a fresh ed25519 key (mode 0600) on first run. */
export function loadOrCreateHostKey(path: string): string {
  if (existsSync(path)) {
    return readFileSync(path, "utf8")
  }
  const dir = dirname(path)
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const pair = utils.generateKeyPairSync("ed25519")
  writeFileSync(path, pair.private, { mode: 0o600 })
  try {
    writeFileSync(`${path}.pub`, pair.public, { mode: 0o644 })
  } catch {
    // The public sidecar is a convenience only; ignore failures.
  }
  return pair.private
}
