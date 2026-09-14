import { describe, expect, test } from "bun:test"
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_REDIRECTS } from "./constants"
import {
  assertPublicAddresses,
  fetchAttachment,
  isPublicIp,
  type HttpGet,
  type HttpResponse,
  type ResolveAddresses,
} from "./fetch"
import { OneBotAttachmentNotFound, OneBotError } from "./shared"

class FakeResponse implements HttpResponse {
  statusChecked = false
  bodyRead = false
  readonly status: number
  readonly headers: Headers
  private readonly chunks: Uint8Array[]
  private readonly slowMs: number

  constructor(
    chunks: Array<Uint8Array | string>,
    opts: { status?: number; headers?: Record<string, string>; slowMs?: number } = {},
  ) {
    this.chunks = chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))
    this.status = opts.status ?? 200
    this.headers = new Headers(opts.headers)
    this.slowMs = opts.slowMs ?? 0
  }

  raiseForStatus(): void {
    this.statusChecked = true
    if (this.status >= 400) throw new Error(`http.${this.status}`)
  }

  get body(): AsyncIterable<Uint8Array> {
    const chunks = this.chunks
    const slowMs = this.slowMs
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        self.bodyRead = true
        if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs))
        for (const chunk of chunks) yield chunk
      },
    }
  }
}

class FakeHttp {
  readonly urls: string[] = []
  readonly inits: Array<{ redirect: "manual" }> = []
  constructor(private readonly responses: FakeResponse[]) {}
  get: HttpGet = async (url, init) => {
    this.urls.push(url)
    this.inits.push({ redirect: init.redirect })
    const response = this.responses.shift()
    if (!response) throw new Error("no fake response")
    return response
  }
}

const publicDns: ResolveAddresses = async () => ["93.184.216.34"]

describe("fetchAttachment — happy path", () => {
  test("streams a public HTTP URL without following redirects automatically", async () => {
    const response = new FakeResponse(["im", "age"])
    const http = new FakeHttp([response])
    const data = await fetchAttachment("https://cdn.example/map.png", {
      resolveAddresses: publicDns,
      httpGet: http.get,
    })
    expect(Buffer.from(data).toString()).toBe("image")
    expect(http.urls).toEqual(["https://cdn.example/map.png"])
    expect(http.inits).toEqual([{ redirect: "manual" }])
    expect(response.statusChecked).toBe(true)
  })
})

describe("fetchAttachment — literal unsafe URLs rejected before any request", () => {
  const urls = [
    "http://127.0.0.1/private",
    "http://10.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/private",
    "https://user:password@8.8.8.8/private",
    "https://8.8.8.8/file#fragment",
  ]
  for (const url of urls) {
    test(url, async () => {
      const http = new FakeHttp([new FakeResponse(["secret"])])
      await expect(fetchAttachment(url, { httpGet: http.get, resolveAddresses: publicDns })).rejects.toMatchObject({
        code: "onebot.attachment.unsafe_url",
      })
      expect(http.urls).toEqual([])
    })
  }
})

describe("fetchAttachment — DNS answers", () => {
  test("a hostname with ANY private DNS answer is rejected before the request", async () => {
    const http = new FakeHttp([new FakeResponse(["secret"])])
    const resolve: ResolveAddresses = async () => ["93.184.216.34", "127.0.0.1"]
    await expect(
      fetchAttachment("https://mixed.example/file", { httpGet: http.get, resolveAddresses: resolve }),
    ).rejects.toMatchObject({ code: "onebot.attachment.unsafe_url" })
    expect(http.urls).toEqual([])
  })

  test("assertPublicAddresses throws unsafe_address on a DNS-rebinding set", () => {
    expect(() => assertPublicAddresses(["93.184.216.34", "169.254.169.254"])).toThrow(OneBotError)
    try {
      assertPublicAddresses(["93.184.216.34", "169.254.169.254"])
    } catch (err) {
      expect((err as OneBotError).code).toBe("onebot.attachment.unsafe_address")
    }
  })
})

describe("fetchAttachment — redirects", () => {
  test("validates every redirect hop before following", async () => {
    const http = new FakeHttp([
      new FakeResponse([], { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
      new FakeResponse(["secret"]),
    ])
    await expect(
      fetchAttachment("https://public.example/redirect", { httpGet: http.get, resolveAddresses: publicDns }),
    ).rejects.toMatchObject({ code: "onebot.attachment.unsafe_url" })
    expect(http.urls).toEqual(["https://public.example/redirect"])
  })

  test("follows a bounded public redirect", async () => {
    const http = new FakeHttp([
      new FakeResponse([], { status: 307, headers: { Location: "https://8.8.8.8/final" } }),
      new FakeResponse(["public"]),
    ])
    const data = await fetchAttachment("https://public.example/redirect", {
      httpGet: http.get,
      resolveAddresses: publicDns,
    })
    expect(Buffer.from(data).toString()).toBe("public")
    expect(http.urls).toEqual(["https://public.example/redirect", "https://8.8.8.8/final"])
  })

  test("stops after the bounded redirect count", async () => {
    const hops = Array.from({ length: MAX_ATTACHMENT_REDIRECTS + 1 }, (_, i) =>
      new FakeResponse([], { status: 302, headers: { Location: `https://8.8.8.8/h${i}` } }),
    )
    const http = new FakeHttp(hops)
    await expect(
      fetchAttachment("https://8.8.8.8/start", { httpGet: http.get, resolveAddresses: publicDns }),
    ).rejects.toMatchObject({ code: "onebot.attachment.redirect.invalid" })
    expect(http.urls).toHaveLength(MAX_ATTACHMENT_REDIRECTS + 1)
  })
})

describe("fetchAttachment — size and timeout", () => {
  test("rejects oversize Content-Length before streaming", async () => {
    const response = new FakeResponse(["not-read"], {
      headers: { "Content-Length": String(20 * 1024 * 1024 + 1) },
    })
    const http = new FakeHttp([response])
    await expect(fetchAttachment("https://8.8.8.8/large", { httpGet: http.get })).rejects.toMatchObject({
      code: "onebot.attachment.too_large",
    })
    expect(response.bodyRead).toBe(false)
  })

  test("aborts an oversize body even without Content-Length", async () => {
    const response = new FakeResponse([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)])
    const http = new FakeHttp([response])
    await expect(fetchAttachment("https://8.8.8.8/chunky", { httpGet: http.get })).rejects.toMatchObject({
      code: "onebot.attachment.too_large",
    })
    expect(response.bodyRead).toBe(true)
  })

  test("the whole-chain timeout covers a slow body", async () => {
    const response = new FakeResponse(["late"], { slowMs: 200 })
    const http = new FakeHttp([response])
    await expect(
      fetchAttachment("https://8.8.8.8/slow", { httpGet: http.get, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(OneBotAttachmentNotFound)
  })
})

describe("isPublicIp", () => {
  test("rejects loopback, private, link-local, and mapped loopback", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false)
    expect(isPublicIp("10.0.0.1")).toBe(false)
    expect(isPublicIp("192.168.1.1")).toBe(false)
    expect(isPublicIp("169.254.169.254")).toBe(false)
    expect(isPublicIp("::1")).toBe(false)
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false)
    expect(isPublicIp("8.8.8.8")).toBe(true)
    expect(isPublicIp("93.184.216.34")).toBe(true)
  })
})
