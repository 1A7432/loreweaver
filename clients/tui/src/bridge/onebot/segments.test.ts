import { describe, expect, test } from "bun:test"
import { MAX_ATTACHMENT_BYTES, MAX_TEXT_CHARS } from "./constants"
import {
  atSegment,
  buildOutboundSegments,
  imageSegment,
  replySegment,
  splitText,
  textSegment,
} from "./segments"
import { OneBotError } from "./shared"

describe("splitText", () => {
  test("splits rendered text to OneBot limits without loss", () => {
    const rendered = `prefix\n${"x".repeat(5000)}\n1. Help — .help`
    const parts = splitText(rendered, MAX_TEXT_CHARS)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => part.length <= MAX_TEXT_CHARS)).toBe(true)
    expect(parts.join("")).toBe(rendered)
  })

  test("prefers a paragraph boundary in the latter half of the window", () => {
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(2000)}`
    const parts = splitText(text, 4000)
    expect(parts.join("")).toBe(text)
    expect(parts[0]!.endsWith("\n\n")).toBe(true)
    expect(parts[0]!.length).toBe(3002)
    expect(parts[0]!.length).toBeLessThanOrEqual(4000)
  })

  test("a separator at the window edge does not produce a chunk longer than the limit", () => {
    const text = `${"a".repeat(99)}\n\n${"b".repeat(50)}`
    const parts = splitText(text, 100)
    expect(parts.every((part) => part.length <= 100)).toBe(true)
    expect(parts.join("")).toBe(text)
  })
})

describe("outbound segments", () => {
  test("reply + text + image as base64", () => {
    const png = new Uint8Array([1, 2, 3])
    const segments = buildOutboundSegments({
      text: "keeper",
      replyTo: "10",
      image: { data: png, mime: "image/png" },
    })
    expect(segments[0]).toEqual(replySegment("10"))
    expect(segments[1]).toEqual(textSegment("keeper"))
    expect(segments[2]).toEqual(imageSegment({ data: png }))
    expect(segments[2]!.data.file).toBe(`base64://${Buffer.from(png).toString("base64")}`)
  })

  test("at segment precedes text", () => {
    const segments = buildOutboundSegments({ text: "hello", at: [7] })
    expect(segments[0]).toEqual(atSegment(7))
    expect(segments[1]).toEqual(textSegment("hello"))
  })

  test("oversize image throws a stable too_large error", () => {
    const data = new Uint8Array(MAX_ATTACHMENT_BYTES + 1)
    expect(() => imageSegment({ data })).toThrow(OneBotError)
    try {
      imageSegment({ data })
    } catch (err) {
      expect((err as OneBotError).code).toBe("onebot.attachment.too_large")
    }
  })
})
