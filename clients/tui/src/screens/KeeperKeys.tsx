import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import {
  FrameType,
  stripControlChars,
  type AdminKeyPurpose,
  type AdminKeyInfo,
  type MintedKey,
  type PlayerRole,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

// Only the admin methods + onMessage are needed here — the narrow superset of the
// web AdminPanel's `AdminClient`. App owns the socket; this screen drives the
// keeper-gated key list/mint frames and renders their replies. The server is the
// real gate (role==="keeper" in net/admin.py); the menu hiding this item is only
// a UI courtesy, so a non-keeper reaching here just gets `admin_error{forbidden}`.
export interface KeeperKeysClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  adminListKeys(): void
  adminMintKey(
    room: string,
    name?: string,
    role?: PlayerRole,
    purpose?: AdminKeyPurpose,
    expiresIn?: number,
  ): void
  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void
  adminDeleteKey(id: string): void
  adminDeleteRoom(room: string): void
  adminExportRoom(room: string, path?: string): void
  adminImportRoom(path: string, room?: string): void
  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void
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

type Field = "name" | "role" | "path"
const FIELD_ORDER: Field[] = ["name", "role", "path"]

const CURSOR = "⚄"
const CHAT_BIND_TTL_SECONDS = 600

function roleOptions(locale: string): SelectOption[] {
  return [
    { name: tt(locale, "keys.role.player"), description: tt(locale, "keys.role.player.desc"), value: "player" },
    { name: tt(locale, "keys.role.keeper"), description: tt(locale, "keys.role.keeper.desc"), value: "keeper" },
  ]
}

function describeRoomOp(frame: Extract<ServerFrame, { type: typeof FrameType.AdminRoomOp }>, locale: string): string {
  const action =
    frame.action === "export" ? tt(locale, "keys.op.export") : frame.action === "import" ? tt(locale, "keys.op.import") : tt(locale, "keys.op.delete")
  const path = frame.path ? ` · ${frame.path}` : ""
  return tt(locale, "keys.op.summary", {
    action,
    room: frame.room,
    keys: frame.keys,
    rows: frame.store_rows,
    vectors: frame.vector_points,
    media: frame.media_files ?? 0,
    path,
  })
}

export function KeeperKeys({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperKeysProps) {
  const locale = welcome.locale
  const ROLE_OPTIONS = roleOptions(locale)
  const [keys, setKeys] = useState<AdminKeyInfo[]>([])
  const [minted, setMinted] = useState<MintedKey>()
  const [error, setError] = useState<string>()
  const [roomOp, setRoomOp] = useState<string>()

  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [roleIndex, setRoleIndex] = useState(0)
  const [selectedKey, setSelectedKey] = useState(0)
  const [focused, setFocused] = useState<Field>("name")
  const [confirming, setConfirming] = useState<"key" | "room" | "roomData" | null>(null)

  // Mirror the text fields into refs so submit always reads the latest typed value
  // regardless of render timing (same reason ConnectScreen/CharacterScreen do it).
  const nameRef = useRef(name)
  const pathRef = useRef(path)

  const isKeeper = welcome.you.role === "keeper"

  // Subscribe to admin replies for this screen only, unsubscribing on unmount, then
  // fire the initial list request — mirrors AdminPanel's effect. `admin_keys` carries
  // the (masked) list and, on a mint, a one-time cleartext `minted`; `admin_error`
  // (forbidden / bad_request / anything the wire sends) surfaces inline.
  useEffect(() => {
    // A reconnect can replace the member's room without remounting the whole App. Never retain
    // masked keys, a one-time cleartext invite, or a destructive confirmation across that boundary.
    setKeys([])
    setMinted(undefined)
    setError(undefined)
    setRoomOp(undefined)
    setSelectedKey(0)
    setConfirming(null)
    setName("")
    nameRef.current = ""
    setPath("")
    pathRef.current = ""
    setRoleIndex(0)
    const off = client.onMessage((frame) => {
      if (frame.type === FrameType.AdminKeys) {
        setKeys(frame.keys)
        setSelectedKey((current) => Math.max(0, Math.min(current, frame.keys.length - 1)))
        setConfirming(null)
        if (frame.minted) setMinted(frame.minted)
        setError(undefined)
      } else if (frame.type === FrameType.AdminRoomOp) {
        setRoomOp(describeRoomOp(frame, locale))
        setError(undefined)
      } else if (frame.type === FrameType.AdminError) {
        setError(frame.message ?? frame.code)
      }
    })
    client.adminListKeys()
    return off
  }, [client, locale, welcome.room])

  // A Keeper connection may administer only the room its own key is bound to.
  // Keep that boundary in the UI as well as on the server: never offer an
  // arbitrary room field that would only produce a forbidden response.
  const mint = () => {
    setConfirming(null)
    const nameValue = nameRef.current.trim()
    const role = String(ROLE_OPTIONS[roleIndex]?.value ?? "player") as PlayerRole
    client.adminMintKey(welcome.room, nameValue || undefined, role)
    setName("")
    nameRef.current = ""
  }

  const mintChatBind = () => {
    setConfirming(null)
    client.adminMintKey(welcome.room, undefined, "keeper", "chat_bind", CHAT_BIND_TTL_SECONDS)
  }

  const selected = keys[selectedKey]
  const selectedChatBinding = selected?.id.startsWith("chat:") ?? false

  // Destructive ops (delete invite / room access / full room) require a SECOND click to fire —
  // a single misclick can't irreversibly wipe a room's data or keys. Arming a different
  // destructive button, or any non-destructive action below, resets the pending confirmation.
  const armOrRun = (which: "key" | "room" | "roomData", run: () => void) => {
    if (confirming === which) {
      setConfirming(null)
      run()
    } else {
      setConfirming(which)
    }
  }

  const loadSelected = () => {
    setConfirming(null)
    if (!selected || selectedChatBinding) return
    setName(selected.name)
    nameRef.current = selected.name
    setRoleIndex(selected.role === "keeper" ? 1 : 0)
  }

  const updateSelected = () => {
    setConfirming(null)
    if (!selected || selectedChatBinding) return
    const nameValue = nameRef.current.trim()
    const role = String(ROLE_OPTIONS[roleIndex]?.value ?? "player") as PlayerRole
    client.adminUpdateKey(selected.id, welcome.room, nameValue, role)
  }

  const deleteSelected = () => {
    if (!selected) return
    client.adminDeleteKey(selected.id)
  }

  const deleteRoom = () => {
    client.adminDeleteRoom(welcome.room)
  }

  const targetRoom = () => welcome.room

  const exportRoom = () => {
    setConfirming(null)
    const roomValue = targetRoom().trim()
    if (!roomValue) return
    client.adminExportRoom(roomValue, pathRef.current.trim() || undefined)
  }

  const importRoom = () => {
    setConfirming(null)
    const pathValue = pathRef.current.trim()
    if (!pathValue) return
    client.adminImportRoom(pathValue)
  }

  const deleteRoomData = () => {
    const roomValue = targetRoom().trim()
    if (!roomValue) return
    client.adminDeleteRoomData(roomValue, true, pathRef.current.trim() || undefined)
  }

  // Scoped to this screen and further scoped by focus: Tab cycles fields, Esc goes
  // back. Arrows are left to the focused role <select>; the name/path <input>s
  // get Enter via onSubmit and the select gets it via onSelect.
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
    // The role select owns its arrows. Moving it must not silently retarget a pending key edit or
    // deletion to another invite in the list.
    if (focused !== "role" && keyName === "up") {
      setConfirming(null)
      setSelectedKey((prev) => Math.max(0, prev - 1))
    }
    if (focused !== "role" && keyName === "down" && keys.length) {
      setConfirming(null)
      setSelectedKey((prev) => Math.min(keys.length - 1, prev + 1))
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "keys.title")}</text>
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
              <text fg={theme.fumble}>{tt(locale, "keeper.notKeeper")}</text>
            </box>
          ) : null}

          {error ? (
            <box marginBottom={1} border borderColor={theme.fumble} paddingX={1}>
              <text fg={theme.fumble}>{stripControlChars(error)}</text>
            </box>
          ) : null}

          {minted ? (
            <box flexDirection="column" height={5} marginBottom={1} border borderColor={theme.accent} paddingX={1}>
              <text fg={theme.accent}>
                {minted.purpose === "chat_bind"
                  ? tt(locale, "keys.chatBindMinted", { room: stripControlChars(minted.room) })
                  : tt(locale, "keys.minted", { room: stripControlChars(minted.room), role: minted.role })}
              </text>
              <text fg={theme.success}>
                {CURSOR} {minted.purpose === "chat_bind" ? "/bind " : ""}
                {stripControlChars(minted.key)}
              </text>
              <text fg={theme.fumble}>
                {tt(locale, minted.purpose === "chat_bind" ? "keys.chatBindCopyOnce" : "keys.copyOnce")}
              </text>
            </box>
          ) : null}

          {roomOp ? (
            <box marginBottom={1} border borderColor={theme.success} paddingX={1}>
              <text fg={theme.success}>{stripControlChars(roomOp)}</text>
            </box>
          ) : null}

          <box
            flexDirection="column"
            height={Math.min(Math.max(keys.length + 3, 4), 8)}
            border
            borderColor={theme.border}
            paddingX={1}
          >
            <text fg={theme.accent}>{tt(locale, "keys.existing")}</text>
            {keys.length ? (
              keys.map((entry, index) => (
                <text key={entry.id} fg={index === selectedKey ? theme.accent : theme.fg}>
                  {index === selectedKey ? CURSOR : " "} {stripControlChars(entry.key_masked)} · {stripControlChars(entry.room)} ·{" "}
                  {stripControlChars(entry.name || "—")} · {entry.role}
                </text>
              ))
            ) : (
              <text fg={theme.dim}>{tt(locale, "keys.none")}</text>
            )}
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={72} maxWidth="100%" minWidth={0} flexShrink={0}>
            <text fg={theme.dim}>{tt(locale, "keys.intro")}</text>

            <box flexDirection="column" marginTop={1}>
              <text fg={theme.dim}>{tt(locale, "keys.room")}</text>
              <text fg={theme.fg}>{stripControlChars(welcome.room)}</text>
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("name")}>
              <text fg={focused === "name" ? theme.accent : theme.dim}>{tt(locale, "keys.name")}</text>
              <input
                flexGrow={1}
                value={name}
                focused={focused === "name"}
                placeholder={tt(locale, "keys.blank")}
                onInput={(value: string) => {
                  setConfirming(null)
                  nameRef.current = value
                  setName(value)
                }}
                onSubmit={mint}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("role")}>
              <text fg={focused === "role" ? theme.accent : theme.dim}>{tt(locale, "keys.role")}</text>
              <select
                flexGrow={1}
                height={4}
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
                onChange={(index: number) => {
                  setConfirming(null)
                  setRoleIndex(index)
                }}
                onSelect={mint}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("path")}>
              <text fg={focused === "path" ? theme.accent : theme.dim}>{tt(locale, "keys.backupPath")}</text>
              <input
                flexGrow={1}
                value={path}
                focused={focused === "path"}
                placeholder={tt(locale, "keys.backupPlaceholder")}
                onInput={(value: string) => {
                  setConfirming(null)
                  pathRef.current = value
                  setPath(value)
                }}
                onSubmit={exportRoom}
              />
            </box>

            {/* Primary action — mint a new invite key */}
            <box marginTop={1} onMouseDown={mint} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "keys.mint")}</text>
            </box>
            <box onMouseDown={mintChatBind} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "keys.mintChatBind")}</text>
            </box>

            {/* Manage the selected key */}
            <box flexDirection="row" marginTop={1}>
              {!selectedChatBinding ? (
                <>
                  <box onMouseDown={loadSelected} backgroundColor={theme.border} paddingX={1}>
                    <text fg={theme.fg}>{tt(locale, "keys.load")}</text>
                  </box>
                  <box marginLeft={1} onMouseDown={updateSelected} backgroundColor={theme.border} paddingX={1}>
                    <text fg={theme.fg}>{tt(locale, "keys.save")}</text>
                  </box>
                </>
              ) : null}
              <box marginLeft={selectedChatBinding ? 0 : 1} onMouseDown={() => armOrRun("key", deleteSelected)} backgroundColor={theme.fumble} paddingX={1}>
                <text fg={theme.bg}>{tt(locale, "keys.deleteKey")}{confirming === "key" ? tt(locale, "keys.confirm") : ""}</text>
              </box>
            </box>

            {/* Room backup — the two neutral room ops, grouped + gapped off the row above */}
            <box marginTop={1} onMouseDown={exportRoom} backgroundColor={theme.border} paddingX={1}>
              <text fg={theme.fg}>{tt(locale, "keys.export")}</text>
            </box>
            <box onMouseDown={importRoom} backgroundColor={theme.border} paddingX={1}>
              <text fg={theme.fg}>{tt(locale, "keys.import")}</text>
            </box>

            {/* Danger zone — the destructive ops grouped together and set apart by a gap,
                not interleaved with the neutral ones; each still confirms on a second click. */}
            <box marginTop={1} onMouseDown={() => armOrRun("room", deleteRoom)} backgroundColor={theme.fumble} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "keys.deleteAccess")}{confirming === "room" ? tt(locale, "keys.confirm") : ""}</text>
            </box>
            <box onMouseDown={() => armOrRun("roomData", deleteRoomData)} backgroundColor={theme.fumble} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "keys.deleteRoom")}{confirming === "roomData" ? tt(locale, "keys.confirm") : ""}</text>
            </box>

            <box marginTop={1}>
              <text fg={theme.dim}>{tt(locale, "keys.help")}</text>
            </box>
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperKeys
