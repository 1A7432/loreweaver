/** OneBot 11 practical text cap (NapCat / LLOneBot; Lagrange's OneBot 11 build is sunset). */
export const MAX_TEXT_CHARS = 4000
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_RECONNECT_DELAY_MS = 1_000
export const DEFAULT_REVERSE_PATH = "/onebot/v11/ws"
export const RECENT_MESSAGE_LIMIT = 2048
export const EVENT_QUEUE_LIMIT = 256
/** Raised above the python-websockets 1 MiB default so a base64 image frame can land. */
export const MAX_WEBSOCKET_FRAME_BYTES = 4 * Math.floor((MAX_ATTACHMENT_BYTES + 2) / 3) + 1024 * 1024
export const MAX_ATTACHMENT_REDIRECTS = 5
/** Watchdog grace as a multiple of the heartbeat `interval` the implementation announces. */
export const HEARTBEAT_GRACE_FACTOR = 2.5
