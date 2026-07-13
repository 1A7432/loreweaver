import { Fragment, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type PresenceFrame, type StateFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { CharacterPanel } from "../components/CharacterPanel"
import { PartyPanel } from "../components/PartyPanel"
import { ScenePanel } from "../components/ScenePanel"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface MainMenuProps {
  welcome: WelcomeFrame
  theme: Palette
  themeName: ThemeName
  stateFrame: StateFrame
  presence?: PresenceFrame
  // Offered only when the server advertises its offline demo fallback. Keeping
  // the callback optional preserves compatibility with embedders/older tests.
  onStartDemo?: () => void
  onEnterGame: () => void
  onCharacter: () => void
  onSettings: () => void
  onKeeperKeys: () => void
  onKeeperModule: () => void
  onKeeperModel: () => void
  onKeeperRules: () => void
  onKeeperSkills: () => void
  // Optional so a caller that doesn't wire teardown yet just gets no Quit row (rather than a
  // dead button); App.tsx always supplies it via `handleQuit`.
  onQuit?: () => void
}

interface MenuItem {
  label: string
  keeper: boolean
  run: () => void
}

// The selection cursor is the die glyph (a signature nod to the dice-first rule),
// not a generic ▶.
const CURSOR = "⚄"

export function MainMenu({
  welcome,
  theme,
  themeName,
  stateFrame,
  presence,
  onStartDemo,
  onEnterGame,
  onCharacter,
  onSettings,
  onKeeperKeys,
  onKeeperModule,
  onKeeperModel,
  onKeeperRules,
  onKeeperSkills,
  onQuit,
}: MainMenuProps) {
  const [selected, setSelected] = useState(0)
  const isKeeper = welcome.you.role === "keeper"
  const locale = welcome.locale

  const items: MenuItem[] = []
  if (isKeeper && welcome.features?.includes("demo") && onStartDemo) {
    // First row + initial cursor: a brand-new local user can press Enter once
    // instead of learning magic words such as "upload", "start", or "search".
    items.push({ label: tt(locale, "menu.demo"), keeper: false, run: () => onStartDemo() })
  }
  items.push(
    { label: tt(locale, "menu.enterGame"), keeper: false, run: () => onEnterGame() },
    { label: tt(locale, "menu.character"), keeper: false, run: () => onCharacter() },
    { label: tt(locale, "menu.settings"), keeper: false, run: () => onSettings() },
  )
  if (isKeeper) {
    items.push(
      { label: tt(locale, "menu.keys"), keeper: true, run: () => onKeeperKeys() },
      { label: tt(locale, "menu.module"), keeper: true, run: () => onKeeperModule() },
      { label: tt(locale, "menu.rules"), keeper: true, run: () => onKeeperRules() },
      { label: tt(locale, "menu.skills"), keeper: true, run: () => onKeeperSkills() },
      { label: tt(locale, "menu.model"), keeper: true, run: () => onKeeperModel() },
    )
  }
  // Placed last and visually separated (a blank spacer row, below) — not for someone new to
  // the app to hit by accident while arrowing through the game actions.
  const quitIndex = onQuit ? items.length : -1
  if (onQuit) items.push({ label: tt(locale, "menu.quit"), keeper: false, run: () => onQuit() })

  const clamp = (index: number) => Math.max(0, Math.min(items.length - 1, index))
  // Capabilities/roles may change while the menu is mounted (for example a hot switch removes
  // the one-shot demo row). Render and activate a clamped cursor immediately; no follow-up state
  // effect is needed, so the capability update cannot briefly target an item that no longer exists.
  const visibleSelected = clamp(selected)
  const activate = (index: number) => {
    const target = clamp(index)
    setSelected(target)
    items[target]?.run()
  }

  // Scoped to the menu (mounted only here) so it can't fight the connect screen's
  // Tab handling or a focused input. Arrows move the shared cursor, Enter activates.
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "up") setSelected((prev) => clamp(prev - 1))
    if (keyName === "down") setSelected((prev) => clamp(prev + 1))
    if (keyName === "return" || keyName === "enter") activate(visibleSelected)
  })

  const firstKeeperIndex = items.findIndex((item) => item.keeper)

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      {/* height=4 → 2 inner rows: the height the `tiny` ascii-font wordmark needs so
          its second row doesn't bleed into the border (matches the GameView header);
          the room + role still sit side by side on the first content row. */}
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "menu.table", { room: stripControlChars(welcome.room) })}</text>
          <text fg={theme.dim}>
            {" · "}
            {stripControlChars(welcome.you.name)} ·{" "}
            {welcome.you.role === "keeper" ? tt(locale, "menu.role.keeper") : tt(locale, "menu.role.player")}
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {index === firstKeeperIndex ? (
                <box marginTop={1}>
                  <text fg={theme.fumble}>{tt(locale, "menu.keeperSection")}</text>
                </box>
              ) : null}
              {index === quitIndex ? <box height={1} /> : null}
              <box
                height={1}
                backgroundColor={visibleSelected === index ? theme.accent : theme.bg}
                onMouseOver={() => setSelected(index)}
                onMouseDown={() => activate(index)}
              >
                <text fg={visibleSelected === index ? theme.bg : theme.fg}>
                  {visibleSelected === index ? `${CURSOR} ` : "  "}
                  {item.label}
                </text>
              </box>
            </Fragment>
          ))}
        </box>

        <box width={32} flexDirection="column">
          <CharacterPanel character={stateFrame.character} theme={theme} locale={locale} />
          <PartyPanel party={stateFrame.party} initiative={stateFrame.initiative} theme={theme} locale={locale} />
          <ScenePanel scene={stateFrame.scene} clock={stateFrame.clock} theme={theme} locale={locale} />
        </box>
      </box>

      <StatusBar welcome={welcome} presence={presence} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default MainMenu
