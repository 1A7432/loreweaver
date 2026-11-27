/**
 * `loreweaver-tui selftest`: prove this build has the two native parts a single-file build can
 * lose — the renderer (one frame drawn off-screen) and the transport (a loopback endpoint bound
 * and closed). It needs no terminal and no network, so a release build runs it on every platform
 * before it is packaged. The answer is one JSON object, for a script.
 */
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { defaultLoadIroh, type LoadIroh } from "./irohLink"
import { resolveClientVersion } from "./version"

/** What the off-screen frame must show. */
const MARK = "loreweaver selftest"

export interface SelftestStep {
  readonly step: "render" | "transport"
  readonly ok: boolean
  /** Why not, when it failed. */
  readonly detail?: string
}

export interface SelftestReport {
  readonly ok: boolean
  readonly version: string
  readonly steps: readonly SelftestStep[]
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function render(): Promise<void> {
  // `act`: the off-screen renderer is React's test environment, which reports an update made outside one.
  let harness!: Awaited<ReturnType<typeof testRender>>
  await act(async () => {
    harness = await testRender(<text>{MARK}</text>, { width: 40, height: 3 })
  })
  try {
    await act(async () => {
      await harness.renderOnce()
    })
    const frame = harness.captureCharFrame()
    if (!frame.includes(MARK)) throw new Error("the frame does not show what was drawn")
  } finally {
    act(() => harness.renderer.destroy())
  }
}

async function transport(loadIroh: LoadIroh): Promise<void> {
  const iroh = await loadIroh()
  if (!iroh.presetMinimal || !iroh.RelayMode) throw new Error("the transport has no loopback mode")
  const builder = iroh.Endpoint.builder()
  if (!builder.bindAddr || !builder.relayMode) throw new Error("the transport has no loopback mode")
  // Loopback only and no relay: nothing leaves this machine.
  iroh.presetMinimal(builder)
  builder.relayMode(iroh.RelayMode.disabled())
  builder.bindAddr("127.0.0.1:0")
  const endpoint = await builder.bind()
  await endpoint.close?.()
}

async function attempt(step: SelftestStep["step"], run: () => Promise<void>): Promise<SelftestStep> {
  try {
    await run()
    return { step, ok: true }
  } catch (error) {
    return { step, ok: false, detail: detailOf(error) }
  }
}

export async function selftest(loadIroh: LoadIroh = defaultLoadIroh): Promise<SelftestReport> {
  const steps = [await attempt("render", render), await attempt("transport", () => transport(loadIroh))]
  return { ok: steps.every((step) => step.ok), version: resolveClientVersion(), steps }
}
