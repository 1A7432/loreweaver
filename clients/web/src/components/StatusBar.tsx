import type { WelcomeFrame } from "@trpg-kp/protocol"
import { THEME_ORDER, type ThemeName } from "../themes"

export interface StatusBarProps {
  welcome?: WelcomeFrame
  online: number
  theme: ThemeName
  onThemeChange: (theme: ThemeName) => void
}

export function StatusBar({ welcome, online, theme, onThemeChange }: StatusBarProps) {
  const room = welcome?.room ?? "not joined"
  const locale = welcome?.locale ?? "--"
  return (
    <footer className="status-bar">
      <span className="status-room">{room}</span>
      <span className="sep">·</span>
      <span className="status-online">{online} online</span>
      <span className="sep">·</span>
      <span className="status-locale">{locale}</span>
      <span className="grow" />
      <label className="status-theme">
        theme{" "}
        <select
          aria-label="Theme"
          value={theme}
          onChange={(event) => onThemeChange(event.target.value as ThemeName)}
        >
          {THEME_ORDER.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </footer>
  )
}
