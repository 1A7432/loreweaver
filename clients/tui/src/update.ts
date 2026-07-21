// `loreweaver update` — self-update the client and, by default, the server too.
//
// The client half re-runs the published install script (the same one-liner from the
// README). The server half reuses the ordinary keeper connection: connect + join with a
// saved invite key, and if the server advertises the "update" feature (operator opted in
// AND we are a keeper), send `admin_update_server` and wait for its reply. The server then
// runs its OWN configured command and re-execs — we never hand it anything to run.
import { FrameType, type ServerFrame } from "@loreweaver/protocol"
import type { AppClient } from "./client"

const INSTALL_SH = "https://github.com/1A7432/loreweaver/releases/latest/download/install.sh"
const INSTALL_PS1 = "https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1"

export type ServerUpdateOutcome = "restarting" | "failed" | "unsupported" | "no-server" | "error"

/** The shell command that reinstalls the latest client for this platform. */
export function clientUpdateCommand(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    return ["powershell", "-NoProfile", "-Command", `irm ${INSTALL_PS1} | iex`]
  }
  return ["bash", "-c", `curl -fsSL ${INSTALL_SH} | bash`]
}

/**
 * Connect with a keeper key and ask the server to self-update. Resolves with the outcome:
 * "restarting"/"failed" mirror the server's `admin_update` reply; "unsupported" means the
 * server didn't advertise the update feature (not configured, or we aren't a keeper);
 * "error" is a connect/timeout failure. Never rejects.
 */
export async function triggerServerUpdate(
  client: AppClient,
  host: string,
  key: string,
  name: string | undefined,
  timeoutMs = 60000,
): Promise<ServerUpdateOutcome> {
  return new Promise<ServerUpdateOutcome>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: ServerUpdateOutcome) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        client.close?.()
      } catch {
        /* closing a half-open transport is best-effort */
      }
      resolve(outcome)
    }
    timer = setTimeout(() => finish("error"), timeoutMs)
    client.onMessage((frame: ServerFrame) => {
      if (frame.type === FrameType.Welcome) {
        if ((frame.features ?? []).includes("update")) client.adminUpdateServer()
        else finish("unsupported")
      } else if (frame.type === FrameType.AdminUpdate) {
        finish(frame.status)
      } else if (frame.type === FrameType.AdminError) {
        finish("failed")
      }
    })
    client
      .connect(host)
      .then(() => client.join(key, name))
      .catch(() => finish("error"))
  })
}
