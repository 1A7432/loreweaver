import { useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type Role, type SessionSnapshot } from "loreweaver-protocol/v3"
import { CharacterPanel } from "../components/CharacterPanel"
import { PartyPanel } from "../components/PartyPanel"
import { ScenePanel } from "../components/ScenePanel"
import { StatusBar } from "../components/StatusBar"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt } from "../i18n"
import { sidebarCollapsed, sidebarWidth } from "../layout"
import type { Palette, ThemeName } from "../themes"

export interface MainMenuProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onEnterGame: () => void
  onCharacter: () => void
  onCommands: () => void
  onSettings: () => void
  // Optional so a caller that does not wire teardown gets no Quit row rather than a dead one.
  onQuit?: () => void
}

interface MenuItem {
  label: string
  run: () => void
}

// The selection cursor is the die glyph (a nod to the dice-first rule), not a generic ▶.
const CURSOR = "⚄"

/** The person's role in words: the `me` view's own label (in this member's language) when it
 * has arrived, else ours. The human with the admin key is the room's admin — never "the Keeper",
 * which is the AI. */
export function roleLabel(snapshot: SessionSnapshot, locale: string): string {
  const fromView = viewData(snapshot, "me")?.member.roleLabel
  if (fromView) return stripControlChars(fromView)
  const role: Role = snapshot.welcome?.you.role ?? "player"
  return tt(locale, role === "admin" ? "menu.role.admin" : role === "observer" ? "menu.role.observer" : "menu.role.player")
}

export function MainMenu({ connection, theme, themeName, locale, onEnterGame, onCharacter, onCommands, onSettings, onQuit }: MainMenuProps) {
  const snapshot = useSnapshot(connection)
  const { width: terminalWidth } = useTerminalDimensions()
  const showSidebar = !sidebarCollapsed(terminalWidth)
  const [selected, setSelected] = useState(0)
  const welcome = snapshot.welcome
  const party = viewData(snapshot, "party")
  const online = (party?.members ?? []).filter((member) => member.online).length
  const isAdmin = welcome?.you.role === "admin"

  const items: MenuItem[] = [
    { label: tt(locale, "menu.enterGame"), run: onEnterGame },
    { label: tt(locale, "menu.character"), run: onCharacter },
    { label: tt(locale, "menu.commands"), run: onCommands },
    { label: tt(locale, "menu.settings"), run: onSettings },
  ]
  // Last and set apart by a blank row: not for a newcomer to hit while arrowing through.
  const quitIndex = onQuit ? items.length : -1
  if (onQuit) items.push({ label: tt(locale, "menu.quit"), run: onQuit })

  const clamp = (index: number) => Math.max(0, Math.min(items.length - 1, index))
  const visibleSelected = clamp(selected)
  const activate = (index: number) => {
    const target = clamp(index)
    setSelected(target)
    items[target]?.run()
  }

  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "up") setSelected((prev) => clamp(prev - 1))
    if (keyName === "down") setSelected((prev) => clamp(prev + 1))
    if (keyName === "return" || keyName === "enter") activate(visibleSelected)
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      {/* height=4 → 2 inner rows: what the `tiny` ascii-font wordmark needs. */}
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "menu.table", { room: stripControlChars(welcome?.room.id ?? "") })}
          </text>
          <text fg={theme.dim} wrapMode="none" truncate>
            {" · "}
            {stripControlChars(welcome?.you.name ?? "")} · {roleLabel(snapshot, locale)}
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {items.map((item, index) => (
            <box key={item.label} flexDirection="column">
              {index === quitIndex ? <box height={1} /> : null}
              <box
                height={1}
                backgroundColor={visibleSelected === index ? theme.accent : theme.bg}
                // The pointer MOVING onto a row selects it. Not `onMouseOver`: that also fires when a new
                // screen puts a row under a pointer that has not moved, and the row under the button
                // just clicked can be Quit or Delete — one Enter away.
                onMouseMove={() => setSelected(index)}
                onMouseDown={() => activate(index)}
              >
                <text fg={visibleSelected === index ? theme.bg : theme.fg}>
                  {visibleSelected === index ? `${CURSOR} ` : "  "}
                  {item.label}
                </text>
              </box>
            </box>
          ))}
          {isAdmin ? (
            <box marginTop={1}>
              <text fg={theme.dim}>{tt(locale, "menu.adminHint")}</text>
            </box>
          ) : null}
        </box>

        {showSidebar ? (
          <box width={sidebarWidth(terminalWidth)} maxWidth="40%" flexShrink={0} flexDirection="column">
            <CharacterPanel character={viewData(snapshot, "me")?.character} theme={theme} locale={locale} />
            <PartyPanel party={party} theme={theme} locale={locale} />
            <ScenePanel scene={viewData(snapshot, "scene")} theme={theme} locale={locale} />
          </box>
        ) : null}
      </box>

      <StatusBar room={welcome?.room.id} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default MainMenu
