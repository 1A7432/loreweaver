/**
 * SillyTavern status-bar residue. Cards built for ST's frontend carry macros such as
 * `{{format_message_variable::stat_data}}` inside wrapper tags (`<status_current_variables>`);
 * they are frontend render directives with no meaning in a prompt, and a model that quotes
 * one leaks raw template text to the table. They are removed at render time, wrapper
 * pairs left empty by that removal collapse, and an entry that is NOTHING but residue
 * imports disabled. This is the engine's own rule, not SillyTavern behaviour.
 */

const FRONTEND_MACRO = /\{\{(?:format|get)_message_variable::[^{}]*\}\}/gu;
// A wrapper pair with only whitespace inside. The tag name is a bounded run of word
// characters; the backreference only ever compares that one name.
const EMPTY_WRAPPER = /<([A-Za-z_][\p{L}\p{N}_-]{0,64})>\s*<\/\1>/gu;
const SEPARATOR_LINE = /^[-=_*·—]{3,}$/u;
// A text can only lose so many wrapper pairs; this bounds the collapse loop on content.
const MAX_COLLAPSE_PASSES = 64;

/** Removes status-bar macros and the wrapper tags their removal left empty. */
export function scrubFrontendTemplates(text: string): string {
  let cleaned = text.replace(FRONTEND_MACRO, "");
  if (cleaned === text && !new RegExp(EMPTY_WRAPPER.source, "u").test(cleaned)) return text;
  for (let pass = 0; pass < MAX_COLLAPSE_PASSES; pass++) {
    const next = cleaned.replace(EMPTY_WRAPPER, "");
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned.trim();
}

/**
 * Whether `content` carries no prompt meaning once the residue is scrubbed: nothing left,
 * or only separator rules and blank lines. A plain divider entry that had nothing
 * scrubbed is the author's own and keeps its meaning.
 */
export function isFrontendResidue(content: string): boolean {
  const remainder = scrubFrontendTemplates(content);
  if (remainder === "") return true;
  if (remainder === content) return false;
  return remainder.split(/\r?\n/u).every((line) => line.trim() === "" || SEPARATOR_LINE.test(line.trim()));
}
