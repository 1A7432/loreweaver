import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { FrameType, stripControlChars, type ServerFrame, type StateFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import { StatusBar } from "../components/StatusBar"
import type { Palette, ThemeName } from "../themes"

// This screen needs only the `input` channel + `onMessage`. A `.module <path>`
// command runs over the TUI input channel (always as MASTER server-side) and its
// reply — the localized DocumentTools.upload_document result string (success /
// analysis-started, or an error like "文档功能未启用" / "指定的文件不存在") — is
// broadcast back to the room as a system-authored NARRATIVE line: gateway/turn.py
// publishes every command reply as `Event.narrative(speaker="system")`, rendered by
// net/tui_server.py as `narrative{speaker:"system"}` — NOT a `system` frame. The
// player-input echo returns as speaker "player", so filtering on speaker "system"
// captures exactly the command result and never our own echo. There is no
// correlation id, so we just render the latest such line(s) after submit.
export interface KeeperModuleClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  sendInput(text: string): void
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

export function KeeperModule({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperModuleProps) {
  const [path, setPath] = useState("")
  const [pending, setPending] = useState(false)
  const [log, setLog] = useState<string[]>([])

  // Mirror the path into a ref so submit always reads the latest typed value
  // regardless of render timing (same reason the sibling screens do it).
  const pathRef = useRef(path)

  const isKeeper = welcome.you.role === "keeper"

  // Subscribe for this screen only. The `.module` reply is a system-authored
  // narrative line (see the interface note); collect the last few and clear the
  // pending flag once any arrives.
  useEffect(() => {
    return client.onMessage((frame) => {
      if (frame.type === FrameType.Narrative && frame.speaker === "system" && frame.text.trim()) {
        setLog((current) => [...current, frame.text].slice(-MAX_LOG))
        setPending(false)
      }
    })
  }, [client])

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

  // Scoped to this screen; Esc goes back. The single path <input> submits on Enter
  // (its onSubmit), so no Tab/arrow field handling is needed here.
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "escape") onBack()
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="TRPG KP" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>导入模组</text>
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
              <text fg={theme.fumble}>此邀请码非守秘人 — 导入模组会被服务端拒绝。</text>
            </box>
          ) : null}

          <box flexDirection="column" border borderColor={theme.border} paddingX={1}>
            <text fg={theme.accent}>导入结果</text>
            {pending ? <text fg={theme.hard}>⚄ 分析中…（模组分析约需 1–2 分钟）</text> : null}
            {log.length ? (
              log.map((line, index) => (
                <text key={`sys-${index}`} fg={index === log.length - 1 ? theme.fg : theme.dim}>
                  {stripControlChars(line)}
                </text>
              ))
            ) : pending ? null : (
              <text fg={theme.dim}>填服务端路径并导入,结果会显示在这里</text>
            )}
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={60}>
            <text fg={theme.dim}>导入模组 = 服务端上的文件路径(自托管,无跨机上传)</text>

            <box flexDirection="column" marginTop={1}>
              <text fg={theme.accent}>模组文件路径(服务端)</text>
              <input
                flexGrow={1}
                value={path}
                focused
                placeholder="modules/shuxue.md"
                onInput={(value: string) => {
                  pathRef.current = value
                  setPath(value)
                }}
                onSubmit={submit}
              />
            </box>

            <box marginTop={1} onMouseDown={submit} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>⚄ 导入模组</text>
            </box>

            <box marginTop={1}>
              <text fg={theme.dim}>Enter 导入 · Esc 返回菜单</text>
            </box>
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperModule
