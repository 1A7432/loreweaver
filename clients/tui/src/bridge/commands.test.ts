import { describe, expect, test } from "bun:test"
import { isBridgeCommand, looksLikeCommand, parseBridgeCommand, runBridgeCommand, shouldForwardInbound } from "./commands"
import { LastKeeperError } from "./keyring"

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
    expect(await runBridgeCommand(".bridge admin add 2", true, view(), effects)).toContain("2")
    expect(state.admins).toContain("2")
    expect(await runBridgeCommand(".bridge kick 8", true, view(), effects)).toContain("8")
    expect(state.kicked).toEqual(["8"])
    expect(await runBridgeCommand(".bridge status", false, view(), effects)).toContain("Only a room admin")
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
})
