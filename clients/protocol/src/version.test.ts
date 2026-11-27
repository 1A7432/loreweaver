// The package's version is the protocol's: `major.minor` of package.json equals
// `PROTOCOL_VERSION`, so a package cannot be published advertising another protocol.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { PROTOCOL_MAJOR, PROTOCOL_VERSION } from "./v3/frames.js"

test("package.json's major.minor is the protocol version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
  const [major, minor] = manifest.version.split(".")
  expect(`${major}.${minor}`).toBe(PROTOCOL_VERSION)
  expect(Number(major)).toBe(PROTOCOL_MAJOR)
})

test("the root entry and ./v3 are the same protocol", async () => {
  const root = await import("./index.js")
  const v3 = await import("./v3/index.js")
  for (const name of Object.keys(v3)) expect([name, name in root]).toEqual([name, true])
  // …plus the condition language, for authoring tools.
  expect(typeof root.isVisible).toBe("function")
  expect(typeof root.evaluate).toBe("function")
})
