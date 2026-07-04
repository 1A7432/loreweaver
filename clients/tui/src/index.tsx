#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import App, { type AppPrefill } from "./App"
import { forgetServer, loadConnectMemory, rememberServer, saveConnectMemory, type SavedServer } from "./connectMemory"

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
    "  loreweaver                    # launch the lobby (connect screen)",
    "  loreweaver connect --host <p2p-ticket> --key <k> [--name N]   # prefilled",
    "  loreweaver update             # re-fetch + reinstall the latest client",
    "",
    "Local server:",
    "  click 'Host locally & play' on the connect screen (or: python -m app --serve)",
  ].join("\n")
}

const args = parseArgs(Bun.argv.slice(2))

// --host/--key are no longer required: a bare `loreweaver` opens the lobby and the
// args (if any) just prefill the connect form. Only an explicit help request is
// handled before the renderer starts.
if (args.command === "help" || args.command === "--help" || args.command === "-h") {
  console.log(usage())
  process.exit(0)
}

const remembered = await loadConnectMemory()
const prefill: AppPrefill = {
  host: args.host ?? remembered.host,
  key: args.key ?? remembered.key,
  name: args.name ?? remembered.name,
  locale: remembered.locale,
  servers: remembered.servers,
}

const renderer = await createCliRenderer()
// Set a clean terminal window title. Without this the shell leaves the title as the
// full launch command — which overflows the title bar and, worse, exposes the invite
// key in it. OSC 2 (window title) + BEL terminator.
process.stdout.write("\x1b]2;Loreweaver\x07")
createRoot(renderer).render(
  <App
    prefill={prefill}
    onRememberConnect={(memory) => {
      // Persist as "last used" AND float this server to the top of the saved list, so the
      // connect screen remembers every server/key you've joined (deduped by host+key).
      void loadConnectMemory().then((m) =>
        saveConnectMemory({
          ...m,
          ...memory,
          servers: rememberServer(m.servers, { host: memory.host, key: memory.key, name: memory.name }),
        }),
      )
    }}
    onLocaleChange={(locale) => {
      // Persist a language pick made before connecting, merging with the saved file
      // so a later connect still overwrites host/key/name correctly.
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, locale }))
    }}
    onForgetConnect={(entry: SavedServer) => {
      // Mirrors onRememberConnect: load the current file, apply the pure list edit, re-save.
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, servers: forgetServer(m.servers, entry) }))
    }}
    onQuit={() => {
      // Restore the terminal (raw mode / alt-screen) BEFORE exiting — otherwise the shell
      // is left in whatever state the renderer put it in.
      try {
        renderer.destroy?.()
      } catch {
        // best-effort — still exit even if teardown itself throws
      }
      process.exit(0)
    }}
  />,
)
