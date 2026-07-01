#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { WsClient } from "@trpg-kp/protocol"
import App from "./App"

interface Args {
  command?: string
  host?: string
  key?: string
  name?: string
  solo?: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  const rest = [...argv]
  args.command = rest.shift()
  while (rest.length > 0) {
    const part = rest.shift()
    if (part === "--host") args.host = rest.shift()
    else if (part === "--key") args.key = rest.shift()
    else if (part === "--name") args.name = rest.shift()
    else if (part === "--solo") args.solo = true
  }
  return args
}

function usage(): string {
  return [
    "Usage:",
    "  trpg-kp connect --host ws://127.0.0.1:8787 --key <k> [--name N]",
    "  trpg-kp connect --solo",
    "",
    "Local server:",
    "  python -m app --serve",
  ].join("\n")
}

const args = parseArgs(Bun.argv.slice(2))

if (args.solo) {
  console.log("Start the local Python server first:")
  console.log("  python -m app --serve")
  process.exit(0)
}

if (args.command !== "connect" || !args.host || !args.key) {
  console.log(usage())
  process.exit(args.command ? 1 : 0)
}

const client = new WsClient()
await client.connect(args.host)
client.join(args.key, args.name)

const renderer = await createCliRenderer()
createRoot(renderer).render(<App client={client} />)

