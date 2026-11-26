// A small JSON Schema checker for the subset the view schemas use: `type` (one or a list),
// `enum`, `const`, `anyOf`, `properties` / `required` / `additionalProperties: false`,
// `items`. Returns the paths that do not fit; empty when the value fits.
type Schema = { readonly [key: string]: unknown };

function typeOf(value: unknown): string[] {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array"];
  if (typeof value === "number") return Number.isSafeInteger(value) ? ["integer", "number"] : Number.isFinite(value) ? ["number"] : [];
  return [typeof value];
}

export function schemaProblems(schema: Schema, value: unknown, path = "$"): string[] {
  const problems: string[] = [];
  if (Array.isArray(schema.anyOf)) {
    const fits = (schema.anyOf as Schema[]).some((option) => schemaProblems(option, value, path).length === 0);
    if (!fits) problems.push(`${path}: matches no anyOf branch`);
  }
  if ("const" in schema && value !== schema.const) problems.push(`${path}: not ${JSON.stringify(schema.const)}`);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!typeOf(value).some((type) => allowed.includes(type))) {
      problems.push(`${path}: ${JSON.stringify(value)?.slice(0, 40)} is not ${allowed.join("|")}`);
      return problems;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`${path}: not in enum`);
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => problems.push(...schemaProblems(schema.items as Schema, item, `${path}[${index}]`)));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && schema.properties !== undefined) {
    const properties = schema.properties as Record<string, Schema>;
    const record = value as Record<string, unknown>;
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(record, name)) problems.push(`${path}.${name}: missing`);
    }
    for (const [name, member] of Object.entries(record)) {
      const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
      if (property === undefined) {
        if (schema.additionalProperties === false) problems.push(`${path}.${name}: not in the schema`);
        continue;
      }
      problems.push(...schemaProblems(property, member, `${path}.${name}`));
    }
  }
  return problems;
}
