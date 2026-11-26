/**
 * The built-in skills' `SKILL.md` text, imported as data so a compiled single-file binary
 * carries them (no file is read at run time). Order is the built-in discovery order.
 *
 * In the first release: `mature-mode`, `romance-relationships`, `image-gen`. Left out on
 * purpose: the forge skills (`module-forge`, `rule-forge`, `skill-forge` — the forge is not
 * in the first release) and `svg-mapmaker`.
 */

import imageGen from "../../../../skills/image-gen/SKILL.md" with { type: "text" };
import matureMode from "../../../../skills/mature-mode/SKILL.md" with { type: "text" };
import romance from "../../../../skills/romance-relationships/SKILL.md" with { type: "text" };

import { FrozenMap } from "../resolution/index.ts";

function text(id: string, value: unknown): readonly [string, string] {
  // The text loader yields a string; anything else means the import attribute was lost.
  if (typeof value !== "string") throw new TypeError(`built-in skill '${id}' was not embedded as text`);
  return [id, value];
}

/** Built-in skill id → `SKILL.md` text, in discovery order. */
export const BUILT_IN_SKILL_SOURCES: FrozenMap<string, string> = new FrozenMap([
  text("mature-mode", matureMode),
  text("romance-relationships", romance),
  text("image-gen", imageGen),
]);
