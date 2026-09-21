import { describe, expect, test } from "bun:test"
import { BridgeConfigError, isWsUrl, onebotTimeoutsMs, parseBridgeConfig } from "./config"

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
    expect(cfg.onebot!.mode).toBe("forward")
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

  test("access_token is required in both modes, loopback included", () => {
    const missing = [
      { mode: "forward", ws_url: "ws://127.0.0.1:3001" },
      { mode: "forward", ws_url: "ws://127.0.0.1:3001", access_token: "   " },
      { mode: "reverse", listen_host: "0.0.0.0", listen_port: 6700 },
      { mode: "reverse", listen_host: "127.0.0.1", listen_port: 6700 },
    ]
    for (const onebot of missing) {
      expect(() => parseBridgeConfig({ groups: base.groups, onebot })).toThrow(BridgeConfigError)
      try {
        parseBridgeConfig({ groups: base.groups, onebot })
      } catch (error) {
        expect((error as BridgeConfigError).code).toBe("token_required")
      }
    }
    const ok = parseBridgeConfig({
      groups: base.groups,
      onebot: { mode: "reverse", listen_host: "0.0.0.0", listen_port: 6700, access_token: "secret" },
    })
    expect(ok.onebot!.mode).toBe("reverse")
    expect(ok.onebot!.access_token).toBe("secret")
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
        onebot: { mode: "reverse", listen_host: "127.0.0.1", listen_port: 1, path: "onebot", access_token: "tok" },
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_reverse_path")
      return
    }
    throw new Error("expected invalid_reverse_path")
  })

  test("OneBot timeouts are seconds in JSON and convert to milliseconds", () => {
    const cfg = parseBridgeConfig(base)
    expect(cfg.onebot!.request_timeout).toBe(10)
    expect(cfg.onebot!.reconnect_delay).toBe(1)
    const ms = onebotTimeoutsMs(cfg.onebot!)
    expect(ms.requestTimeoutMs).toBe(10_000)
    expect(ms.reconnectDelayMs).toBe(1_000)
    const custom = parseBridgeConfig({
      ...base,
      onebot: { ...base.onebot, request_timeout: 7.5, reconnect_delay: 0 },
    })
    expect(onebotTimeoutsMs(custom.onebot!)).toEqual({ requestTimeoutMs: 7500, reconnectDelayMs: 0 })
    try {
      parseBridgeConfig({ ...base, onebot: { ...base.onebot, request_timeout: 0 } })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_timeout")
      return
    }
    throw new Error("expected invalid_timeout")
  })

  test("rejects a room_keeper_key reused by two groups", () => {
    try {
      parseBridgeConfig({
        onebot: base.onebot,
        keeper_key: "top",
        groups: [
          { group_id: 1, room_keeper_key: "same", admins: [] },
          { group_id: 2, room_keeper_key: "same", admins: [] },
        ],
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("duplicate_keeper_key")
      return
    }
    throw new Error("expected duplicate_keeper_key")
  })

  test("one group may use the top-level keeper_key; two groups may not share it", () => {
    const ok = parseBridgeConfig({
      onebot: base.onebot,
      keeper_key: "shared",
      groups: [
        { group_id: 1, room_keeper_key: "shared", admins: [] },
        { group_id: 2, room_keeper_key: "other", admins: [] },
      ],
    })
    expect(ok.groups).toHaveLength(2)
    try {
      parseBridgeConfig({
        onebot: base.onebot,
        keeper_key: "shared",
        groups: [
          { group_id: 1, room_keeper_key: "shared", admins: [] },
          { group_id: 2, room_keeper_key: "shared", admins: [] },
        ],
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("duplicate_keeper_key")
      return
    }
    throw new Error("expected duplicate_keeper_key")
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

  test("platform defaults to onebot so an M24 config keeps working", () => {
    const cfg = parseBridgeConfig(base)
    expect(cfg.platform).toBe("onebot")
    expect(cfg.onebot?.mode).toBe("forward")
    expect(cfg.qqbot).toBeUndefined()
  })
})

const qqbotBase = {
  platform: "qqbot" as const,
  qqbot: { app_id: "102000000", client_secret: "super-secret-value-never-echo" },
  groups: [{ group_openid: "B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5", mode: "mention" as const }],
}

describe("bridge config — qqbot platform", () => {
  test("parses the spec sample with defaults", () => {
    const cfg = parseBridgeConfig({
      ...qqbotBase,
      locale: "zh",
      busy_notice: true,
      idle_close_minutes: 30,
      state_dir: "~/.loreweaver/bridge",
    })
    expect(cfg.platform).toBe("qqbot")
    expect(cfg.onebot).toBeUndefined()
    expect(cfg.qqbot).toEqual({
      app_id: "102000000",
      client_secret: "super-secret-value-never-echo",
      transport: "websocket",
      receive_all: false,
      max_chunk_chars: 2800,
      url_whitelist: [],
      media_public_base_url: null,
      bot_qpm: 30,
      send_timeout: 5,
    })
    expect(cfg.groups[0]!.group_id).toBe("B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5")
    expect(cfg.groups[0]!.admins).toEqual([])
    expect(cfg.groups[0]!.mode).toBe("mention")
  })

  test("maps group_openid to group_id and accepts an admins seed", () => {
    const cfg = parseBridgeConfig({
      ...qqbotBase,
      groups: [
        {
          group_openid: "G-OPEN",
          room_keeper_key: "rk",
          admins: ["M-AAA", "M-BBB"],
        },
      ],
    })
    expect(cfg.groups[0]).toMatchObject({
      group_id: "G-OPEN",
      room_keeper_key: "rk",
      admins: ["M-AAA", "M-BBB"],
    })
  })

  test("onebot and qqbot blocks together are platform_mismatch", () => {
    try {
      parseBridgeConfig({
        platform: "qqbot",
        onebot: base.onebot,
        qqbot: qqbotBase.qqbot,
        groups: qqbotBase.groups,
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("platform_mismatch")
      expect((error as Error).message).not.toContain("super-secret")
      return
    }
    throw new Error("expected platform_mismatch")
  })

  test("platform qqbot with an onebot block is platform_mismatch", () => {
    try {
      parseBridgeConfig({
        platform: "qqbot",
        onebot: base.onebot,
        groups: qqbotBase.groups,
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("platform_mismatch")
      return
    }
    throw new Error("expected platform_mismatch")
  })

  test("platform onebot with a qqbot block is platform_mismatch", () => {
    try {
      parseBridgeConfig({
        platform: "onebot",
        qqbot: qqbotBase.qqbot,
        groups: base.groups,
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("platform_mismatch")
      expect((error as Error).message).not.toContain("super-secret-value-never-echo")
      return
    }
    throw new Error("expected platform_mismatch")
  })

  test("unknown platform is invalid_platform", () => {
    try {
      parseBridgeConfig({ platform: "discord", onebot: base.onebot, groups: base.groups })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_platform")
      return
    }
    throw new Error("expected invalid_platform")
  })

  test("client_secret is required and never appears in the error text", () => {
    const secret = "super-secret-value-never-echo"
    const cases = [
      { app_id: "102000000" },
      { app_id: "102000000", client_secret: "   " },
    ]
    for (const qqbot of cases) {
      try {
        parseBridgeConfig({ platform: "qqbot", qqbot, groups: qqbotBase.groups })
      } catch (error) {
        expect((error as BridgeConfigError).code).toBe("secret_required")
        expect((error as Error).message).not.toContain(secret)
        expect(JSON.stringify(error)).not.toContain(secret)
        continue
      }
      throw new Error("expected secret_required")
    }
  })

  test("a qqbot group without group_openid is invalid_group", () => {
    try {
      parseBridgeConfig({
        platform: "qqbot",
        qqbot: qqbotBase.qqbot,
        groups: [{ group_id: "not-an-openid" }],
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_group")
      expect((error as Error).message).toContain("group_openid")
      return
    }
    throw new Error("expected invalid_group")
  })

  test("duplicate group_openid uses the same duplicate_group code", () => {
    try {
      parseBridgeConfig({
        platform: "qqbot",
        qqbot: qqbotBase.qqbot,
        groups: [{ group_openid: "G1" }, { group_openid: "G1" }],
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("duplicate_group")
      return
    }
    throw new Error("expected duplicate_group")
  })

  test("webhook transport is refused; send_timeout must be > 0", () => {
    try {
      parseBridgeConfig({
        ...qqbotBase,
        qqbot: { ...qqbotBase.qqbot, transport: "webhook" },
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_qqbot")
      expect((error as Error).message).not.toContain("super-secret-value-never-echo")
    }
    try {
      parseBridgeConfig({
        ...qqbotBase,
        qqbot: { ...qqbotBase.qqbot, send_timeout: 0 },
      })
    } catch (error) {
      expect((error as BridgeConfigError).code).toBe("invalid_timeout")
      return
    }
    throw new Error("expected invalid_timeout")
  })
})
