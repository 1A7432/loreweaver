/**
 * Payload shapes copied from the official autogen pages (fetched 2026-09-20 / 2026-09-21),
 * not from the 2024 botpy snapshot. Used by the fakes and by tests.
 */

export const SAMPLE_GROUP_OPENID = "B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5"
export const SAMPLE_MEMBER_OPENID = "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4"
export const SAMPLE_USER_OPENID = "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4"
export const SAMPLE_MSG_ID = "ROBOT1.0_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export const SAMPLE_FILE_INFO = "AE86C5D3F0E14B238C656C0F6DD1D0479C"

/** GROUP_AT_MESSAGE_CREATE d — autogen event page example 1. */
export function groupAtMessageCreate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SAMPLE_MSG_ID,
    author: {
      id: SAMPLE_MEMBER_OPENID,
      member_openid: SAMPLE_MEMBER_OPENID,
      member_role: "member",
      username: "小明",
      bot: false,
    },
    content: " /今日天气 ",
    group_openid: SAMPLE_GROUP_OPENID,
    message_type: 0,
    timestamp: "2026-07-21T10:00:00+08:00",
    message_scene: {
      source: "default",
      ext: ["msg_idx=REFIDX_xxxxxxxxxxxxxxx==", "auth_token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    },
    ...overrides,
  }
}

/** GROUP_AT_MESSAGE_CREATE d — autogen event page example 2 (attachment). */
export function groupAtMessageWithImage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return groupAtMessageCreate({
    id: "ROBOT1.0_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
    author: {
      id: "C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6",
      member_openid: "C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6",
      member_role: "member",
      username: "小红",
      bot: false,
    },
    content: " 看看这张风景照 ",
    timestamp: "2026-07-21T10:05:00+08:00",
    attachments: [
      {
        content_type: "image/jpeg",
        filename: "photo.jpg",
        url: "https://multimedia.nt.qq.com.cn/download?appid=xxx&fileid=xxx&rkey=xxx&spec=0",
        width: 1920,
        height: 1080,
        size: 256000,
      },
    ],
    ...overrides,
  })
}

/** C2C_MESSAGE_CREATE d — autogen event page example 1. */
export function c2cMessageCreate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SAMPLE_MSG_ID,
    author: {
      id: SAMPLE_USER_OPENID,
      user_openid: SAMPLE_USER_OPENID,
      union_openid: "",
      username: "",
      bot: false,
    },
    content: "你好，今天有什么推荐的活动吗？",
    message_type: 0,
    message_scene: { source: "default", ext: ["msg_idx=REFIDX_xxxxxxxxxxxxxxx=="] },
    timestamp: "2026-07-21T10:00:00+08:00",
    ...overrides,
  }
}

/** GROUP_ADD_ROBOT d — autogen event page. timestamp is Unix seconds. */
export function groupAddRobot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group_openid: SAMPLE_GROUP_OPENID,
    op_member_openid: SAMPLE_MEMBER_OPENID,
    timestamp: 1784570534,
    ...overrides,
  }
}

export function groupMsgReceive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return groupAddRobot(overrides)
}

export function friendAdd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openid: SAMPLE_USER_OPENID,
    timestamp: 1784570534,
    ...overrides,
  }
}

/** READY d — official websocket.html. */
export function readyEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    session_id: "082ee18c-0be3-491b-9d8b-fbd95c51673a",
    user: {
      id: "6158788878435714165",
      username: "群pro测试机器人",
      bot: true,
    },
    shard: [0, 1],
    ...overrides,
  }
}

/** Successful send — autogen POST .../messages response example. */
export function sendSuccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ROBOT1.0_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    timestamp: "2026-07-21T10:00:00+08:00",
    ext_info: { ref_idx: "REFIDX_xxxxxxxxxxxxxxx==" },
    ...overrides,
  }
}

/** Successful /files — autogen response example. */
export function filesSuccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file_uuid: "uuid_a1b2c3d4e5f6",
    file_info: SAMPLE_FILE_INFO,
    ttl: 300,
    ...overrides,
  }
}

/** upload_prepare success — autogen 3-part example (block_size is a string). */
export function uploadPrepareSuccess(
  baseUrl: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    upload_id: "upload_a1b2c3d4e5f6",
    block_size: "10485760",
    parts: [
      {
        index: 0,
        presigned_url: `${baseUrl}/upload/part/0`,
        block_size: "10485760",
      },
      {
        index: 1,
        presigned_url: `${baseUrl}/upload/part/1`,
        block_size: "10485760",
      },
      {
        index: 2,
        presigned_url: `${baseUrl}/upload/part/2`,
        block_size: "10485760",
      },
    ],
    upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
    ...overrides,
  }
}

export function dispatch(t: string, d: unknown, opts: { s?: number; id?: string } = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = { op: 0, t, d, s: opts.s ?? 1 }
  if (opts.id !== undefined) payload.id = opts.id
  return payload
}

export function hello(heartbeatIntervalMs = 40_000): Record<string, unknown> {
  return { op: 10, d: { heartbeat_interval: heartbeatIntervalMs } }
}

export function heartbeatAck(): Record<string, unknown> {
  return { op: 11, d: null }
}
