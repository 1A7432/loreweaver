import { expect, test } from "bun:test";

import { OpenAIEmbeddings, type OpenAIEmbeddingsSettings, RecallError } from "../../../src/infra/recall/index.ts";
import { answer, FakeEndpoint } from "./fake_fetch.ts";

const BASE = "https://embed.example.test/v1";

function lane(endpoint: FakeEndpoint, extra: Partial<OpenAIEmbeddingsSettings> = {}): OpenAIEmbeddings {
  return new OpenAIEmbeddings({ baseUrl: BASE, apiKey: "test-key", model: "m-embed", dimensions: 3, fetch: endpoint.fetch, ...extra });
}

async function failure(promise: Promise<unknown>): Promise<RecallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RecallError) return error;
    throw error;
  }
  throw new Error("expected a RecallError");
}

test("the request: the model, the inputs, the dimension count, plain floats, and the key", async () => {
  const endpoint = new FakeEndpoint([answer([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]])]);
  const vectors = await lane(endpoint).embed(["first", "second"]);
  expect(endpoint.sent).toHaveLength(1);
  const sent = endpoint.sent[0];
  expect(sent?.url).toBe(`${BASE}/embeddings`);
  expect(sent?.headers.get("authorization")).toBe("Bearer test-key");
  // `encoding_format` is stated: without it the SDK asks for base64 on its own.
  expect(sent?.body).toEqual({ model: "m-embed", input: ["first", "second"], dimensions: 3, encoding_format: "float" });
  expect(vectors).toEqual([Float64Array.of(0.1, 0.2, 0.3), Float64Array.of(0.4, 0.5, 0.6)]);
  expect(vectors[0]).toBeInstanceOf(Float64Array);
});

test("the lane reports the dimension count it was given", () => {
  expect(lane(new FakeEndpoint([])).dimensions).toBe(3);
});

test("an empty list makes no request", async () => {
  const endpoint = new FakeEndpoint([]);
  expect(await lane(endpoint).embed([])).toEqual([]);
  expect(endpoint.sent).toHaveLength(0);
});

test("items are placed by their index, whatever order the endpoint lists them in", async () => {
  const endpoint = new FakeEndpoint([answer([[3, 3, 3], [1, 1, 1], [2, 2, 2]], [2, 0, 1])]);
  expect(await lane(endpoint).embed(["a", "b", "c"])).toEqual([Float64Array.of(1, 1, 1), Float64Array.of(2, 2, 2), Float64Array.of(3, 3, 3)]);
});

test("a long list is sent in batches of the configured size, results in order", async () => {
  const endpoint = new FakeEndpoint([answer([[1, 0, 0], [2, 0, 0]]), answer([[3, 0, 0], [4, 0, 0]]), answer([[5, 0, 0]])]);
  const vectors = await lane(endpoint, { batchSize: 2 }).embed(["a", "b", "c", "d", "e"]);
  expect(endpoint.sent.map((request) => request.body.input)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  expect(vectors.map((vector) => vector[0])).toEqual([1, 2, 3, 4, 5]);
});

test("the default batch is 64 texts", async () => {
  const texts = Array.from({ length: 65 }, (_, i) => `t${i}`);
  const endpoint = new FakeEndpoint([answer(texts.slice(0, 64).map(() => [1, 0, 0])), answer([[1, 0, 0]])]);
  expect(await lane(endpoint).embed(texts)).toHaveLength(65);
  expect(endpoint.sent.map((request) => (request.body.input as string[]).length)).toEqual([64, 1]);
});

test("a vector of the wrong length is refused with the sizes, and nothing is returned", async () => {
  const endpoint = new FakeEndpoint([answer([[1, 2, 3], [1, 2, 3, 4]])]);
  const error = await failure(lane(endpoint).embed(["a", "b"]));
  expect(error.code).toBe("dimension_mismatch");
  expect(error.detail).toEqual({ expected: 3, actual: 4, index: 1 });
});

test("answers that do not have the documented shape are refused", async () => {
  const bad: unknown[] = [
    {},
    { data: "nope" },
    { data: [] },
    { data: [{ index: 0, embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 0, embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 2, embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1.5, embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, { embedding: [1, 2, 3] }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1 }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: "AAAA" }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [1, "2", 3] }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }, null] },
  ];
  for (const json of bad) {
    const error = await failure(lane(new FakeEndpoint([{ json }])).embed(["a", "b"]));
    expect(error.code).toBe("bad_response");
  }
});

test("a number that is not finite is refused", async () => {
  // 1e999 is valid JSON and parses to Infinity.
  const text = '{"data":[{"index":0,"embedding":[1,1e999,3]}]}';
  const error = await failure(lane(new FakeEndpoint([{ text }])).embed(["a"]));
  expect(error.code).toBe("non_finite");
});

test("a failed batch fails the whole call", async () => {
  const endpoint = new FakeEndpoint([answer([[1, 0, 0], [2, 0, 0]]), { status: 500, json: { error: { message: "down" } } }]);
  const error = await failure(lane(endpoint, { batchSize: 2 }).embed(["a", "b", "c"]));
  expect(error.code).toBe("provider");
  expect(error.status).toBe(500);
});

test("HTTP failures keep their status and say whether trying again can help", async () => {
  const limited = await failure(
    lane(new FakeEndpoint([{ status: 429, headers: { "retry-after": "7" }, json: { error: { message: "slow down" } } }])).embed(["a"]),
  );
  expect(limited).toMatchObject({ code: "provider", status: 429, retryable: true, retryAfterMs: 7000 });
  const denied = await failure(lane(new FakeEndpoint([{ status: 401, json: { error: { message: "no" } } }])).embed(["a"]));
  expect(denied).toMatchObject({ code: "provider", status: 401, retryable: false });
  const refused = await failure(lane(new FakeEndpoint([{ status: 400, json: { error: { message: "empty input" } } }])).embed(["a"]));
  expect(refused).toMatchObject({ code: "provider", status: 400, retryable: false });
  const down = await failure(lane(new FakeEndpoint([{ networkError: new TypeError("fetch failed") }])).embed(["a"]));
  expect(down).toMatchObject({ code: "provider", retryable: true });
});

test("the SDK does not retry behind the caller's back", async () => {
  const endpoint = new FakeEndpoint([{ status: 503, json: {} }, answer([[1, 2, 3]])]);
  const error = await failure(lane(endpoint).embed(["a"]));
  expect(error.status).toBe(503);
  expect(endpoint.sent).toHaveLength(1);
});

test("a signal that is already aborted sends nothing", async () => {
  const endpoint = new FakeEndpoint([answer([[1, 2, 3]])]);
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  expect((await failure(lane(endpoint).embed(["a"], { signal: controller.signal }))).code).toBe("aborted");
  expect(endpoint.sent).toHaveLength(0);
});

test("aborting while the endpoint is thinking stops the call", async () => {
  const endpoint = new FakeEndpoint([{ hang: true }]);
  const controller = new AbortController();
  const pending = failure(lane(endpoint).embed(["a"], { signal: controller.signal }));
  await Bun.sleep(5);
  controller.abort(new Error("stop"));
  expect((await pending).code).toBe("aborted");
});

test("aborting between batches stops before the next request", async () => {
  const endpoint = new FakeEndpoint([answer([[1, 0, 0]]), answer([[2, 0, 0]])]);
  const controller = new AbortController();
  const slow = new OpenAIEmbeddings({
    baseUrl: BASE,
    apiKey: "k",
    model: "m",
    dimensions: 3,
    batchSize: 1,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await endpoint.fetch(input, init);
      controller.abort(new Error("stop"));
      return response;
    }) as typeof fetch,
  });
  expect((await failure(slow.embed(["a", "b"], { signal: controller.signal }))).code).toBe("aborted");
  expect(endpoint.sent).toHaveLength(1);
});

test("a timeout is a retryable provider failure", async () => {
  const endpoint = new FakeEndpoint([{ hang: true }]);
  const error = await failure(lane(endpoint, { timeoutMs: 20 }).embed(["a"]));
  expect(error).toMatchObject({ code: "provider", retryable: true });
});

test("no key is sent a placeholder, and OpenAI's own address is the default endpoint", async () => {
  const endpoint = new FakeEndpoint([answer([[1, 2, 3]])]);
  await new OpenAIEmbeddings({ apiKey: "", model: "m", dimensions: 3, fetch: endpoint.fetch }).embed(["a"]);
  expect(endpoint.sent[0]?.url).toBe("https://api.openai.com/v1/embeddings");
  expect(endpoint.sent[0]?.headers.get("authorization")).toBe("Bearer no-key");
});

test("ambient OPENAI_* environment variables never reach a request", async () => {
  const names = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.OPENAI_API_KEY = "ambient-key";
  process.env.OPENAI_BASE_URL = "https://ambient.example.test/v1";
  process.env.OPENAI_ORG_ID = "ambient-org";
  process.env.OPENAI_PROJECT_ID = "ambient-project";
  try {
    const endpoint = new FakeEndpoint([answer([[1, 2, 3]]), answer([[1, 2, 3]])]);
    await new OpenAIEmbeddings({ apiKey: "own-key", model: "m", dimensions: 3, fetch: endpoint.fetch }).embed(["a"]);
    await new OpenAIEmbeddings({ apiKey: "", model: "m", dimensions: 3, fetch: endpoint.fetch }).embed(["a"]);
    for (const sent of endpoint.sent) {
      expect(sent.url).toBe("https://api.openai.com/v1/embeddings");
      expect(sent.headers.get("openai-organization")).toBeNull();
      expect(sent.headers.get("openai-project")).toBeNull();
    }
    expect(endpoint.sent[0]?.headers.get("authorization")).toBe("Bearer own-key");
    expect(endpoint.sent[1]?.headers.get("authorization")).toBe("Bearer no-key");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("settings that cannot work are refused when the lane is built", () => {
  const endpoint = new FakeEndpoint([]);
  expect(() => lane(endpoint, { dimensions: 0 })).toThrow(expect.objectContaining({ code: "invalid_settings" }));
  expect(() => lane(endpoint, { dimensions: 1.5 })).toThrow(expect.objectContaining({ code: "invalid_settings" }));
  expect(() => lane(endpoint, { batchSize: 0 })).toThrow(expect.objectContaining({ code: "invalid_settings" }));
});
