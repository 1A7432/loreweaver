/**
 * Leading `@@decorator` lines on an entry's content (the ST-Prompt-Template convention,
 * also SillyTavern's own `@@activate` / `@@dont_activate`).
 *
 * The rules are the recorded ones (`st_decorators` vectors): parsing starts at the first
 * line and stops at the first line that is neither a decorator nor blank; a blank FIRST
 * line means "no decorators"; blank lines after a decorator are consumed; leading
 * whitespace on a decorator line is tolerated; a name is letters and underscores only and
 * is lower-cased; a repeated decorator's last occurrence wins; `@@if <expr>` keeps its
 * trimmed expression and every other decorator (with or without an argument) is a flag.
 * SillyTavern's own `parseDecorators` (world-info.js) recognises only its two built-ins
 * and skips `@@@` escapes; the wider rule here exists because imported cards also carry
 * the extension's `@@if`, `@@initial_variables` and render-time decorators, which must
 * come off the content either way.
 */

/** What a decorator line says: `@@if` carries its expression, every other one is a flag. */
export type DecoratorValue = string | true;

export interface Decorated {
  /** Decorator names (lower-cased) in first-appearance order. */
  readonly decorators: ReadonlyMap<string, DecoratorValue>;
  /** The content after the decorator block; the original text when there was none. */
  readonly body: string;
}

const DECORATOR_LINE = /^@@([A-Za-z_]+)(?:\s+(.*))?$/su;

/** Splits the leading decorator lines off `text`. */
export function splitDecorators(text: string): Decorated {
  const decorators = new Map<string, DecoratorValue>();
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    if (line === "" && decorators.size > 0) {
      index++;
      continue;
    }
    const match = DECORATOR_LINE.exec(line);
    if (match === null) break;
    const name = (match[1] ?? "").toLowerCase();
    const arg = (match[2] ?? "").trim();
    // Setting an existing key keeps its position: the last occurrence's value wins.
    decorators.set(name, name === "if" && arg !== "" ? arg : true);
    index++;
  }
  if (decorators.size === 0) return { decorators, body: text };
  return { decorators, body: lines.slice(index).join("\n") };
}
