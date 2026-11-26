// The one write-result vocabulary both variable kinds speak: the imported tree (a model's
// `<UpdateVariable>` commands) and the declared module variables (the Keeper's tools and
// the admin's commands). A write is data — applied with its old and new value, or refused
// with a stable code — never an exception and never English text; the caller renders it.
import type { Json } from "./tree.ts";

export type WriteRefusalCode =
  /** The path or variable id names nothing that exists. */
  | "unknown_path"
  /** A path segment lands inside a value that holds no children. */
  | "not_a_container"
  /** The parent of a path to be created does not exist. */
  | "missing_parent"
  /** The whole tree cannot be replaced, merged into or deleted by one command. */
  | "root_path"
  /** A list index that is not a non-negative integer, or is past the end. */
  | "bad_index"
  /** The target (or, for module variables, the value) is not a number. */
  | "not_a_number"
  /** `add`'s delta is not a number. */
  | "delta_not_number"
  /** The target holds a kind of value the operation does not change (`add` on text). */
  | "unsupported_target"
  /** A value in the command could not be read. */
  | "bad_value"
  /** `delete` found no such element or key. */
  | "not_found"
  /** `insert` without a key merges a mapping into a mapping; anything else is refused. */
  | "merge_mismatch"
  /** The write would push the tree past a bound (depth, node count, string length). */
  | "too_large"
  /** The value is not one of the variable's options. */
  | "not_an_option"
  /** The value is not usable true/false. */
  | "not_a_boolean"
  /** The value is not usable text (a mapping, a list, or null). */
  | "not_text"
  /** The text is longer than the variable allows. */
  | "too_long"
  /** The operation does not apply to this variable's kind (adjusting a text variable). */
  | "wrong_kind"
  /** No more variables may be declared. */
  | "limit_reached";

export type WriteOutcome =
  | { readonly status: "applied"; readonly old: Json; readonly value: Json }
  | { readonly status: "refused"; readonly code: WriteRefusalCode };

export function applied(old: Json, value: Json): WriteOutcome {
  return { status: "applied", old, value };
}

export function refused(code: WriteRefusalCode): WriteOutcome {
  return { status: "refused", code };
}
