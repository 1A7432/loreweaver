import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import {
  FrameType,
  stripControlChars,
  type AdminForgeKind,
  type AdminSkillInfo,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { Spinner } from "../components/Spinner"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

// Narrow superset of the web AdminPanel's `AdminClient`: list + per-room enable KP
// skills, and describe->generate a brand-new one. App owns the socket; the server
// gates these on the connection's keeper role (net/admin.py), so a non-keeper just
// gets `admin_error`. See docs/plugins.md "Layer B" for the skill model.
export interface KeeperSkillsClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  adminListSkills(): void
  adminEnableSkill(id: string, on: boolean): void
  adminGenerate(kind: AdminForgeKind, description: string): void
}

export interface KeeperSkillsProps {
  client: KeeperSkillsClient
  theme: Palette
  themeName: ThemeName
  welcome: WelcomeFrame
  // Threaded only for the shared StatusBar's online count (as the sibling screens do).
  stateFrame: StateFrame
  onBack: () => void
}

type Field = "list" | "description"
const FIELD_ORDER: Field[] = ["list", "description"]

const CURSOR = "⚄"

export function KeeperSkills({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperSkillsProps) {
  const locale = welcome.locale
  const [skills, setSkills] = useState<AdminSkillInfo[]>([])
  const [error, setError] = useState<string>()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focused, setFocused] = useState<Field>("list")

  const [description, setDescription] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generateResult, setGenerateResult] = useState<string>()

  // Mirror the description into a ref so submit always reads the latest typed value
  // regardless of render timing (same reason the sibling screens do it).
  const descriptionRef = useRef(description)

  const isKeeper = welcome.you.role === "keeper"

  // Subscribe for this screen only, then request the current list on mount. Every
  // `admin_skills` (including the one that follows a toggle or a successful
  // generate) is the single source of truth: just repaint from it, mirroring
  // KeeperModel's `admin_config` handling.
  useEffect(() => {
    const off = client.onMessage((frame) => {
      if (frame.type === FrameType.AdminSkills) {
        setSkills(frame.skills)
        setSelectedIndex((current: number) => Math.max(0, Math.min(current, frame.skills.length - 1)))
        setError(undefined)
      } else if (frame.type === FrameType.AdminGenerated && frame.kind === "skill") {
        setGenerating(false)
        if (frame.ok) {
          setGenerateResult(tt(locale, "skills.generateOk", { name: stripControlChars(frame.name), id: frame.id }))
          // The new skill only shows up in the list once we re-request it.
          client.adminListSkills()
        } else {
          setGenerateResult(tt(locale, "skills.generateError", { error: stripControlChars(frame.error) }))
        }
      } else if (frame.type === FrameType.AdminError) {
        setError(frame.message ?? frame.code)
        setGenerating(false)
      } else if (frame.type === FrameType.Error) {
        // A backend failure during generate (LLM timeout / rate-limit / auth error) surfaces as a
        // GENERIC error frame, not admin_error — clear the spinner and show it, never hang.
        setError(frame.message ?? frame.code)
        setGenerating(false)
      }
    })
    client.adminListSkills()
    return off
  }, [client, locale])

  const toggle = (entry: AdminSkillInfo) => {
    client.adminEnableSkill(entry.id, !entry.enabled)
  }

  const generate = () => {
    const value = descriptionRef.current.trim()
    if (!value) return
    setGenerateResult(undefined)
    setGenerating(true)
    client.adminGenerate("skill", value)
  }

  // Scoped to this screen; Tab cycles list/description, Esc goes back. When the
  // list is focused, arrows move the row cursor and Enter toggles it; the
  // description <input> gets Enter via its own onSubmit.
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "escape") {
      onBack()
      return
    }
    if (keyName === "tab") {
      setFocused((prev: Field) => {
        const index = FIELD_ORDER.indexOf(prev)
        const delta = event.shift ? FIELD_ORDER.length - 1 : 1
        return FIELD_ORDER[(index + delta) % FIELD_ORDER.length]
      })
      return
    }
    if (focused === "list") {
      if (keyName === "up") setSelectedIndex((prev: number) => Math.max(0, prev - 1))
      if (keyName === "down" && skills.length) setSelectedIndex((prev: number) => Math.min(skills.length - 1, prev + 1))
      if ((keyName === "return" || keyName === "enter") && skills[selectedIndex]) toggle(skills[selectedIndex])
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "skills.title")}</text>
          <text fg={theme.dim}>
            {" · "}
            {stripControlChars(welcome.room)}
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {!isKeeper ? (
            <box marginBottom={1}>
              <text fg={theme.fumble}>{tt(locale, "skills.notKeeper")}</text>
            </box>
          ) : null}

          {error ? (
            <box marginBottom={1} border borderColor={theme.fumble} paddingX={1}>
              <text fg={theme.fumble}>{stripControlChars(error)}</text>
            </box>
          ) : null}

          <box
            flexDirection="column"
            height={Math.min(Math.max(skills.length + 3, 4), 10)}
            border
            borderColor={theme.border}
            paddingX={1}
            onMouseDown={() => setFocused("list")}
          >
            <text fg={theme.accent}>{tt(locale, "skills.list")}</text>
            {skills.length ? (
              skills.map((entry: AdminSkillInfo, index: number) => (
                <box key={entry.id} onMouseDown={() => toggle(entry)}>
                  <text fg={index === selectedIndex ? theme.accent : theme.fg}>
                    {index === selectedIndex ? CURSOR : " "} {stripControlChars(entry.name)} ·{" "}
                    {stripControlChars(entry.description)} · {stripControlChars(entry.content_rating)} ·{" "}
                    <span fg={entry.enabled ? theme.success : theme.dim}>
                      {entry.enabled ? tt(locale, "skills.on") : tt(locale, "skills.off")}
                    </span>
                  </text>
                </box>
              ))
            ) : (
              <text fg={theme.dim}>{tt(locale, "skills.none")}</text>
            )}
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={72}>
            <text fg={theme.dim}>{tt(locale, "skills.intro")}</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("description")}>
              <text fg={focused === "description" ? theme.accent : theme.dim}>{tt(locale, "skills.description")}</text>
              <input
                flexGrow={1}
                value={description}
                focused={focused === "description"}
                placeholder={tt(locale, "skills.descriptionPlaceholder")}
                onInput={(value: string) => {
                  descriptionRef.current = value
                  setDescription(value)
                }}
                onSubmit={generate}
              />
            </box>

            <box marginTop={1} onMouseDown={generate} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "skills.generateButton")}</text>
            </box>

            <Spinner active={generating} label={tt(locale, "skills.generating")} color={theme.hard} />
            {!generating && generateResult ? <text fg={theme.fg}>{generateResult}</text> : null}

            <box marginTop={1}>
              <text fg={theme.dim}>{tt(locale, "skills.help")}</text>
            </box>
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperSkills
