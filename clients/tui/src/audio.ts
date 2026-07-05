import { access, mkdir, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  FrameType,
  type AudioControlFrame,
  type AudioLayer,
  type AudioLibraryItemFrame,
  type AudioStateFrame,
  type MediaRef,
} from "@loreweaver/protocol"
import type { AppClient } from "./client"
import { extensionForMime, sha256Hex } from "./media"

type SpawnFn = (command: string, args: string[], options: { detached?: boolean; stdio?: "ignore" }) => PlayerProcess
type WhichFn = (command: string) => Promise<boolean>

interface PlayerProcess {
  kill(signal?: NodeJS.Signals | number): boolean
  unref?(): void
}

export interface AudioControllerOptions {
  spawn?: SpawnFn
  which?: WhichFn
  platform?: NodeJS.Platform
  cacheDir?: string
}

const STATEFUL_LAYERS: AudioLayer[] = ["bgm", "ambience"]

export class AudioController {
  private readonly spawn: SpawnFn
  private readonly which: WhichFn
  private readonly platform: NodeJS.Platform
  private readonly cacheDir: string
  private readonly layers = new Map<AudioLayer, PlayerProcess>()
  private readonly library = new Map<string, AudioLibraryItemFrame>()

  constructor(options: AudioControllerOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn
    this.which = options.which ?? defaultWhich
    this.platform = options.platform ?? process.platform
    this.cacheDir = options.cacheDir ?? join(tmpdir(), "loreweaver-audio")
  }

  async handle(frame: AudioControlFrame | AudioLibraryItemFrame | AudioStateFrame, client: AppClient): Promise<void> {
    if (frame.type === FrameType.AudioLibraryItem) {
      this.library.set(frame.hash, frame)
      return
    }
    if (frame.type === FrameType.AudioState) {
      for (const layer of frame.layers) {
        if (layer.playing && layer.hash && layer.mime) {
          await this.handleControl(
            {
              type: FrameType.AudioControl,
              id: `state-${layer.layer}-${layer.hash}`,
              action: "play",
              layer: layer.layer,
              hash: layer.hash,
              mime: layer.mime,
              name: layer.name,
              title: layer.title,
              volume: layer.volume,
              loop: layer.loop,
            },
            client,
          )
        } else if (layer.layer !== "sfx") {
          this.stopLayer(layer.layer)
        }
      }
      return
    }
    await this.handleControl(frame, client)
  }

  stopAll(): void {
    for (const layer of STATEFUL_LAYERS) this.stopLayer(layer)
  }

  private async handleControl(frame: AudioControlFrame, client: AppClient): Promise<void> {
    if (frame.action === "stop" || frame.action === "pause") {
      this.stopLayer(frame.layer)
      return
    }
    if (frame.action === "volume") {
      return
    }
    if (frame.action !== "play" || !frame.hash || !frame.mime) {
      return
    }

    const media: MediaRef = {
      hash: frame.hash,
      mime: frame.mime,
      size: 0,
      name: frame.name ?? frame.title ?? frame.hash,
    }
    const payload = await client.getMedia(media.hash)
    if (sha256Hex(payload.bytes) !== media.hash) throw new Error("media checksum mismatch")
    const path = join(this.cacheDir, `${payload.hash}${extensionForMime(payload.mime)}`)
    await mkdir(this.cacheDir, { recursive: true })
    await writeFile(path, payload.bytes)
    const player = await this.playerCommand(path, frame)
    if (!player) return
    if (frame.layer !== "sfx") this.stopLayer(frame.layer)
    const child = this.spawn(player.command, player.args, { detached: true, stdio: "ignore" })
    child.unref?.()
    if (frame.layer !== "sfx") this.layers.set(frame.layer, child)
  }

  private stopLayer(layer: AudioLayer): void {
    const child = this.layers.get(layer)
    if (!child) return
    child.kill()
    this.layers.delete(layer)
  }

  private async playerCommand(path: string, frame: AudioControlFrame): Promise<{ command: string; args: string[] } | undefined> {
    const volume = Math.round(Math.max(0, Math.min(1, frame.volume ?? 1)) * 100)
    if (await this.which("mpv")) {
      const args = ["--no-video", `--volume=${volume}`]
      if (frame.loop) args.push("--loop-file=inf")
      args.push(path)
      return { command: "mpv", args }
    }
    if (this.platform === "darwin" && (await this.which("afplay"))) {
      return { command: "afplay", args: [path] }
    }
    if (this.platform === "win32") {
      return { command: "cmd", args: ["/c", "start", "", path] }
    }
    if (await this.which("xdg-open")) {
      return { command: "xdg-open", args: [path] }
    }
    return undefined
  }
}

function defaultSpawn(command: string, args: string[], options: { detached?: boolean; stdio?: "ignore" }): PlayerProcess {
  return nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams
}

async function defaultWhich(command: string): Promise<boolean> {
  const paths = String(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")
  for (const dir of paths) {
    if (!dir) continue
    try {
      await access(join(dir, command), constants.X_OK)
      return true
    } catch {
      // keep searching
    }
  }
  return false
}
