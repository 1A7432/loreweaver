import { describe, expect, test } from "bun:test";

import { decodeArgs, param } from "../../../src/agent/tools/index.ts";

const params = {
  name: param.string("A name."),
  count: param.integer("A count.").or(0),
  ratio: param.number("A ratio.").optional(),
  flag: param.boolean("A flag.").or(false),
  tags: param.array("integer", "Some numbers.").optional(),
  extra: param.object("A mapping.").optional(),
};

function decode(value: Record<string, unknown>) {
  return decodeArgs(params, { valid: true, value });
}

function args(value: Record<string, unknown>) {
  const decoded = decode(value);
  if (!decoded.ok) throw new Error(decoded.error);
  return decoded.args;
}

function error(value: Record<string, unknown>): string {
  const decoded = decode(value);
  if (decoded.ok) throw new Error("expected a refusal");
  return decoded.error;
}

describe("the argument decoder", () => {
  test("fills defaults and leaves optionals undefined", () => {
    expect(args({ name: "Ada" })).toEqual({ name: "Ada", count: 0, ratio: undefined, flag: false, tags: undefined, extra: undefined });
  });

  test("null counts as absent", () => {
    expect(args({ name: "Ada", count: null }).count).toBe(0);
    expect(error({ name: null })).toBe("missing required argument 'name'");
  });

  test("a missing required argument is named", () => {
    expect(error({ count: 1 })).toBe("missing required argument 'name'");
  });

  test("unknown argument names are refused, listing the accepted ones", () => {
    expect(error({ name: "x", value: 1 })).toBe("unknown argument 'value'; accepted parameters: name, count, ratio, flag, tags, extra");
    expect(error({ name: "x", a: 1, b: 2 })).toStartWith("unknown arguments 'a', 'b';");
    // A content key that is also an object's prototype name is just an unknown name.
    expect(error(JSON.parse('{"name":"x","__proto__":1}'))).toStartWith("unknown argument '__proto__'");
  });

  test("strings: kept, or written out as the reference did", () => {
    expect(args({ name: 5 }).name).toBe("5");
    expect(args({ name: true }).name).toBe("True");
    expect(args({ name: false }).name).toBe("False");
    expect(args({ name: [1, "a"] }).name).toBe('[1,"a"]');
  });

  test("integers: booleans, whole numbers and digit strings", () => {
    expect(args({ name: "x", count: true }).count).toBe(1);
    expect(args({ name: "x", count: false }).count).toBe(0);
    expect(args({ name: "x", count: 7.0 }).count).toBe(7);
    expect(args({ name: "x", count: " -12 " }).count).toBe(-12);
    expect(args({ name: "x", count: "+3" }).count).toBe(3);
    expect(error({ name: "x", count: 2.5 })).toBe("cannot coerce 2.5 to int");
    expect(error({ name: "x", count: "2.0" })).toBe('cannot coerce "2.0" to int');
    expect(error({ name: "x", count: "abc" })).toBe('cannot coerce "abc" to int');
    expect(error({ name: "x", count: 2 ** 60 })).toStartWith("cannot coerce");
  });

  test("numbers: never a boolean", () => {
    expect(args({ name: "x", ratio: 0.5 }).ratio).toBe(0.5);
    expect(args({ name: "x", ratio: " 1e2 " }).ratio).toBe(100);
    expect(args({ name: "x", ratio: "-.5" }).ratio).toBe(-0.5);
    expect(error({ name: "x", ratio: true })).toBe("cannot coerce true to float");
    expect(error({ name: "x", ratio: "inf" })).toBe('cannot coerce "inf" to float');
  });

  test("booleans: words and numbers", () => {
    for (const word of ["true", "1", "yes", "Y", " on "]) expect(args({ name: "x", flag: word }).flag).toBe(true);
    for (const word of ["false", "0", "no", "N", "off"]) expect(args({ name: "x", flag: word }).flag).toBe(false);
    expect(args({ name: "x", flag: 2 }).flag).toBe(true);
    expect(args({ name: "x", flag: 0 }).flag).toBe(false);
    expect(error({ name: "x", flag: "maybe" })).toBe('cannot coerce "maybe" to bool');
  });

  test("arrays: each item coerced; objects must be objects", () => {
    expect(args({ name: "x", tags: ["1", 2, true] }).tags).toEqual([1, 2, 1]);
    expect(error({ name: "x", tags: "1,2" })).toBe('expected a list, got "1,2"');
    expect(error({ name: "x", tags: ["a"] })).toBe('cannot coerce "a" to int');
    expect(args({ name: "x", extra: { pool: 3 } }).extra).toEqual({ pool: 3 });
    expect(error({ name: "x", extra: [1] })).toBe("expected an object, got [1]");
  });

  test("arguments that were not valid JSON come back as a readable refusal", () => {
    const decoded = decodeArgs(params, { valid: false, raw: '{"name": "Ada", "count": ' });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toContain("not a JSON object");
    expect(decoded.error).toContain('{\\"name\\": \\"Ada\\"');
    const long = decodeArgs(params, { valid: false, raw: "x".repeat(5000) });
    expect(!long.ok && long.error.length < 400).toBe(true);
  });
});
