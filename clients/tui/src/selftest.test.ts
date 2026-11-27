import { expect, test } from "bun:test"
import { selftest } from "./selftest"
import type { IrohModuleLike } from "./irohLink"

test("the self-test draws a frame and binds a loopback endpoint with the real native parts", async () => {
  const report = await selftest()
  expect(report).toEqual({ ok: true, version: report.version, steps: [{ step: "render", ok: true }, { step: "transport", ok: true }] })
  expect(report.version).toMatch(/^\d+\.\d+\.\d+/)
})

test("a transport that cannot load fails its step, says why, and the report is not ok", async () => {
  const report = await selftest(() => Promise.reject(new Error("no native module")))
  expect(report.ok).toBe(false)
  expect(report.steps).toEqual([{ step: "render", ok: true }, { step: "transport", ok: false, detail: "no native module" }])
})

test("a transport without a loopback mode is a failure, not a dial to the public relays", async () => {
  let bound = false
  const iroh = { Endpoint: { builder: () => ({ bind: async () => ((bound = true), { online: async () => {}, connect: async () => ({ openBi: async () => ({}) }) }) }) }, presetN0: () => {}, EndpointTicket: { fromString: () => ({ endpointAddr: () => null }) } } as unknown as IrohModuleLike
  const report = await selftest(async () => iroh)
  expect(report.steps[1]).toEqual({ step: "transport", ok: false, detail: "the transport has no loopback mode" })
  expect(bound).toBe(false)
})
