import { describe, expect, test } from "bun:test"
import { ingestEvent, parseOneBotEvent, RecentMessageWindow } from "./events"

function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: 1,
    self_id: 42,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 10,
    group_id: 99,
    user_id: 7,
    message: [{ type: "text", data: { text: "hello" } }],
    sender: { nickname: "Ada", card: "Investigator" },
    ...overrides,
  }
}

describe("parseOneBotEvent — array segments", () => {
  test("maps mentions, sender, reply-to, and attachments", () => {
    const encodedAudio = Buffer.from("ogg").toString("base64")
    const event = groupEvent({
      message: [
        { type: "reply", data: { id: "9" } },
        { type: "at", data: { qq: "42" } },
        { type: "text", data: { text: "  /roll 1d20 " } },
        { type: "at", data: { qq: "88" } },
        { type: "text", data: { text: " now" } },
        {
          type: "image",
          data: { file: "map.png", url: "https://cdn.example/map.png", file_size: "12" },
        },
        { type: "record", data: { file: `base64://${encodedAudio}` } },
      ],
    })

    const inbound = parseOneBotEvent(event)
    expect(inbound).not.toBeNull()
    expect(inbound!.chatType).toBe("group")
    expect(inbound!.chatId).toBe("99")
    expect(inbound!.groupId).toBe("99")
    expect(inbound!.sender.userId).toBe("7")
    expect(inbound!.sender.name).toBe("Investigator")
    expect(inbound!.messageId).toBe("10")
    expect(inbound!.replyToId).toBe("9")
    expect(inbound!.text).toBe("/roll 1d20 @88 now")
    expect(inbound!.atSelf).toBe(true)
    expect(inbound!.raw).toBe(event)
    expect(inbound!.attachments[0]).toEqual({
      id: "map.png",
      name: "map.png",
      mime: "image/png",
      size: 12,
      url: "https://cdn.example/map.png",
    })
    expect(inbound!.attachments[1]!.mime).toBe("audio/ogg")
    expect(Buffer.from(inbound!.attachments[1]!.data!).toString()).toBe("ogg")
  })

  test("exact @-self detection does not treat another qq as the bot", () => {
    const inbound = parseOneBotEvent(
      groupEvent({
        message: [
          { type: "at", data: { qq: "99" } },
          { type: "text", data: { text: " hello" } },
        ],
      }),
    )
    expect(inbound!.atSelf).toBe(false)
    expect(inbound!.text).toBe("@99 hello")
  })

  test("@全体成员 is dropped from the text, and NapCat's file name beats its download URL", () => {
    // Shapes from NapCat api/msg.ts: textElement → {type:"at",data:{qq:"all"}};
    // picElement → {file:"<md5>.jpg", url:"https://multimedia.nt.qq.com.cn/download?…", file_size, sub_type}.
    const inbound = parseOneBotEvent(
      groupEvent({
        message: [
          { type: "at", data: { qq: "all" } },
          { type: "text", data: { text: " 开团了" } },
          {
            type: "image",
            data: {
              summary: "",
              file: "A1B2C3D4E5F6.jpg",
              sub_type: 0,
              url: "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=xyz",
              file_size: "34567",
            },
          },
        ],
      }),
    )
    expect(inbound!.text).toBe("开团了")
    expect(inbound!.atSelf).toBe(false)
    expect(inbound!.attachments[0]!.name).toBe("A1B2C3D4E5F6.jpg")
    expect(inbound!.attachments[0]!.mime).toBe("image/jpeg")
    expect(inbound!.attachments[0]!.size).toBe(34567)
    expect(inbound!.attachments[0]!.url).toBe("https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=xyz")
  })
})

describe("parseOneBotEvent — CQ strings", () => {
  test("unescapes CQ text and dispatches a private event", () => {
    const event = {
      self_id: 42,
      post_type: "message",
      message_type: "private",
      message_id: 11,
      user_id: 8,
      message: "[CQ:at,qq=42]  .help&#91;x&#93;&amp;[CQ:image,file=https://cdn.example/a.jpg]",
      sender: { nickname: "Lin" },
    }
    const inbound = parseOneBotEvent(event)
    expect(inbound).not.toBeNull()
    expect(inbound!.chatType).toBe("private")
    expect(inbound!.chatId).toBe("8")
    expect(inbound!.text).toBe(".help[x]&")
    expect(inbound!.atSelf).toBe(true)
    expect(inbound!.attachments[0]!.url).toBe("https://cdn.example/a.jpg")
    expect(inbound!.sender.name).toBe("Lin")
  })

  test("CQ reply segment becomes replyToId", () => {
    const inbound = parseOneBotEvent(
      groupEvent({
        message: "[CQ:reply,id=321][CQ:at,qq=42] yes",
      }),
    )
    expect(inbound!.replyToId).toBe("321")
    expect(inbound!.atSelf).toBe(true)
    expect(inbound!.text).toBe("yes")
  })
})

describe("parseOneBotEvent — own-message and empty filtering", () => {
  test("rejects the bot's own messages, message_sent, meta events, and empty faces", () => {
    expect(parseOneBotEvent(groupEvent({ self_id: 42, user_id: 42 }))).toBeNull()
    expect(parseOneBotEvent(groupEvent({ post_type: "message_sent" }))).toBeNull()
    expect(parseOneBotEvent({ post_type: "meta_event", meta_event_type: "heartbeat" })).toBeNull()
    expect(parseOneBotEvent(groupEvent({ message: [{ type: "face", data: { id: "1" } }] }))).toBeNull()
  })
})

describe("RecentMessageWindow — bounded (self_id, chat_type, chat_id, message_id) dedupe", () => {
  test("dispatches a duplicate message id once, but does not collapse distinct chats or missing ids", () => {
    const window = new RecentMessageWindow()
    const event = groupEvent({ message_id: 25 })
    expect(ingestEvent(event, window)?.text).toBe("hello")
    expect(ingestEvent({ ...event }, window)).toBeNull()
    expect(ingestEvent({ ...event, self_id: 43 }, window)?.text).toBe("hello")
    expect(ingestEvent(groupEvent({ message_id: 25, group_id: 100 }), window)?.text).toBe("hello")

    const withoutId = { ...event }
    delete withoutId.message_id
    expect(ingestEvent(withoutId, window)?.text).toBe("hello")
    expect(ingestEvent({ ...withoutId }, window)?.text).toBe("hello")
  })

  test("a private chat reusing a group message id is not collapsed", () => {
    const window = new RecentMessageWindow()
    expect(ingestEvent(groupEvent({ message_id: 7, group_id: 99 }), window)).not.toBeNull()
    expect(
      ingestEvent(
        {
          self_id: 42,
          post_type: "message",
          message_type: "private",
          message_id: 7,
          user_id: 7,
          message: "hello",
          sender: { nickname: "Ada" },
        },
        window,
      ),
    ).not.toBeNull()
  })
})
