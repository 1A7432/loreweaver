import type { UiChoiceOption, UiChoicesBlock } from "loreweaver-protocol"

export const CHOICES_TTL_MS = 10 * 60 * 1000

const DIGITS_ONLY = /^\d+$/

export type ChoiceMatch =
  | { kind: "hit"; input: string }
  | { kind: "expired" }
  | { kind: "miss" }

/**
 * One open choices window per group. A digits-only message from any user within
 * the window (until the next Keeper narrative, or 10 minutes) becomes that
 * option's `input` on that user's link. Expired → the caller forwards as plain
 * text. A non-digit message never matches.
 */
export class ChoicesWindow {
  private current:
    | {
        options: UiChoiceOption[]
        openedAt: number
      }
    | undefined
  /** Distinguishes "never opened" (miss → normal inbound rules) from "just closed". */
  private closed = false

  open(block: UiChoicesBlock, now: number): void {
    this.current = { options: block.options.slice(), openedAt: now }
    this.closed = false
  }

  /** Keeper narrative (or an explicit close) ends the window. */
  close(): void {
    if (this.current) this.closed = true
    this.current = undefined
  }

  get isOpen(): boolean {
    return this.current !== undefined
  }

  match(text: string, now: number): ChoiceMatch {
    const trimmed = text.trim()
    if (!DIGITS_ONLY.test(trimmed)) return { kind: "miss" }
    const open = this.current
    if (!open) return this.closed ? { kind: "expired" } : { kind: "miss" }
    if (now - open.openedAt >= CHOICES_TTL_MS) {
      this.current = undefined
      this.closed = true
      return { kind: "expired" }
    }
    const index = Number.parseInt(trimmed, 10)
    const option = open.options[index - 1]
    if (!option) return { kind: "miss" }
    return { kind: "hit", input: option.input }
  }
}
