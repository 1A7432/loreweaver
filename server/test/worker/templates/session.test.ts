// The template engine's guarantees: isolation, time limits, bounded effects, pending
// promises, determinism. Short limits keep the timeouts fast.

import { describe, expect, test } from "bun:test";

import { MAX_OUTPUT_CHARS, MAX_TEMPLATE_CHARS, TemplateSession, type TemplateEnvironment } from "../../../src/worker/templates/index.ts";

const ENV: TemplateEnvironment = {
  flat: { fear: 7 },
  tree: { 理: { 好感度: [33, "affinity"] } },
  worldInfo: [["chapel", "The chapel is locked."]],
  character: { name: "络络" },
  chat: {},
  seed: "s",
  nowMs: 1_700_000_000_000,
};

function session(perTemplateMs = 100, perAssemblyMs = 2000, env: TemplateEnvironment = ENV): TemplateSession {
  return new TemplateSession(env, { perTemplateMs, perAssemblyMs });
}

describe("isolation", () => {
  test("no host globals, no host Function through any constructor chain", () => {
    const outcome = session().render(
      [
        "<%= typeof process %>",
        "<%= typeof Bun %>",
        "<%= typeof require %>",
        "<%= typeof module %>",
        "<%= typeof setTimeout %>",
        "<%= this.constructor.constructor('return typeof process')() %>",
        "<%= globalThis.constructor.constructor('return typeof Bun')() %>",
        "<%= getvar.constructor('return typeof process')() %>",
        "<%= (function(){ return this })().constructor.constructor('return typeof require')() %>",
        "<%= typeof WebAssembly %>",
        "<%= typeof Atomics %>",
        "<%= typeof SharedArrayBuffer %>",
      ].join("|"),
    );
    expect(outcome).toEqual({ ok: true, text: Array.from({ length: 12 }, () => "undefined").join("|") });
  });

  test("dynamic import is refused", () => {
    const outcome = session().render("<% const m = await import('node:fs') %>x");
    expect(outcome.ok).toBe(false);
  });

  test("`require` and `process` used directly are runtime failures", () => {
    expect(session().render("<% require('node:fs') %>")).toMatchObject({ ok: false, code: "runtime" });
    expect(session().render("<%= process.env.HOME %>")).toMatchObject({ ok: false, code: "runtime" });
  });

  test("console exists but writes nowhere", () => {
    expect(session().render("<% console.log('hi') %>ok")).toEqual({ ok: true, text: "ok" });
  });

  test("a template cannot replace the bridge", () => {
    const s = session();
    expect(s.render("<% try { globalThis.__lw = null } catch (e) {} %><% try { __lw.take = () => 'x' } catch (e) {} %>a")).toEqual({ ok: true, text: "a" });
    expect(s.render("<%= 1 + 1 %>")).toEqual({ ok: true, text: "2" });
  });

  test("two sessions share nothing", () => {
    const a = session();
    a.render("<% define('carried', 1); globalThis.leak = 2 %>");
    expect(a.render("<%= carried %>")).toEqual({ ok: true, text: "1" });
    const b = session();
    expect(b.render("<%= typeof carried %>|<%= typeof leak %>")).toEqual({ ok: true, text: "undefined|undefined" });
  });
});

describe("failures render as nothing and say why", () => {
  test("an infinite loop times out, and the next template still runs with earlier writes", () => {
    const s = session(50);
    expect(s.render("<% setvar('before', 1) %>ok")).toEqual({ ok: true, text: "ok" });
    expect(s.render("<% setvar('lost', 1); while (true) {} %>")).toEqual({ ok: false, code: "timeout" });
    expect(s.render("<%= getvar('before') %>|<%= getvar('lost') %>")).toEqual({ ok: true, text: "1|" });
    expect(s.writes).toEqual([{ path: "before", value: 1 }]);
  });

  test("an endless promise chain times out too", () => {
    expect(session(50).render("<% await (async function spin() { for (;;) await null; })() %>")).toEqual({ ok: false, code: "timeout" });
  });

  test("a throw, a rejection and a syntax error have their codes", () => {
    expect(session().render("<% throw new Error('boom') %>")).toMatchObject({ ok: false, code: "runtime", detail: expect.stringContaining("boom") });
    expect(session().render("<%= await Promise.reject(new Error('no')) %>")).toMatchObject({ ok: false, code: "runtime" });
    expect(session().render("<% if ( { %>")).toMatchObject({ ok: false, code: "syntax" });
    expect(session().render("a <%= 1 ")).toMatchObject({ ok: false, code: "syntax" });
  });

  test("the assembly budget runs out across templates", () => {
    const s = session(40, 60);
    expect(s.render("<% while (true) {} %>")).toEqual({ ok: false, code: "timeout" });
    const second = s.render("<% while (true) {} %>");
    expect(second.ok).toBe(false);
    expect(s.render("plain <%= 1 %>")).toEqual({ ok: false, code: "assembly_time_exhausted" });
  });

  test("oversized sources and outputs fail", () => {
    expect(session().render("x".repeat(MAX_TEMPLATE_CHARS + 1))).toEqual({ ok: false, code: "template_too_large" });
    expect(session().render(`<%= 'x'.repeat(${MAX_OUTPUT_CHARS + 1}) %>`)).toEqual({ ok: false, code: "output_too_large" });
  });
});

describe("pending promises", () => {
  test("a template left waiting is `unsettled`, and resolving it later cannot act for it", () => {
    const s = session();
    expect(s.render("<% await new Promise((resolve) => { globalThis.wake = resolve }); setvar('late', 1); activewi('late') %>")).toEqual({
      ok: false,
      code: "unsettled",
    });
    expect(s.render("<% wake() %>woke")).toEqual({ ok: true, text: "woke" });
    expect(s.render("<%= getvar('late') %>")).toEqual({ ok: true, text: "" });
    expect(s.writes).toEqual([]);
    expect(s.takeActivations()).toEqual([]);
  });
});

describe("bounded effects", () => {
  test("at most 64 writes are kept per assembly, the rest are counted", () => {
    const s = session();
    expect(s.render("<% for (let i = 0; i < 70; i++) setvar('k' + i, i) %>done")).toEqual({ ok: true, text: "done" });
    expect(s.render("<% setvar('more', 1) %>")).toEqual({ ok: true, text: "" });
    expect(s.writes.length).toBe(64);
    expect(s.writes[63]).toEqual({ path: "k63", value: 63 });
    expect(s.droppedWrites).toBe(7);
  });

  test("a write that is not JSON or too large is dropped", () => {
    const s = session();
    s.render("<% const o = {}; o.self = o; setvar('cycle', o); setvar('big', 'x'.repeat(20000)); setvar('fn', () => 1); setvar('ok', [1, 'a']) %>");
    expect(s.writes).toEqual([{ path: "ok", value: [1, "a"] }]);
    expect(s.droppedWrites).toBe(3);
  });

  test("write paths drop the `variables.` / `stat_data.` root; `__proto__` is an ordinary name", () => {
    const s = session();
    expect(s.render("<% setvar('variables.a', 1); setvar('__proto__', 2) %><%= getvar('__proto__') %>")).toEqual({ ok: true, text: "2" });
    expect(s.writes).toEqual([
      { path: "a", value: 1 },
      { path: "__proto__", value: 2 },
    ]);
    expect(Object.getPrototypeOf(s.writes[1])).toBe(Object.prototype);
  });
});

describe("ST-Prompt-Template surface", () => {
  test("print() writes to the output (outputFunctionName: 'print')", () => {
    expect(session().render("a<% print('x', 'y') %>b<%= 'z' %>")).toEqual({ ok: true, text: "axbz" });
  });

  test("getwi by name or by (book, name); getchar; SafeGetValue; lodash", () => {
    expect(
      session().render("<%- getwi('chapel') %>|<%- getwi('any book', 'chapel') %>|<%= getchar('name') %>|<%= SafeGetValue(stat_data.理.好感度) %>|<%= _.sum([1, 2]) %>"),
    ).toEqual({ ok: true, text: "The chapel is locked.|The chapel is locked.|络络|33|3" });
  });

  test("define returns the previous value", () => {
    expect(session().render("<%= define('a', 1) %>|<%= define('a', 2) %>|<%= a %>")).toEqual({ ok: true, text: "|1|2" });
  });

  test("conditions: truthiness, and null when the expression throws or loops", () => {
    const s = session(50);
    expect(s.evaluateCondition("getvar('fear') > 5")).toEqual({ ok: true, value: true });
    expect(s.evaluateCondition("nothing.here")).toEqual({ ok: false, code: "runtime" });
    expect(s.evaluateCondition("while (true) {}")).toEqual({ ok: false, code: "timeout" });
    expect(s.evalCondition("[1].length")).toBe(true);
  });
});

describe("determinism", () => {
  test("Math.random and Date come from the environment", () => {
    const template = "<%= Math.random() %>|<%= Date.now() %>|<%= new Date().getTime() %>|<%= _.random(1, 1000) %>|<%= new Date(0).getTime() %>";
    const a = session().render(template);
    const b = session().render(template);
    expect(a).toEqual(b);
    expect(a.ok && a.text.split("|").slice(1, 3)).toEqual(["1700000000000", "1700000000000"]);
    const other = new TemplateSession({ ...ENV, seed: "other" }, { perTemplateMs: 100, perAssemblyMs: 1000 }).render(template);
    expect(other).not.toEqual(a);
  });

  test("a fresh context costs little", () => {
    const started = performance.now();
    for (let i = 0; i < 20; i++) session().render("<%= 1 %>");
    expect((performance.now() - started) / 20).toBeLessThan(50);
  });
});
