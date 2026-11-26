import { useEffect, useState } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { useConnectionState } from "../hooks"
import { tt } from "../i18n"
import { chooseViewerMode, viewImage, type RendererLike } from "../imageViewer"
import type { Picture } from "../log"
import { sharerName } from "../logText"
import { halfBlockPreviewSize, openInSystemViewer, type HalfBlockLine } from "../media"
import type { Palette } from "../themes"
import { fetchFailureText } from "../transfer"

export interface PictureViewerProps {
  connection: Connection
  picture: Picture
  theme: Palette
  locale: string
  names?: ReadonlyMap<string, string>
  /** The environment the graphics protocol is chosen from (tests hand in `{}`). */
  env?: Record<string, string | undefined>
  /** Whether the terminal's own graphics may be used (kitty, iTerm2, sixel); off, the half-block preview always. */
  graphics?: boolean
  onClose: () => void
}

type Shown = { kind: "lines"; lines: HalfBlockLine[] } | { kind: "external" } | { kind: "error"; text: string }

/**
 * One picture, fetched over the byte channel (or from the cache) and shown: in the terminal's own
 * graphics where it has them (the picture takes the screen until a key is pressed), else as a
 * half-block preview in this panel. Enter, Esc or q closes it.
 */
export function PictureViewer({ connection, picture, theme, locale, names, env = process.env, graphics = true, onClose }: PictureViewerProps) {
  const state = useConnectionState(connection)
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const fetched = state.fetches.get(picture.hash)
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    void connection.fetchMedia(picture.hash, { ...(picture.mime ? { mime: picture.mime } : {}), ...(picture.name ? { name: picture.name } : {}) }).catch(() => undefined)
  }, [picture.hash])

  const ready = fetched?.status === "ready" ? fetched.file : null
  useEffect(() => {
    if (ready === null) return
    let live = true
    const host: RendererLike = graphics
      ? { capabilities: renderer.capabilities, suspend: () => renderer.suspend(), resume: () => renderer.resume() }
      : { capabilities: null }
    // In this panel the preview shares the screen with the log: at most half its height.
    const size = halfBlockPreviewSize(width - 8, Math.floor(height / 2) - 4)
    const inPanel = !graphics || ready.mime === "image/svg+xml" || chooseViewerMode(renderer.capabilities, env) === "modal"
    const path = ready.path
    viewImage({
      payload: { hash: ready.hash, mime: ready.mime, name: ready.name, bytes: ready.bytes },
      renderer: host,
      closeHint: tt(locale, "picture.closeHint"),
      columns: inPanel ? size.width : Math.max(20, width - 4),
      rows: inPanel ? size.height : Math.max(10, height - 4),
      env: graphics ? env : {},
      ...(path ? { openExternally: () => openInSystemViewer(path) } : {}),
    })
      .then((lines) => {
        if (!live) return
        if (lines) setShown({ kind: "lines", lines })
        else if (ready.mime === "image/gif" || ready.mime === "image/webp") setShown({ kind: "external" })
        // The terminal showed it full-screen and a key closed it.
        else onClose()
      })
      .catch(() => {
        if (live) setShown({ kind: "error", text: tt(locale, "picture.noPreview", { mime: stripControlChars(ready.mime) }) })
      })
    return () => {
      live = false
    }
  }, [ready])

  useKeyboard((event: KeyEvent) => {
    const name = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (name === "escape" || name === "return" || name === "enter" || name === "q") onClose()
  })

  const title = stripControlChars(picture.name || ready?.name || picture.hash.slice(0, 12))
  const from = picture.from ? ` · ${tt(locale, "picture.sharedBy", { from: sharerName(picture.from, names, locale) })}` : ""
  return (
    <box flexDirection="column" border borderColor={theme.accent} paddingX={1} backgroundColor={theme.bg} width="100%" flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>
        {tt(locale, "picture.title", { name: title })}
        {from}
      </text>
      {fetched === undefined || fetched.status === "loading" ? <text fg={theme.dim}>{tt(locale, "picture.loading")}</text> : null}
      {fetched?.status === "failed" ? <text fg={theme.fumble}>{fetchFailureText(fetched, locale)}</text> : null}
      {shown?.kind === "lines"
        ? shown.lines.map((line, row) => (
            <text key={row} wrapMode="none">
              {line.cells.map((cell, column) => (
                <span key={column} fg={cell.fg} bg={cell.bg}>
                  {cell.char}
                </span>
              ))}
            </text>
          ))
        : null}
      {shown?.kind === "external" ? <text fg={theme.dim}>{tt(locale, "picture.external")}</text> : null}
      {shown?.kind === "error" ? <text fg={theme.fumble}>{shown.text}</text> : null}
      <text fg={theme.dim} wrapMode="none" truncate>
        {tt(locale, "picture.help")}
      </text>
    </box>
  )
}
