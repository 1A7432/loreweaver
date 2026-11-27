import { expect, test } from "bun:test";

import { coerceWord, formArgs, MAX_FORM_WORD_CHARS, matchForm, parseForm, pickForm, type TextForm } from "./forms.ts";

const params = {
  type: "object",
  properties: { target: { type: "string" }, times: { type: "integer" }, ratio: { type: "number" }, loud: { type: "boolean" }, line: { type: "string" } },
};

function form(source: string, against: unknown = params): TextForm {
  const read = parseForm(source, against);
  if (!read.ok) throw new Error(`bad form in the test: ${source} (${read.problem})`);
  return read.form;
}

test("a form is read into its word, its tokens and its literal count", () => {
  expect(form("attack at {target} {times}")).toEqual({
    source: "attack at {target} {times}",
    word: "attack",
    tokens: [
      { kind: "literal", text: "at" },
      { kind: "one", name: "target" },
      { kind: "one", name: "times" },
    ],
    literals: 1,
  });
  expect(form("say {line...}").tokens).toEqual([{ kind: "rest", name: "line" }]);
  // The command word and the literals are held case-folded; the source is as written.
  expect(form("ATTACK At {target}")).toMatchObject({ source: "ATTACK At {target}", word: "attack", tokens: [{ kind: "literal", text: "at" }, { kind: "one", name: "target" }] });
});

test("the command word is any script, up to its length limit; nothing else is a word", () => {
  expect(form("攻击 {target}").word).toBe("攻击");
  expect(form("Ａttack {target}").word).toBe("ａttack");
  expect(parseForm("a".repeat(MAX_FORM_WORD_CHARS), params).ok).toBe(true);
  expect(parseForm("a".repeat(MAX_FORM_WORD_CHARS + 1), params)).toEqual({ ok: false, problem: "bad_word" });
  // Counted in code points, not UTF-16 units.
  expect(parseForm("𠮷".repeat(MAX_FORM_WORD_CHARS), params).ok).toBe(true);
  expect(parseForm("duel/attack {target}", params)).toEqual({ ok: false, problem: "bad_word" });
  expect(parseForm("{target}", params)).toEqual({ ok: false, problem: "bad_word" });
  expect(parseForm("", params)).toEqual({ ok: false, problem: "spacing" });
});

test("each rule a form can break names itself", () => {
  expect(parseForm("attack  {target}", params)).toEqual({ ok: false, problem: "spacing" });
  expect(parseForm(" attack", params)).toEqual({ ok: false, problem: "spacing" });
  expect(parseForm("attack\t{target}", params)).toEqual({ ok: false, problem: "spacing" });
  expect(parseForm("attack {target}x", params)).toEqual({ ok: false, problem: "bad_token" });
  expect(parseForm("attack {}", params)).toEqual({ ok: false, problem: "bad_token" });
  expect(parseForm("attack {line...} {target}", params)).toEqual({ ok: false, problem: "rest_not_last" });
  expect(parseForm("attack {nobody}", params)).toEqual({ ok: false, problem: "unknown_param" });
  expect(parseForm("attack {target} {target}", params)).toEqual({ ok: false, problem: "repeated_param" });
  expect(parseForm("attack {target} {target...}", params)).toEqual({ ok: false, problem: "repeated_param" });
  // A name is a property of `params` itself, never one found on the prototype chain.
  expect(parseForm("attack {constructor}", params)).toEqual({ ok: false, problem: "unknown_param" });
  expect(parseForm("attack {target}", undefined)).toEqual({ ok: false, problem: "unknown_param" });
});

test("a line is matched word by word; the rest of the line is trimmed and absent when empty", () => {
  expect(matchForm(form("attack {target}"), "Bo")).toEqual(new Map([["target", "Bo"]]));
  expect(matchForm(form("attack {target}"), "")).toBeNull();
  expect(matchForm(form("attack {target}"), "Bo again")).toBeNull();
  expect(matchForm(form("attack"), "")).toEqual(new Map());
  expect(matchForm(form("attack"), "Bo")).toBeNull();
  expect(matchForm(form("attack at {target}"), "AT Bo")).toEqual(new Map([["target", "Bo"]]));
  expect(matchForm(form("attack at {target}"), "by Bo")).toBeNull();
  expect(matchForm(form("say {line...}"), "Run,   now!  ")).toEqual(new Map([["line", "Run,   now!"]]));
  expect(matchForm(form("say {line...}"), "")).toEqual(new Map());
  expect(matchForm(form("go {target} {line...}"), "Bo to the door")).toEqual(new Map([["target", "Bo"], ["line", "to the door"]]));
  expect(matchForm(form("go {target} {line...}"), "Bo")).toEqual(new Map([["target", "Bo"]]));
  // Whole-word, case-folded matching of CJK and full-width literals.
  expect(matchForm(form("j 攻 {target}"), "攻 刀客")).toEqual(new Map([["target", "刀客"]]));
  expect(matchForm(form("j ａｔ {target}"), "ＡＴ Bo")).toEqual(new Map([["target", "Bo"]]));
});

test("a typed word is coerced by its property's declared type, and stays text when it does not parse", () => {
  expect(coerceWord("3", { type: "integer" })).toBe(3);
  expect(coerceWord("-2", { type: "integer" })).toBe(-2);
  expect(coerceWord("+7", { type: "integer" })).toBe(7);
  expect(coerceWord("1.5", { type: "integer" })).toBe("1.5");
  expect(coerceWord("12345678901234567890", { type: "integer" })).toBe("12345678901234567890");
  expect(coerceWord("1.5", { type: "number" })).toBe(1.5);
  expect(coerceWord(".5", { type: "number" })).toBe(0.5);
  expect(coerceWord("1e3", { type: "number" })).toBe(1000);
  expect(coerceWord("0x10", { type: "number" })).toBe("0x10");
  expect(coerceWord("", { type: "number" })).toBe("");
  expect(coerceWord("true", { type: "boolean" })).toBe(true);
  expect(coerceWord("false", { type: "boolean" })).toBe(false);
  expect(coerceWord("True", { type: "boolean" })).toBe("True");
  expect(coerceWord("3", { type: "string" })).toBe("3");
  expect(coerceWord("3", {})).toBe("3");
  expect(coerceWord("3", undefined)).toBe("3");
  // Several types: the first the text parses as, integer before number.
  expect(coerceWord("3", { type: ["number", "string"] })).toBe(3);
  expect(coerceWord("3", { type: ["string", "integer"] })).toBe(3);
  expect(coerceWord("x", { type: ["number", "string"] })).toBe("x");
});

test("the arguments of a form are its captured words, coerced; a name like __proto__ is a plain argument", () => {
  const captured = new Map([["target", "Bo"], ["times", "3"], ["loud", "true"], ["ratio", "x"]]);
  expect(formArgs(captured, params)).toEqual({ target: "Bo", times: 3, loud: true, ratio: "x" });
  const odd = { type: "object", properties: Object.fromEntries([["__proto__", { type: "integer" }]]) };
  const args = formArgs(new Map([["__proto__", "4"]]), odd);
  expect(Object.keys(args)).toEqual(["__proto__"]);
  expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toBe(4);
  expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
});

test("of the forms that fit, the one with the most literal words wins, then the first declared", () => {
  const candidates = ["attack {target}", "attack {target} {times}", "attack at {target}", "attack {target...}"].map((source) => ({ source, form: form(source) }));
  const pick = (rest: string) => pickForm(candidates, rest)?.candidate.source ?? null;
  expect(pick("Bo")).toBe("attack {target}");
  expect(pick("Bo 3")).toBe("attack {target} {times}");
  expect(pick("at Bo")).toBe("attack at {target}");
  // `attack {target...}` also fits `Bo 3 now`, and nothing else does.
  expect(pick("Bo 3 now")).toBe("attack {target...}");
  expect(pick("")).toBe("attack {target...}");
  expect(pickForm(candidates, "at Bo")?.captured).toEqual(new Map([["target", "Bo"]]));
  expect(pickForm([{ form: form("attack {target}") }], "")).toBeNull();
  expect(pickForm([], "Bo")).toBeNull();
});
