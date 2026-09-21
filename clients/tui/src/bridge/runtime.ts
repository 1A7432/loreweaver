import type { ClientFrame, ServerFrame } from "loreweaver-protocol"
import { OneBotAPIError, OneBotError } from "./onebot"

const CONTROL_QUEUE_CAP = 64
const URL_SAFE_TOKEN = /[A-Za-z0-9_-]{16,}/

/**
 * Mask keeper keys and QQ Bot secrets in host-bootstrap / status logs.
 * `extraSecrets` are exact values (e.g. `client_secret`) stripped wherever they appear.
 */
export function redactKeeperSecrets(line: string, extraSecrets: readonly string[] = []): string {
  let out = line
    .replace(/\bkey\b\s*[:=]?\s*[A-Za-z0-9_-]{16,}/gi, (match) => match.replace(URL_SAFE_TOKEN, "****"))
    .replace(/密钥\s*[:：]?\s*[A-Za-z0-9_-]{16,}/g, (match) => match.replace(URL_SAFE_TOKEN, "****"))
    .replace(/\bclient_secret\b\s*[:=]?\s*\S+/gi, "client_secret ****")
    .replace(/\bclientSecret\b\s*[:=]?\s*\S+/g, "clientSecret ****")
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("****")
  }
  return out
}

/** Fan-out control surface so a Keyring survives control-link redials. */
export class RelayingControl {
  private link: ControlLinkLike | undefined
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  private readonly queue: ClientFrame[] = []
  private off: (() => void) | undefined

  bind(link: ControlLinkLike): void {
    this.off?.()
    this.link = link
    this.off = link.onMessage((frame) => {
      for (const handler of this.handlers) handler(frame)
    })
    const pending = this.queue.splice(0)
    for (const frame of pending) this.send(frame)
  }

  send(frame: ClientFrame): void {
    if (this.isLive()) {
      this.link!.send(frame)
      return
    }
    this.queue.push(frame)
    while (this.queue.length > CONTROL_QUEUE_CAP) this.queue.shift()
  }

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => {
      this.handlers.delete(cb)
    }
  }

  private isLive(): boolean {
    if (!this.link) return false
    if (this.link.isAlive === false) return false
    return true
  }
}

export type ControlLinkLike = {
  send(frame: ClientFrame): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
  readonly isAlive?: boolean
}

export function isImageAttachment(att: { mime: string; name: string }): boolean {
  if (att.mime.toLowerCase().startsWith("image/")) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name)
}

/** A machine code for the log line — never the error message, which can carry a signed URL. */
export function attachmentFailureReason(err: unknown): string {
  if (err instanceof OneBotAPIError) return `onebot.api.${err.retcode}`
  if (err instanceof OneBotError) return err.code
  if (err instanceof Error) return err.name || "Error"
  return "Error"
}
