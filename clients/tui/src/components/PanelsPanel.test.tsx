import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { ModuleVariable, UiManifestPanel } from "loreweaver-protocol"
import { themes } from "../themes"
import { PanelsPanel } from "./PanelsPanel"

const theme = themes.lamplight

const VARS: ModuleVariable[] = [
  { id: "town_fear", label: "恐慌", kind: "number", value: 7 },
  { id: "mvu.clues.ash", label: "clues.ash", kind: "text", value: "cold ash" },
]

const TIER1: UiManifestPanel = {
  id: "pack/board",
  title: { en: "Case Board", zh: "案情板" },
  slot: "sidebar",
  tier: 1,
  blocks: [
    { kind: "meter", label: { en: "Fear", zh: "恐慌" }, value: { $var: "town_fear" }, min: 0, max: 10 },
    { repeat: { prefix: "mvu.clues.", block: { kind: "badge", label: { $leaf: "value" } } } },
  ],
}

const TIER2_FALLBACK: UiManifestPanel = {
  id: "pack/map",
  title: { en: "Manor Map" },
  slot: "modal",
  tier: 2,
  entry: { hash: "a".repeat(64), size: 10 },
  assets: [],
  fallback: [{ kind: "text", text: { en: "Ask the keeper for the map." } }],
}

const TIER2_NULL: UiManifestPanel = {
  id: "pack/orrery",
  title: { en: "Orrery", zh: "星仪" },
  slot: "tray",
  tier: 2,
  entry: { hash: "b".repeat(64), size: 10 },
  assets: [],
  fallback: null,
}

describe("PanelsPanel", () => {
  test("tier-1 templates instantiate against the viewer's variables; every slot folds into the sidebar", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(
      <PanelsPanel panels={[TIER1, TIER2_FALLBACK, TIER2_NULL]} variables={VARS} theme={theme} locale="zh" />,
      { width: 44, height: 22 },
    )
    await flush()
    const text = captureCharFrame()
    expect(text).toContain("案情板")
    expect(text).toContain("恐慌")
    expect(text).toContain("7/10")
    expect(text).toContain("[cold ash]")
    // Tier-2 with fallback blocks renders them; slot modal/tray fold in alongside.
    expect(text).toContain("Manor Map")
    expect(text).toContain("Ask the keeper for the map.")
    // Explicit `fallback: null` renders the localized rich-client-only line.
    expect(text).toContain("星仪")
    expect(text).toContain("此面板请在富客户端查看。")
    act(() => renderer.destroy())
  })

  test("a panel whose every bound block fails to resolve collapses entirely (fail-closed)", async () => {
    const bound: UiManifestPanel = {
      id: "pack/secrets-shaped",
      title: { en: "Ghost Panel" },
      slot: "sidebar",
      tier: 1,
      blocks: [{ kind: "stat", label: { en: "Doom" }, value: { $var: "not_in_my_state" } }],
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <PanelsPanel panels={[bound]} variables={VARS} theme={theme} locale="en" />,
      { width: 44, height: 10 },
    )
    await flush()
    expect(captureCharFrame()).not.toContain("Ghost Panel")
    act(() => renderer.destroy())
  })

  // A card that ships a tier-2 (rich) panel is expected to also ship `fallback`
  // blocks for text-first clients — the TUI's only view of that panel.
  test("a tier-2 panel's CJK fallback blocks are the TUI's whole view of it", async () => {
    const width = 32
    const cardVars: ModuleVariable[] = [
      { id: "mvu.酒馆.声望", label: "酒馆.声望", kind: "number", value: 34 },
      { id: "mvu.内部.剧本阶段", label: "内部.剧本阶段", kind: "text", value: "第二幕", hidden: true },
    ]
    const ledger: UiManifestPanel = {
      id: "jiuguan/ledger",
      title: { zh: "账簿", en: "Ledger" },
      slot: "modal",
      tier: 2,
      entry: { hash: "c".repeat(64), size: 10 },
      assets: [],
      fallback: [
        { kind: "text", text: { zh: "今日流水请向掌柜索取。" } },
        { kind: "meter", label: { zh: "酒馆声望" }, value: { $var: "mvu.酒馆.声望" }, min: 0, max: 100 },
        // Bound to a not-yet-exposed leaf: fail-closed, so this block never appears.
        { kind: "stat", label: { zh: "内部阶段" }, value: { $var: "mvu.内部.剧本阶段" } },
        { kind: "choices", prompt: { zh: "要做什么" }, options: [{ id: "o1", label: { zh: "查看今日流水" }, input: "查账" }] },
      ],
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <PanelsPanel panels={[ledger]} variables={cardVars} theme={theme} locale="zh" />,
      { width, height: 14 },
    )
    await flush()

    const text = captureCharFrame()
    expect(text).toContain("账簿")
    expect(text).toContain("酒馆声望 ▓▓░░░░ 34/100")
    expect(text).toContain("要做什么")
    // Sidebar choices stay a static list — the interactive surface is the rich client.
    expect(text).toContain("▫ 查看今日流水")
    expect(text).not.toContain("内部阶段")
    expect(text).not.toContain("第二幕")
    expect(text.split("\n").every((line) => Bun.stringWidth(line) <= width)).toBe(true)

    act(() => renderer.destroy())
  })

  test("a fallback bound only to un-exposed card leaves collapses the whole section", async () => {
    const cardVars: ModuleVariable[] = [
      { id: "mvu.内部.真凶", label: "内部.真凶", kind: "text", value: "掌柜的兄长", hidden: true },
    ]
    const spoiler: UiManifestPanel = {
      id: "jiuguan/truth",
      title: { zh: "真相板" },
      slot: "sidebar",
      tier: 1,
      blocks: [{ kind: "stat", label: { zh: "真凶" }, value: { $var: "mvu.内部.真凶" } }],
    }
    const { renderer, flush, captureCharFrame } = await testRender(
      <PanelsPanel panels={[spoiler]} variables={cardVars} theme={theme} locale="zh" />,
      { width: 32, height: 10 },
    )
    await flush()
    expect(captureCharFrame().trim()).toBe("")
    act(() => renderer.destroy())
  })

  test("renders nothing at all for an empty manifest", async () => {
    const { renderer, flush, captureCharFrame } = await testRender(
      <PanelsPanel panels={[]} variables={VARS} theme={theme} locale="en" />,
      { width: 44, height: 6 },
    )
    await flush()
    expect(captureCharFrame().trim()).toBe("")
    act(() => renderer.destroy())
  })
})
