import { describe, expect, test } from "bun:test"
import { FrameType, type ServerFrame } from "@loreweaver/protocol"
import type { AppClient } from "./client"
import { clientUpdateCommand, triggerServerUpdate } from "./update"

interface FakeOpts {
  connectFails?: boolean
  welcomeFeatures?: string[]
  updateStatus?: "restarting" | "failed"
  emitAdminError?: boolean
}

// A minimal stand-in for AppClient: only the four methods triggerServerUpdate touches,
// wired to replay a scripted welcome + admin_update to the registered onMessage handler.
class FakeClient {
  connectCalls = 0
  joinCalls: Array<[string, string | undefined]> = []
  updateCalls = 0
  closed = false
  private handlers = new Set<(f: ServerFrame) => void>()

  constructor(private opts: FakeOpts) {}

  private emit(frame: ServerFrame) {
    for (const h of this.handlers) h(frame)
  }
  async connect(_host: string): Promise<void> {
    this.connectCalls += 1
    if (this.opts.connectFails) throw new Error("connect failed")
  }
  join(key: string, name?: string): void {
    this.joinCalls.push([key, name])
    queueMicrotask(() =>
      this.emit({
        type: FrameType.Welcome,
        protocol: "1.5",
        room: "r",
        you: { id: "i", name: "n", role: "keeper" },
        locale: "en",
        server: "s",
        features: this.opts.welcomeFeatures,
      }),
    )
  }
  adminUpdateServer(): void {
    this.updateCalls += 1
    queueMicrotask(() =>
      this.opts.emitAdminError
        ? this.emit({ type: FrameType.AdminError, code: "forbidden" })
        : this.emit({ type: FrameType.AdminUpdate, status: this.opts.updateStatus ?? "restarting" }),
    )
  }
  onMessage(cb: (f: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }
  close(): void {
    this.closed = true
  }
}

const asClient = (f: FakeClient) => f as unknown as AppClient

describe("clientUpdateCommand", () => {
  test("uses the install.sh one-liner on unix", () => {
    const cmd = clientUpdateCommand("linux")
    expect(cmd[0]).toBe("bash")
    expect(cmd.join(" ")).toContain("install.sh")
  })
  test("uses the install.ps1 one-liner on windows", () => {
    const cmd = clientUpdateCommand("win32")
    expect(cmd[0]).toBe("powershell")
    expect(cmd.join(" ")).toContain("install.ps1")
  })
})

describe("triggerServerUpdate", () => {
  test("sends admin_update_server on an update-capable welcome and returns the status", async () => {
    const fake = new FakeClient({ welcomeFeatures: ["media", "update"], updateStatus: "restarting" })
    const outcome = await triggerServerUpdate(asClient(fake), "ticket", "keeperkey", "Keeper")
    expect(outcome).toBe("restarting")
    expect(fake.joinCalls).toEqual([["keeperkey", "Keeper"]])
    expect(fake.updateCalls).toBe(1)
    expect(fake.closed).toBe(true)
  })
  test("reports 'unsupported' and never asks to update when the feature is absent", async () => {
    const fake = new FakeClient({ welcomeFeatures: ["media", "audio"] })
    const outcome = await triggerServerUpdate(asClient(fake), "ticket", "k", undefined)
    expect(outcome).toBe("unsupported")
    expect(fake.updateCalls).toBe(0)
  })
  test("surfaces a failed server command", async () => {
    const fake = new FakeClient({ welcomeFeatures: ["update"], updateStatus: "failed" })
    expect(await triggerServerUpdate(asClient(fake), "t", "k", undefined)).toBe("failed")
  })
  test("an admin_error reply is a failure", async () => {
    const fake = new FakeClient({ welcomeFeatures: ["update"], emitAdminError: true })
    expect(await triggerServerUpdate(asClient(fake), "t", "k", undefined)).toBe("failed")
  })
  test("a connect failure returns 'error' without hanging", async () => {
    const fake = new FakeClient({ connectFails: true })
    expect(await triggerServerUpdate(asClient(fake), "t", "k", undefined)).toBe("error")
  })
})
