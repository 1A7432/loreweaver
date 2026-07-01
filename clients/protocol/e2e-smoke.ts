// Cross-language e2e smoke: this Bun/TS WsClient connects to the real Python
// `python -m app --serve` websocket server, joins a room with a deployer key,
// sends a dice command, and asserts it gets back welcome + narrative + state.
// Usage: bun run e2e-smoke.ts <host> <port> <key>
import { WsClient } from "./src/client"
import type { ServerFrame } from "./src/types"

const [host, port, key] = process.argv.slice(2)
const url = `ws://${host}:${port}/`

const frames: ServerFrame[] = []
const client = new WsClient()
client.onMessage((f) => frames.push(f))

// retry connect until the server is up (avoids sleeping)
let connected = false
for (let i = 0; i < 30; i++) {
  try {
    await client.connect(url)
    connected = true
    break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
  }
}
if (!connected) {
  console.error("SMOKE FAIL: could not connect to", url)
  process.exit(2)
}

const welcome = await new Promise<ServerFrame | null>((resolve) => {
  const off = client.on("welcome", (f) => {
    off()
    resolve(f as ServerFrame)
  })
  client.join(key, "Nora")
  setTimeout(() => resolve(null), 3000)
})
if (!welcome) {
  console.error("SMOKE FAIL: no welcome frame after join")
  process.exit(3)
}
console.log("welcome:", JSON.stringify(welcome))

client.sendInput(".r 1d1+1")
await new Promise((r) => setTimeout(r, 2500))
client.close()

const types = frames.map((f) => f.type)
const narratives = frames.filter((f) => f.type === "narrative") as Extract<ServerFrame, { type: "narrative" }>[]
const hasWelcome = frames.some((f) => f.type === "welcome")
const hasResult = narratives.some((f) => f.text.includes("2"))
const hasState = frames.some((f) => f.type === "state")

console.log("frame types:", types.join(", "))
for (const n of narratives) console.log(`  narrative[${n.speaker}]: ${n.text.slice(0, 80)}`)

if (hasWelcome && hasResult && hasState) {
  console.log("SMOKE OK: welcome + dice-result narrative (=2) + state all received over the wire")
  process.exit(0)
}
console.error(`SMOKE FAIL: welcome=${hasWelcome} result=${hasResult} state=${hasState}`)
process.exit(1)
