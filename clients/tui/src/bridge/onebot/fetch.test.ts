import { describe, expect, test } from "bun:test"
import { promises as dns } from "node:dns"
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_REDIRECTS } from "./constants"
import {
  buildHttpRequestOptions,
  defaultHttpGet,
  defaultResolveAddresses,
  fetchAttachment,
  isPublicIp,
  pinnedLookup,
  type AddressEntry,
  type HttpGet,
  type HttpResponse,
  type ResolveAddresses,
} from "./fetch"
import { OneBotAttachmentNotFound, OneBotError, parseIPv4 } from "./shared"

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

  test("pinned lookup refuses a rebinding set and never hands private addresses to the client", () => {
    const lookup = pinnedLookup(["93.184.216.34", "169.254.169.254"])
    let err: Error | null = null
    let entries: AddressEntry[] | undefined
    lookup("rebind.example", { all: true }, (error, addresses) => {
      err = error
      entries = addresses
    })
    expect(err).toBeInstanceOf(OneBotError)
    expect((err as unknown as OneBotError).code).toBe("onebot.attachment.unsafe_address")
    expect(entries).toEqual([])
  })

  test("the pinned lookup hands the client only the already-validated addresses", () => {
    const lookup = pinnedLookup(["93.184.216.34"])
    let entries: AddressEntry[] | undefined
    lookup("cdn.example", { all: true }, (error, addresses) => {
      expect(error).toBeNull()
      entries = addresses
    })
    expect(entries).toEqual([{ address: "93.184.216.34", family: 4 }])
  })
})

describe("defaultHttpGet — pinned lookup seam", () => {
  test("an HTTPS URL keeps servername equal to the original hostname", () => {
    const opts = buildHttpRequestOptions(new URL("https://cdn.example/file"), ["93.184.216.34"])
    expect(opts.servername).toBe("cdn.example")
    expect(opts.hostname).toBe("cdn.example")
    expect(opts.protocol).toBe("https:")
  })

  test("defaultHttpGet uses the injected lookup against a local server", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("local-ok")
      },
    })
    try {
      const url = `http://127.0.0.1:${server.port}/file`
      const lookup = (_host: string, options: unknown, callback?: (err: Error | null, addresses: AddressEntry[]) => void) => {
        const cb = typeof options === "function" ? options : callback
        cb?.(null, [{ address: "127.0.0.1", family: 4 }])
      }
      const response = await defaultHttpGet(url, {
        redirect: "manual",
        addresses: ["127.0.0.1"],
        lookup,
      })
      expect(response.status).toBe(200)
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toBe("local-ok")
    } finally {
      server.stop(true)
    }
  })

  test("a resolver that answers public first does not reach a loopback server", async () => {
    let hits = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits += 1
        return new Response("secret")
      },
    })
    try {
      await expect(
        fetchAttachment(`http://localhost:${server.port}/secret`, {
          resolveAddresses: async () => ["93.184.216.34"],
          timeoutMs: 250,
        }),
      ).rejects.toBeTruthy()
      expect(hits).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test("defaultResolveAddresses returns every A and AAAA answer for localhost", async () => {
    const independent = await dns.lookup("localhost", { all: true })
    const ours = await defaultResolveAddresses("localhost", 80)
    expect(ours.sort()).toEqual(independent.map((item) => item.address).sort())
    expect(ours.length).toBeGreaterThanOrEqual(1)
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

  test("rejects 2001::/23 (Teredo/ORCHID) and NAT64-embedded private IPv4", () => {
    expect(isPublicIp("2001::1")).toBe(false)
    expect(isPublicIp("2001:1::1")).toBe(false)
    expect(isPublicIp("2001:200::1")).toBe(true)
    expect(isPublicIp("64:ff9b::10.0.0.1")).toBe(false)
    expect(isPublicIp("64:ff9b::8.8.8.8")).toBe(true)
  })
})

describe("parseIPv4", () => {
  test("rejects leading zeros (except the value 0)", () => {
    expect(parseIPv4("0177.0.0.1")).toBeNull()
    expect(parseIPv4("127.0.0.1")).not.toBeNull()
    expect(parseIPv4("0.0.0.0")).toBe(0)
  })
})
