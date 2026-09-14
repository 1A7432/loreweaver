import { describe, expect, test } from "bun:test"
import { markdownToPlain, renderNarrativeNpc, renderNarrativeText, splitText } from "./narrative"
import { BRIDGE_TEXT_LIMIT } from "./uiText"

describe("markdown → plain", () => {
  test("strips emphasis, fences, and headings; keeps list markers and blank lines", () => {
    const src = [
      "# Title",
      "",
      "A **bold** and *italic* word, plus `code`.",
      "",
      "```",
      "kept",
      "```",
      "",
      "- still a list",
      "1. numbered",
    ].join("\n")
    const plain = markdownToPlain(src)
    expect(plain).not.toContain("**")
    expect(plain).not.toContain("```")
    expect(plain).toContain("Title")
    expect(plain).toContain("A bold and italic word, plus code.")
    expect(plain).toContain("kept")
    expect(plain).toContain("- still a list")
    expect(plain).toContain("1. numbered")
    expect(plain).toContain("\n\n")
  })

  test("plain format is not re-parsed as markdown", () => {
    expect(renderNarrativeText("use *this* lever", "plain")).toBe("use *this* lever")
  })

  test("npc lines become Name: text after markdown strip", () => {
    expect(renderNarrativeNpc("Nora", "The **fog** lifts.", "markdown")).toBe("Nora: The fog lifts.")
  })
})

describe("split without loss", () => {
  test("paragraph-first split reconstructs the original and never exceeds the limit", () => {
    const text = `prefix\n${"x".repeat(5000)}\n1. Help — .help`
    const parts = splitText(text, BRIDGE_TEXT_LIMIT)
    expect(parts.join("")).toBe(text)
    expect(parts.every((part) => part.length <= BRIDGE_TEXT_LIMIT)).toBe(true)
    expect(parts.length).toBeGreaterThan(1)
  })

  test("prefers a blank line in the latter half of the window", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}`
    const parts = splitText(text, 40)
    expect(parts.join("")).toBe(text)
    expect(parts.length).toBe(2)
    expect(parts[0]!.endsWith("\n\n")).toBe(true)
    expect(parts[1]!.startsWith("b")).toBe(true)
  })

  test("a hard cut never splits a UTF-16 surrogate pair", () => {
    const emoji = "😀"
    const text = `${"x".repeat(4)}${emoji}${"y".repeat(4)}`
    const parts = splitText(text, 5)
    expect(parts.join("")).toBe(text)
    expect(parts.some((part) => part.includes("\uD83D") && !part.includes("\uDE00"))).toBe(false)
    expect(parts.some((part) => part.includes(emoji))).toBe(true)
  })
})
