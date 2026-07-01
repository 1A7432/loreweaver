#!/usr/bin/env bun
// CLI entrypoint for the SSH front-end.
//
//   bun run src/index.ts \
//     --port 2222 \
//     --ws-url ws://127.0.0.1:8787/ \
//     --keys ./data/ssh_keys.toml \
//     --client /abs/path/to/clients/tui/src/index.tsx
import { resolve } from "node:path"
import { startSshServer } from "./server"

interface CliArgs {
  port: number
  host: string
  wsUrl: string
  keys: string
  client: string
  hostKey: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    port: 2222,
    host: "127.0.0.1",
    wsUrl: "ws://127.0.0.1:8787/",
    keys: "./data/ssh_keys.toml",
    client: resolve(import.meta.dir, "../../tui/src/index.tsx"),
    hostKey: "./data/ssh_host_key",
  }
  const rest = [...argv]
  while (rest.length > 0) {
    const part = rest.shift()
    if (part === "--port") args.port = Number(rest.shift())
    else if (part === "--host") args.host = String(rest.shift())
    else if (part === "--ws-url") args.wsUrl = String(rest.shift())
    else if (part === "--keys") args.keys = String(rest.shift())
    else if (part === "--client") args.client = resolve(String(rest.shift()))
    else if (part === "--host-key") args.hostKey = String(rest.shift())
    else if (part === "--help" || part === "-h") {
      console.log(usage())
      process.exit(0)
    }
  }
  return args
}

function usage(): string {
  return [
    "trpg-kp-ssh — Rich SSH front-end (OpenTUI over SSH)",
    "",
    "Usage:",
    "  trpg-kp-ssh --port 2222 --ws-url ws://127.0.0.1:8787/ \\",
    "              --keys ./data/ssh_keys.toml \\",
    "              --client /abs/path/to/clients/tui/src/index.tsx",
    "",
    "Players connect with:  ssh -p 2222 anything@host",
    "(auth is the SSH public key listed in ssh_keys.toml — no password)",
  ].join("\n")
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2))

  const server = await startSshServer({
    port: args.port,
    host: args.host,
    wsUrl: args.wsUrl,
    clientEntry: args.client,
    sshKeysPath: args.keys,
    hostKeyPath: args.hostKey,
  })

  console.log("trpg-kp-ssh listening")
  console.log(`  ssh port : ${args.host}:${server.port}`)
  console.log(`  ws server: ${args.wsUrl}`)
  console.log(`  keys     : ${args.keys}`)
  console.log(`  client   : ${args.client}`)
  console.log("Players: ssh -p " + server.port + " anything@host")

  const shutdown = async () => {
    console.log("\ntrpg-kp-ssh shutting down")
    await server.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("trpg-kp-ssh failed to start:", err?.message ?? err)
    process.exit(1)
  })
}
