import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import { outcomeOf, type Outcome } from "../adminResult"
import type { Connection } from "../connection"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { MaskedInput } from "./MaskedInput"
import { Spinner } from "./Spinner"

/** A provider the form may pick: its id, and whether a key is already saved for it. */
export interface ProviderChoice {
  readonly id: string
  readonly credential: boolean
}

export interface ModelFormProps {
  connection: Connection
  /** `lane`: `model set` for `lane`. `image`: `imagegen set`. */
  kind: "lane" | "image"
  /** The lane being set (`lane` forms): `keeper`, `npc`, `scribe`, `director` or `memory`. */
  lane: string
  /** What the lane's heading says it is. */
  laneLabel: string
  providers: readonly ProviderChoice[]
  /** What is set now: the form starts from it. */
  current: { readonly provider: string | null; readonly model: string | null; readonly size?: string | null }
  theme: Palette
  locale: string
  /** The command succeeded: the server's own words about it. The form is finished. */
  onDone: (text: string) => void
  onCancel: () => void
}

type Field = "provider" | "name" | "baseUrl" | "model" | "list" | "models" | "key" | "size" | "submit"

interface Listed {
  readonly provider: string
  readonly models: readonly string[]
  readonly total: number
  readonly truncated: boolean
  readonly skipped: number
}

const LABEL_WIDTH = 16
/** Providers shown at once: the presets, the saved endpoints and "Other" fit without scrolling in the usual case. */
const PROVIDER_ROWS = 6
const SELECT_COLORS = (theme: Palette) => ({
  backgroundColor: theme.bg,
  textColor: theme.fg,
  focusedBackgroundColor: theme.bg,
  focusedTextColor: theme.accent,
  selectedBackgroundColor: theme.accent,
  selectedTextColor: theme.bg,
  descriptionColor: theme.dim,
  selectedDescriptionColor: theme.bg,
})

/** The models out of a `model list` answer's data; null when it is not that shape. */
function listedFrom(data: unknown, asked: string): Listed | null {
  if (typeof data !== "object" || data === null) return null
  const record = data as Record<string, unknown>
  if (!Array.isArray(record.models)) return null
  const models = record.models.filter((entry): entry is string => typeof entry === "string")
  return {
    provider: typeof record.provider === "string" ? record.provider : asked,
    models,
    total: typeof record.total === "number" ? record.total : models.length,
    truncated: record.truncated === true,
    skipped: typeof record.skipped === "number" ? record.skipped : 0,
  }
}

/**
 * One model lane's settings, or the image generation's: a provider (or another one by address),
 * a model id typed or picked from what the provider lists, an optional API key, sent with
 * `command.run`. The key is typed into a masked field and lives only in this form's state: it is
 * cleared the moment it is sent and when the form closes, and never reaches the snapshot, the
 * log lines or anything written out. A refusal is shown in the server's own words.
 */
export function ModelForm({ connection, kind, lane, laneLabel, providers, current, theme, locale, onDone, onCancel }: ModelFormProps) {
  const known = providers.findIndex((entry) => entry.id === current.provider)
  const [providerIndex, setProviderIndex] = useState(known >= 0 ? known : 0)
  const other = providerIndex >= providers.length
  const [name, setName] = useState("")
  const nameRef = useRef("")
  const [baseUrl, setBaseUrl] = useState("")
  const baseRef = useRef("")
  // The lane's own model starts in the field when its provider is the one chosen.
  const startModel = known >= 0 ? (current.model ?? "") : ""
  const [model, setModel] = useState(startModel)
  const modelRef = useRef(startModel)
  // Whether the admin has typed or picked a model: until then it follows the provider chosen.
  const modelTouched = useRef(false)
  const [size, setSize] = useState(current.size ?? "")
  const sizeRef = useRef(current.size ?? "")
  // The typed API key: this form's, until it is sent or the form closes.
  const [secret, setSecret] = useState("")
  const secretRef = useRef("")
  const [focus, setFocus] = useState<Field>("provider")
  const [busy, setBusy] = useState<"set" | "list" | null>(null)
  const [message, setMessage] = useState<Outcome>()
  const [listed, setListed] = useState<Listed | null>(null)
  const [listIndex, setListIndex] = useState(0)
  const alive = useRef(true)

  useEffect(
    () => () => {
      alive.current = false
      secretRef.current = ""
    },
    [],
  )

  const fields: Field[] = ["provider"]
  if (other) fields.push("name")
  if (kind === "image" || other) fields.push("baseUrl")
  fields.push("model")
  if (kind === "lane") fields.push("list")
  if (listed !== null && listed.models.length > 0) fields.push("models")
  fields.push("key")
  if (kind === "image") fields.push("size")
  fields.push("submit")
  const at: Field = fields.includes(focus) ? focus : "provider"

  /** The provider as the command names it; "" when "other" has no name yet. */
  const providerName = (): string => (providerIndex >= providers.length ? nameRef.current.trim() : (providers[providerIndex]?.id ?? ""))

  const submit = async () => {
    if (busy !== null) return
    const provider = providerName()
    const address = baseRef.current.trim()
    if (provider === "" || (providerIndex >= providers.length && address === "")) {
      setMessage({ ok: false, text: tt(locale, "model.form.needName") })
      return
    }
    const typed = modelRef.current.trim()
    const picture = sizeRef.current.trim()
    const key = secretRef.current.trim()
    const args: Record<string, unknown> = kind === "lane" ? { op: "set", lane, provider } : { op: "set", provider }
    if (typed !== "") args.model = typed
    if (address !== "") args.baseUrl = address
    if (kind === "image" && picture !== "") args.size = picture
    if (key !== "") args.key = key
    // The key is in `args` and goes out in this one call: gone from the form now.
    secretRef.current = ""
    setSecret("")
    setBusy("set")
    setMessage(undefined)
    const result = await connection.runCommand(kind === "lane" ? "model" : "imagegen", args, { quiet: true })
    if (!alive.current) return
    setBusy(null)
    const answer = outcomeOf(result, locale)
    if (answer.ok) onDone(answer.text)
    else setMessage(answer)
  }

  const list = async () => {
    if (busy !== null || kind !== "lane") return
    const provider = providerName()
    if (provider === "") {
      setMessage({ ok: false, text: tt(locale, "model.form.needName") })
      return
    }
    setBusy("list")
    setMessage(undefined)
    setListed(null)
    const result = await connection.runCommand("model", { op: "list", provider, lane }, { quiet: true })
    if (!alive.current) return
    setBusy(null)
    if (result === null || !result.ok) {
      setMessage(outcomeOf(result, locale))
      return
    }
    const found = listedFrom(result.data, provider)
    if (found === null || found.models.length === 0) {
      setMessage({ ok: false, text: tt(locale, "model.form.listEmpty") })
      return
    }
    setListed(found)
    setListIndex(0)
    setFocus("models")
  }

  const pick = (index: number) => {
    const chosen = listed?.models[index]
    if (chosen === undefined) return
    modelTouched.current = true
    modelRef.current = chosen
    setModel(chosen)
    setFocus("key")
  }

  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (key === "escape") {
      // A send in flight is waited for, so its answer is not lost behind a closed form.
      if (busy !== "set") onCancel()
      return
    }
    if (key === "tab") {
      const index = Math.max(0, fields.indexOf(at))
      setFocus(fields[(index + (event.shift ? fields.length - 1 : 1)) % fields.length] as Field)
      return
    }
    if (key === "return" || key === "enter") {
      if (at === "list") void list()
      if (at === "submit") void submit()
    }
  })

  const options: SelectOption[] = [
    ...providers.map((entry) => ({ name: `${stripControlChars(entry.id)}${entry.credential ? ` · ${tt(locale, "model.form.keySaved")}` : ""}`, description: "", value: entry.id })),
    { name: tt(locale, "model.form.other"), description: "", value: "" },
  ]

  const label = (field: Field, text: string) => (
    <box width={LABEL_WIDTH} flexShrink={0}>
      <text fg={at === field ? theme.accent : theme.dim} wrapMode="none" truncate>
        {text}
      </text>
    </box>
  )
  const textRow = (field: "name" | "baseUrl" | "model" | "size", caption: string, value: string, placeholder: string, ref: { current: string }, set: (value: string) => void) => (
    <box flexDirection="row" height={1} onMouseDown={() => setFocus(field)}>
      {label(field, caption)}
      <input
        flexGrow={1}
        minWidth={0}
        value={value}
        focused={at === field && busy === null}
        placeholder={placeholder}
        onInput={(text: string) => {
          ref.current = text
          if (field === "model") modelTouched.current = true
          set(text)
        }}
        onSubmit={() => void submit()}
      />
    </box>
  )
  const button = (field: "list" | "submit", text: string, press: () => void) => (
    <box marginTop={1} height={1} paddingX={1} backgroundColor={at === field ? theme.accent : theme.border} onMouseDown={() => {
      setFocus(field)
      press()
    }}>
      <text fg={theme.bg} wrapMode="none" truncate>
        {at === field ? "› " : ""}
        {text}
      </text>
    </box>
  )

  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={2} width="100%" maxWidth={80} minWidth={0} flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>
        {kind === "lane" ? tt(locale, "model.form.titleLane", { lane: laneLabel }) : tt(locale, "model.form.titleImage")}
      </text>

      <box flexDirection="row" height={Math.min(PROVIDER_ROWS, options.length)} marginTop={1} onMouseDown={() => setFocus("provider")}>
        {label("provider", tt(locale, "model.form.provider"))}
        <select
          flexGrow={1}
          minWidth={0}
          height={Math.min(PROVIDER_ROWS, options.length)}
          focused={at === "provider" && busy === null}
          options={options}
          selectedIndex={Math.min(providerIndex, options.length - 1)}
          showDescription={false}
          {...SELECT_COLORS(theme)}
          onChange={(index: number) => {
            if (index === providerIndex) return
            setProviderIndex(index)
            setListed(null)
            // The lane's own model belongs to its own provider.
            if (!modelTouched.current) {
              const follow = index === known ? startModel : ""
              modelRef.current = follow
              setModel(follow)
            }
          }}
          onSelect={() => setFocus(other ? "name" : fields[1] ?? "model")}
        />
      </box>
      {other ? textRow("name", tt(locale, "model.form.name"), name, tt(locale, "model.form.namePlaceholder"), nameRef, setName) : null}
      {kind === "image" || other
        ? textRow("baseUrl", tt(locale, "model.form.baseUrl"), baseUrl, tt(locale, other ? "model.form.baseUrlOther" : "model.form.baseUrlKnown"), baseRef, setBaseUrl)
        : null}
      {textRow("model", tt(locale, "model.form.model"), model, tt(locale, "model.form.modelPlaceholder"), modelRef, setModel)}

      {kind === "lane" ? button("list", tt(locale, "model.form.list"), () => void list()) : null}
      {busy === "list" ? <Spinner active label={tt(locale, "model.form.listing")} color={theme.accent} /> : null}
      {listed !== null ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.dim} wrapMode="none" truncate>
            {tt(locale, "model.form.listed", { count: listed.models.length, provider: stripControlChars(listed.provider) })}
          </text>
          {listed.truncated ? <text fg={theme.fumble}>{tt(locale, "model.form.listTruncated", { shown: listed.models.length, total: listed.total })}</text> : null}
          {listed.skipped > 0 ? <text fg={theme.dim}>{tt(locale, "model.form.listSkipped", { count: listed.skipped })}</text> : null}
          <box onMouseDown={() => setFocus("models")}>
            <select
              flexGrow={1}
              height={Math.min(6, listed.models.length)}
              focused={at === "models" && busy === null}
              options={listed.models.map((id) => ({ name: stripControlChars(id), description: "", value: id }))}
              selectedIndex={Math.min(listIndex, listed.models.length - 1)}
              showDescription={false}
              {...SELECT_COLORS(theme)}
              onChange={(index: number) => setListIndex(index)}
              onSelect={(index: number) => pick(index)}
            />
          </box>
        </box>
      ) : null}

      <box flexDirection="row" height={1} marginTop={1} onMouseDown={() => setFocus("key")}>
        {label("key", tt(locale, "model.form.key"))}
        <MaskedInput
          value={secret}
          focused={at === "key" && busy === null}
          placeholder={tt(locale, "model.form.keyPlaceholder")}
          maskedLabel={tt(locale, "model.form.keyMasked")}
          theme={theme}
          onInput={(text: string) => {
            secretRef.current = text
            setSecret(text)
          }}
          onSubmit={() => void submit()}
        />
      </box>
      <text fg={theme.dim}>{tt(locale, "model.form.keyNote")}</text>
      {kind === "image" ? <box marginTop={1}>{textRow("size", tt(locale, "model.form.size"), size, tt(locale, "model.form.sizePlaceholder"), sizeRef, setSize)}</box> : null}

      {button("submit", tt(locale, "model.form.submit"), () => void submit())}
      {busy === "set" ? <Spinner active label={tt(locale, "admin.working")} color={theme.accent} /> : null}
      {message ? (
        <box marginTop={1} minWidth={0}>
          <text fg={message.ok ? theme.success : theme.fumble}>{message.text}</text>
        </box>
      ) : null}
      <box marginTop={1}>
        <text fg={theme.dim}>{tt(locale, "model.form.help")}</text>
      </box>
    </box>
  )
}

export default ModelForm
