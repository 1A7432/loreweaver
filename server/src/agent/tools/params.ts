// A tool's parameters, declared once: the same declaration produces the JSON Schema the
// model is sent, the TypeScript type the handler receives, and the rules the argument
// decoder applies. Nothing is written twice, so the schema and the type cannot drift.
//
//   const params = {
//     expression: param.string("Dice expression, e.g. '1d100'."),
//     actor: param.string("Set to the NPC/creature name ...").optional(),
//     bonus: param.integer("Count of ...").or(0),
//   };
//   // ArgsOf<typeof params> = { expression: string; actor: string | undefined; bonus: number }
//
// A required parameter must be sent; an optional one arrives as `undefined` when it is
// not; a defaulted one (`.or(value)`) arrives as its default. Only required parameters are
// listed in the schema's `required`.

/** The JSON types a parameter may have. */
export type ParamType = "string" | "integer" | "number" | "boolean" | "object" | "array";
/** The JSON types an array parameter's items may have. */
export type ItemType = "string" | "integer" | "number" | "boolean";

export type Presence = "required" | "optional" | "defaulted";

/** An object argument: a JSON object as the model sent it (never an array). */
export type ArgObject = Readonly<Record<string, unknown>>;

export interface Param<T, P extends Presence> {
  readonly type: ParamType;
  /** The item type of an array parameter; null otherwise. */
  readonly items: ItemType | null;
  readonly description: string;
  readonly presence: P;
  /** The value a defaulted parameter takes when absent. */
  readonly fallback: T | undefined;
  /** Never set: carries `T` for `ArgsOf`. */
  readonly __value?: T;
}

/** Any parameter. */
export type AnyParam = Param<unknown, Presence>;

/** A tool's parameters by name, in the order the schema lists them. */
export type ParamSet = Readonly<Record<string, AnyParam>>;

/** The arguments a handler receives for `S`. */
export type ArgsOf<S extends ParamSet> = {
  readonly [K in keyof S]: S[K] extends Param<infer T, "optional"> ? T | undefined : S[K] extends Param<infer T, Presence> ? T : never;
};

/** A required parameter, which can be made optional or given a default. */
export interface RequiredParam<T> extends Param<T, "required"> {
  optional(): Param<T, "optional">;
  or(fallback: T): Param<T, "defaulted">;
}

function make<T>(type: ParamType, description: string, items: ItemType | null = null): RequiredParam<T> {
  if (description.trim() === "") throw new Error("every tool parameter carries a description");
  const base = { type, items, description };
  return {
    ...base,
    presence: "required",
    fallback: undefined,
    optional: (): Param<T, "optional"> => ({ ...base, presence: "optional", fallback: undefined }),
    or: (fallback: T): Param<T, "defaulted"> => ({ ...base, presence: "defaulted", fallback }),
  };
}

type ItemValue<I extends ItemType> = I extends "string" ? string : I extends "boolean" ? boolean : number;

export const param = {
  string: (description: string): RequiredParam<string> => make<string>("string", description),
  integer: (description: string): RequiredParam<number> => make<number>("integer", description),
  number: (description: string): RequiredParam<number> => make<number>("number", description),
  boolean: (description: string): RequiredParam<boolean> => make<boolean>("boolean", description),
  object: (description: string): RequiredParam<ArgObject> => make<ArgObject>("object", description),
  array: <I extends ItemType>(items: I, description: string): RequiredParam<readonly ItemValue<I>[]> =>
    make<readonly ItemValue<I>[]>("array", description, items),
};

/** One property of a parameters schema. */
export interface PropertySchema {
  readonly type: ParamType;
  readonly description: string;
  readonly items?: { readonly type: ItemType };
}

/** The JSON Schema object of a tool's parameters. */
export interface ParametersSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, PropertySchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export function parametersSchema(params: ParamSet): ParametersSchema {
  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(params)) {
    properties[name] = spec.items === null ? { type: spec.type, description: spec.description } : { type: spec.type, description: spec.description, items: { type: spec.items } };
    if (spec.presence === "required") required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
