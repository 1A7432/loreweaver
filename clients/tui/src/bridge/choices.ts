import type { UiChoiceOption, UiChoicesBlock } from "loreweaver-protocol"

export const CHOICES_TTL_MS = 10 * 60 * 1000

const DIGITS_ONLY = /^\d+$/

export type ChoiceMatch =
  | { kind: "hit"; input: string }
  | { kind: "expired" }
  | { kind: "miss" }

function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
}

/**
 * One open choices window per group. A digits-only message from any user within
 * the window (until the next Keeper narrative, or 10 minutes) becomes that
 * option's `input` on that user's link. Expired / closed digits go through
 * normal inbound rules (they are not auto-forwarded). A non-digit never matches.
 */
export class ChoicesWindow {
  private current:
    | {
        options: UiChoiceOption[]
        openedAt: number
      }
    | undefined
  private closedAt: number | undefined

  open(block: UiChoicesBlock, now: number): void {
    this.current = { options: block.options.slice(), openedAt: now }
    this.closedAt = undefined
  }

  /** Keeper narrative (or an explicit close) ends the window. */
  close(now: number): void {
    if (this.current || this.closedAt !== undefined) this.closedAt = now
    this.current = undefined
  }

  get isOpen(): boolean {
    return this.current !== undefined
  }

  match(text: string, now: number): ChoiceMatch {
    const trimmed = normalizeDigits(text.trim())
    if (!DIGITS_ONLY.test(trimmed)) return { kind: "miss" }
    if (this.closedAt !== undefined && now - this.closedAt >= CHOICES_TTL_MS) {
      this.closedAt = undefined
    }
    const open = this.current
    if (!open) return this.closedAt !== undefined ? { kind: "expired" } : { kind: "miss" }
    if (now - open.openedAt >= CHOICES_TTL_MS) {
      this.current = undefined
      this.closedAt = now
      return { kind: "expired" }
    }
    const index = Number.parseInt(trimmed, 10)
    const option = open.options[index - 1]
    if (!option) return { kind: "miss" }
    return { kind: "hit", input: option.input }
  }
}
