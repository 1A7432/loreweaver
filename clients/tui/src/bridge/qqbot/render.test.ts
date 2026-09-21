import { describe, expect, test } from "bun:test"
import { FrameType } from "loreweaver-protocol"
import {
  QQBOT_CHUNK_CHARS,
  URL_PLACEHOLDER,
  atUserTag,
  cutMarkdown,
  isQueuedInputNotice,
  recutHalf,
  renderFrame,
  renderNpcMarkdown,
  replaceUrls,
} from "./render"

describe("qqbot render", () => {
  test("NPC lines are markdown with a fullwidth colon", () => {
    expect(renderNpcMarkdown("Nora", "Stay **back**.")).toBe("**Nora**：Stay **back**.")
  })

  test("URLs become [链接] unless the host is whitelisted", () => {
    const text = "see https://evil.example/x and https://ok.example/y"
    expect(replaceUrls(text, [])).toBe(`see ${URL_PLACEHOLDER} and ${URL_PLACEHOLDER}`)
    expect(replaceUrls(text, ["ok.example"])).toBe(`see ${URL_PLACEHOLDER} and https://ok.example/y`)
  })

  test("queued-input notice is recognised in both engine locales", () => {
    expect(isQueuedInputNotice("⏳ A turn is already running at this table. Your input is queued and will run as soon as it is your turn.")).toBe(true)
    expect(isQueuedInputNotice("⏳ 桌上正有一个回合在进行。你的输入已入队，轮到时会自动执行。")).toBe(true)
    expect(isQueuedInputNotice("STR 60")).toBe(false)
  })

  test("system queued notice is skipped; kp markdown is kept", () => {
    const queued = renderFrame({
      type: FrameType.System,
      level: "info",
      text: "Your input is queued and will run as soon as it is your turn.",
    })
    expect(queued.skip).toBe(true)
    expect(queued.isQueuedNotice).toBe(true)
    const kp = renderFrame({
      type: FrameType.Narrative,
      id: "n",
      speaker: "kp",
      text: "The **hinge** shrieks.",
      format: "markdown",
    })
    expect(kp.text).toContain("**hinge**")
    expect(kp.isKpNarrative).toBe(true)
  })

  test("2,800-char paragraph cut reconstructs; recut-at-half is shorter", () => {
    const text = `${"a".repeat(2000)}\n\n${"b".repeat(2000)}`
    const parts = cutMarkdown(text, QQBOT_CHUNK_CHARS)
    expect(parts.join("")).toBe(text)
    expect(parts[0]!.length).toBeLessThanOrEqual(QQBOT_CHUNK_CHARS)
    const half = recutHalf(text)
    expect(half.length).toBeLessThanOrEqual(Math.ceil(text.length / 2) + 2)
  })

  test("at-user tag shape", () => {
    expect(atUserTag("member-openid")).toBe('<qqbot-at-user id="member-openid" />')
  })
})
