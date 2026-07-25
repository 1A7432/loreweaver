/** Copying the chat log to the SYSTEM clipboard from inside the full-screen TUI.
 *
 * Why this exists: the renderer runs with mouse reporting on (OpenTUI's
 * `useMouse` defaults to true), so the terminal hands mouse events to us and
 * stops doing its own drag-select — the reason players reported the narration
 * "can't really be copied". OpenTUI already tracks a selection over its own
 * renderables (`<text>` and `<markdown>` alike, verified in `copy.test.ts`);
 * what was missing was any way to get that selection OUT. `copySelection`
 * writes it to the real system clipboard over OSC 52, which also works through
 * SSH and over the Iroh carrier — the terminal at the player's end receives the
 * escape sequence, so no local filesystem or pbcopy/xclip is involved.
 *
 * Ctrl+C is the binding (wired in `App.tsx`), and ONLY inside the game room:
 * copy-the-selection is what Ctrl+C means everywhere else, and with no selection
 * it still quits, so the terminal habit is preserved rather than replaced. On
 * every other screen Ctrl+C stays plain quit.
 *
 * macOS is deliberately excluded — see `usesAppClipboardCopy`.
 */

/** Whether this platform should use the in-app Ctrl+C copy at all.
 *
 * False on macOS. There, copy is Cmd+C — a TERMINAL shortcut that iTerm2 /
 * Terminal.app consume themselves, so it never reaches a TUI and cannot be bound
 * from here; it copies the terminal's OWN selection, which players make by
 * holding Option while dragging (Option is what tells the terminal to select
 * natively instead of forwarding the drag to us). So on macOS Ctrl+C keeps
 * meaning quit, and the help line points at Option-drag + Cmd+C instead.
 *
 * Elsewhere the terminal's copy shortcut is usually Ctrl+Shift+C — also consumed
 * by the terminal, also only able to see a native selection — so the in-app
 * Ctrl+C over OSC 52 is the path that actually works on the app's own selection.
 */
export function usesAppClipboardCopy(platform: string = process.platform): boolean {
  return platform !== "darwin"
}

/** The slice of OpenTUI's `CliRenderer` this module needs. Every member is
 * optional so a partially-mocked renderer (and the `renderer?: ...` props that
 * thread it through the app) degrade to "nothing to copy" instead of throwing. */
export interface ClipboardRenderer {
  getSelection?: () => { getSelectedText: () => string } | null
  clearSelection?: () => void
  copyToClipboardOSC52?: (text: string) => boolean
}

export type CopyOutcome =
  /** Text reached the clipboard. `chars` is what the player can paste. */
  | { kind: "copied"; chars: number }
  /** Nothing was selected — the caller decides what Ctrl+C should mean instead. */
  | { kind: "empty" }
  /** There WAS text, but the terminal refused the OSC 52 write. */
  | { kind: "unsupported" }

/** Text currently selected in the renderer, trimmed of trailing blank padding.
 *
 * A selection that spans a wrapped block comes back with the layout's own
 * right-edge padding on each line; that is noise in a paste, so every line is
 * right-trimmed while the line structure itself is kept intact.
 */
export function selectedText(renderer?: ClipboardRenderer): string {
  const raw = renderer?.getSelection?.()?.getSelectedText() ?? ""
  if (!raw) return ""
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim()
}

/** Put `text` on the system clipboard. Empty/whitespace-only text is a no-op. */
export function copyText(renderer: ClipboardRenderer | undefined, text: string): CopyOutcome {
  const payload = text.trim()
  if (!payload) return { kind: "empty" }
  const ok = renderer?.copyToClipboardOSC52?.(payload)
  if (!ok) return { kind: "unsupported" }
  return { kind: "copied", chars: payload.length }
}

/** Copy the current selection, then drop the highlight so the copy visibly "took".
 *
 * Returns `{kind:"empty"}` when there is no selection at all — `App.tsx` treats
 * that as "this Ctrl+C was meant as quit".
 */
export function copySelection(renderer?: ClipboardRenderer): CopyOutcome {
  const outcome = copyText(renderer, selectedText(renderer))
  if (outcome.kind !== "empty") renderer?.clearSelection?.()
  return outcome
}
