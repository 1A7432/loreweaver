import { describe, expect, test } from "bun:test"
import { copySelection, copyText, selectedText, usesAppClipboardCopy, type ClipboardRenderer } from "./copy"

function fakeRenderer(
  selection: string | null,
  options: { osc52?: boolean } = {},
): ClipboardRenderer & { copied: string[]; cleared: number } {
  const state = {
    copied: [] as string[],
    cleared: 0,
    getSelection: () => (selection === null ? null : { getSelectedText: () => selection }),
    clearSelection: () => {
      state.cleared += 1
    },
    copyToClipboardOSC52: (text: string) => {
      if (options.osc52 === false) return false
      state.copied.push(text)
      return true
    },
  }
  return state
}

describe("selectedText", () => {
  test("strips the layout's right-edge padding but keeps line structure", () => {
    const renderer = fakeRenderer("KP: the door gives way        \nMartha: keep your voice down   ")
    expect(selectedText(renderer)).toBe("KP: the door gives way\nMartha: keep your voice down")
  })

  test("no selection and no renderer both read as empty", () => {
    expect(selectedText(fakeRenderer(null))).toBe("")
    expect(selectedText(undefined)).toBe("")
  })
})

describe("copySelection", () => {
  test("copies the selection to the clipboard and drops the highlight", () => {
    const renderer = fakeRenderer("the lamp gutters")
    expect(copySelection(renderer)).toEqual({ kind: "copied", chars: 16 })
    expect(renderer.copied).toEqual(["the lamp gutters"])
    expect(renderer.cleared).toBe(1)
  })

  test("an empty selection reports `empty` and leaves the selection alone", () => {
    // App.tsx keys "this Ctrl+C was meant as quit" off exactly this outcome, so
    // it must never be conflated with a failed clipboard write.
    const renderer = fakeRenderer("   \n  ")
    expect(copySelection(renderer)).toEqual({ kind: "empty" })
    expect(renderer.copied).toEqual([])
    expect(renderer.cleared).toBe(0)
  })

  test("a terminal that refuses OSC 52 reports `unsupported`, not success", () => {
    const renderer = fakeRenderer("something worth keeping", { osc52: false })
    expect(copySelection(renderer)).toEqual({ kind: "unsupported" })
    expect(renderer.copied).toEqual([])
  })

  test("a renderer without clipboard support cannot silently swallow the copy", () => {
    expect(copyText({ getSelection: () => ({ getSelectedText: () => "x" }) }, "x")).toEqual({ kind: "unsupported" })
  })
})

describe("usesAppClipboardCopy", () => {
  test("macOS keeps Ctrl+C as quit — copy there is the terminal's own Cmd+C", () => {
    expect(usesAppClipboardCopy("darwin")).toBe(false)
  })

  test("linux and windows use the in-app Ctrl+C copy", () => {
    expect(usesAppClipboardCopy("linux")).toBe(true)
    expect(usesAppClipboardCopy("win32")).toBe(true)
  })
})
