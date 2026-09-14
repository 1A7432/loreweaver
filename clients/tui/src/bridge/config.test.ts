import { describe, expect, test } from "bun:test"
import { BridgeConfigError, isLoopbackHost, isWsUrl, onebotTimeoutsMs, parseBridgeConfig } from "./config"

const base = {
  onebot: { mode: "forward" as const, ws_url: "ws://127.0.0.1:3001", access_token: "tok" },
  groups: [{ group_id: 123456789, admins: [11111111], mode: "mention" as const }],
}

describe("bridge config", () => {
  test("accepts the spec sample (forward ws URL, one group)", () => {
    const cfg = parseBridgeConfig({
      ...base,
      locale: "zh",
      busy_notice: true,
      idle_close_minutes: 30,
      state_dir: "~/.loreweaver/bridge",
    })
    expect(cfg.onebot.mode).toBe("forward")
    expect(cfg.groups).toHaveLength(1)
    expect(cfg.groups[0]!.group_id).toBe("123456789")
    expect(cfg.groups[0]!.admins).toEqual(["11111111"])
    expect(cfg.groups[0]!.mode).toBe("mention")
    expect(cfg.busy_notice).toBe(true)
    expect(cfg.locale).toBe("zh")
    expect(cfg.state_dir).toContain(".loreweaver")
  })

  test("rejects a non-ws URL", () => {
    expect(() => parseBridgeConfig({ ...base, onebot: { mode: "forward", ws_url: "https://example.test/ws" } })).toThrow(
      BridgeConfigError,
    )
    try {
      parseBridgeConfig({ ...base, onebot: { mode: "forward", ws_url: "not-a-url" } })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_ws_url")
    }
    expect(isWsUrl("ws://")).toBe(false)
    expect(isWsUrl("ws://example.test/path#fragment")).toBe(false)
    expect(isWsUrl("wss://napcat.local/ws")).toBe(true)
  })

  test("a non-loopback reverse listener requires access_token", () => {
    expect(() =>
      parseBridgeConfig({
        groups: base.groups,
        onebot: { mode: "reverse", listen_host: "0.0.0.0", listen_port: 6700 },
      }),
    ).toThrow(BridgeConfigError)
    try {
      parseBridgeConfig({
        groups: base.groups,
        onebot: { mode: "reverse", listen_host: "0.0.0.0", listen_port: 6700 },
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("reverse_token_required")
    }
    const ok = parseBridgeConfig({
      groups: base.groups,
      onebot: { mode: "reverse", listen_host: "0.0.0.0", listen_port: 6700, access_token: "secret" },
    })
    expect(ok.onebot.mode).toBe("reverse")
    const loopback = parseBridgeConfig({
      groups: base.groups,
      onebot: { mode: "reverse", listen_host: "127.0.0.1", listen_port: 6700 },
    })
    expect(loopback.onebot.mode).toBe("reverse")
    expect(isLoopbackHost("localhost")).toBe(true)
  })

  test("omitted locale is undefined so welcome.locale can win", () => {
    const cfg = parseBridgeConfig(base)
    expect(cfg.locale).toBeUndefined()
  })

  test("a ticket requires a keeper key", () => {
    try {
      parseBridgeConfig({ ...base, ticket: "endpointabc" })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("missing_keeper_key")
      return
    }
    throw new Error("expected missing_keeper_key")
  })

  test("more than one group requires per-group room_keeper_key", () => {
    try {
      parseBridgeConfig({
        onebot: base.onebot,
        keeper_key: "k",
        groups: [
          { group_id: 1, admins: [] },
          { group_id: 2, admins: [] },
        ],
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("missing_room_keeper_key")
      return
    }
    throw new Error("expected missing_room_keeper_key")
  })

  test("invalid idle_close_minutes has its own error code", () => {
    try {
      parseBridgeConfig({ ...base, idle_close_minutes: -1 })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_idle_close")
      return
    }
    throw new Error("expected invalid_idle_close")
  })

  test("reverse path must start with /", () => {
    try {
      parseBridgeConfig({
        groups: base.groups,
        onebot: { mode: "reverse", listen_host: "127.0.0.1", listen_port: 1, path: "onebot" },
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_reverse_path")
      return
    }
    throw new Error("expected invalid_reverse_path")
  })

  test("OneBot timeouts are seconds in JSON and convert to milliseconds", () => {
    const cfg = parseBridgeConfig(base)
    expect(cfg.onebot.request_timeout).toBe(10)
    expect(cfg.onebot.reconnect_delay).toBe(1)
    const ms = onebotTimeoutsMs(cfg.onebot)
    expect(ms.requestTimeoutMs).toBe(10_000)
    expect(ms.reconnectDelayMs).toBe(1_000)
    const custom = parseBridgeConfig({
      ...base,
      onebot: { ...base.onebot, request_timeout: 7.5, reconnect_delay: 0 },
    })
    expect(onebotTimeoutsMs(custom.onebot)).toEqual({ requestTimeoutMs: 7500, reconnectDelayMs: 0 })
    try {
      parseBridgeConfig({ ...base, onebot: { ...base.onebot, request_timeout: 0 } })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_timeout")
      return
    }
    throw new Error("expected invalid_timeout")
  })

  test("rejects duplicate group ids", () => {
    try {
      parseBridgeConfig({
        onebot: base.onebot,
        groups: [
          { group_id: 1, admins: [] },
          { group_id: "1", admins: [2] },
        ],
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("duplicate_group")
      return
    }
    throw new Error("expected duplicate_group")
  })
})
