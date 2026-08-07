import { useEffect, useState } from "react"
import type { MediaRef } from "loreweaver-protocol"
import type { AppClient } from "../client"
import { getCachedMedia, halfBlockPreviewSize, renderHalfBlockPreview, type HalfBlockLine } from "../media"

// One shared "fetch by hash, decode, draw as half-blocks" implementation. Both the
// media log entries and the `image` UI blocks (protocol 2.1) are the SAME affordance
// from a viewer's side — a picture the room already holds, addressed by hash — so they
// share the fetch/verify/cache path rather than growing a second one that drifts.

// Animated and lossy-container formats have no terminal decoder here; they degrade to
// their caption line instead of a broken preview.
const UNPREVIEWABLE: ReadonlySet<string> = new Set(["image/gif", "image/webp"])

export interface MediaPreviewState {
  lines?: HalfBlockLine[]
  failed: boolean
}

/** Fetch + decode `media` into terminal half-block rows. `undefined` lines mean
 * "still loading, or nothing to draw"; `failed` means the fetch/decode gave up (the
 * caller shows its placeholder line instead). A cancelled effect never sets state. */
export function useMediaPreview(
  media: Pick<MediaRef, "hash" | "mime"> | undefined,
  client?: AppClient,
  width = 56,
  height = 28,
): MediaPreviewState {
  const [lines, setLines] = useState<HalfBlockLine[] | undefined>()
  const [failed, setFailed] = useState(false)
  const hash = media?.hash
  const mime = media?.mime

  useEffect(() => {
    let cancelled = false
    setLines(undefined)
    setFailed(false)
    if (!client || !hash || !mime || UNPREVIEWABLE.has(mime)) return
    void getCachedMedia(client, { hash, mime, size: 0 })
      .then((payload) => {
        const size = halfBlockPreviewSize(width, height)
        return renderHalfBlockPreview(payload.bytes, payload.mime, size.width, size.height)
      })
      .then((preview) => {
        if (!cancelled) setLines(preview)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, hash, mime, width, height])

  return { lines, failed }
}

/** The decoded rows as colored terminal cells. */
export function MediaPreviewRows({ lines, keyPrefix }: { lines: HalfBlockLine[]; keyPrefix: string }) {
  return (
    <>
      {lines.map((line, row) => (
        <box key={`${keyPrefix}-${row}`} flexDirection="row">
          {line.cells.map((cell, col) => (
            <text key={`${keyPrefix}-${row}-${col}`} fg={cell.fg} bg={cell.bg}>
              {cell.char}
            </text>
          ))}
        </box>
      ))}
    </>
  )
}
