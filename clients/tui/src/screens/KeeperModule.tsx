import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import {
  FrameType,
  stripControlChars,
  type AdminForgeKind,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { Spinner } from "../components/Spinner"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

// This screen needs the `input` channel + `onMessage` (the path-import flow) plus
// `adminGenerate` (the describe->generate flow, Layer B.4b). A `.module <path>`
// command runs over the TUI input channel (always as MASTER server-side) and its
// reply — the localized DocumentTools.upload_document result string (success /
// analysis-started, or an error like "文档功能未启用" / "指定的文件不存在") — is
// broadcast back to the room as a system-authored NARRATIVE line: gateway/turn.py
// publishes every command reply as `Event.narrative(speaker="system")`, rendered by
// net/tui_server.py as `narrative{speaker:"system"}` — NOT a `system` frame. The
// player-input echo returns as speaker "player", so filtering on speaker "system"
// captures exactly the command result and never our own echo. There is no
// correlation id, so we just render the latest such line(s) after submit.
// `adminGenerate("module", description)` is a plain request/reply answered by a
// single `admin_generated` frame — the server gates it on the keeper role exactly
// like every other admin_* request (net/admin.py).
export interface KeeperModuleClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  sendInput(text: string): void
  adminGenerate(kind: AdminForgeKind, description: string): void
}

export interface KeeperModuleProps {
  client: KeeperModuleClient
  theme: Palette
  themeName: ThemeName
  welcome: WelcomeFrame
  // Threaded only for the shared StatusBar's online count (as the sibling screens do).
  stateFrame: StateFrame
  onBack: () => void
}

// Keep only the last few system-authored lines so long-running analysis progress is
// visible without unbounded growth.
const MAX_LOG = 5

type Field = "path" | "description"
const FIELD_ORDER: Field[] = ["path", "description"]

export function KeeperModule({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperModuleProps) {
  const locale = welcome.locale
  const [path, setPath] = useState("")
  const [pending, setPending] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [focused, setFocused] = useState<Field>("path")

  // The describe->generate flow (Layer B.4b): a description authored into a brand-new
  // module via `agent.forge.generate_and_install_module`, installed PER-ROOM through
  // the same upload pipeline the path-import flow above uses.
  const [description, setDescription] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generateResult, setGenerateResult] = useState<string>()

  // Mirror the path/description into refs so submit always reads the latest typed
  // value regardless of render timing (same reason the sibling screens do it).
  const pathRef = useRef(path)
  const descriptionRef = useRef(description)

  const isKeeper = welcome.you.role === "keeper"

  // Subscribe for this screen only. The `.module` reply is a system-authored
  // narrative line (see the interface note); collect the last few and clear the
  // pending flag once any arrives. `admin_generated{kind:"module"}` answers the
  // describe->generate flow instead — a plain request/reply, no narrative involved.
  useEffect(() => {
    return client.onMessage((frame) => {
      if (frame.type === FrameType.Narrative && frame.speaker === "system" && frame.text.trim()) {
        setLog((current: string[]) => [...current, frame.text].slice(-MAX_LOG))
        // A progress-bar frame (it carries the █/░ bar) keeps the spinner alive through the
        // long analysis stage; only the final, non-bar reply clears the pending state.
        const isProgress = frame.text.includes("█") || frame.text.includes("░")
        if (!isProgress) setPending(false)
      } else if (frame.type === FrameType.AdminGenerated && frame.kind === "module") {
        setGenerating(false)
        if (frame.ok) {
          // `detail` is the per-room install outcome — for a module this is the real
          // signal it landed in the room, so surface it alongside `name` either way.
          setGenerateResult(
            tt(locale, "module.generateOk", { name: stripControlChars(frame.name), detail: stripControlChars(frame.detail) }),
          )
        } else {
          setGenerateResult(tt(locale, "module.generateError", { error: stripControlChars(frame.error) }))
        }
      } else if (frame.type === FrameType.Error) {
        // A backend failure during generate/analysis surfaces as a GENERIC error frame (not
        // admin_error) — clear BOTH spinners and surface it, never leave one hung.
        setGenerating(false)
        setPending(false)
        setGenerateResult(tt(locale, "module.generateError", { error: stripControlChars(frame.message ?? frame.code) }))
      }
    })
  }, [client, locale])

  // Submit runs `.module <path>` over the input channel; ignore an empty path
  // (mirror the sibling screens' silent guard). The reply arrives asynchronously
  // over onMessage, so flip to a pending state until it lands. The path is kept
  // (not cleared) so a keeper can tweak + re-import after an error without retyping.
  const submit = () => {
    const value = pathRef.current.trim()
    if (!value) return
    client.sendInput(`.module ${value}`)
    setPending(true)
  }

  const generate = () => {
    const value = descriptionRef.current.trim()
    if (!value) return
    setGenerateResult(undefined)
    setGenerating(true)
    client.adminGenerate("module", value)
  }

  // Scoped to this screen; Tab cycles path/description, Esc goes back. Each
  // <input> submits on its own Enter (onSubmit).
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
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "module.title")}</text>
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
              <text fg={theme.fumble}>{tt(locale, "module.notKeeper")}</text>
            </box>
          ) : null}

          <box flexDirection="column" border borderColor={theme.border} paddingX={1}>
            <text fg={theme.accent}>{tt(locale, "module.result")}</text>
            <Spinner active={pending} label={tt(locale, "module.pending")} color={theme.hard} />
            {log.length ? (
              log.map((line: string, index: number) => (
                <text key={`sys-${index}`} fg={index === log.length - 1 ? theme.fg : theme.dim}>
                  {stripControlChars(line)}
                </text>
              ))
            ) : pending ? null : (
              <text fg={theme.dim}>{tt(locale, "module.empty")}</text>
            )}
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={60}>
            <text fg={theme.dim}>{tt(locale, "module.intro")}</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("path")}>
              <text fg={focused === "path" ? theme.accent : theme.dim}>{tt(locale, "module.path")}</text>
              <input
                flexGrow={1}
                value={path}
                focused={focused === "path"}
                placeholder="modules/shuxue.md"
                onInput={(value: string) => {
                  pathRef.current = value
                  setPath(value)
                }}
                onSubmit={submit}
              />
            </box>

            <box marginTop={1} onMouseDown={submit} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "module.button")}</text>
            </box>

            <box marginTop={1}>
              <text fg={theme.dim}>{tt(locale, "module.help")}</text>
            </box>
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={60}>
            <text fg={theme.dim}>{tt(locale, "module.generateIntro")}</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("description")}>
              <text fg={focused === "description" ? theme.accent : theme.dim}>{tt(locale, "module.description")}</text>
              <input
                flexGrow={1}
                value={description}
                focused={focused === "description"}
                placeholder={tt(locale, "module.descriptionPlaceholder")}
                onInput={(value: string) => {
                  descriptionRef.current = value
                  setDescription(value)
                }}
                onSubmit={generate}
              />
            </box>

            <box marginTop={1} onMouseDown={generate} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "module.generateButton")}</text>
            </box>

            <Spinner active={generating} label={tt(locale, "module.generating")} color={theme.hard} />
            {!generating && generateResult ? <text fg={theme.fg}>{generateResult}</text> : null}
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperModule
