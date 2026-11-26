// Where a pack comes from: a local path, an `https://` URL, or `gh:owner/repo[@tag]` — a
// GitHub release (Git releases are the registry: no central index, no account). A `gh:`
// reference asks the releases API for the release with that tag, or the latest release,
// and takes its first asset whose name ends in `.lwpack`.
//
// `fetch` is injected (tests never touch the network). Only https is spoken, redirects
// included: each hop is followed by hand and must stay on https. A download is capped
// while it streams, not by the length a server announces.
import { lstatSync, readFileSync } from "node:fs";

import { MAX_ARCHIVE_BYTES } from "../zip.ts";

export const PACK_SUFFIX = ".lwpack";
export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 30_000;
/** The release metadata a `gh:` reference reads is JSON of at most this size. */
export const MAX_RELEASE_JSON_BYTES = 4 * 1024 * 1024;
const GH_REF = /^gh:([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:@([^\s@/][^\s@]{0,119}))?$/u;
const USER_AGENT = "loreweaver-pack";

export type FetchLike = (url: string, init: { readonly redirect: "manual"; readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal }) => Promise<Response>;

export type SourceCode =
  | "empty_ref"
  /** A scheme other than https (`http://`, `ftp://`, `file://`, …). */
  | "not_https"
  | "bad_gh_ref"
  /** A local path that is not a regular file. */
  | "not_found"
  | "too_large"
  /** The server answered with an error status (`detail`), or the request failed. */
  | "fetch_failed"
  | "too_many_redirects"
  /** The release has no `.lwpack` asset. */
  | "no_pack_asset"
  /** The releases API answered with something that is not a release. */
  | "bad_release";

export type PackSource = { readonly ok: true; readonly bytes: Uint8Array; readonly from: string } | { readonly ok: false; readonly code: SourceCode; readonly detail?: string };

export interface SourceDeps {
  readonly fetch: FetchLike;
  /** Default `MAX_ARCHIVE_BYTES`. */
  readonly maxBytes?: number;
}

function refused(code: SourceCode, detail?: string): PackSource {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

async function download(url: string, deps: SourceDeps, accept: string, maxBytes: number): Promise<PackSource> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!current.startsWith("https://")) return refused("not_https", current);
    let response: Response;
    try {
      response = await deps.fetch(current, { redirect: "manual", headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      return refused("fetch_failed", error instanceof Error ? error.name : "error");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) return refused("fetch_failed", String(response.status));
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) return refused("fetch_failed", String(response.status));
    const announced = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(announced) && announced > maxBytes) return refused("too_large");
    const body = response.body;
    if (body === null) return refused("fetch_failed", "no_body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        return refused("too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { ok: true, bytes, from: current };
  }
  return refused("too_many_redirects");
}

async function fromGitHub(ref: string, deps: SourceDeps, maxBytes: number): Promise<PackSource> {
  const match = GH_REF.exec(ref);
  if (match === null) return refused("bad_gh_ref");
  const [, owner, repo, tag] = match as unknown as [string, string, string, string | undefined];
  const release = tag === undefined ? `https://api.github.com/repos/${owner}/${repo}/releases/latest` : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const metadata = await download(release, deps, "application/vnd.github+json", MAX_RELEASE_JSON_BYTES);
  if (!metadata.ok) return metadata;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(metadata.bytes));
  } catch {
    return refused("bad_release");
  }
  const assets = typeof parsed === "object" && parsed !== null ? (parsed as { assets?: unknown }).assets : undefined;
  if (!Array.isArray(assets)) return refused("bad_release");
  for (const asset of assets) {
    if (typeof asset !== "object" || asset === null) continue;
    const { name, browser_download_url: url } = asset as { name?: unknown; browser_download_url?: unknown };
    if (typeof name === "string" && name.endsWith(PACK_SUFFIX) && typeof url === "string" && url.startsWith("https://")) return download(url, deps, "application/octet-stream", maxBytes);
  }
  return refused("no_pack_asset");
}

/** The archive bytes a reference names. */
export async function fetchPackSource(ref: string, deps: SourceDeps): Promise<PackSource> {
  const trimmed = ref.trim();
  const maxBytes = deps.maxBytes ?? MAX_ARCHIVE_BYTES;
  if (trimmed === "") return refused("empty_ref");
  if (trimmed.startsWith("gh:")) return fromGitHub(trimmed, deps, maxBytes);
  if (trimmed.startsWith("https://")) return download(trimmed, deps, "application/octet-stream", maxBytes);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return refused("not_https");
  try {
    const stat = lstatSync(trimmed);
    if (!stat.isFile()) return refused("not_found");
    if (stat.size > maxBytes) return refused("too_large");
    return { ok: true, bytes: new Uint8Array(readFileSync(trimmed)), from: trimmed };
  } catch {
    return refused("not_found");
  }
}
