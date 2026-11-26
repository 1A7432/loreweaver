// The reply stream gate: fail-closed incremental release of the Keeper's in-progress reply
// (ported from `_ReplyStreamGate` in `agent/loop.py`).
//
// A leak cannot be streamed first and stripped later, so text leaves for the table only
// once it can no longer become part of a machinery block (a textual tool call, see
// `stripTextToolCalls`) or an `<UpdateVariable>` block: everything from a plausible opener
// onward is HELD until the block closes (then dropped whole) or the round ends (an
// unclosed suspicious tail is dropped). Released text goes out in slices — at 48
// characters or a newline — as `draft` signals; a client appends the slices of one id, and
// the final `narrative` event with that id replaces the bubble, so the event is
// authoritative and a draft can only ever show LESS than it.
//
// Ids: each round drafts under a fresh id (`newId`), so a discarded draft never comes
// back. A round that turns out to be a tool round is discarded; so is a draft the provider
// abandoned mid-stream to retry (`discard()`, from `ChatOptions.onRetry`), after which the
// retry streams under a new id. The reply event takes the id of the round it came from:
// read `id` after `finishRound({ discard: false })`.
//
// Synchronous: `emit` is called in order, inside `feed`/`finishRound`/`discard`. An `emit`
// that throws ends the round's drafting (nothing more is shown; the event still lands).
import type { SignalPayloads } from "loreweaver-protocol/v3";

import { stripTextToolCalls } from "./reply.ts";

/** Released text is sent once this many characters (code points) are pending, or at a newline. */
export const DRAFT_FLUSH_CHARS = 48;

// Tag-name prefixes that may open a machinery block or an MVU update block.
const SUSPECT_PREFIXES: readonly string[] = ["deep", "use", "tool_call", "tool_use", "function_call", "function_calls", "invoke", "updatevariable"];
// After a `<`: optional spaces and slash, then a tag name (Python's `[\w-]`, any script).
const TAG_RE = /^\s*\/?\s*([A-Za-z_][\p{L}\p{N}_-]*)/u;
// What may follow a `<` before the tag name has started.
const UNFINISHED_TAG_RE = /^\s*\/?\s*$/u;

/** Where text first could still be the start of a suspicious block; `text.length` when nowhere. */
export function suspectHoldIndex(text: string): number {
  let search = 0;
  for (;;) {
    const index = text.indexOf("<", search);
    if (index === -1) return text.length;
    const rest = text.slice(index + 1);
    // A trailing `<` (or `<` and spaces, or the slash of a closing tag) could still become
    // anything. (The reference held only `<` and spaces, so a closing tag split after its
    // slash — `</` then `UpdateVariable…` — streamed; held whole it was held.)
    if (UNFINISHED_TAG_RE.test(rest)) return index;
    const tag = TAG_RE.exec(rest);
    if (tag !== null) {
      const name = (tag[1] ?? "").toLowerCase();
      if (SUSPECT_PREFIXES.some((prefix) => name.startsWith(prefix) || prefix.startsWith(name))) return index;
    }
    search = index + 1;
  }
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

export type DraftPayload = SignalPayloads["draft"];

export interface ReplyStreamGateOptions {
  readonly emit: (draft: DraftPayload) => void;
  /** A fresh id for each draft (the reply event reuses the last kept one). */
  readonly newId: () => string;
}

export class ReplyStreamGate {
  readonly #emit: (draft: DraftPayload) => void;
  readonly #newId: () => string;
  #id: string;
  #pending = "";
  #held = "";
  /** A slice went out under the current id. */
  #shown = false;
  /** Between `beginRound` and `finishRound`, and not stopped by a failed emit. */
  #open = false;

  constructor(options: ReplyStreamGateOptions) {
    this.#emit = options.emit;
    this.#newId = options.newId;
    this.#id = options.newId();
  }

  /** The current draft's id: after a kept round, the id its reply event takes. */
  get id(): string {
    return this.#id;
  }

  /** A model round starts: a fresh draft. */
  beginRound(): void {
    this.#reset(this.#newId());
    this.#open = true;
  }

  /** A piece of the model's text (`ChatOptions.onTextDelta`). */
  feed(delta: string): void {
    if (!this.#open) return;
    this.#held += delta;
    this.#releaseSafe();
    if (codePointLength(this.#pending) >= DRAFT_FLUSH_CHARS || this.#pending.includes("\n")) this.#flush();
  }

  /**
   * The round is over. A tool round (`discard: true`) drops its draft; a final round
   * releases the held remainder through the full strip, minus any unclosed suspicious tail.
   */
  finishRound(options: { readonly discard: boolean }): void {
    if (options.discard) {
      this.#drop();
      this.#open = false;
      return;
    }
    if (this.#open) {
      const remainder = stripTextToolCalls(this.#held);
      this.#held = "";
      this.#pending += remainder.slice(0, suspectHoldIndex(remainder));
      this.#flush();
    }
    this.#pending = "";
    this.#held = "";
    this.#open = false;
  }

  /**
   * Drop everything drafted so far in this round — the provider is retrying the call
   * (`ChatOptions.onRetry`) — and keep streaming the retry under a fresh id.
   */
  discard(): void {
    const open = this.#open;
    this.#drop();
    this.#reset(this.#newId());
    this.#open = open;
  }

  #drop(): void {
    if (this.#shown) this.#send({ id: this.#id, discard: true });
    this.#pending = "";
    this.#held = "";
    this.#shown = false;
  }

  #reset(id: string): void {
    this.#id = id;
    this.#pending = "";
    this.#held = "";
    this.#shown = false;
  }

  #releaseSafe(): void {
    for (;;) {
      const cut = suspectHoldIndex(this.#held);
      if (cut < this.#held.length) {
        const stripped = stripTextToolCalls(this.#held);
        if (stripped !== this.#held) {
          // A machinery block completed and was dropped whole; look again.
          this.#held = stripped;
          continue;
        }
      }
      this.#pending += this.#held.slice(0, cut);
      this.#held = this.#held.slice(cut);
      return;
    }
  }

  #flush(): void {
    if (this.#pending === "" || !this.#open) return;
    const text = this.#pending;
    this.#pending = "";
    if (this.#send({ id: this.#id, text })) this.#shown = true;
  }

  #send(draft: DraftPayload): boolean {
    try {
      this.#emit(draft);
      return true;
    } catch {
      // Fail closed: nothing more is shown this round. A half-sent slice is still on the
      // table, so a later discard must still be sent.
      this.#open = false;
      if ("text" in draft) this.#shown = true;
      return false;
    }
  }
}
