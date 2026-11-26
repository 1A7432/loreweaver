// `st_decorators` vectors: leading `@@decorator` lines. Every row is compared.

import { describe, expect, test } from "bun:test";

import { splitDecorators } from "../../../src/core/worldbook/index.ts";
import { readReference } from "../../reference.ts";

interface Row {
  readonly case: string;
  readonly input: { readonly text: string };
  readonly decorators: Record<string, string | true>;
  readonly body: string;
}

describe("st_decorators", () => {
  const rows = readReference<Row>("st_decorators");

  test("every row is accounted for", () => {
    expect(rows.length).toBe(15);
  });

  for (const row of rows) {
    test(row.case, () => {
      const { decorators, body } = splitDecorators(row.input.text);
      expect(Object.fromEntries(decorators)).toEqual(row.decorators);
      expect(body).toBe(row.body);
    });
  }
});
