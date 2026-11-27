#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import App, { type AppPrefill } from "./App"
import { forgetServer, loadConnectMemory, rememberLocalKey, rememberServer, saveConnectMemory, type SavedServer } from "./connectMemory"
import { defaultTuiLocale, tt } from "./i18n"

interface Args {
  command?: string
  host?: string
  key?: string
  name?: string
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
  }
  return args
}

const args = parseArgs(Bun.argv.slice(2))

// A bare `loreweaver` opens the connect screen; `connect --host … --key …` only prefills it.
// Only an explicit help request is handled before the renderer starts.
if (args.command === "help" || args.command === "--help" || args.command === "-h") {
  console.log(tt(defaultTuiLocale(), "cli.usage"))
  process.exit(0)
}

const remembered = await loadConnectMemory()
const prefill: AppPrefill = {
  host: args.host ?? remembered.host,
  key: args.key ?? remembered.key,
  name: args.name ?? remembered.name,
  // The remembered choice, or the environment's locale: a local preference, independent of the
  // room's language.
  locale: remembered.locale ?? defaultTuiLocale(),
  localServerHome: remembered.localServerHome,
  servers: remembered.servers,
  localKeys: remembered.localKeys,
  muted: remembered.muted,
}

// `exitOnCtrlC: false` hands Ctrl+C to the App shell, which copies the current selection when
// there is one and otherwise quits — and releases the connection and a local server on the way.
const renderer = await createCliRenderer({ exitOnCtrlC: false })
// A clean window title: otherwise the shell leaves the launch command there, key included.
process.stdout.write("\x1b]2;Loreweaver\x07")
createRoot(renderer).render(
  <App
    prefill={prefill}
    onRememberConnect={(memory) => {
      // Last used, and floated to the top of the saved list (deduplicated by ticket + key).
      void loadConnectMemory().then((m) =>
        saveConnectMemory({ ...m, ...memory, servers: rememberServer(m.servers, { host: memory.host, key: memory.key, name: memory.name }) }),
      )
    }}
    onLocaleChange={(locale) => {
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, locale }))
    }}
    onLocalServerHomeChange={(localServerHome) => {
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, localServerHome }))
    }}
    onLocalKey={(entry) => {
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, localKeys: rememberLocalKey(m.localKeys, entry) }))
    }}
    onMutedChange={(muted) => {
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, muted }))
    }}
    onForgetConnect={(entry: SavedServer) => {
      void loadConnectMemory().then((m) => saveConnectMemory({ ...m, servers: forgetServer(m.servers, entry) }))
    }}
    onQuit={() => {
      // Restore the terminal (raw mode / alt-screen) BEFORE exiting.
      try {
        renderer.destroy?.()
      } catch {
        // best effort — still exit
      }
      process.exit(0)
    }}
    renderer={renderer}
  />,
)
