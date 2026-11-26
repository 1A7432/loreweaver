import { describe, expect, test } from "bun:test";

import {
  detectRasterMime,
  ImageGenError,
  type ImageGenSettings,
  OpenAICompatibleImageGen,
  parseImageSize,
  xaiDimensions,
} from "../../../src/infra/imagegen/index.ts";

// A real 1×1 PNG.
const PNG = new Uint8Array(
  Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8ffff3f0005fe02fea7a0a5810000000049454e44ae426082",
    "hex",
  ),
);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const B64 = Buffer.from(PNG).toString("base64");

const OPENAI: ImageGenSettings = { baseUrl: "https://api.example.test/v1/", apiKey: "sk-test", model: "gpt-image-2.5-flare", size: "1024x1024" };
const XAI: ImageGenSettings = { baseUrl: "https://api.x.ai/v1", apiKey: "xai-test", model: "grok-imagine-image-2.0", size: "1536x1024", dialect: "xai" };

interface Seen {
  readonly url: string;
  readonly init: RequestInit;
}

function fake(responses: ((seen: Seen) => Response | Promise<Response>)[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const entry = { url: String(input), init };
    seen.push(entry);
    const next = responses.shift();
    if (next === undefined) throw new Error("no response left");
    return next(entry);
  };
  return { fetch: impl as typeof fetch, seen };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImageGenError) return error.code;
    throw error;
  }
  return "no error";
}

describe("OpenAI dialect", () => {
  test("a generation: the JSON body, and a base64 answer returned as bytes with the detected type", async () => {
    const { fetch, seen } = fake([() => json({ created: 1, data: [{ b64_json: B64 }], output_format: "webp" })]);
    const image = await new OpenAICompatibleImageGen(OPENAI, { fetch }).generate({ prompt: "  a lantern on the quay  " });
    expect(image.mime).toBe("image/png");
    expect(image.bytes).toEqual(PNG);
    expect(seen[0]?.url).toBe("https://api.example.test/v1/images/generations");
    expect(seen[0]?.init.method).toBe("POST");
    expect((seen[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    // No `response_format`: unsupported for GPT image models (SDK typings).
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ model: "gpt-image-2.5-flare", prompt: "a lantern on the quay", n: 1, size: "1024x1024" });
  });

  test("a URL answer is downloaded — without the API key — and never handed on", async () => {
    const { fetch, seen } = fake([() => json({ created: 1, data: [{ url: "https://cdn.example.test/img/abc.jpg" }] }), () => new Response(JPEG, { status: 200 })]);
    const image = await new OpenAICompatibleImageGen(OPENAI, { fetch }).generate({ prompt: "p", size: "1536x1024" });
    expect(image).toEqual({ bytes: JPEG, mime: "image/jpeg" });
    expect(JSON.parse(String(seen[0]?.init.body)).size).toBe("1536x1024");
    expect(seen[1]?.url).toBe("https://cdn.example.test/img/abc.jpg");
    expect(seen[1]?.init.headers).toBeUndefined();
  });

  test("a reference picture makes it a multipart edit with the picture in `image`", async () => {
    const { fetch, seen } = fake([() => json({ data: [{ b64_json: B64 }] })]);
    await new OpenAICompatibleImageGen(OPENAI, { fetch }).generate({ prompt: "her again", reference: { bytes: PNG, mime: "image/png" } });
    expect(seen[0]?.url).toBe("https://api.example.test/v1/images/edits");
    const form = seen[0]?.init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2.5-flare");
    expect(form.get("prompt")).toBe("her again");
    const file = form.get("image") as File;
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });
});

describe("xAI dialect", () => {
  test("aspect ratio and resolution instead of size; base64 asked for", async () => {
    const { fetch, seen } = fake([() => json({ data: [{ b64_json: B64, mime_type: "image/jpeg" }] })]);
    const image = await new OpenAICompatibleImageGen(XAI, { fetch }).generate({ prompt: "p" });
    // The declared type is not trusted: the bytes are a PNG.
    expect(image.mime).toBe("image/png");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ model: "grok-imagine-image-2.0", prompt: "p", n: 1, response_format: "b64_json", aspect_ratio: "3:2", resolution: "1.5k" });
  });

  test("an edit is JSON with the reference as a data URL", async () => {
    const { fetch, seen } = fake([() => json({ data: [{ url: `data:image/png;base64,${B64}` }] })]);
    const image = await new OpenAICompatibleImageGen(XAI, { fetch }).generate({ prompt: "p", reference: { bytes: PNG, mime: "image/png" } });
    expect(image.bytes).toEqual(PNG);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.x.ai/v1/images/edits");
    expect(JSON.parse(String(seen[0]?.init.body)).image).toEqual({ url: `data:image/png;base64,${B64}` });
  });

  test("sizes map to the nearest documented ratio", () => {
    expect(xaiDimensions({ width: 1024, height: 1024 })).toEqual({ aspect_ratio: "1:1", resolution: "1k" });
    expect(xaiDimensions({ width: 1080, height: 1920 })).toEqual({ aspect_ratio: "9:16", resolution: "2k" });
    expect(xaiDimensions("auto")).toEqual({ aspect_ratio: "auto" });
  });
});

describe("failures", () => {
  test("HTTP errors carry the shared codes", async () => {
    const { fetch } = fake([() => json({ error: { message: "slow down sk-test" } }, 429, { "retry-after": "3" }), () => json({}, 401), () => json({}, 400), () => json({}, 503)]);
    const client = new OpenAICompatibleImageGen(OPENAI, { fetch });
    try {
      await client.generate({ prompt: "p" });
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageGenError);
      const failure = error as ImageGenError;
      expect([failure.code, failure.status, failure.retryable, failure.retryAfterMs]).toEqual(["rate_limited", 429, true, 3000]);
      expect(failure.message).not.toContain("sk-test");
    }
    expect(await code(client.generate({ prompt: "p" }))).toBe("auth");
    expect(await code(client.generate({ prompt: "p" }))).toBe("bad_request");
    expect(await code(client.generate({ prompt: "p" }))).toBe("transient");
  });

  test("answers that are not a raster picture are refused", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const { fetch } = fake([() => json({ data: [{ b64_json: svg }] }), () => json({ data: [] }), () => json({ data: [{ b64_json: "not base64!" }] }), () => new Response("oops", { status: 200 }), () => json({ data: [{ url: "http://plain.example.test/x.png" }] })]);
    const client = new OpenAICompatibleImageGen(OPENAI, { fetch });
    for (let index = 0; index < 5; index++) expect(await code(client.generate({ prompt: "p" }))).toBe("bad_response");
  });

  test("too large is refused", async () => {
    const { fetch } = fake([() => json({ data: [{ b64_json: B64 }] })]);
    expect(await code(new OpenAICompatibleImageGen({ ...OPENAI, maxBytes: 10 }, { fetch }).generate({ prompt: "p" }))).toBe("too_large");
  });

  test("abort stops a request in flight", async () => {
    const controller = new AbortController();
    const { fetch } = fake([
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          controller.abort();
        }),
    ]);
    expect(await code(new OpenAICompatibleImageGen(OPENAI, { fetch }).generate({ prompt: "p" }, controller.signal))).toBe("aborted");
    // Already aborted: nothing is sent.
    const idle = fake([]);
    expect(await code(new OpenAICompatibleImageGen(OPENAI, { fetch: idle.fetch }).generate({ prompt: "p" }, controller.signal))).toBe("aborted");
    expect(idle.seen).toHaveLength(0);
  });

  test("a network failure is transient; bad settings and prompts send nothing", async () => {
    const { fetch } = fake([() => Promise.reject(new TypeError("connection refused"))]);
    expect(await code(new OpenAICompatibleImageGen(OPENAI, { fetch }).generate({ prompt: "p" }))).toBe("transient");
    const idle = fake([]);
    expect(await code(new OpenAICompatibleImageGen({ ...OPENAI, apiKey: "" }, { fetch: idle.fetch }).generate({ prompt: "p" }))).toBe("not_configured");
    expect(await code(new OpenAICompatibleImageGen(OPENAI, { fetch: idle.fetch }).generate({ prompt: "   " }))).toBe("bad_prompt");
    expect(await code(new OpenAICompatibleImageGen(OPENAI, { fetch: idle.fetch }).generate({ prompt: "p", size: "huge" }))).toBe("bad_prompt");
    expect(idle.seen).toHaveLength(0);
  });
});

test("helpers", () => {
  expect(detectRasterMime(PNG)).toBe("image/png");
  expect(detectRasterMime(new Uint8Array([1, 2, 3]))).toBeNull();
  expect(parseImageSize("1024x1536")).toEqual({ width: 1024, height: 1536 });
  expect(parseImageSize("0x5")).toBeNull();
});
