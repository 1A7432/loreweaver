import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { isBridgeCommand, looksLikeCommand, parseBridgeCommand, runBridgeCommand, shouldForwardInbound } from "./commands"
import { LastKeeperError } from "./keyring"
import { IdentityStore } from "./qqbot/identity"
import { tt } from "../i18n"

describe("bridge commands", () => {
  test(".bridge is recognised with ., /, and fullwidth prefix, and never looks like engine input", () => {
    expect(isBridgeCommand(".bridge status")).toBe(true)
    expect(isBridgeCommand("/bridge members")).toBe(true)
    expect(isBridgeCommand("。bridge kick 1")).toBe(true)
    expect(isBridgeCommand(".r 3d6")).toBe(false)
    expect(looksLikeCommand(".ra 侦查")).toBe(true)
    expect(looksLikeCommand("r 3d6+2")).toBe(true)
    expect(looksLikeCommand("hello there")).toBe(false)
  })

  test("non-admins cannot run .bridge and the command is never forwarded", () => {
    expect(shouldForwardInbound({ text: ".bridge status", channel: "group", mode: "all", mentioned: true })).toBe(false)
    expect(parseBridgeCommand(".bridge status")).toEqual({ name: "status" })
  })

  test("admin subcommands mutate mode/notice/admins and kick", async () => {
    const state = {
      mode: "mention" as const,
      busyNotice: true,
      admins: ["1"],
      kicked: [] as string[],
    }
    const view = () => ({
      locale: "en" as const,
      groupId: "99",
      mode: state.mode,
      busyNotice: state.busyNotice,
      admins: state.admins,
      members: [{ userId: "8", keyId: "kid", role: "player" }],
    })
    const effects = {
      setMode: (mode: "all" | "mention") => {
        state.mode = mode
      },
      setBusyNotice: (on: boolean) => {
        state.busyNotice = on
      },
      addAdmin: (id: string) => {
        state.admins.push(id)
      },
      removeAdmin: (id: string) => {
        state.admins = state.admins.filter((row) => row !== id)
      },
      kick: async (id: string) => {
        state.kicked.push(id)
      },
    }
    expect(await runBridgeCommand(".bridge status", true, view(), effects)).toContain("group 99")
    expect(await runBridgeCommand(".bridge members", true, view(), effects)).toContain("8 → kid")
    expect(await runBridgeCommand(".bridge mode all", true, view(), effects)).toContain("all")
    expect(state.mode).toBe("all")
    expect(await runBridgeCommand(".bridge notice off", true, view(), effects)).toContain("off")
    expect(state.busyNotice).toBe(false)
    expect(await runBridgeCommand(".bridge admin remove 1", true, view(), effects)).toContain("last admin")
    expect(state.admins).toEqual(["1"])
    expect(await runBridgeCommand(".bridge admin add 2", true, view(), effects)).toContain("2")
    expect(state.admins).toContain("2")
    expect(await runBridgeCommand(".bridge admin remove 1", true, view(), effects)).toContain("Removed admin 1")
    expect(state.admins).toEqual(["2"])
    expect(await runBridgeCommand(".bridge kick 8", true, view(), effects)).toContain("8")
    expect(state.kicked).toEqual(["8"])
    expect(await runBridgeCommand(".bridge status", false, view(), effects)).toContain("Only a room admin")
    expect(parseBridgeCommand(".bridge claim ABCDEFGH")).toEqual({ name: "claim", code: "ABCDEFGH" })
    expect(parseBridgeCommand(".bridge name 阿绫")).toEqual({ name: "name", display: "阿绫" })
    expect(parseBridgeCommand(".bridge deferred")).toEqual({ name: "deferred" })
    expect(await runBridgeCommand(".bridge claim ABCDEFGH", false, view(), effects)).toContain("Only a room admin")
    expect(await runBridgeCommand(".bridge deferred", true, view(), effects)).toContain("Unknown")
  })

  test("a last_keeper refusal is surfaced, never worked around", async () => {
    const reply = await runBridgeCommand(
      ".bridge kick 1",
      true,
      { locale: "en", groupId: "99", mode: "mention", busyNotice: true, admins: ["1"], members: [] },
      {
        setMode() {},
        setBusyNotice() {},
        addAdmin() {},
        removeAdmin() {},
        kick: async () => {
          throw new LastKeeperError("cannot delete the last keeper key")
        },
      },
    )
    expect(reply).toContain("last keeper key")
    expect(reply).not.toContain("cannot delete")
  })

  test(".bridge name before/after a character claim; collision returns the minted name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-cmd-id-"))
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "G")
    const taken = new Set<string>(["路人"])
    const remints: Array<{ userId: string; display: string }> = []
    const closed: string[] = []
    const view = {
      locale: "zh" as const,
      groupId: "G",
      mode: "mention" as const,
      busyNotice: true,
      admins: [] as string[],
      members: [],
      channel: "group" as const,
      memberOpenid: "M2",
      seat: "M2",
    }
    const effects = {
      setMode() {},
      setBusyNotice() {},
      addAdmin() {},
      removeAdmin() {},
      kick: async () => {},
      identity,
      hasCharacter: (seat: string) => seat === "M-locked",
      remintSeat: async (userId: string, displayName: string) => {
        remints.push({ userId, display: displayName })
        const name = taken.has(displayName) && displayName !== "first" ? `qq:${userId}` : displayName
        taken.add(name)
        return { previousKey: "old-key", name }
      },
      onSeatReminted: (_userId: string, previousKey: string) => {
        closed.push(previousKey)
      },
    }
    const changed = await runBridgeCommand(".bridge name 阿绫", false, view, effects)
    expect(changed).toBe(tt("zh", "bridge.qqbot.nameChanged", { name: "阿绫" }))
    expect(identity.chosenName("M2")).toBe("阿绫")
    expect(closed).toEqual(["old-key"])

    const collide = await runBridgeCommand(".bridge name 路人", false, view, effects)
    expect(collide).toBe(tt("zh", "bridge.qqbot.nameChanged", { name: "qq:M2" }))

    const locked = await runBridgeCommand(
      ".bridge name 新名",
      false,
      { ...view, memberOpenid: "M-locked", seat: "M-locked" },
      effects,
    )
    expect(locked).toBe(tt("zh", "bridge.qqbot.nameLocked"))

    const noPred = await runBridgeCommand(".bridge name 别名", false, view, {
      ...effects,
      hasCharacter: undefined,
    })
    expect(noPred).toBe(tt("zh", "bridge.qqbot.nameLocked"))
  })

  test(".bridge deferred reports queue length and oldest age", async () => {
    const view = {
      locale: "en" as const,
      groupId: "99",
      mode: "mention" as const,
      busyNotice: true,
      admins: ["1"],
      members: [],
      deferredSummary: { length: 3, oldestAgeMs: 45_000 },
    }
    const effects = {
      setMode() {},
      setBusyNotice() {},
      addAdmin() {},
      removeAdmin() {},
      kick: async () => {},
    }
    expect(await runBridgeCommand(".bridge deferred", true, view, effects)).toBe(
      tt("en", "bridge.qqbot.deferred", { count: 3, seconds: 45 }),
    )
    expect(
      await runBridgeCommand(".bridge deferred", true, { ...view, deferredSummary: { length: 0 } }, effects),
    ).toBe(tt("en", "bridge.qqbot.deferredEmpty"))
  })

  test("C2C claim issues a link privately; group claim completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-cmd-claim-"))
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "G")
    const admins: string[] = []
    const remints: string[] = []
    const effects = {
      setMode() {},
      setBusyNotice() {},
      addAdmin: (id: string) => {
        if (!admins.includes(id)) admins.push(id)
      },
      removeAdmin() {},
      kick: async () => {},
      identity,
      remintSeat: async (userId: string, displayName: string) => {
        remints.push(userId)
        return { name: displayName }
      },
    }
    const code = await identity.issueClaimCode()
    const c2c = await runBridgeCommand(".bridge claim " + code, false, {
      locale: "en",
      groupId: "G",
      mode: "mention",
      busyNotice: true,
      admins,
      members: [],
      channel: "private",
      userOpenid: "U1",
    }, effects)
    expect(c2c).toContain(".bridge claim")
    expect(admins).toEqual([])
    const issued = identity.pending[0]
    expect(issued).toBeDefined()

    const link = (c2c ?? "").match(/claim\s+([A-Z2-9]{6})/i)?.[1]
    expect(link).toBeTruthy()
    const group = await runBridgeCommand(`.bridge claim ${link}`, false, {
      locale: "en",
      groupId: "G",
      mode: "mention",
      busyNotice: true,
      admins,
      members: [],
      channel: "group",
      memberOpenid: "M1",
      username: "阿绫",
    }, effects)
    expect(group).toBe(tt("en", "bridge.qqbot.claimDone"))
    expect(admins).toEqual(["M1"])
    expect(remints).toEqual(["M1"])

    effects.removeAdmin = () => {
      admins.length = 0
    }
    await runBridgeCommand(".bridge admin remove M1", true, {
      locale: "en",
      groupId: "G",
      mode: "mention",
      busyNotice: true,
      admins,
      members: [],
    }, effects)
    expect(admins).toEqual([])
    remints.length = 0
    const againGroup = await runBridgeCommand(".bridge claim GARBAGE", false, {
      locale: "en",
      groupId: "G",
      mode: "mention",
      busyNotice: true,
      admins,
      members: [],
      channel: "group",
      memberOpenid: "M1",
    }, effects)
    expect(againGroup).toBe(tt("en", "bridge.qqbot.claimDone"))
    const againC2C = await runBridgeCommand(".bridge claim GARBAGE", false, {
      locale: "en",
      groupId: "G",
      mode: "mention",
      busyNotice: true,
      admins,
      members: [],
      channel: "private",
      userOpenid: "U1",
    }, effects)
    expect(againC2C).toBe(tt("en", "bridge.qqbot.claimDone"))
    expect(admins).toEqual([])
    expect(remints).toEqual([])
  })

  test("a mint failure on group claim does not addAdmin and answers seatFailed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-cmd-mintfail-"))
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "G")
    const admins: string[] = []
    const effects = {
      setMode() {},
      setBusyNotice() {},
      addAdmin: (id: string) => {
        admins.push(id)
      },
      removeAdmin() {},
      kick: async () => {},
      identity,
      remintSeat: async () => {
        throw new Error("admin_mint_key timed out")
      },
      onLog() {},
    }
    const code = await identity.issueClaimCode()
    const c2c = await runBridgeCommand(`.bridge claim ${code}`, false, {
      locale: "en",
      groupId: "G",
      mode: "mention",
      busyNotice: true,
      admins,
      members: [],
      channel: "private",
      userOpenid: "U1",
    }, effects)
    const link = (c2c ?? "").match(/claim\s+([A-Z2-9]{6})/i)?.[1]
    const group = await runBridgeCommand(`.bridge claim ${link}`, false, {
      locale: "en",
      groupId: "G",
      mode: "mention",
      busyNotice: true,
      admins,
      members: [],
      channel: "group",
      memberOpenid: "M1",
    }, effects)
    expect(group).toBe(tt("en", "bridge.seatFailed"))
    expect(admins).toEqual([])
  })
})
