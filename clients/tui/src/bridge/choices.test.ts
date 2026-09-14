import { describe, expect, test } from "bun:test"
import { ChoicesWindow, CHOICES_TTL_MS } from "./choices"

const BLOCK = {
  kind: "choices" as const,
  prompt: "Do you?",
  options: [
    { id: "a", label: "Open the door", input: "I open the door" },
    { id: "b", label: "Wait", input: "I wait" },
  ],
}

describe("choices window", () => {
  test("a digits-only reply maps to that option's input", () => {
    const window = new ChoicesWindow()
    window.open(BLOCK, 0)
    expect(window.match("1", 1000)).toEqual({ kind: "hit", input: "I open the door" })
    expect(window.match("2", 1000)).toEqual({ kind: "hit", input: "I wait" })
    expect(window.match("01", 1000)).toEqual({ kind: "hit", input: "I open the door" })
  })

  test("a non-digit message never matches", () => {
    const window = new ChoicesWindow()
    window.open(BLOCK, 0)
    expect(window.match("I open the door", 1000)).toEqual({ kind: "miss" })
    expect(window.match("1.", 1000)).toEqual({ kind: "miss" })
    expect(window.match("1a", 1000)).toEqual({ kind: "miss" })
    expect(window.match(" 1 wait", 1000)).toEqual({ kind: "miss" })
  })

  test("an expired window forwards as plain text (expired), not a hit", () => {
    const window = new ChoicesWindow()
    window.open(BLOCK, 0)
    expect(window.match("1", CHOICES_TTL_MS)).toEqual({ kind: "expired" })
    expect(window.match("1", CHOICES_TTL_MS + 1)).toEqual({ kind: "expired" })
  })

  test("the next Keeper narrative closes the window", () => {
    const window = new ChoicesWindow()
    window.open(BLOCK, 0)
    window.close()
    expect(window.match("1", 1000)).toEqual({ kind: "expired" })
  })

  test("digits with no window ever opened are a miss, not an expired match", () => {
    const window = new ChoicesWindow()
    expect(window.match("1", 0)).toEqual({ kind: "miss" })
  })
})
