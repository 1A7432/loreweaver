// `st_ejs_full` vectors: one session per row, templates rendered in order on it, then the
// conditions. Compared: each render's text or failure class, the warnings, the condition
// verdicts, the buffered writes and the `activewi` names.
//
// Not compared: `error_message`. The recorded messages are QuickJS's wording; this engine
// runs on the host's JavaScript engine, whose messages differ. The failure CLASS
// (`syntax`, `runtime`, `timeout`) is the contract and is compared.
//
// The time limit here is 200 ms instead of the production 1 s, so the two infinite-loop
// cases stay fast; the outcome class is the same.

import { describe, expect, test } from "bun:test";

import { TemplateSession } from "../../../src/worker/templates/index.ts";
import { readReference } from "../../reference.ts";

interface Render {
  readonly ok: boolean;
  readonly text?: string;
  readonly warnings?: string[];
  readonly error_class?: string;
}
interface Row {
  readonly case: string;
  readonly input: {
    readonly templates: string[];
    readonly conditions: string[] | null;
    readonly flat: Record<string, unknown>;
    readonly tree: Record<string, unknown>;
    readonly worldinfo: Record<string, string>;
    readonly char: Record<string, unknown>;
    readonly chat: Record<string, unknown>;
  };
  readonly renders: Render[];
  readonly conditions: { readonly expression: string; readonly result: boolean | null }[];
  readonly pending_writes: [string, unknown][];
  readonly activated: string[];
}

/** Rows encoding an old-engine divergence from ST-Prompt-Template that this port corrects. */
const CORRECTED: Readonly<Record<string, string>> = {
  full_print_is_identity:
    "ST-PT compiles with `outputFunctionName: 'print'` (function/ejs.ts), so `<% print('x') %>` outputs x; the old engine shadowed print with an identity function",
};

export function sessionFor(input: Row["input"], perTemplateMs = 200): TemplateSession {
  return new TemplateSession(
    {
      flat: input.flat,
      tree: input.tree,
      worldInfo: Object.entries(input.worldinfo),
      character: input.char,
      chat: input.chat,
      seed: "vectors",
      nowMs: 0,
    },
    { perTemplateMs, perAssemblyMs: 10_000 },
  );
}

describe("st_ejs_full", () => {
  const rows = readReference<Row>("st_ejs_full");

  test("every row is accounted for", () => {
    expect(rows.length).toBe(54);
    for (const name of Object.keys(CORRECTED)) expect(rows.some((row) => row.case === name)).toBe(true);
  });

  for (const row of rows) {
    const corrected = CORRECTED[row.case];
    if (corrected !== undefined) {
      test.skip(`${row.case} (corrected: ${corrected})`, () => {});
      continue;
    }
    test(row.case, () => {
      const session = sessionFor(row.input);
      const renders = row.input.templates.map((template) => session.render(template));
      const got: unknown[] = renders.map((render) => (render.ok ? { ok: true, text: render.text } : { ok: false, class: render.code }));
      expect(got).toEqual(
        row.renders.map((render) => (render.ok ? { ok: true, text: render.text } : { ok: false, class: render.error_class })),
      );
      const verdicts = (row.input.conditions ?? []).map((condition) => session.evalCondition(condition));
      expect(verdicts).toEqual(row.conditions.map((condition) => condition.result));
      expect(session.warnings).toEqual(row.renders.flatMap((render) => render.warnings ?? []));
      expect(session.writes.map((write) => [write.path, write.value])).toEqual(row.pending_writes);
      expect(session.takeActivations()).toEqual(row.activated);
    });
  }
});

// `st_ejs_lite` recorded the dropped subset renderer; its templates are reused here only
// as extra inputs: every one must come back as a well-formed outcome without throwing,
// and a successful render must not contain an EJS tag the template did not escape.
describe("st_ejs_lite templates on the full engine", () => {
  interface LiteRow {
    readonly case: string;
    readonly input: { readonly template: string; readonly flat?: Record<string, unknown>; readonly tree?: Record<string, unknown> };
  }
  const rows = readReference<LiteRow>("st_ejs_lite");

  test("each renders to a text or a failure code", () => {
    expect(rows.length).toBe(54);
    for (const row of rows) {
      const session = sessionFor({ templates: [], conditions: null, flat: row.input.flat ?? {}, tree: row.input.tree ?? {}, worldinfo: {}, char: {}, chat: {} });
      const outcome = session.render(row.input.template);
      if (outcome.ok) {
        const escaped = row.input.template.includes("<%%");
        if (!escaped) expect(outcome.text.includes("<%")).toBe(false);
      } else {
        expect(["syntax", "runtime", "timeout", "unsettled", "template_too_large"]).toContain(outcome.code);
      }
    }
  });
});
