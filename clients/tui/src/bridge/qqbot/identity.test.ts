import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { tt } from "../../i18n"
import {
  CLAIM_CODE_LENGTH,
  CLAIM_CODE_TTL_MS,
  CLAIM_REJECT_COOLDOWN_MS,
  C2CIdentityRouter,
  IdentityStore,
  LINK_CODE_LENGTH,
  LINK_CODE_TTL_MS,
  UNBOUND_C2C_LOG_EVERY_MS,
  identityPath,
  isC2CClaimText,
  openidTail,
  seatName,
} from "./identity"

async function makeStore(opts: { now: { ms: number }; locale?: string } = { now: { ms: 1_000 } }) {
  const logs: string[] = []
  const dir = await mkdtemp(join(tmpdir(), "lw-identity-"))
  const groupId = "group-openid-1"
  const path = identityPath(dir, groupId)
  const store = await IdentityStore.load(path, groupId, {
    now: () => opts.now.ms,
    onLog: (line) => logs.push(line),
    locale: opts.locale ?? "zh",
  })
  return { store, path, dir, logs, groupId, now: opts.now }
}

describe("seatName", () => {
  test("username when non-empty; else anonymous i18n tail of member_openid", () => {
    expect(seatName({ username: "阿绫", memberOpenid: "deadbeef1234" }, "zh")).toBe("阿绫")
    expect(seatName({ username: "  ", memberOpenid: "deadbeef1234" }, "zh")).toBe("玩家1234")
    expect(seatName({ memberOpenid: "deadbeef1234" }, "en")).toBe("Player 1234")
    expect(tt("zh", "bridge.qqbot.anonymousSeat", { tail: "abcd" })).toBe("玩家abcd")
    expect(openidTail("zzzz")).toHaveLength(4)
    expect(openidTail("zzzz")).toMatch(/^[0-9a-f]{4}$/)
  })
})

describe("IdentityStore — claim / link codes", () => {
  test("issue / expire / one-use / re-issue; secrets never in logs or on disk", async () => {
    const now = { ms: 10_000 }
    const { store, path, logs, groupId } = await makeStore({ now })
    const unused = await store.issueClaimCode()
    expect(unused).toHaveLength(CLAIM_CODE_LENGTH)
    expect(logs).toEqual([`qqbot.claim.issued ${groupId}`])
    const code = await store.issueClaimCode()
    expect(code).not.toBe(unused)
    expect((await store.claim({ channel: "private", code: unused, userOpenid: "U-stale" })).outcome).toBe("rejected")
    expect(logs.join("\n")).not.toContain(code)
    await store.drainWrites()
    const onDisk = await Bun.file(path).text()
    expect(onDisk).not.toContain(code)
    expect(onDisk).toContain("claimHash")
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)

    const first = await store.claim({ channel: "private", code, userOpenid: "U1" })
    expect(first.outcome).toBe("link_issued")
    const again = await store.claim({ channel: "private", code, userOpenid: "U2" })
    expect(again.outcome).toBe("rejected")

    const fresh = await store.issueClaimCode()
    expect(fresh).not.toBe(code)
    now.ms += CLAIM_CODE_TTL_MS + 1
    const expired = await store.claim({ channel: "private", code: fresh, userOpenid: "U3" })
    expect(expired.outcome).toBe("rejected")

    const next = await store.issueClaimCode()
    const ok = await store.claim({ channel: "private", code: next, userOpenid: "U4" })
    expect(ok.outcome).toBe("link_issued")
    await store.drainWrites()
    const later = await Bun.file(path).text()
    expect(later).not.toContain(next)
    if (ok.outcome === "link_issued") expect(later).not.toContain(ok.linkCode)
    expect(logs.join("\n")).not.toContain(next)
  })

  test("wrong code is rejected and cools down per openid", async () => {
    const now = { ms: 0 }
    const { store } = await makeStore({ now })
    await store.issueClaimCode()
    const bad = await store.claim({ channel: "private", code: "AAAAAAAA", userOpenid: "U9" })
    expect(bad.outcome).toBe("rejected")
    const during = await store.claim({ channel: "private", code: "BBBBBBBB", userOpenid: "U9" })
    expect(during.outcome).toBe("cooldown")
    now.ms += CLAIM_REJECT_COOLDOWN_MS
    const after = await store.claim({ channel: "private", code: "CCCCCCCC", userOpenid: "U9" })
    expect(after.outcome).toBe("rejected")
    const other = await store.claim({ channel: "private", code: "DDDDDDDD", userOpenid: "U8" })
    expect(other.outcome).toBe("rejected")
  })

  test("C2C claim issues a one-use link code; group accepts it once", async () => {
    const { store } = await makeStore()
    const claim = await store.issueClaimCode()
    const c2c = await store.claim({ channel: "private", code: claim, userOpenid: "U1", unionOpenid: "" })
    expect(c2c.outcome).toBe("link_issued")
    if (c2c.outcome !== "link_issued") return
    expect(c2c.linkCode).toHaveLength(LINK_CODE_LENGTH)

    const group = await store.claim({ channel: "group", code: c2c.linkCode, memberOpenid: "M1" })
    expect(group).toMatchObject({ outcome: "done", memberOpenid: "M1", userOpenid: "U1" })
    expect(store.resolveC2C("M1")).toBe("U1")
    expect(store.isBoundC2C("U1")).toBe(true)
    expect(store.seatForC2C("U1")).toBe("M1")

    const reuse = await store.claim({ channel: "group", code: c2c.linkCode, memberOpenid: "M2" })
    expect(reuse.outcome).toBe("rejected")
  })

  test("a link code sent in C2C is rejected; a claim code sent in the group is rejected", async () => {
    const { store, logs } = await makeStore()
    const claim = await store.issueClaimCode()
    const c2c = await store.claim({ channel: "private", code: claim, userOpenid: "U1" })
    expect(c2c.outcome).toBe("link_issued")
    if (c2c.outcome !== "link_issued") return

    const linkInC2C = await store.claim({ channel: "private", code: c2c.linkCode, userOpenid: "U1" })
    expect(linkInC2C.outcome).toBe("rejected")
    expect(store.isBoundC2C("U1")).toBe(false)

    const other = await store.issueClaimCode()
    const claimInGroup = await store.claim({ channel: "group", code: other, memberOpenid: "M1" })
    expect(claimInGroup.outcome).toBe("rejected")
    expect(store.resolveC2C("M1")).toBeUndefined()
    expect(logs.includes("qqbot.claim.burned")).toBe(true)

    const still = await store.claim({ channel: "private", code: other, userOpenid: "U2" })
    expect(still.outcome).toBe("rejected")
  })

  test("union_openid fast path links a later group message; empty never links", async () => {
    const now = { ms: 0 }
    const { store, logs } = await makeStore({ now })
    const claim = await store.issueClaimCode()
    const c2c = await store.claim({
      channel: "private",
      code: claim,
      userOpenid: "U1",
      unionOpenid: "UNION-SAME",
    })
    expect(c2c.outcome).toBe("link_issued")

    const empty = await store.tryUnionLink({ memberOpenid: "M1", unionOpenid: "" })
    expect(empty).toBeUndefined()
    const mismatch = await store.tryUnionLink({ memberOpenid: "M1", unionOpenid: "OTHER" })
    expect(mismatch).toBeUndefined()

    const short = await store.tryUnionLink({ memberOpenid: "M1", unionOpenid: "SHORT" })
    expect(short).toBeUndefined()
    const linked = await store.tryUnionLink({ memberOpenid: "M1", unionOpenid: "UNION-SAME" })
    expect(linked).toMatchObject({ memberOpenid: "M1", userOpenid: "U1" })
    expect(logs.some((line) => line === "qqbot.claim.union_linked M1")).toBe(true)
    expect(store.resolveC2C("M1")).toBe("U1")

    if (c2c.outcome === "link_issued") {
      const used = await store.claim({ channel: "group", code: c2c.linkCode, memberOpenid: "M9" })
      expect(used.outcome).toBe("rejected")
    }
  })

  test("union_openid on the group claim verb also completes without the link code", async () => {
    const { store } = await makeStore()
    const claim = await store.issueClaimCode()
    await store.claim({ channel: "private", code: claim, userOpenid: "U1", unionOpenid: "UNION-001" })
    const done = await store.claim({
      channel: "group",
      code: "XXXXXX",
      memberOpenid: "M1",
      unionOpenid: "UNION-001",
    })
    expect(done).toMatchObject({ outcome: "done", memberOpenid: "M1", userOpenid: "U1" })
  })

  test("link code expires after 5 minutes", async () => {
    const now = { ms: 0 }
    const { store } = await makeStore({ now })
    const claim = await store.issueClaimCode()
    const c2c = await store.claim({ channel: "private", code: claim, userOpenid: "U1" })
    expect(c2c.outcome).toBe("link_issued")
    if (c2c.outcome !== "link_issued") return
    now.ms += LINK_CODE_TTL_MS + 1
    const late = await store.claim({ channel: "group", code: c2c.linkCode, memberOpenid: "M1" })
    expect(late.outcome).toBe("rejected")
  })

  test("bindings persist and reload; resolveC2C is undefined when unbound", async () => {
    const now = { ms: 5 }
    const { store, path, groupId } = await makeStore({ now })
    const claim = await store.issueClaimCode()
    const c2c = await store.claim({ channel: "private", code: claim, userOpenid: "U1" })
    if (c2c.outcome !== "link_issued") throw new Error("expected link")
    await store.claim({ channel: "group", code: c2c.linkCode, memberOpenid: "M1" })
    await store.setChosenName("M1", "阿绫")
    await store.drainWrites()

    expect(store.resolveC2C("M-unbound")).toBeUndefined()
    expect(store.isBoundC2C("U-nope")).toBe(false)

    const reloaded = await IdentityStore.load(path, groupId, { now: () => now.ms })
    expect(reloaded.resolveC2C("M1")).toBe("U1")
    expect(reloaded.seatForC2C("U1")).toBe("M1")
    expect(reloaded.chosenName("M1")).toBe("阿绫")
    expect(reloaded.displayNameFor("M2", { username: "" }, "zh")).toBe(`玩家${openidTail("M2")}`)
  })
})

describe("IdentityStore — unbound C2C fail-closed", () => {
  test("unbound C2C .r 1d6 is ignored with one throttled log line; claim still accepted", async () => {
    const now = { ms: 0 }
    const { store, logs, path } = await makeStore({ now })
    expect(isC2CClaimText(".bridge claim ABCDEFGH")).toBe(true)
    expect(isC2CClaimText(".r 1d6")).toBe(false)

    expect(store.acceptC2CInbound("Ux", ".r 1d6")).toBe("ignore")
    await store.drainWrites()
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toEqual(["qqbot.c2c.unbound"])
    expect(await Bun.file(path).exists()).toBe(false)

    expect(store.acceptC2CInbound("Ux", "hello")).toBe("ignore")
    expect(store.acceptC2CInbound("Ux", ".bridge status")).toBe("ignore")
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toHaveLength(1)

    now.ms += UNBOUND_C2C_LOG_EVERY_MS
    expect(store.acceptC2CInbound("Ux", ".ra 侦查")).toBe("ignore")
    await store.drainWrites()
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toHaveLength(2)

    expect(store.acceptC2CInbound("Ux", ".bridge claim ABCDEFGH")).toBe("claim")
    expect(store.acceptC2CInbound("Uy", "/bridge claim x")).toBe("claim")
    expect(store.seatForC2C("Ux")).toBeUndefined()
    expect(store.isBoundC2C("Ux")).toBe(false)
  })

  test("bound C2C forwards; unbound never mints a seat", async () => {
    const { store } = await makeStore()
    const claim = await store.issueClaimCode()
    const c2c = await store.claim({ channel: "private", code: claim, userOpenid: "U1" })
    if (c2c.outcome !== "link_issued") throw new Error("expected link")
    await store.claim({ channel: "group", code: c2c.linkCode, memberOpenid: "M1" })
    expect(store.acceptC2CInbound("U1", ".r 1d6")).toBe("forward")
    expect(store.acceptC2CInbound("U-other", ".r 1d6")).toBe("ignore")
  })
})

describe("C2CIdentityRouter — multi-group C2C", () => {
  test("bound in A routes to A; B's claim code from an unbound openid; garbage is one log", async () => {
    const now = { ms: 0 }
    const logs: string[] = []
    const dir = await mkdtemp(join(tmpdir(), "lw-c2c-router-"))
    const storeA = await IdentityStore.load(identityPath(dir, "A"), "A", { now: () => now.ms })
    const storeB = await IdentityStore.load(identityPath(dir, "B"), "B", { now: () => now.ms })
    const facade = new C2CIdentityRouter([storeA, storeB], { now: () => now.ms, onLog: (line) => logs.push(line) })

    const codeA = await storeA.issueClaimCode()
    const c2cA = await storeA.claim({ channel: "private", code: codeA, userOpenid: "U-ada" })
    if (c2cA.outcome !== "link_issued") throw new Error("expected link")
    await storeA.claim({ channel: "group", code: c2cA.linkCode, memberOpenid: "M-ada" })

    const toA = facade.classify("U-ada", ".r 1d6")
    expect(toA).toMatchObject({ kind: "bound", seat: "M-ada" })
    if (toA.kind === "bound") expect(toA.store.id).toBe("A")

    const codeB = await storeB.issueClaimCode()
    const claimB = facade.classify("U-stranger", `.bridge claim ${codeB}`)
    expect(claimB).toMatchObject({ kind: "claim" })
    if (claimB.kind === "claim") expect(claimB.store.id).toBe("B")

    expect(facade.classify("U-x", ".bridge claim GARBAGE1")).toEqual({ kind: "ignore" })
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toHaveLength(1)
    expect(facade.classify("U-x", ".bridge claim GARBAGE2")).toEqual({ kind: "ignore" })
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toHaveLength(1)
    expect(facade.classify("U-x", ".r 1d6")).toEqual({ kind: "ignore" })
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toHaveLength(1)
  })
})
