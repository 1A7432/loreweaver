import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FrameType, type AudioControlFrame, type MediaPayload, type ServerFrame } from "@loreweaver/protocol"
import { AudioController } from "./audio"
import type { AppClient } from "./client"
import { sha256Hex } from "./media"

class MockClient implements AppClient {
  constructor(private readonly payload: MediaPayload) {}
  connect(): Promise<void> {
    return Promise.resolve()
  }
  join(): void {}
  sendInput(): void {}
  uploadMedia(): Promise<undefined> {
    return Promise.resolve(undefined)
  }
  getMedia(): Promise<MediaPayload> {
    return Promise.resolve(this.payload)
  }
  setMediaEnabled(): void {}
  onMessage(_cb: (frame: ServerFrame) => void): () => void {
    return () => {}
  }
  adminGetConfig(): void {}
  adminSetModel(): void {}
  adminListModels(): void {}
  adminListKeys(): void {}
  adminMintKey(): void {}
  adminUpdateKey(): void {}
  adminDeleteKey(): void {}
  adminDeleteRoom(): void {}
  adminExportRoom(): void {}
  adminImportRoom(): void {}
  adminDeleteRoomData(): void {}
  adminResetRoom(): void {}
  adminListSkills(): void {}
  adminEnableSkill(): void {}
  adminListRules(): void {}
  adminGenerate(): void {}
}

describe("AudioController", () => {
  test("spawns mpv for a bgm play control and stops the previous layer", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const hash = sha256Hex(bytes)
    const client = new MockClient({ hash, mime: "audio/mpeg", name: "theme.mp3", bytes })
    const spawned: Array<{ command: string; args: string[]; killed: boolean }> = []
    const dir = await mkdtemp(join(tmpdir(), "lw-audio-controller-"))
    const controller = new AudioController({
      cacheDir: dir,
      which: (command) => Promise.resolve(command === "mpv"),
      spawn: (command, args) => {
        const child = { command, args, killed: false }
        spawned.push(child)
        return {
          kill: () => {
            child.killed = true
            return true
          },
          unref: () => {},
        }
      },
    })
    const frame: AudioControlFrame = {
      type: FrameType.AudioControl,
      id: "a1",
      action: "play",
      layer: "bgm",
      hash,
      mime: "audio/mpeg",
      name: "theme.mp3",
      loop: true,
      volume: 0.7,
    }

    await controller.handle(frame, client)
    await controller.handle({ ...frame, id: "a2", volume: 0.4 }, client)

    expect(spawned).toHaveLength(2)
    expect(spawned[0].command).toBe("mpv")
    expect(spawned[0].args).toContain("--no-video")
    expect(spawned[0].args).toContain("--loop-file=inf")
    expect(spawned[0].args).toContain("--volume=70")
    expect(spawned[0].killed).toBe(true)
    expect(spawned[1].args).toContain("--volume=40")
  })
})
