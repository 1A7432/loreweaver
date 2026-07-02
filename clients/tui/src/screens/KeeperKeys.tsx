import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import {
  FrameType,
  stripControlChars,
  type AdminKeyInfo,
  type MintedKey,
  type PlayerRole,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@trpg-kp/protocol"
import { StatusBar } from "../components/StatusBar"
import type { Palette, ThemeName } from "../themes"

// Only the admin methods + onMessage are needed here — the narrow superset of the
// web AdminPanel's `AdminClient`. App owns the socket; this screen drives the
// keeper-gated key list/mint frames and renders their replies. The server is the
// real gate (role==="keeper" in net/admin.py); the menu hiding this item is only
// a UI courtesy, so a non-keeper reaching here just gets `admin_error{forbidden}`.
export interface KeeperKeysClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  adminListKeys(): void
  adminMintKey(room: string, name?: string, role?: PlayerRole): void
}

export interface KeeperKeysProps {
  client: KeeperKeysClient
  theme: Palette
  themeName: ThemeName
  welcome: WelcomeFrame
  // Carried purely so the shared StatusBar shows an accurate online count, exactly
  // as CharacterScreen threads it — the screen itself needs no other state data.
  stateFrame: StateFrame
  onBack: () => void
}

type Field = "room" | "name" | "role"
const FIELD_ORDER: Field[] = ["room", "name", "role"]

const ROLE_OPTIONS: SelectOption[] = [
  { name: "玩家 · player", description: "普通调查员席位", value: "player" },
  { name: "守秘人 · keeper", description: "可管理房间与配置", value: "keeper" },
]

const CURSOR = "⚄"

export function KeeperKeys({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperKeysProps) {
  const [keys, setKeys] = useState<AdminKeyInfo[]>([])
  const [minted, setMinted] = useState<MintedKey>()
  const [error, setError] = useState<string>()

  const [room, setRoom] = useState("")
  const [name, setName] = useState("")
  const [roleIndex, setRoleIndex] = useState(0)
  const [focused, setFocused] = useState<Field>("room")

  // Mirror the text fields into refs so submit always reads the latest typed value
  // regardless of render timing (same reason ConnectScreen/CharacterScreen do it).
  const roomRef = useRef(room)
  const nameRef = useRef(name)

  const isKeeper = welcome.you.role === "keeper"

  // Subscribe to admin replies for this screen only, unsubscribing on unmount, then
  // fire the initial list request — mirrors AdminPanel's effect. `admin_keys` carries
  // the (masked) list and, on a mint, a one-time cleartext `minted`; `admin_error`
  // (forbidden / bad_request / anything the wire sends) surfaces inline.
  useEffect(() => {
    const off = client.onMessage((frame) => {
      if (frame.type === FrameType.AdminKeys) {
        setKeys(frame.keys)
        if (frame.minted) setMinted(frame.minted)
        setError(undefined)
      } else if (frame.type === FrameType.AdminError) {
        setError(frame.message ?? frame.code)
      }
    })
    client.adminListKeys()
    return off
  }, [client])

  // Minting a key for a room IS the create-room path. Require a non-empty room
  // (mirror AdminPanel's silent guard); the reply is a fresh `admin_keys` that
  // repaints the list and shows the cleartext key once, so clear the inputs after.
  const mint = () => {
    const roomValue = roomRef.current.trim()
    if (!roomValue) return
    const nameValue = nameRef.current.trim()
    const role = String(ROLE_OPTIONS[roleIndex]?.value ?? "player") as PlayerRole
    client.adminMintKey(roomValue, nameValue || undefined, role)
    setRoom("")
    setName("")
    roomRef.current = ""
    nameRef.current = ""
  }

  // Scoped to this screen and further scoped by focus: Tab cycles fields, Esc goes
  // back. Arrows are left to the focused role <select>; the room/name <input>s get
  // Enter via onSubmit and the select gets it via onSelect, so both submit.
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "escape") {
      onBack()
      return
    }
    if (keyName === "tab") {
      setFocused((prev) => {
        const index = FIELD_ORDER.indexOf(prev)
        const delta = event.shift ? FIELD_ORDER.length - 1 : 1
        return FIELD_ORDER[(index + delta) % FIELD_ORDER.length]
      })
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="TRPG KP" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>房间与邀请</text>
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
              <text fg={theme.fumble}>此邀请码非守秘人 — 管理操作会被服务端拒绝。</text>
            </box>
          ) : null}

          {error ? (
            <box marginBottom={1} border borderColor={theme.fumble} paddingX={1}>
              <text fg={theme.fumble}>{stripControlChars(error)}</text>
            </box>
          ) : null}

          {minted ? (
            <box flexDirection="column" marginBottom={1} border borderColor={theme.accent} paddingX={1}>
              <text fg={theme.accent}>
                新邀请码 · 牌桌「{stripControlChars(minted.room)}」· {minted.role}
              </text>
              <text fg={theme.success}>
                {CURSOR} {stripControlChars(minted.key)}
              </text>
              <text fg={theme.fumble}>只显示一次,复制好</text>
            </box>
          ) : null}

          <box flexDirection="column" border borderColor={theme.border} paddingX={1}>
            <text fg={theme.accent}>已有邀请码</text>
            {keys.length ? (
              keys.map((entry, index) => (
                <text key={`${entry.key_masked}-${index}`} fg={theme.fg}>
                  {stripControlChars(entry.key_masked)} · {stripControlChars(entry.room)} ·{" "}
                  {stripControlChars(entry.name || "—")} · {entry.role}
                </text>
              ))
            ) : (
              <text fg={theme.dim}>暂无邀请码</text>
            )}
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={60}>
            <text fg={theme.dim}>发新邀请码 = 建/入房(填房间名即建房)</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("room")}>
              <text fg={focused === "room" ? theme.accent : theme.dim}>房间名</text>
              <input
                flexGrow={1}
                value={room}
                focused={focused === "room"}
                placeholder="shuxue"
                onInput={(value: string) => {
                  roomRef.current = value
                  setRoom(value)
                }}
                onSubmit={mint}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("name")}>
              <text fg={focused === "name" ? theme.accent : theme.dim}>备注名(可选)</text>
              <input
                flexGrow={1}
                value={name}
                focused={focused === "name"}
                placeholder="留空即可"
                onInput={(value: string) => {
                  nameRef.current = value
                  setName(value)
                }}
                onSubmit={mint}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("role")}>
              <text fg={focused === "role" ? theme.accent : theme.dim}>角色</text>
              <select
                flexGrow={1}
                height={6}
                focused={focused === "role"}
                options={ROLE_OPTIONS}
                selectedIndex={roleIndex}
                backgroundColor={theme.bg}
                textColor={theme.fg}
                focusedBackgroundColor={theme.bg}
                focusedTextColor={theme.accent}
                selectedBackgroundColor={theme.accent}
                selectedTextColor={theme.bg}
                descriptionColor={theme.dim}
                selectedDescriptionColor={theme.bg}
                onChange={(index: number) => setRoleIndex(index)}
                onSelect={mint}
              />
            </box>

            <box marginTop={1} onMouseDown={mint} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>⚄ 发邀请码</text>
            </box>

            <box marginTop={1}>
              <text fg={theme.dim}>Tab 切换字段 · Enter 发码 · Esc 返回菜单</text>
            </box>
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperKeys
