// A small client for an OpenAI-compatible image-generation endpoint: one prompt in, one
// picture out, as BYTES with the MIME type their own signature shows. Never a remote URL:
// a URL a vendor hands back is fetched here, so no client is ever sent to a third-party
// host and the media store gets bytes it can verify (`../media/signatures.ts`).
//
// Plain settings in, nothing read from the environment; `fetch` is injected for tests; an
// `AbortSignal` stops a request in flight. Failures are `ImageGenError`s with a code from a
// small closed set that reuses the model lanes' vocabulary where it fits
// (`../llm/errors.ts`): `auth`, `rate_limited`, `bad_request`, `transient`, `aborted`,
// `unknown`, plus what only images have.
//
// Vendor facts, looked up 2026-11-26 — not copied from the 2.6 client:
//
// OpenAI (the installed SDK's typings,
// node_modules/.bun/openai@7.65.0+…/node_modules/openai/resources/images.d.ts):
// - `POST /images/generations` takes JSON (`images.js`: plain body); `POST /images/edits`
//   takes multipart form data (`images.js`: `multipartFormRequestOptions`) with the input
//   picture in `image` (`ImageEditParamsBase.image: Uploadable | Array<Uploadable>`).
// - `response_format` is "@deprecated Legacy response format parameter for retired image
//   models. Unsupported for GPT image models, which always return base64-encoded images."
//   So this client does NOT send it on the OpenAI dialect (the 2.6 client did, on every
//   request) and reads whichever of the two encodings comes back:
//   `Image.b64_json` ("Returned by default for GPT image models") or `Image.url` ("when
//   `response_format` is set to `url` for models that support that parameter"; legacy
//   DALL·E). The OpenAI image guide's examples read `result.data?.[0]?.b64_json`
//   (https://developers.openai.com/api/docs/guides/image-generation).
// - `size` is `WIDTHxHEIGHT` or `auto`; the standard sizes are `1024x1024`, `1536x1024`
//   and `1024x1536` (`ImageGenerateParamsBase.size`). The prompt's maximum is "32000
//   characters" (`ImageGenerateParamsBase.prompt`).
// - The response carries no per-image MIME type, only a top-level `output_format`
//   ('png' | 'webp' | 'jpeg' | 'gif' | 'svg'); this client trusts neither and reads the
//   signature. SVG is refused: a generated picture shown to the table is raster.
// - `gpt-image-1` — the 2.6 preset's default model — "was shut down on October 23, 2026"
//   (`ImageGenerateParamsBase.model`). No default model here: the settings name one.
//
// xAI (https://docs.x.ai/developers/rest-api-reference/inference/images.md and
// https://docs.x.ai/developers/model-capabilities/images/generation.md):
// - No `size` field. `aspect_ratio` is one of "1:1" "3:4" "4:3" "9:16" "16:9" "2:3" "3:2"
//   "9:19.5" "19.5:9" "9:20" "20:9" "1:2" "2:1" "21:9" "5:2" "auto"; `resolution` is one
//   of "1k" "2k" "1.5k" ("1k (default when omitted)").
// - "Images are returned as URLs by default. URLs are temporary"; `response_format` "Can
//   be url or b64_json". This client asks for `b64_json`, and still accepts a URL.
// - `data[].mime_type` is given ("e.g. image/png, image/jpeg, image/webp"); read the
//   signature regardless.
// - `POST /v1/images/edits` takes JSON, not multipart: `image: { url }` where url is a
//   "Public URL or base64-encoded data URL of the image (JPEG, PNG, or WebP)". The 2.6
//   client sent xAI a multipart body, which that endpoint does not document.
import { retryAfterMs } from "../llm/errors.ts";
import { matchesSignature } from "../media/signatures.ts";

/** The raster types a generated picture may be; the media store accepts each. */
export const RASTER_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type RasterMime = (typeof RASTER_MIMES)[number];

/** Which request shape the endpoint speaks (see the header). */
export type ImageDialect = "openai" | "xai";

/** OpenAI's documented prompt maximum, in characters. */
export const MAX_IMAGE_PROMPT_CHARS = 32_000;
/** The media store's default image file limit: a bigger picture could not be kept anyway. */
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;

export interface ImageGenSettings {
  /** E.g. `https://api.openai.com/v1`; the endpoint paths are appended. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** `WIDTHxHEIGHT` or `auto`; a request may override it. */
  readonly size: string;
  /** Defaults to `openai`. */
  readonly dialect?: ImageDialect;
  readonly timeoutMs?: number;
  /** Bigger answers are refused (`too_large`); defaults to `DEFAULT_MAX_IMAGE_BYTES`. */
  readonly maxBytes?: number;
}

export interface ImageGenRuntime {
  readonly fetch?: typeof fetch;
}

export interface ImageReference {
  readonly bytes: Uint8Array;
  readonly mime: RasterMime;
}

export interface ImageRequest {
  readonly prompt: string;
  /** Overrides the settings' size. */
  readonly size?: string;
  /** A fixed reference picture: the request becomes an edit conditioned on it. */
  readonly reference?: ImageReference;
}

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  /** As the bytes' own signature shows, never as the vendor declared. */
  readonly mime: RasterMime;
}

export type ImageGenErrorCode =
  /** A setting is missing or malformed: no request was sent. */
  | "not_configured"
  /** The prompt is empty or longer than `MAX_IMAGE_PROMPT_CHARS`, or the size is unreadable. */
  | "bad_prompt"
  | "auth"
  | "rate_limited"
  | "bad_request"
  | "transient"
  | "aborted"
  /** The answer was not an image this client can return (no data, bad base64, not raster). */
  | "bad_response"
  /** The picture is larger than `maxBytes`. */
  | "too_large"
  | "unknown";

export class ImageGenError extends Error {
  readonly code: ImageGenErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: ImageGenErrorCode, init: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {}) {
    super(init.status === undefined ? `imagegen ${code}` : `imagegen ${code} ${init.status}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ImageGenError";
    this.code = code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export interface ImageGenerator {
  generate(request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage>;
}

/** The raster type `bytes` start like, or null. */
export function detectRasterMime(bytes: Uint8Array): RasterMime | null {
  for (const mime of RASTER_MIMES) if (matchesSignature(mime, bytes)) return mime;
  return null;
}

const SIZE = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/;

/** `WIDTHxHEIGHT` as numbers, `auto`, or null when unreadable. */
export function parseImageSize(size: string): { readonly width: number; readonly height: number } | "auto" | null {
  if (size === "auto") return "auto";
  const match = SIZE.exec(size);
  if (match === null) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** xAI's documented aspect ratios (see the header), as width/height. */
const XAI_ASPECT_RATIOS: readonly (readonly [string, number])[] = [
  ["1:1", 1],
  ["3:4", 3 / 4],
  ["4:3", 4 / 3],
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["2:3", 2 / 3],
  ["3:2", 3 / 2],
  ["9:19.5", 9 / 19.5],
  ["19.5:9", 19.5 / 9],
  ["9:20", 9 / 20],
  ["20:9", 20 / 9],
  ["1:2", 1 / 2],
  ["2:1", 2],
  ["21:9", 21 / 9],
  ["5:2", 5 / 2],
];

/**
 * A pixel size as xAI's nearest aspect ratio and resolution. The documentation names the
 * resolutions but not their pixel counts, so the edge thresholds are this client's choice:
 * up to 1024 px is `1k`, up to 1536 px `1.5k`, larger `2k`.
 */
export function xaiDimensions(size: { readonly width: number; readonly height: number } | "auto"): { aspect_ratio: string; resolution?: string } {
  if (size === "auto") return { aspect_ratio: "auto" };
  const ratio = size.width / size.height;
  let best = XAI_ASPECT_RATIOS[0] as readonly [string, number];
  // Log distance treats a portrait and a landscape miss alike.
  for (const candidate of XAI_ASPECT_RATIOS) if (Math.abs(Math.log(ratio / candidate[1])) < Math.abs(Math.log(ratio / best[1]))) best = candidate;
  const edge = Math.max(size.width, size.height);
  return { aspect_ratio: best[0], resolution: edge > 1536 ? "2k" : edge > 1024 ? "1.5k" : "1k" };
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64"));
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** The shared class for an HTTP status (the same table as the model lanes). */
function byStatus(status: number): { code: ImageGenErrorCode; retryable: boolean } {
  if (status === 401 || status === 402 || status === 403) return { code: "auth", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 408 || status === 409 || status >= 500) return { code: "transient", retryable: true };
  if (status >= 400) return { code: "bad_request", retryable: false };
  return { code: "unknown", retryable: false };
}

export class OpenAICompatibleImageGen implements ImageGenerator {
  readonly #settings: ImageGenSettings;
  readonly #fetch: typeof fetch;

  constructor(settings: ImageGenSettings, runtime: ImageGenRuntime = {}) {
    this.#settings = settings;
    this.#fetch = runtime.fetch ?? fetch;
  }

  async generate(request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage> {
    const settings = this.#settings;
    if (settings.baseUrl.trim() === "" || settings.apiKey === "" || settings.model.trim() === "") throw new ImageGenError("not_configured");
    const prompt = request.prompt.trim();
    if (prompt === "" || codePoints(prompt) > MAX_IMAGE_PROMPT_CHARS) throw new ImageGenError("bad_prompt");
    const size = parseImageSize(request.size ?? settings.size);
    if (size === null) throw new ImageGenError("bad_prompt");
    if (signal?.aborted === true) throw new ImageGenError("aborted");

    const timeout = AbortSignal.timeout(settings.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const failure = (error: unknown): ImageGenError => {
      if (error instanceof ImageGenError) return error;
      if (signal?.aborted === true) return new ImageGenError("aborted", { cause: error });
      // The timeout fired, or the connection failed: asking again could succeed.
      return new ImageGenError("transient", { retryable: true, cause: error });
    };
    const [url, init] = this.#request(prompt, size, request.reference);
    try {
      const response = await this.#fetch(url, { ...init, signal: combined });
      return await this.#read(response, combined, signal);
    } catch (error) {
      throw failure(error);
    }
  }

  #request(prompt: string, size: { width: number; height: number } | "auto", reference: ImageReference | undefined): [string, RequestInit] {
    const settings = this.#settings;
    const base = settings.baseUrl.replace(/\/+$/, "");
    const auth = { Authorization: `Bearer ${settings.apiKey}` };
    const sizeText = size === "auto" ? "auto" : `${size.width}x${size.height}`;
    if ((settings.dialect ?? "openai") === "xai") {
      const body: Record<string, unknown> = { model: settings.model, prompt, n: 1, response_format: "b64_json", ...xaiDimensions(size) };
      if (reference !== undefined) body.image = { url: `data:${reference.mime};base64,${encodeBase64(reference.bytes)}` };
      const path = reference === undefined ? "/images/generations" : "/images/edits";
      return [`${base}${path}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }];
    }
    if (reference === undefined) {
      const body = { model: settings.model, prompt, n: 1, size: sizeText };
      return [`${base}/images/generations`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }];
    }
    const form = new FormData();
    form.set("model", settings.model);
    form.set("prompt", prompt);
    form.set("n", "1");
    form.set("size", sizeText);
    const extension = reference.mime.slice("image/".length);
    form.set("image", new Blob([reference.bytes], { type: reference.mime }), `reference.${extension}`);
    // No Content-Type header: fetch writes the multipart boundary itself.
    return [`${base}/images/edits`, { method: "POST", headers: auth, body: form }];
  }

  async #read(response: Response, signal: AbortSignal, callerSignal: AbortSignal | undefined): Promise<GeneratedImage> {
    if (!response.ok) {
      const { code, retryable } = byStatus(response.status);
      const wait = retryAfterMs(response.headers);
      // The body may quote the request (and an auth failure the credential): not kept.
      await response.body?.cancel().catch(() => undefined);
      throw new ImageGenError(code, { status: response.status, retryable, ...(wait === undefined ? {} : { retryAfterMs: wait }) });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (callerSignal?.aborted === true) throw new ImageGenError("aborted", { cause: error });
      throw new ImageGenError("bad_response", { cause: error });
    }
    const data = isRecord(payload) ? payload.data : undefined;
    const first: unknown = Array.isArray(data) ? data[0] : undefined;
    if (!isRecord(first)) throw new ImageGenError("bad_response");
    let bytes: Uint8Array | null = null;
    if (typeof first.b64_json === "string" && first.b64_json !== "") {
      bytes = decodeBase64(first.b64_json);
      if (bytes === null) throw new ImageGenError("bad_response");
    } else if (typeof first.url === "string" && first.url !== "") {
      bytes = await this.#download(first.url, signal);
    } else {
      throw new ImageGenError("bad_response");
    }
    return this.#accept(bytes);
  }

  /** A vendor's temporary URL, fetched now. Never sent the API key: it is another host. */
  async #download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ImageGenError("bad_response");
    }
    if (parsed.protocol === "data:") {
      const match = /^data:image\/[a-z.+-]+;base64,(.*)$/s.exec(url);
      const bytes = match === null ? null : decodeBase64(match[1] ?? "");
      if (bytes === null) throw new ImageGenError("bad_response");
      return bytes;
    }
    if (parsed.protocol !== "https:") throw new ImageGenError("bad_response");
    const response = await this.#fetch(parsed.href, { method: "GET", signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const { code, retryable } = byStatus(response.status);
      throw new ImageGenError(code, { status: response.status, retryable });
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > this.#maxBytes()) {
      await response.body?.cancel().catch(() => undefined);
      throw new ImageGenError("too_large");
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  #maxBytes(): number {
    return this.#settings.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  #accept(bytes: Uint8Array): GeneratedImage {
    if (bytes.length > this.#maxBytes()) throw new ImageGenError("too_large");
    const mime = detectRasterMime(bytes);
    if (mime === null) throw new ImageGenError("bad_response");
    return { bytes, mime };
  }
}

export function createImageGen(settings: ImageGenSettings, runtime: ImageGenRuntime = {}): ImageGenerator {
  return new OpenAICompatibleImageGen(settings, runtime);
}
