/**
 * The built-in rule packs' YAML text, imported as data so a compiled single-file binary
 * carries them (no file is read at run time). Order is the built-in discovery order:
 * a built-in claims its names before any other pack.
 */

import coc7 from "../../../../rulepacks/coc7.yaml" with { type: "text" };
import dnd5e from "../../../../rulepacks/dnd5e.yaml" with { type: "text" };
import wod from "../../../../rulepacks/wod.yaml" with { type: "text" };

import { FrozenMap } from "../resolution/index.ts";

function text(id: string, value: unknown): readonly [string, string] {
  // The text loader yields a string; anything else means the import attribute was lost
  // (a bundler that parsed the YAML itself), and every pack would then be wrong.
  if (typeof value !== "string") throw new TypeError(`built-in rule pack '${id}' was not embedded as text`);
  return [id, value];
}

/** Built-in pack id → YAML text, in discovery order. */
export const BUILT_IN_SOURCES: FrozenMap<string, string> = new FrozenMap([text("coc7", coc7), text("dnd5e", dnd5e), text("wod", wod)]);
