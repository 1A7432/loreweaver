#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import App, { type AppPrefill } from "./App"
import { createClient } from "./client"
import { forgetServer, loadConnectMemory, rememberServer, saveConnectMemory, type SavedServer } from "./connectMemory"
import { defaultTuiLocale } from "./i18n"
import { clientUpdateCommand, triggerServerUpdate } from "./update"

interface Args {
  command?: string
  host?: string
  key?: string
  name?: string
  solo?: boolean
  clientOnly?: boolean
  serverOnly?: boolean
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
    else if (part === "--client-only") args.clientOnly = true
    else if (part === "--server-only") args.serverOnly = true
  }
  return args
}

function usage(): string {
  return [
    "Usage:",
    "  loreweaver                    # launch the lobby (connect screen)",
    "  loreweaver connect --host <p2p-ticket> --key <k> [--name N]   # prefilled",
    "  loreweaver update             # reinstall the latest client AND update your server",
    "  loreweaver update --client-only   # just the client",
    "  loreweaver update --server-only   # just the saved server",
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

if (args.command === "update") {
  // `loreweaver update` reinstalls the client and, by default, also updates the saved
  // server (keeper key required) so the two stay in step — the more natural one-liner.
  let ok = true
  if (!args.serverOnly) {
    console.log("Updating client…")
    const proc = Bun.spawn(clientUpdateCommand(), { stdout: "inherit", stderr: "inherit" })
    const code = await proc.exited
    ok = code === 0
    console.log(ok ? "Client updated." : `Client update exited ${code}.`)
  }
  if (!args.clientOnly) {
    const mem = await loadConnectMemory()
    const host = args.host ?? mem.host
    const key = args.key ?? mem.key
    if (!host || !key) {
      console.log("No saved server to update — connect once first, or pass --host/--key.")
    } else {
      console.log("Updating server…")
      const outcome = await triggerServerUpdate(createClient(), host, key, args.name ?? mem.name)
      const message: Record<string, string> = {
        restarting: "Server is updating and will restart.",
        failed: "Server update command failed — check the server logs.",
        unsupported: "Server self-update isn't enabled (set TRPG_TUI__UPDATE_COMMAND on it), or your key isn't a keeper.",
        "no-server": "No saved server to update.",
        error: "Could not reach the server to update it.",
      }
      console.log(message[outcome] ?? outcome)
      if (outcome === "failed" || outcome === "error") ok = false
    }
  }
  process.exit(ok ? 0 : 1)
}

const remembered = await loadConnectMemory()
const prefill: AppPrefill = {
  host: args.host ?? remembered.host,
  key: args.key ?? remembered.key,
  name: args.name ?? remembered.name,
  // Treat the remembered choice or OS/environment-derived locale as a local
  // user preference, so a remote room's locale cannot flip the TUI after join.
  locale: remembered.locale ?? defaultTuiLocale(),
  localServerHome: remembered.localServerHome,
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
      if (!memory.host || !memory.key) return
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
    onLocalServerHomeChange={(localServerHome) => {
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, localServerHome }))
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
    renderer={renderer}
  />,
)
