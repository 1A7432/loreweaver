import { stripControlChars, type Result } from "loreweaver-protocol/v3"
import { tt } from "./i18n"

/** A command's outcome as an admin screen shows it: the server's own words, or ours when no answer came. */
export interface Outcome {
  readonly ok: boolean
  readonly text: string
}

/**
 * `result` as a line for the person. A refusal shows the server's message as it came (it is already
 * in this member's language — a code is never re-translated here); `null` is a request that got no
 * answer at all (the link was down).
 */
export function outcomeOf(result: Result | null, locale: string): Outcome {
  if (result === null) return { ok: false, text: tt(locale, "log.notConnected") }
  if (!result.ok) return { ok: false, text: stripControlChars(result.error.message) }
  return { ok: true, text: stripControlChars(result.text ?? "") }
}
