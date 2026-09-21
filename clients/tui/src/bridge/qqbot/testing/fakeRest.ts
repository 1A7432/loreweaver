import { TOKEN_OVERLAP_WINDOW_S } from "../constants"
import { filesSuccess, sendSuccess, uploadPrepareSuccess } from "./fixtures"

export interface FakeRestCall {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

export interface FakeSendAnswer {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export interface FakeQQBotRestOptions {
  appId?: string
  clientSecret?: string
  accessToken?: string
  /** Official example returns this as a string. */
  expiresIn?: number | string
  gatewayUrl?: string
  /** When set, a token request inside this many seconds of expiry issues a NEW token. Default 60. */
  overlapWindowS?: number
  /** When true, every token request returns the original token (spec "same token is not refreshed"). */
  stickyToken?: boolean
  now?: () => number
  sendHandler?: (call: FakeRestCall) => FakeSendAnswer | undefined
  filesHandler?: (call: FakeRestCall) => FakeSendAnswer | undefined
}

type WsData = Record<string, never>

/**
 * Bun.serve HTTP double of the official REST surface: token, /gateway/bot,
 * group/C2C messages, files, upload_prepare / upload_part_finish, and presigned PUTs.
 * Shapes from the autogen pages, not botpy.
 */
export class FakeQQBotRest {
  readonly calls: FakeRestCall[] = []
  readonly uploadedParts = new Map<string, Uint8Array>()
  readonly finishedParts: Array<{ uploadId: string; partIndex: number; md5?: string }> = []
  accessToken: string
  expiresIn: number
  nextToken?: string
  sendAnswer: FakeSendAnswer = { status: 200, body: sendSuccess() }
  filesAnswer: FakeSendAnswer = { status: 200, body: filesSuccess() }
  hangSend = false
  tokenStatus = 200
  tokenBody: Record<string, unknown> | undefined
  gatewayStatus = 200
  private server: ReturnType<typeof Bun.serve<WsData>>
  private issuedAt: number
  private readonly appId: string
  private readonly clientSecret: string
  private readonly overlapWindowS: number
  private readonly now: () => number
  private readonly sendHandler?: (call: FakeRestCall) => FakeSendAnswer | undefined
  private readonly filesHandler?: (call: FakeRestCall) => FakeSendAnswer | undefined
  private readonly stickyToken: boolean
  private tokenIssueCount = 0
  gatewayUrlOverride?: string

  constructor(opts: FakeQQBotRestOptions = {}) {
    this.appId = opts.appId ?? "102000000"
    this.clientSecret = opts.clientSecret ?? "test-secret"
    this.accessToken = opts.accessToken ?? "ACCESS_TOKEN"
    this.expiresIn = typeof opts.expiresIn === "string" ? Number(opts.expiresIn) : (opts.expiresIn ?? 7200)
    this.overlapWindowS = opts.overlapWindowS ?? TOKEN_OVERLAP_WINDOW_S
    this.now = opts.now ?? (() => Date.now())
    this.issuedAt = this.now()
    this.sendHandler = opts.sendHandler
    this.filesHandler = opts.filesHandler
    this.stickyToken = opts.stickyToken ?? false
    this.gatewayUrlOverride = opts.gatewayUrl
    const self = this
    this.server = Bun.serve<WsData>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        return await self.handle(req)
      },
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  get authBase(): string {
    return this.url
  }

  get apiBase(): string {
    return this.url
  }

  get tokenCalls(): FakeRestCall[] {
    return this.calls.filter((call) => call.path === "/app/getAppAccessToken")
  }

  close(): void {
    try {
      this.server.stop(true)
    } catch {
      // already gone
    }
  }

  /** Force the next token request to mint a new value (simulates the 60 s overlap). */
  rotateToken(next = `ACCESS_TOKEN_${this.tokenIssueCount + 1}`): void {
    this.nextToken = next
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    let body: unknown
    if (req.method !== "GET" && req.method !== "HEAD") {
      const buf = new Uint8Array(await req.arrayBuffer())
      if (req.method === "PUT") {
        body = buf
      } else {
        const text = new TextDecoder().decode(buf)
        try {
          body = text ? JSON.parse(text) : undefined
        } catch {
          body = text
        }
      }
    }
    const call: FakeRestCall = { method: req.method, path, headers, body }
    this.calls.push(call)

    if (path === "/app/getAppAccessToken" && req.method === "POST") {
      return this.handleToken(body)
    }
    if (path === "/gateway/bot" && req.method === "GET") {
      if (this.gatewayStatus !== 200) {
        return jsonResponse(this.gatewayStatus, { code: this.gatewayStatus, message: "gateway failed" })
      }
      return jsonResponse(200, {
        url: this.gatewayUrlOverride ?? `${this.url.replace("http", "ws")}/gateway`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 86400000, max_concurrency: 1 },
      })
    }
    if (req.method === "PUT" && path.startsWith("/upload/part/")) {
      this.uploadedParts.set(path, body instanceof Uint8Array ? body : new Uint8Array())
      return new Response("", { status: 200 })
    }

    const groupPrepare = matchPath(path, "/v2/groups/", "/upload_prepare")
    const userPrepare = matchPath(path, "/v2/users/", "/upload_prepare")
    if (req.method === "POST" && (groupPrepare || userPrepare)) {
      const blockSize = String(Math.min(Number((body as { file_size?: string })?.file_size ?? 0) || 5 * 1024 * 1024, 5 * 1024 * 1024))
      const size = Number((body as { file_size?: string })?.file_size ?? 0)
      const chunk = Number(blockSize)
      const count = Math.max(1, Math.ceil((size || chunk) / chunk))
      const parts = Array.from({ length: count }, (_, index) => ({
        index,
        presigned_url: `${this.url}/upload/part/${index}`,
        block_size: String(index === count - 1 && size ? size - chunk * (count - 1) : chunk),
      }))
      return jsonResponse(200, {
        ...uploadPrepareSuccess(this.url, { parts, block_size: blockSize }),
        parts,
        block_size: blockSize,
      })
    }

    const groupFinish = matchPath(path, "/v2/groups/", "/upload_part_finish")
    const userFinish = matchPath(path, "/v2/users/", "/upload_part_finish")
    if (req.method === "POST" && (groupFinish || userFinish)) {
      const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
      this.finishedParts.push({
        uploadId: String(rec.upload_id ?? ""),
        partIndex: Number(rec.part_index ?? 0),
        md5: rec.md5 !== undefined ? String(rec.md5) : undefined,
      })
      return jsonResponse(200, {})
    }

    const groupFiles = matchPath(path, "/v2/groups/", "/files")
    const userFiles = matchPath(path, "/v2/users/", "/files")
    if (req.method === "POST" && (groupFiles || userFiles)) {
      const custom = this.filesHandler?.(call)
      const answer = custom ?? this.filesAnswer
      return jsonResponse(answer.status, answer.body, answer.headers)
    }

    const groupMsg = matchPath(path, "/v2/groups/", "/messages")
    const userMsg = matchPath(path, "/v2/users/", "/messages")
    if (req.method === "POST" && (groupMsg || userMsg)) {
      if (this.hangSend) return new Promise<Response>(() => {})
      const custom = this.sendHandler?.(call)
      const answer = custom ?? this.sendAnswer
      return jsonResponse(answer.status, answer.body, answer.headers)
    }

    return jsonResponse(404, { code: 404, message: "not found" })
  }

  private handleToken(body: unknown): Response {
    if (this.tokenStatus !== 200) {
      return jsonResponse(this.tokenStatus, this.tokenBody ?? { code: this.tokenStatus, message: "auth failed" })
    }
    if (this.tokenBody) return jsonResponse(200, this.tokenBody)
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    if (String(rec.appId ?? "") !== this.appId || String(rec.clientSecret ?? "") !== this.clientSecret) {
      return jsonResponse(401, { code: 401, message: "invalid appId or clientSecret" })
    }
    this.tokenIssueCount += 1
    const elapsedS = (this.now() - this.issuedAt) / 1000
    const remaining = this.expiresIn - elapsedS
    if (!this.stickyToken && (this.nextToken || remaining <= this.overlapWindowS)) {
      if (this.nextToken) {
        this.accessToken = this.nextToken
        this.nextToken = undefined
      } else {
        this.accessToken = `ACCESS_TOKEN_${this.tokenIssueCount}`
      }
      this.issuedAt = this.now()
    }
    // Official example types expires_in as a string.
    return jsonResponse(200, { access_token: this.accessToken, expires_in: String(this.expiresIn) })
  }
}

function matchPath(path: string, prefix: string, suffix: string): boolean {
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false
  const mid = path.slice(prefix.length, path.length - suffix.length)
  return mid.length > 0 && !mid.includes("/")
}

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  })
}

export function startFakeQQBotRest(opts?: FakeQQBotRestOptions): FakeQQBotRest {
  return new FakeQQBotRest(opts)
}
