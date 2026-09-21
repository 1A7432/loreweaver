import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType } from "loreweaver-protocol"
import { tt } from "../../i18n"
import {
  QQBOT_CHUNK_CHARS,
  atUserTag,
  cutMarkdown,
  isQueuedInputNotice,
  recutHalf,
  renderFrame,
  renderNpcMarkdown,
  replaceUrls,
  urlPlaceholder,
} from "./render"

describe("qqbot render", () => {
  test("NPC lines are markdown with a fullwidth colon", () => {
    expect(renderNpcMarkdown("Nora", "Stay **back**.")).toBe("**Nora**：Stay **back**.")
  })

  test("URLs become the locale placeholder unless the host is whitelisted", () => {
    const zh = urlPlaceholder("zh")
    const en = urlPlaceholder("en")
    expect(zh).toBe(tt("zh", "bridge.qqbot.urlStripped"))
    expect(en).toBe(tt("en", "bridge.qqbot.urlStripped"))
    const text = "see https://evil.example/x and https://ok.example/y"
    expect(replaceUrls(text, [], zh)).toBe(`see ${zh} and ${zh}`)
    expect(replaceUrls(text, ["ok.example"], zh)).toBe(`see ${zh} and https://ok.example/y`)
    expect(replaceUrls(text, [], en)).toContain("[link]")
  })

  test("queued-input substrings still appear in both engine hub locales", () => {
    const root = join(import.meta.dir, "../../../../../locales")
    const en = JSON.parse(readFileSync(join(root, "en/hub.json"), "utf8")) as { "hub.turn.queued": string }
    const zh = JSON.parse(readFileSync(join(root, "zh/hub.json"), "utf8")) as { "hub.turn.queued": string }
    expect(en["hub.turn.queued"]).toContain("Your input is queued")
    expect(zh["hub.turn.queued"]).toContain("你的输入已入队")
    expect(isQueuedInputNotice(en["hub.turn.queued"])).toBe(true)
    expect(isQueuedInputNotice(zh["hub.turn.queued"])).toBe(true)
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
