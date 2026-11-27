import { useEffect, useRef, useState, type ReactNode } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { Outcome } from "../adminResult"
import { ScreenFrame } from "../components/ScreenFrame"
import { Spinner } from "../components/Spinner"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt } from "../i18n"
import { readLocalFile } from "../media"
import { MAX_SAVE_BYTES, parseSaveFile, SAVE_LIMIT_MB, sizeLabel } from "../save"
import type { Palette, ThemeName } from "../themes"
import { transferErrorText } from "../transfer"

export interface RestoreRoomScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onBack: () => void
  /** The room was replaced and this client is back in it: leave for the menu. */
  onRestored: () => void
}

/** The save file the admin picked, read and checked, waiting for the confirmation. */
interface Picked {
  readonly name: string
  readonly size: number
  readonly bundle: Record<string, unknown>
}

type Step = "path" | "confirm" | "sending" | "waiting"

const CURSOR = "⚄"
const ROWS = ["cancel", "go"] as const

/**
 * The admin's "Restore the room from a save file": a path, the file read and checked, a plain
 * warning with the file's name and size, and only then `save {op: "import", bundle}`.
 *
 * An import REPLACES the room, so the server ends every member's connection after it has
 * answered (docs/protocol.md §6.7): this link drops on purpose. The session then goes offline,
 * `Connection` redials by itself, and the new welcome names another epoch. That is what this
 * screen waits for — an epoch other than the one it sent from, on an online session — and then
 * leaves. A request cut off by the drop (no answer) is told by the same sign: another epoch
 * means the room was replaced; the same epoch means nothing happened. No error is shown for the
 * drop itself.
 */
export function RestoreRoomScreen({ connection, theme, themeName, locale, onBack, onRestored }: RestoreRoomScreenProps) {
  const snapshot = useSnapshot(connection)
  const isAdmin = snapshot.welcome?.you.role === "admin"
  const room = snapshot.welcome?.room.id ?? ""
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length

  const [step, setStep] = useState<Step>("path")
  const [path, setPath] = useState("")
  const pathRef = useRef("")
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [choice, setChoice] = useState(0)
  const [outcome, setOutcome] = useState<Outcome>()
  // What the waiting panel says, and what it is waiting out.
  const [waitingText, setWaitingText] = useState("")
  const epochSentFrom = useRef<number | null>(null)
  const unanswered = useRef(false)

  const guarded = async (work: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await work()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const submitPath = () =>
    guarded(async () => {
      setOutcome(undefined)
      try {
        const file = await readLocalFile(pathRef.current, "save", MAX_SAVE_BYTES)
        const parsed = parseSaveFile(file.bytes)
        if (!parsed.ok) {
          setOutcome({ ok: false, text: tt(locale, parsed.code === "not_json" ? "restore.notJson" : "restore.notObject", { name: stripControlChars(file.name) }) })
          return
        }
        setPicked({ name: file.name, size: file.bytes.length, bundle: parsed.bundle })
        setChoice(0)
        setStep("confirm")
      } catch (caught) {
        setOutcome({ ok: false, text: transferErrorText(caught, locale, SAVE_LIMIT_MB) })
      }
    })

  const replaceRoom = () =>
    guarded(async () => {
      if (picked === null) return
      epochSentFrom.current = connection.session.getSnapshot().epoch
      unanswered.current = false
      setOutcome(undefined)
      setStep("sending")
      // Quiet: the answer is shown here, not in the game's log lines.
      const result = await connection.runCommand("save", { op: "import", bundle: picked.bundle }, { quiet: true })
      setPicked(null)
      if (result === null) {
        // The link went down under the request: that is how an import ends a connection when
        // the answer does not get out first. Whether the room was replaced is for the next
        // welcome to say.
        unanswered.current = true
        setWaitingText(tt(locale, "restore.waiting"))
        setStep("waiting")
        return
      }
      if (!result.ok) {
        // The server's refusal, in its own words (`bad_bundle`, a version it cannot read…).
        setOutcome({ ok: false, text: stripControlChars(result.error.message) })
        setStep("path")
        return
      }
      setWaitingText(stripControlChars(result.text ?? ""))
      setStep("waiting")
    })

  // Back online in another generation: the room is the restored one. Back online in the same
  // generation after an unanswered request: nothing was replaced.
  useEffect(() => {
    if (step !== "waiting" || snapshot.status !== "online") return
    if (snapshot.epoch !== epochSentFrom.current) {
      onRestored()
      return
    }
    if (unanswered.current) {
      unanswered.current = false
      setOutcome({ ok: false, text: tt(locale, "restore.notApplied") })
      setStep("path")
    }
  }, [step, snapshot.status, snapshot.epoch])

  const choose = (index: number) => {
    const row = ROWS[Math.max(0, Math.min(ROWS.length - 1, index))]
    setChoice(index)
    if (row === "cancel") {
      setStep("path")
      return
    }
    void replaceRoom()
  }

  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (!isAdmin) {
      if (key === "escape") onBack()
      return
    }
    if (step === "path") {
      if (key === "escape") onBack()
      return
    }
    if (step === "confirm") {
      if (key === "up") setChoice(0)
      if (key === "down") setChoice(1)
      if (key === "return" || key === "enter") choose(choice)
      if (key === "escape") setStep("path")
      return
    }
    // Sending cannot be called back; waiting can be left (the link comes back in the menu).
    if (step === "waiting" && key === "escape") onBack()
  })

  const panel = (children: ReactNode) => (
    <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={80} minWidth={0} flexShrink={0}>
      {children}
    </box>
  )

  const row = (index: number, label: string) => (
    <box key={label} height={1} backgroundColor={choice === index ? theme.accent : theme.bg} onMouseMove={() => setChoice(index)} onMouseDown={() => choose(index)}>
      <text fg={choice === index ? theme.bg : index === 1 ? theme.fumble : theme.fg} wrapMode="none" truncate>
        {choice === index ? `${CURSOR} ` : "  "}
        {label}
      </text>
    </box>
  )

  let body: ReactNode
  if (!isAdmin) {
    body = <text fg={theme.fumble}>{tt(locale, "admin.onlyAdmins")}</text>
  } else if (step === "confirm" && picked !== null) {
    body = panel(
      <>
        <text fg={theme.fumble}>{tt(locale, "restore.confirmTitle")}</text>
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.fg}>{tt(locale, "restore.file", { name: stripControlChars(picked.name) })}</text>
          <text fg={theme.fg}>{tt(locale, "restore.size", { size: sizeLabel(picked.size) })}</text>
        </box>
        <box marginTop={1}>
          <text fg={theme.fumble}>{tt(locale, "restore.warning")}</text>
        </box>
        <box flexDirection="column" marginTop={1}>
          {row(0, tt(locale, "restore.cancel"))}
          {row(1, tt(locale, "restore.go"))}
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "restore.confirmHelp")}</text>
        </box>
      </>,
    )
  } else if (step === "sending") {
    body = panel(<Spinner active label={tt(locale, "restore.working")} color={theme.accent} />)
  } else if (step === "waiting") {
    body = panel(
      <>
        {waitingText ? <text fg={theme.success}>{waitingText}</text> : null}
        <box marginTop={waitingText ? 1 : 0}>
          <Spinner active label={tt(locale, unanswered.current ? "restore.waiting" : "restore.reconnecting")} color={theme.accent} />
        </box>
      </>,
    )
  } else {
    body = panel(
      <>
        <text fg={theme.dim}>{tt(locale, "restore.intro")}</text>
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "restore.path")}
          </text>
          <input
            flexGrow={1}
            value={path}
            focused={!busy}
            placeholder={tt(locale, "restore.placeholder")}
            onInput={(value: string) => {
              pathRef.current = value
              setPath(value)
            }}
            onSubmit={() => void submitPath()}
          />
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "restore.help", { mb: SAVE_LIMIT_MB })}</text>
        </box>
      </>,
    )
  }

  return (
    <ScreenFrame title={tt(locale, "restore.title")} room={room} online={online} locale={locale} theme={theme} themeName={themeName}>
      {body}
      {outcome && step === "path" ? (
        <box marginTop={1} minWidth={0}>
          <text fg={outcome.ok ? theme.success : theme.fumble}>{outcome.text}</text>
        </box>
      ) : null}
    </ScreenFrame>
  )
}

export default RestoreRoomScreen
