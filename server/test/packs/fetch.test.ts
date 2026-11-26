// Where a pack comes from: a local path, https, or a GitHub release — over a fake fetch,
// never the network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type FetchLike, fetchPackSource } from "../../src/infra/packs/fetch.ts";

const dir = mkdtempSync(join(tmpdir(), "loreweaver-fetch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Route = (url: string) => Response;

/** A fetch that answers from `routes` and records every URL asked for. */
function fakeFetch(routes: Readonly<Record<string, Route>>): { fetch: FetchLike; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (url, init) => {
      asked.push(url);
      expect(init.redirect).toBe("manual");
      const route = routes[url];
      return Promise.resolve(route === undefined ? new Response("missing", { status: 404 }) : route(url));
    },
  };
}

const bytes = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, i) => i % 256);

describe("https", () => {
  test("a direct link downloads", async () => {
    const { fetch } = fakeFetch({ "https://example.org/a.lwpack": () => new Response(bytes(10)) });
    const source = await fetchPackSource("https://example.org/a.lwpack", { fetch });
    expect(source.ok && [...source.bytes]).toEqual([...bytes(10)]);
  });

  test("other schemes are refused before anything is asked", async () => {
    const { fetch, asked } = fakeFetch({});
    for (const ref of ["http://example.org/a.lwpack", "ftp://example.org/a.lwpack", "file:///etc/passwd"]) expect(await fetchPackSource(ref, { fetch })).toEqual({ ok: false, code: "not_https" });
    expect(asked).toEqual([]);
  });

  test("redirects are followed by hand and must stay on https", async () => {
    const hop = (to: string): Route => () => new Response(null, { status: 302, headers: { location: to } });
    const { fetch } = fakeFetch({
      "https://example.org/a": hop("https://cdn.example.org/a"),
      "https://cdn.example.org/a": () => new Response(bytes(3)),
      "https://example.org/down": hop("http://example.org/plain"),
      "https://example.org/loop": hop("https://example.org/loop"),
    });
    const followed = await fetchPackSource("https://example.org/a", { fetch });
    expect(followed.ok && followed.from).toBe("https://cdn.example.org/a");
    expect(await fetchPackSource("https://example.org/down", { fetch })).toEqual({ ok: false, code: "not_https", detail: "http://example.org/plain" });
    expect(await fetchPackSource("https://example.org/loop", { fetch })).toEqual({ ok: false, code: "too_many_redirects" });
  });

  test("an error status is refused with it", async () => {
    const { fetch } = fakeFetch({});
    expect(await fetchPackSource("https://example.org/none", { fetch })).toEqual({ ok: false, code: "fetch_failed", detail: "404" });
  });

  test("oversize: by the announced length, and while streaming when none is announced", async () => {
    const announced = fakeFetch({ "https://example.org/big": () => new Response(bytes(100), { headers: { "content-length": "100" } }) });
    expect(await fetchPackSource("https://example.org/big", { fetch: announced.fetch, maxBytes: 50 })).toEqual({ ok: false, code: "too_large" });
    const streamed = fakeFetch({
      "https://example.org/stream": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 10; i++) controller.enqueue(bytes(20));
              controller.close();
            },
          }),
        ),
    });
    expect(await fetchPackSource("https://example.org/stream", { fetch: streamed.fetch, maxBytes: 50 })).toEqual({ ok: false, code: "too_large" });
  });
});

describe("gh:owner/repo[@tag]", () => {
  const release = (assets: unknown[]): Route => () => Response.json({ tag_name: "v1", assets });

  test("a tagged release: its first .lwpack asset", async () => {
    const { fetch, asked } = fakeFetch({
      "https://api.github.com/repos/ada/harbor/releases/tags/v1.2": release([
        { name: "notes.txt", browser_download_url: "https://github.com/ada/harbor/releases/download/v1.2/notes.txt" },
        { name: "harbor-1.2.0.lwpack", browser_download_url: "https://github.com/ada/harbor/releases/download/v1.2/harbor-1.2.0.lwpack" },
        { name: "second.lwpack", browser_download_url: "https://github.com/ada/harbor/releases/download/v1.2/second.lwpack" },
      ]),
      "https://github.com/ada/harbor/releases/download/v1.2/harbor-1.2.0.lwpack": () => new Response(bytes(4)),
    });
    const source = await fetchPackSource("gh:ada/harbor@v1.2", { fetch });
    expect(source.ok).toBe(true);
    expect(asked).toEqual(["https://api.github.com/repos/ada/harbor/releases/tags/v1.2", "https://github.com/ada/harbor/releases/download/v1.2/harbor-1.2.0.lwpack"]);
  });

  test("no tag: the latest release", async () => {
    const { fetch, asked } = fakeFetch({ "https://api.github.com/repos/ada/harbor/releases/latest": release([]) });
    await fetchPackSource("gh:ada/harbor", { fetch });
    expect(asked[0]).toBe("https://api.github.com/repos/ada/harbor/releases/latest");
  });

  test("a release with no pack asset", async () => {
    const { fetch } = fakeFetch({ "https://api.github.com/repos/ada/harbor/releases/latest": release([{ name: "a.zip", browser_download_url: "https://x/a.zip" }]) });
    expect(await fetchPackSource("gh:ada/harbor", { fetch })).toEqual({ ok: false, code: "no_pack_asset" });
  });

  test("a malformed reference, and a release that is not one", async () => {
    const { fetch } = fakeFetch({ "https://api.github.com/repos/ada/harbor/releases/latest": () => new Response("not json") });
    expect(await fetchPackSource("gh:ada", { fetch })).toEqual({ ok: false, code: "bad_gh_ref" });
    expect(await fetchPackSource("gh:ada/har bor", { fetch })).toEqual({ ok: false, code: "bad_gh_ref" });
    expect(await fetchPackSource("gh:ada/harbor", { fetch })).toEqual({ ok: false, code: "bad_release" });
  });
});

describe("a local path", () => {
  test("a file reads; a directory or nothing does not", async () => {
    const file = join(dir, "local.lwpack");
    writeFileSync(file, bytes(5));
    const { fetch } = fakeFetch({});
    const source = await fetchPackSource(file, { fetch });
    expect(source.ok && source.bytes.length).toBe(5);
    expect(await fetchPackSource(dir, { fetch })).toEqual({ ok: false, code: "not_found" });
    expect(await fetchPackSource(join(dir, "none.lwpack"), { fetch })).toEqual({ ok: false, code: "not_found" });
    expect(await fetchPackSource(file, { fetch, maxBytes: 4 })).toEqual({ ok: false, code: "too_large" });
    expect(await fetchPackSource("  ", { fetch })).toEqual({ ok: false, code: "empty_ref" });
  });
});
