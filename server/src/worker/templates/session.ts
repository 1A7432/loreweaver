/**
 * One template session = one prompt assembly = one fresh `node:vm` context.
 *
 * The context gets the four precompiled scripts (environment, EJS, lodash, API) and the
 * assembly's data as a JSON string; from then on the host talks to it only by running
 * small scripts whose arguments are JSON string literals and whose results are primitive
 * strings or booleans. Nothing the context returns is trusted: every result is re-parsed
 * and re-bounded here (a template can redefine anything it can reach, including the
 * prototypes the bridge uses).
 *
 * Time. Every call into the context runs under `timeout` = min(per-template limit, time
 * left in the assembly). The context is created with `microtaskMode: "afterEvaluate"`, so
 * the promise jobs a template queues run INSIDE that call and under its timeout; with no
 * timers or I/O in the context, nothing can run once the call returned. A template still
 * waiting when its call ends has failed (`unsettled`). After a timeout the context is
 * discarded and rebuilt (writes so far carried, `define`d values lost), so one runaway
 * template cannot poison the rest of the assembly.
 *
 * Memory is NOT bounded here: `node:vm` has no per-context heap limit. The room worker's
 * own resource limits are the backstop for a template that allocates without end.
 */

import vm from "node:vm";

import { compiledScripts } from "./vendor.ts";

export type TemplateFailureCode =
  /** The template is not valid EJS / JavaScript. */
  | "syntax"
  /** It threw, or its promise rejected. */
  | "runtime"
  /** It ran past its time limit. */
  | "timeout"
  /** Its promise had not settled when its call ended (it awaited something that never came). */
  | "unsettled"
  /** The template source is over `MAX_TEMPLATE_CHARS`. */
  | "template_too_large"
  /** The rendered text is over `MAX_OUTPUT_CHARS`. */
  | "output_too_large"
  /** The assembly's time was used up before this template ran. */
  | "assembly_time_exhausted"
  /** The context answered with something that is not the bridge's protocol. */
  | "engine";

export type RenderOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: TemplateFailureCode; readonly detail?: string };

export type ConditionOutcome =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly code: TemplateFailureCode };

/** A template write, applied by the caller (the template never touches engine state). */
export interface TemplateWrite {
  /** The variable path, `variables.` / `stat_data.` stripped. */
  readonly path: string;
  readonly value: unknown;
}

export interface TemplateLimits {
  /** Wall time one render or condition may take. */
  readonly perTemplateMs: number;
  /** Wall time all renders and conditions of one assembly may take together. */
  readonly perAssemblyMs: number;
}

export const DEFAULT_LIMITS: TemplateLimits = Object.freeze({ perTemplateMs: 1000, perAssemblyMs: 3000 });
/** Upper bounds a caller cannot raise. */
export const MAX_PER_TEMPLATE_MS = 5000;
export const MAX_PER_ASSEMBLY_MS = 15_000;
/** Template writes kept per assembly (the old engine's cap). */
export const MAX_TEMPLATE_WRITES = 64;
/** `activewi()` names kept per assembly. */
export const MAX_ACTIVATIONS = 64;
/** `injectPrompt()` calls kept per assembly. */
export const MAX_INJECTIONS = 64;
/** Warnings kept per assembly. */
export const MAX_WARNINGS = 32;
/** One write's JSON, in UTF-16 units. */
export const MAX_WRITE_CHARS = 16_384;
/** A template source, in UTF-16 units (entries are at most 16,000 code points). */
export const MAX_TEMPLATE_CHARS = 65_536;
/** A rendered text, in UTF-16 units. */
export const MAX_OUTPUT_CHARS = 100_000;
/** One `take()` answer, in UTF-16 units: writes + activations + warnings + text. */
const MAX_TAKE_CHARS = 4_000_000;
/** Building a context runs only this engine's own scripts; the limit is a safety net. */
const SETUP_TIMEOUT_MS = 2000;

export interface TemplateEnvironment {
  readonly flat: Readonly<Record<string, unknown>>;
  readonly tree: Readonly<Record<string, unknown>>;
  /** The `getwi` library: [title, content] pairs; a later title wins. */
  readonly worldInfo: ReadonlyArray<readonly [string, string]>;
  readonly character: Readonly<Record<string, unknown>>;
  readonly chat: Readonly<Record<string, unknown>>;
  /** Seeds the context's `Math.random`. */
  readonly seed: string;
  /** The context's fixed `Date.now()`. */
  readonly nowMs: number;
}

/** A monotonic millisecond clock (injectable for tests). */
export type Clock = () => number;

function bounded(value: number, ceiling: number): number {
  return Number.isFinite(value) ? Math.min(ceiling, Math.max(1, Math.trunc(value))) : ceiling;
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FAILURE_CODES: ReadonlySet<string> = new Set(["syntax", "runtime", "unsettled"]);

export class TemplateSession {
  readonly #env: TemplateEnvironment;
  readonly #limits: TemplateLimits;
  readonly #clock: Clock;
  #spent = 0;
  #context: vm.Context | undefined;
  #flatOverlay = new Map<string, unknown>();
  readonly #writes: TemplateWrite[] = [];
  #activationCount = 0;
  #pendingActivations: string[] = [];
  readonly #warnings: string[] = [];
  #droppedWrites = 0;

  constructor(env: TemplateEnvironment, limits: TemplateLimits = DEFAULT_LIMITS, clock: Clock = () => performance.now()) {
    this.#env = env;
    this.#limits = {
      perTemplateMs: bounded(limits.perTemplateMs, MAX_PER_TEMPLATE_MS),
      perAssemblyMs: bounded(limits.perAssemblyMs, MAX_PER_ASSEMBLY_MS),
    };
    this.#clock = clock;
  }

  /** Writes collected so far, in call order. */
  get writes(): readonly TemplateWrite[] {
    return this.#writes;
  }

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  /** Writes past the cap or over the size bound, dropped. */
  get droppedWrites(): number {
    return this.#droppedWrites;
  }

  /** Names passed to `activewi()` since the last call. */
  takeActivations(): string[] {
    const names = this.#pendingActivations;
    this.#pendingActivations = [];
    return names;
  }

  #remaining(): number {
    return this.#limits.perAssemblyMs - this.#spent;
  }

  #build(): vm.Context {
    const scripts = compiledScripts();
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.#env.flat)) Object.defineProperty(flat, key, { value, enumerable: true, writable: true, configurable: true });
    for (const [key, value] of this.#flatOverlay) Object.defineProperty(flat, key, { value, enumerable: true, writable: true, configurable: true });
    const payload = JSON.stringify({
      flat,
      tree: this.#env.tree,
      worldInfo: this.#env.worldInfo,
      character: this.#env.character,
      chat: this.#env.chat,
      writesSoFar: this.#writes.length + this.#droppedWrites,
      activationsSoFar: this.#activationCount,
      limits: {
        writes: MAX_TEMPLATE_WRITES,
        writeChars: MAX_WRITE_CHARS,
        activations: MAX_ACTIVATIONS,
        injections: MAX_INJECTIONS,
        warnings: MAX_WARNINGS,
      },
    });
    // A null-prototype sandbox: with an ordinary `{}` the context's global would resolve
    // `constructor` through the HOST's Object.prototype (measured on Bun), handing
    // content the host Function. Only primitive strings are placed on it.
    const sandbox = Object.create(null) as Record<string, unknown>;
    sandbox["__lwBoot"] = JSON.stringify({ seed: this.#env.seed, now: this.#env.nowMs });
    sandbox["__lwPayload"] = payload;
    const context = vm.createContext(sandbox, { microtaskMode: "afterEvaluate", codeGeneration: { strings: true, wasm: false } });
    for (const script of [scripts.environment, scripts.ejs, scripts.lodash, scripts.api]) {
      script.runInContext(context, { timeout: SETUP_TIMEOUT_MS });
    }
    return context;
  }

  /** Runs `code` in the context under the time limits; the raw result, or a failure code. */
  #run(code: string): { readonly value: unknown } | { readonly failure: TemplateFailureCode } {
    const remaining = this.#remaining();
    if (remaining <= 0) return { failure: "assembly_time_exhausted" };
    const timeout = Math.max(1, Math.min(this.#limits.perTemplateMs, Math.ceil(remaining)));
    const started = this.#clock();
    try {
      this.#context ??= this.#build();
      return { value: vm.runInContext(code, this.#context, { timeout }) };
    } catch (error) {
      if (isTimeout(error)) {
        this.#context = undefined;
        return { failure: "timeout" };
      }
      this.#context = undefined;
      return { failure: "engine" };
    } finally {
      this.#spent += Math.max(0, this.#clock() - started);
    }
  }

  /** Renders one EJS template. Never throws. */
  render(source: string): RenderOutcome {
    if (source.length > MAX_TEMPLATE_CHARS) return { ok: false, code: "template_too_large" };
    const started = this.#run(`__lw.render(${JSON.stringify(source)})`);
    if ("failure" in started) return { ok: false, code: started.failure };
    const taken = this.#run("__lw.take()");
    if ("failure" in taken) return { ok: false, code: taken.failure };
    return this.#absorb(taken.value);
  }

  /**
   * Evaluates a JavaScript condition the way ST-Prompt-Template's `@@if` does: the
   * expression is `eval`ed inside `with (data)`, and its truthiness is the verdict.
   * Never throws.
   */
  evaluateCondition(source: string): ConditionOutcome {
    if (source.length > MAX_TEMPLATE_CHARS) return { ok: false, code: "template_too_large" };
    const result = this.#run(`__lw.condition(${JSON.stringify(source)})`);
    if ("failure" in result) return { ok: false, code: result.failure };
    // Collect what the condition queued (warnings) through a take; its outcome is unused.
    const taken = this.#run("__lw.take()");
    if (!("failure" in taken)) this.#absorb(taken.value);
    if (result.value === null) return { ok: false, code: "runtime" };
    return typeof result.value === "boolean" ? { ok: true, value: result.value } : { ok: false, code: "engine" };
  }

  /** `evaluateCondition` folded to `null` on any failure. */
  evalCondition(source: string): boolean | null {
    const outcome = this.evaluateCondition(source);
    return outcome.ok ? outcome.value : null;
  }

  /** Validates one `take()` answer and keeps its side effects. */
  #absorb(raw: unknown): RenderOutcome {
    if (typeof raw !== "string" || raw.length > MAX_TAKE_CHARS) return { ok: false, code: "engine" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, code: "engine" };
    }
    if (!isRecord(parsed)) return { ok: false, code: "engine" };
    this.#keepEffects(parsed);
    const outcome = parsed["outcome"];
    if (!isRecord(outcome)) return { ok: false, code: "engine" };
    if (outcome["ok"] === true && typeof outcome["text"] === "string") {
      const text = outcome["text"];
      return text.length > MAX_OUTPUT_CHARS ? { ok: false, code: "output_too_large" } : { ok: true, text };
    }
    const code = typeof outcome["code"] === "string" && FAILURE_CODES.has(outcome["code"]) ? (outcome["code"] as TemplateFailureCode) : "engine";
    const detail = typeof outcome["detail"] === "string" ? outcome["detail"].slice(0, 500) : undefined;
    return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
  }

  #keepEffects(parsed: Record<string, unknown>): void {
    const writes = Array.isArray(parsed["writes"]) ? parsed["writes"] : [];
    for (const item of writes) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || item[0] === "" || typeof item[1] !== "string") continue;
      if (this.#writes.length >= MAX_TEMPLATE_WRITES || item[1].length > MAX_WRITE_CHARS) {
        this.#droppedWrites++;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(item[1]);
      } catch {
        this.#droppedWrites++;
        continue;
      }
      this.#writes.push({ path: item[0], value });
      this.#flatOverlay.set(item[0], value);
    }
    for (const counter of ["dropped", "oversize"]) {
      const count = parsed[counter];
      if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) this.#droppedWrites += Math.min(count, 1_000_000);
    }
    const activations = Array.isArray(parsed["activations"]) ? parsed["activations"] : [];
    for (const name of activations) {
      if (typeof name !== "string" || this.#activationCount >= MAX_ACTIVATIONS) continue;
      this.#pendingActivations.push(name.slice(0, 200));
      this.#activationCount++;
    }
    const warnings = Array.isArray(parsed["warnings"]) ? parsed["warnings"] : [];
    for (const warning of warnings) {
      if (typeof warning === "string" && this.#warnings.length < MAX_WARNINGS) this.#warnings.push(warning.slice(0, 200));
    }
  }
}
