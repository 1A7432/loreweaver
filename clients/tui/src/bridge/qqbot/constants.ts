/** Official REST host (live api-use.html "统一地址"); auth and OpenAPI share it. */
export const DEFAULT_API_BASE = "https://api.bot.qq.com"
/** Token endpoint host — spec §5 / official getAppAccessToken. */
export const DEFAULT_AUTH_BASE = "https://api.bot.qq.com"

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** Docs advise HTTP timeout ≥ 5 s; this is the floor we apply when a caller omits it. */
export const MIN_REQUEST_TIMEOUT_MS = 5_000

/** Refresh inside the server's 60 s overlap window, matching adapter-qq. */
export const TOKEN_REFRESH_MARGIN_S = 30
/** Floor on every token-refresh sleep so expires_in ≤ 30 cannot spin. */
export const TOKEN_REFRESH_FLOOR_MS = 30_000
/** Official overlap: a request earlier than this returns the old token. */
export const TOKEN_OVERLAP_WINDOW_S = 60
/** Extra delay after Invalid Session (op 9), on top of reconnect backoff. */
export const INVALID_SESSION_JITTER_MIN_MS = 1_000
export const INVALID_SESSION_JITTER_MAX_MS = 5_000
/** Chunk PUT: 30 s plus 10 s per MiB of that part. */
export const UPLOAD_PART_TIMEOUT_BASE_MS = 30_000
export const UPLOAD_PART_TIMEOUT_PER_MIB_MS = 10_000

export const GROUP_AND_C2C_EVENT = 1 << 25

export const RECENT_EVENT_LIMIT = 2048

export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000] as const
export const RECONNECT_BACKOFF_CAP_MS = 30_000

/** First 10_002_432 bytes (~9.54 MiB) — official md5_10m input. */
export const MD5_10M_BYTES = 10_002_432

/** Default block size when the platform omits it (docs: 5 MiB). */
export const DEFAULT_UPLOAD_BLOCK_SIZE = 5 * 1024 * 1024

export const GATEWAY_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

/** Close 4004: token invalid — refresh then Identify. */
export const CLOSE_TOKEN_INVALID = 4004
/** Close 9001 / 9005: drop session_id + last seq, fresh Identify (botpy). */
export const CLOSE_NEW_SESSION = new Set([9001, 9005])

export const FILE_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  VOICE: 3,
  FILE: 4,
} as const
