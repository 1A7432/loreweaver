import { useState, type ReactNode } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type AdminModelLane, type AdminModelView, type SettingSource } from "loreweaver-protocol/v3"
import { outcomeOf, type Outcome } from "../adminResult"
import { ModelForm } from "../components/ModelForm"
import { ScreenFrame } from "../components/ScreenFrame"
import { Spinner } from "../components/Spinner"
import type { Connection } from "../connection"
import { useSnapshot, useViews, viewData } from "../hooks"
import { tt, type MessageKey } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface ModelScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onBack: () => void
}

type Mode = "overview" | "actions" | "form" | "reset"
/** What the admin picked: a model lane, or image generation. */
type Target = { readonly kind: "lane"; readonly lane: AdminModelLane["lane"] } | { readonly kind: "image" }

const CURSOR = "⚄"
const LANE_LABELS: Record<AdminModelLane["lane"], MessageKey> = {
  keeper: "model.lane.keeper",
  npc: "model.lane.npc",
  scribe: "model.lane.scribe",
  director: "model.lane.director",
  memory: "model.lane.memory",
}
const SOURCE_LABELS: Record<SettingSource, MessageKey> = {
  override: "model.source.override",
  environment: "model.source.environment",
  default: "model.source.default",
}

function sameTarget(a: Target, b: Target): boolean {
  return a.kind === b.kind && (a.kind === "image" || (b.kind === "lane" && a.lane === b.lane))
}

/** One row of the overview: what is said about a lane or about pictures. */
interface Summary {
  readonly target: Target
  readonly head: string
  readonly detail?: string
}

function keyText(key: { set: boolean; masked: string | null }, locale: string): string {
  return key.set && key.masked !== null ? tt(locale, "model.keyIs", { masked: stripControlChars(key.masked) }) : tt(locale, "model.noKey")
}

/**
 * What to call where a lane's model is served: the provider's name, or — for an endpoint the
 * operator named by URL only — the host of that URL. "?" only when the server says neither.
 */
export function endpointName(provider: string | null, baseUrl: string | null): string {
  if (provider !== null) return stripControlChars(provider)
  if (baseUrl !== null) {
    try {
      const host = new URL(baseUrl).host
      if (host !== "") return stripControlChars(host)
    } catch {
      // not a URL: fall through
    }
  }
  return "?"
}

function laneSummary(lane: AdminModelLane, locale: string): Summary {
  const label = tt(locale, LANE_LABELS[lane.lane])
  const target: Target = { kind: "lane", lane: lane.lane }
  // A lane that follows the Keeper's is said in one short line: there is nothing of its own to show.
  if (lane.sameAsKeeper) return { target, head: `${label}: ${tt(locale, "model.sameAsKeeper")}` }
  if (lane.provider === null && lane.model === null) return { target, head: `${label}: ${tt(locale, "model.notConfigured")}`, detail: tt(locale, SOURCE_LABELS[lane.source]) }
  return {
    target,
    head: `${label}: ${endpointName(lane.provider, lane.baseUrl)} / ${stripControlChars(lane.model ?? "?")}`,
    detail: `${tt(locale, SOURCE_LABELS[lane.source])} · ${keyText(lane.key, locale)}`,
  }
}

function imageSummary(image: AdminModelView["imagegen"], locale: string): Summary {
  const label = tt(locale, "model.image")
  const target: Target = { kind: "image" }
  if (!image.enabled) return { target, head: `${label}: ${tt(locale, "model.image.off")}`, detail: tt(locale, SOURCE_LABELS[image.source]) }
  return {
    target,
    head: `${label}: ${endpointName(image.provider, image.baseUrl)} / ${stripControlChars(image.model ?? "?")}${image.size ? ` · ${stripControlChars(image.size)}` : ""}`,
    detail: `${tt(locale, SOURCE_LABELS[image.source])} · ${keyText(image.key, locale)}`,
  }
}

/**
 * The admin's "Model": which model each lane of the Keeper uses and the picture maker (the
 * `admin/model` view, subscribed only while this screen is open), and the `model` / `imagegen`
 * commands with typed arguments to change them. Server-wide, so the screen says so. The API key
 * an admin types lives in `ModelForm` alone (see there).
 */
export function ModelScreen({ connection, theme, themeName, locale, onBack }: ModelScreenProps) {
  const snapshot = useSnapshot(connection)
  const isAdmin = snapshot.welcome?.you.role === "admin"
  useViews(connection, isAdmin ? ["admin/model"] : [])
  const view = isAdmin ? viewData(snapshot, "admin/model") : null
  const problem = snapshot.viewProblems.get("admin/model")
  const room = snapshot.welcome?.room.id ?? ""
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length

  const [mode, setMode] = useState<Mode>("overview")
  const [selected, setSelected] = useState(0)
  const [actionIndex, setActionIndex] = useState(0)
  const [target, setTarget] = useState<Target>({ kind: "lane", lane: "keeper" })
  const [outcome, setOutcome] = useState<Outcome>()
  const [busy, setBusy] = useState(false)

  const summaries: Summary[] = view === null ? [] : [...view.lanes.map((lane) => laneSummary(lane, locale)), imageSummary(view.imagegen, locale)]
  const clamp = (index: number, count: number) => Math.max(0, Math.min(count - 1, index))
  const targetLabel = target.kind === "lane" ? tt(locale, LANE_LABELS[target.lane]) : tt(locale, "model.image")

  // The actions for the target picked: set it, take it back, or turn it off.
  const actions: { readonly label: string; readonly run: () => void }[] = [
    target.kind === "lane"
      ? { label: tt(locale, "model.action.setLane"), run: () => setMode("form") }
      : { label: tt(locale, "model.action.setImage"), run: () => setMode("form") },
    target.kind === "lane"
      ? {
          label: tt(locale, "model.action.resetLane"),
          run: () => {
            setOutcome(undefined)
            setMode("reset")
          },
        }
      : { label: tt(locale, "model.action.imageOff"), run: () => void imageOff() },
    {
      label: tt(locale, "model.action.back"),
      run: () => {
        setOutcome(undefined)
        setMode("overview")
      },
    },
  ]

  const run = async (id: string, args: Record<string, unknown>): Promise<Outcome> => {
    setBusy(true)
    try {
      return outcomeOf(await connection.runCommand(id, args, { quiet: true }), locale)
    } finally {
      setBusy(false)
    }
  }

  const imageOff = async () => {
    if (busy) return
    const answer = await run("imagegen", { op: "off" })
    setOutcome(answer)
    if (answer.ok) setMode("overview")
  }

  const resetLane = async () => {
    if (busy || target.kind !== "lane") return
    const answer = await run("model", { op: "reset", lane: target.lane })
    setOutcome(answer)
    setMode(answer.ok ? "overview" : "actions")
  }

  const activateRow = (index: number) => {
    const row = summaries[clamp(index, summaries.length)]
    if (row === undefined) return
    setSelected(clamp(index, summaries.length))
    setTarget(row.target)
    setActionIndex(0)
    setOutcome(undefined)
    setMode("actions")
  }

  const activateAction = (index: number) => {
    const at = clamp(index, actions.length)
    setActionIndex(at)
    actions[at]?.run()
  }

  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""
    // The form keeps its own keys (and its own Esc).
    if (mode === "form" && isAdmin) return
    if (!isAdmin) {
      if (key === "escape") onBack()
      return
    }
    if (mode === "overview") {
      if (key === "up") setSelected((prev) => clamp(prev - 1, summaries.length))
      if (key === "down") setSelected((prev) => clamp(prev + 1, summaries.length))
      if ((key === "return" || key === "enter") && summaries.length > 0) activateRow(selected)
      if (key === "escape") onBack()
      return
    }
    if (mode === "actions") {
      if (key === "up") setActionIndex((prev) => clamp(prev - 1, actions.length))
      if (key === "down") setActionIndex((prev) => clamp(prev + 1, actions.length))
      if (key === "return" || key === "enter") activateAction(actionIndex)
      if (key === "escape") {
        setOutcome(undefined)
        setMode("overview")
      }
      return
    }
    // reset
    if (key === "return" || key === "enter") void resetLane()
    if (key === "escape") {
      setOutcome(undefined)
      setMode("actions")
    }
  })

  const choiceRow = (active: boolean, label: string, onClick: () => void, onMove: () => void) => (
    <box key={label} height={1} backgroundColor={active ? theme.accent : theme.bg} onMouseMove={onMove} onMouseDown={onClick}>
      <text fg={active ? theme.bg : theme.fg} wrapMode="none" truncate>
        {active ? `${CURSOR} ` : "  "}
        {label}
      </text>
    </box>
  )

  let body: ReactNode
  if (!isAdmin) {
    body = <text fg={theme.fumble}>{tt(locale, "admin.onlyAdmins")}</text>
  } else if (view === null) {
    body = <text fg={theme.dim}>{problem ? tt(locale, "commands.refused", { code: problem }) : tt(locale, "model.loading")}</text>
  } else if (mode === "form") {
    body =
      target.kind === "lane" ? (
        <ModelForm
          // A new form (and so new, empty key state) for each target.
          key={`lane:${target.lane}`}
          connection={connection}
          kind="lane"
          lane={target.lane}
          laneLabel={targetLabel}
          providers={view.providers.map((entry) => ({ id: entry.id, credential: entry.credential }))}
          current={view.lanes.find((entry) => entry.lane === target.lane) ?? { provider: null, model: null }}
          theme={theme}
          locale={locale}
          onDone={(text) => {
            setOutcome({ ok: true, text })
            setMode("overview")
          }}
          onCancel={() => setMode("actions")}
        />
      ) : (
        <ModelForm
          key="image"
          connection={connection}
          kind="image"
          lane="image"
          laneLabel={targetLabel}
          providers={view.imageProviders.map((entry) => ({ id: entry.id, credential: entry.credential }))}
          current={{ provider: view.imagegen.provider, model: view.imagegen.model, size: view.imagegen.size }}
          theme={theme}
          locale={locale}
          onDone={(text) => {
            setOutcome({ ok: true, text })
            setMode("overview")
          }}
          onCancel={() => setMode("actions")}
        />
      )
  } else if (mode === "reset") {
    body = (
      <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={76} minWidth={0} flexShrink={0}>
        <text fg={theme.fumble}>{tt(locale, "model.reset.confirm", { lane: targetLabel })}</text>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "model.reset.help")}</text>
        </box>
      </box>
    )
  } else if (mode === "actions") {
    body = (
      <>
        <text fg={theme.accent} wrapMode="none" truncate>
          {summaries.find((row) => sameTarget(row.target, target))?.head ?? targetLabel}
        </text>
        <box flexDirection="column" marginTop={1}>
          {actions.map((action, index) => choiceRow(actionIndex === index, action.label, () => activateAction(index), () => setActionIndex(index)))}
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "model.actionsHelp")}</text>
        </box>
      </>
    )
  } else {
    body = (
      <>
        <text fg={theme.dim}>{tt(locale, "model.intro")}</text>
        <box flexDirection="column" marginTop={1}>
          {summaries.map((row, index) => (
            <box key={index} flexDirection="column" flexShrink={0} backgroundColor={selected === index ? theme.accent : theme.bg} onMouseMove={() => setSelected(index)} onMouseDown={() => activateRow(index)}>
              <text fg={selected === index ? theme.bg : theme.fg} wrapMode="none" truncate>
                {selected === index ? `${CURSOR} ` : "  "}
                {row.head}
              </text>
              {row.detail ? (
                <text fg={selected === index ? theme.bg : theme.dim} wrapMode="none" truncate>
                  {`    ${row.detail}`}
                </text>
              ) : null}
            </box>
          ))}
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "model.listHelp")}</text>
        </box>
      </>
    )
  }

  return (
    <ScreenFrame title={tt(locale, "model.title")} room={room} online={online} locale={locale} theme={theme} themeName={themeName}>
      {body}
      {outcome && mode !== "form" ? (
        <box marginTop={1} minWidth={0}>
          <text fg={outcome.ok ? theme.success : theme.fumble}>{outcome.text}</text>
        </box>
      ) : null}
      {busy ? (
        <box marginTop={1}>
          <Spinner active label={tt(locale, "admin.working")} color={theme.accent} />
        </box>
      ) : null}
    </ScreenFrame>
  )
}

export default ModelScreen
