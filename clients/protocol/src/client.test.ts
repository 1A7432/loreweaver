import { describe, expect, test } from "bun:test"
import { FrameType, type NarrativeFrame, type StateFrame } from "./types"
import { packMediaMessage, unpackMediaMessage, WsClient, type WebSocketLike } from "./client"

type Listener = (event: any) => void

class MockWebSocket implements WebSocketLike {
  readonly url: string
  readyState = 0
  sent: Array<string | Uint8Array | ArrayBuffer> = []
  private listeners = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
    queueMicrotask(() => {
      this.readyState = 1
      this.emit("open", {})
    })
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit("close", {})
  }

  serverSend(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) })
  }

  // Deliver a raw payload verbatim (bypasses JSON.stringify) so tests can feed
  // malformed / non-JSON bytes straight into the client's message handler.
  serverSendRaw(data: string): void {
    this.emit("message", { data })
  }

  serverSendBinary(data: Uint8Array): void {
    this.emit("message", { data })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function createClient(): { client: WsClient; sockets: MockWebSocket[] } {
  const sockets: MockWebSocket[] = []
  const client = new WsClient({
    reconnect: false,
    webSocketFactory: (url) => {
      const socket = new MockWebSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  return { client, sockets }
}

describe("WsClient", () => {
  test("connect -> join sends the join frame", async () => {
    const { client, sockets } = createClient()

    await client.connect("ws://example.test")
    client.join("room-key", "Ada")

    expect(sockets[0].url).toBe("ws://example.test")
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: FrameType.Join,
      key: "room-key",
      name: "Ada",
    })
  })

  test("join includes client info when configured", async () => {
    const sockets: MockWebSocket[] = []
    const client = new WsClient({
      reconnect: false,
      clientInfo: { name: "loreweaver-tui", version: "0.5.1.dev2+gabcdef0" },
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url)
        sockets.push(socket)
        return socket
      },
    })

    await client.connect("ws://example.test")
    client.join("room-key", "Ada")

    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: FrameType.Join,
      key: "room-key",
      name: "Ada",
      client: { name: "loreweaver-tui", version: "0.5.1.dev2+gabcdef0" },
    })
  })

  test("incoming frames are parsed and dispatched by type", async () => {
    const { client, sockets } = createClient()
    const narrativeFrames: NarrativeFrame[] = []
    const allFrames: string[] = []

    client.on(FrameType.Narrative, (frame) => narrativeFrames.push(frame))
    client.on(FrameType.AudioControl, (frame) => allFrames.push(`${frame.type}:${frame.layer}`))
    client.onMessage((frame) => allFrames.push(frame.type))

    await client.connect("ws://example.test")
    sockets[0].serverSend({
      type: FrameType.Narrative,
      id: "n1",
      speaker: "kp",
      text: "The door opens.",
      format: "markdown",
    })
    sockets[0].serverSend({
      type: FrameType.State,
      party: [],
      initiative: [],
      online: 1,
    } satisfies StateFrame)
    sockets[0].serverSend({
      type: FrameType.AudioControl,
      id: "a1",
      action: "play",
      layer: "bgm",
      hash: "c".repeat(64),
      mime: "audio/mpeg",
      name: "theme.mp3",
    })

    expect(narrativeFrames).toHaveLength(1)
    expect(narrativeFrames[0].text).toBe("The door opens.")
    expect(allFrames).toEqual([FrameType.Narrative, FrameType.State, FrameType.AudioControl, `${FrameType.AudioControl}:bgm`])
  })

  test("media upload offer sends binary put after accept", async () => {
    const { client, sockets } = createClient()
    await client.connect("ws://example.test")

    const upload = client.uploadMedia({
      name: "handout.png",
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      sha256: "a".repeat(64),
    })
    expect(JSON.parse(sockets[0].sent[0] as string)).toEqual({
      type: FrameType.MediaOffer,
      name: "handout.png",
      mime: "image/png",
      size: 3,
      sha256: "a".repeat(64),
    })

    sockets[0].serverSend({ type: FrameType.MediaAccept, upload_id: "up-1" })
    await upload
    const binary = sockets[0].sent[1] as Uint8Array
    const unpacked = unpackMediaMessage(binary)
    expect(unpacked.header).toEqual({ op: "put", upload_id: "up-1" })
    expect(Array.from(unpacked.body)).toEqual([1, 2, 3])
  })

  test("media get resolves from a binary response", async () => {
    const { client, sockets } = createClient()
    await client.connect("ws://example.test")

    const pending = client.getMedia("b".repeat(64))
    const request = unpackMediaMessage(sockets[0].sent[0] as Uint8Array)
    expect(request.header).toEqual({ op: "get", hash: "b".repeat(64) })

    sockets[0].serverSendBinary(
      packMediaMessage({ op: "get", hash: "b".repeat(64), mime: "image/png", name: "a.png", size: 2 }, new Uint8Array([9, 8])),
    )
    await expect(pending).resolves.toEqual({
      hash: "b".repeat(64),
      mime: "image/png",
      name: "a.png",
      bytes: new Uint8Array([9, 8]),
    })
  })

  test("malformed frames are validated per type and dropped, not dispatched", async () => {
    const { client, sockets } = createClient()
    const seen: string[] = []
    client.onMessage((frame) => seen.push(frame.type))

    await client.connect("ws://example.test")

    // Right `type`, but missing the load-bearing fields the consumers read.
    sockets[0].serverSend({ type: FrameType.State }) // no party / initiative
    sockets[0].serverSend({ type: FrameType.Narrative, id: "x" }) // no speaker / text
    sockets[0].serverSend({ type: FrameType.System, level: "info" }) // no text
    sockets[0].serverSend({ type: "totally-unknown" }) // unknown type
    // A well-formed frame of the same types still gets through untouched.
    sockets[0].serverSend({
      type: FrameType.State,
      party: [],
      initiative: [],
      online: 1,
    } satisfies StateFrame)

    expect(seen).toEqual([FrameType.State])
  })

  test("a non-JSON message is ignored without throwing", async () => {
    const { client, sockets } = createClient()
    const seen: string[] = []
    client.onMessage((frame) => seen.push(frame.type))

    await client.connect("ws://example.test")

    expect(() => sockets[0].serverSendRaw("<<< not json >>>")).not.toThrow()
    expect(() => sockets[0].serverSendRaw("")).not.toThrow()
    expect(seen).toEqual([])
  })

  test("incoming ping auto-sends pong", async () => {
    const { client, sockets } = createClient()

    await client.connect("ws://example.test")
    sockets[0].serverSend({ type: FrameType.Ping, t: 123 })

    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: FrameType.Pong,
      t: 123,
    })
  })

  test("admin request helpers send the v1.1 admin frames", async () => {
    const { client, sockets } = createClient()
    await client.connect("ws://example.test")

    client.adminGetConfig()
    client.adminSetModel("deepseek", "deepseek-chat")
    client.adminSetModel("openai")
    client.adminListKeys()
    client.adminMintKey("arkham", "Ada", "keeper")
    client.adminUpdateKey("kid-1", "dunwich", "Beth", "player")
    client.adminDeleteKey("kid-1")
    client.adminDeleteRoom("dunwich")
    client.adminExportRoom("dunwich", "/tmp/dunwich.json")
    client.adminImportRoom("/tmp/dunwich.json", "dunwich-restored")
    client.adminDeleteRoomData("dunwich", true, "/tmp/dunwich-delete.json")

    expect(sockets[0].sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: FrameType.AdminGetConfig },
      { type: FrameType.AdminSetModel, provider: "deepseek", chat_model: "deepseek-chat" },
      { type: FrameType.AdminSetModel, provider: "openai" },
      { type: FrameType.AdminListKeys },
      { type: FrameType.AdminMintKey, room: "arkham", name: "Ada", role: "keeper" },
      { type: FrameType.AdminUpdateKey, id: "kid-1", room: "dunwich", name: "Beth", role: "player" },
      { type: FrameType.AdminDeleteKey, id: "kid-1" },
      { type: FrameType.AdminDeleteRoom, room: "dunwich" },
      { type: FrameType.AdminExportRoom, room: "dunwich", path: "/tmp/dunwich.json" },
      { type: FrameType.AdminImportRoom, path: "/tmp/dunwich.json", room: "dunwich-restored" },
      { type: FrameType.AdminDeleteRoomData, room: "dunwich", backup: true, path: "/tmp/dunwich-delete.json" },
    ])
  })

  test("admin plugin-management helpers (B.4a) send the right frames", async () => {
    const { client, sockets } = createClient()
    await client.connect("ws://example.test")

    client.adminListSkills()
    client.adminEnableSkill("mature-mode", true)
    client.adminEnableSkill("mature-mode", false)
    client.adminListRules()
    client.adminGenerate("skill", "a grim survival horror campaign")
    client.adminGenerate("rule", "a pulp adventure system")
    client.adminGenerate("module", "a marsh mystery")

    expect(sockets[0].sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: FrameType.AdminListSkills },
      { type: FrameType.AdminEnableSkill, id: "mature-mode", on: true },
      { type: FrameType.AdminEnableSkill, id: "mature-mode", on: false },
      { type: FrameType.AdminListRules },
      { type: FrameType.AdminGenerate, kind: "skill", description: "a grim survival horror campaign" },
      { type: FrameType.AdminGenerate, kind: "rule", description: "a pulp adventure system" },
      { type: FrameType.AdminGenerate, kind: "module", description: "a marsh mystery" },
    ])
  })

  test("adminSetModel carries the key/base_url + adminListModels send the new admin frames", async () => {
    const { client, sockets } = createClient()
    await client.connect("ws://example.test")

    client.adminSetModel("deepseek", "deepseek-chat", "sk-live", "https://api.deepseek.com/v1")
    client.adminSetModel("openai", undefined, "sk-openai")
    client.adminSetModel("openai", undefined, "", "")
    client.adminListModels("deepseek", "sk-live")
    client.adminListModels("openai", "", "")
    client.adminListModels()

    expect(sockets[0].sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: FrameType.AdminSetModel,
        provider: "deepseek",
        chat_model: "deepseek-chat",
        api_key: "sk-live",
        base_url: "https://api.deepseek.com/v1",
      },
      { type: FrameType.AdminSetModel, provider: "openai", api_key: "sk-openai" },
      { type: FrameType.AdminSetModel, provider: "openai", api_key: "", base_url: "" },
      { type: FrameType.AdminListModels, provider: "deepseek", api_key: "sk-live" },
      { type: FrameType.AdminListModels, provider: "openai", api_key: "", base_url: "" },
      { type: FrameType.AdminListModels },
    ])
  })

  test("incoming admin_config / admin_models / admin_keys / admin_room_op / admin_error frames are dispatched", async () => {
    const { client, sockets } = createClient()
    const seen: string[] = []
    client.on(FrameType.AdminConfig, () => seen.push(FrameType.AdminConfig))
    client.on(FrameType.AdminModels, () => seen.push(FrameType.AdminModels))
    client.on(FrameType.AdminKeys, () => seen.push(FrameType.AdminKeys))
    client.on(FrameType.AdminRoomOp, () => seen.push(FrameType.AdminRoomOp))
    client.on(FrameType.AdminError, () => seen.push(FrameType.AdminError))

    await client.connect("ws://example.test")
    sockets[0].serverSend({
      type: FrameType.AdminConfig,
      provider: "openai",
      chat_model: "gpt-4o",
      base_url: "",
      api_key_masked: "",
      providers: ["openai", "deepseek"],
      saved_providers: ["openai"],
      override_active: false,
    })
    sockets[0].serverSend({ type: FrameType.AdminModels, provider: "openai", models: ["gpt-4o", "gpt-4o-mini"] })
    sockets[0].serverSend({ type: FrameType.AdminKeys, keys: [] })
    sockets[0].serverSend({
      type: FrameType.AdminRoomOp,
      action: "export",
      room: "arkham",
      path: "/tmp/arkham.json",
      keys: 1,
      store_rows: 2,
      vector_points: 3,
      media_files: 4,
    })
    sockets[0].serverSend({ type: FrameType.AdminError, code: "forbidden" })

    expect(seen).toEqual([
      FrameType.AdminConfig,
      FrameType.AdminModels,
      FrameType.AdminKeys,
      FrameType.AdminRoomOp,
      FrameType.AdminError,
    ])
  })

  test("incoming admin_skills / admin_rules / admin_generated frames (B.4a) are dispatched", async () => {
    const { client, sockets } = createClient()
    const seen: string[] = []
    client.on(FrameType.AdminSkills, () => seen.push(FrameType.AdminSkills))
    client.on(FrameType.AdminRules, () => seen.push(FrameType.AdminRules))
    client.on(FrameType.AdminGenerated, () => seen.push(FrameType.AdminGenerated))

    await client.connect("ws://example.test")
    sockets[0].serverSend({
      type: FrameType.AdminSkills,
      skills: [
        { id: "mature-mode", name: "Mature mode", description: "...", content_rating: "explicit", enabled: false },
      ],
    })
    sockets[0].serverSend({
      type: FrameType.AdminRules,
      systems: [
        { id: "coc7", built_in: true },
        { id: "dnd5e", built_in: true },
      ],
    })
    sockets[0].serverSend({
      type: FrameType.AdminGenerated,
      kind: "skill",
      ok: true,
      id: "grim-survival-horror",
      name: "Grim Survival Horror",
      error: "",
    })
    // Malformed variants of each are dropped, not dispatched.
    sockets[0].serverSendRaw(JSON.stringify({ type: FrameType.AdminSkills })) // no `skills`
    sockets[0].serverSendRaw(JSON.stringify({ type: FrameType.AdminRules })) // no `systems`
    sockets[0].serverSendRaw(JSON.stringify({ type: FrameType.AdminGenerated, kind: "skill" })) // no `ok`

    expect(seen).toEqual([FrameType.AdminSkills, FrameType.AdminRules, FrameType.AdminGenerated])
  })

  test("onStatus reports online on connect, offline on a manual close", async () => {
    const { client } = createClient()
    const statuses: string[] = []
    client.onStatus((status) => statuses.push(status))

    await client.connect("ws://example.test")
    expect(statuses).toEqual(["connecting", "online"])

    client.close()
    expect(statuses).toEqual(["connecting", "online", "offline"])
  })

  test("onStatus goes reconnecting -> online across an unexpected drop, and re-sends the last join", async () => {
    const sockets: MockWebSocket[] = []
    const client = new WsClient({
      reconnect: true,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url)
        sockets.push(socket)
        return socket
      },
    })
    const statuses: string[] = []
    client.onStatus((status) => statuses.push(status))

    await client.connect("ws://example.test")
    client.join("room-key", "Ada")
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: FrameType.Join, key: "room-key", name: "Ada" })
    expect(statuses).toEqual(["connecting", "online"])

    // The server hangs up unexpectedly (not a manual close) — the socket itself fires
    // "close", independent of anyone calling `client.close()`.
    sockets[0].close()
    expect(statuses).toEqual(["connecting", "online", "reconnecting"])

    // After the backoff, a fresh socket dials in and the last join is auto-resent.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sockets.length).toBe(2)
    expect(JSON.parse(sockets[1].sent[0])).toEqual({ type: FrameType.Join, key: "room-key", name: "Ada" })
    expect(statuses).toEqual(["connecting", "online", "reconnecting", "connecting", "online"])
  })
})
