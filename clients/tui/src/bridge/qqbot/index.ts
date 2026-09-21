// Delivery layer (WS2): anchors, buckets, coalescer, deferred queue, deliverer, port, render.
export {
  AnchorRegistry,
  C2C_BUDGET,
  C2C_WINDOW_MS,
  DEFAULT_SEND_TIMEOUT_MS,
  GROUP_BUDGET,
  GROUP_WINDOW_MS,
  MIN_MARGIN_MS,
  anchorsPath,
  budgetMaxFor,
  computeExpiresAt,
  isAnchorOpen,
  windowMs,
} from "./anchors"
export type { Anchor, AnchorScope, AnchorState, QuotaSnapshot } from "./anchors"

export { ActiveQuota, BOT_QPM_DEFAULT, C2C_DAILY, C2C_QPM, DailyCap, GROUP_DAILY, GROUP_QPM, TokenBucket, utcDayKey } from "./buckets"

export { Coalescer, WINDOW_MS } from "./coalescer"
export type { CoalescedWindow } from "./coalescer"

export {
  DEFERRED_CAP,
  DEFERRED_TTL_MS,
  DROPPED_NOTICE_EVERY_MS,
  LATE_FLUSH_MAX,
  PLAYER_HOLD_TTL_MS,
  PRIVATE_HELD_EVERY_MS,
  DeferredStore,
  deferredPath,
  mediaFromRef,
  nextDeferredId,
} from "./deferred"
export type { DeferredItem, DeferredMedia, DeferredState } from "./deferred"

export { QQBotDeliverer } from "./deliverer"
export type { PendingReview, QQBotDelivererOptions, QQBotMediaSource } from "./deliverer"

export { isSendOk, numericCode } from "./port"
export type {
  QQBotMarkdown,
  QQBotMediaUpload,
  QQBotMsgType,
  QQBotSendFail,
  QQBotSendFailCode,
  QQBotSendOk,
  QQBotSendPort,
  QQBotSendRequest,
  QQBotSendResult,
  QQBotSwitchEvent,
} from "./port"

export {
  QQBOT_CHUNK_CHARS,
  atUserTag,
  cutMarkdown,
  hostAllowed,
  isQueuedInputNotice,
  recutHalf,
  renderFrame,
  renderNpcMarkdown,
  replaceUrls,
  toPlain,
  urlPlaceholder,
} from "./render"
export type { RenderedQqFrame } from "./render"

// Transport layer (WS1): gateway/REST transport, events, shared helpers, constants.
// The transport's request/result types are exported under Transport* names: the port
// layer above speaks the snake_case wire shape, the transport a camelCase one (WS4 adapts).
export {
  QQBotTransport,
  buildSendBody,
  mapSendPlatformCode,
  sessionPolicyForClose,
} from "./transport"
export type {
  EventHandler,
  QQBotFetchImpl,
  QQBotFetchInit,
  QQBotFetchResponse,
  QQBotLoginInfo,
  QQBotSendRequest as QQBotTransportSendRequest,
  QQBotSendResult as QQBotTransportSendResult,
  QQBotStatus,
  QQBotTransportOptions,
  QQBotUploadRequest,
  QQBotUploadResult,
  QQBotWsFactory,
  StatusHandler,
} from "./transport"

export {
  RecentEventWindow,
  ingestDispatch,
  parseDispatch,
  parseGatewayPayload,
  trimLeadingAtSpace,
} from "./events"
export type {
  GatewayPayload,
  QQBotAttachment,
  QQBotEvent,
  QQBotFriendEvent,
  QQBotGroupRobotEvent,
  QQBotMessageEvent,
} from "./events"

export {
  QQBotApiError,
  containsSecret,
  nextBackoffMs,
  parseExpiresIn,
  tokenRefreshDelayMs,
  uploadPartTimeoutMs,
} from "./shared"
export type { QQBotClock } from "./shared"

export {
  CLOSE_NEW_SESSION,
  CLOSE_TOKEN_INVALID,
  DEFAULT_API_BASE,
  DEFAULT_AUTH_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FILE_TYPE,
  GATEWAY_OP,
  GROUP_AND_C2C_EVENT,
  MD5_10M_BYTES,
  MIN_REQUEST_TIMEOUT_MS,
  RECENT_EVENT_LIMIT,
  RECONNECT_BACKOFF_CAP_MS,
  RECONNECT_BACKOFF_MS,
  TOKEN_OVERLAP_WINDOW_S,
  TOKEN_REFRESH_FLOOR_MS,
  TOKEN_REFRESH_MARGIN_S,
} from "./constants"
