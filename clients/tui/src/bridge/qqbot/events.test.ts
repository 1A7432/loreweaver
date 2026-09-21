import { describe, expect, test } from "bun:test"
import { GROUP_AND_C2C_EVENT, RECENT_EVENT_LIMIT } from "./constants"
import {
  ingestDispatch,
  parseDispatch,
  parseGatewayPayload,
  RecentEventWindow,
  trimLeadingAtSpace,
} from "./events"
import {
  c2cMessageCreate,
  dispatch,
  friendAdd,
  groupAddRobot,
  groupAtMessageCreate,
  groupAtMessageWithImage,
  groupMsgReceive,
} from "./testing/fixtures"

describe("trimLeadingAtSpace", () => {
  test("strips the leading space the platform leaves after removing @, keeps the rest", () => {
    expect(trimLeadingAtSpace(" /今日天气 ")).toBe("/今日天气 ")
    expect(trimLeadingAtSpace("\t.ra 侦查")).toBe(".ra 侦查")
    expect(trimLeadingAtSpace("hello")).toBe("hello")
  })
})

describe("parseDispatch — official autogen shapes", () => {
  test("GROUP_AT_MESSAGE_CREATE maps openids, trims the leading space, and keeps attachments", () => {
    const event = parseDispatch(
      parseGatewayPayload(dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate(), { id: "evt-1", s: 4 }))!,
      false,
    )
    expect(event).toMatchObject({
      type: "groupAtMessage",
      id: groupAtMessageCreate().id,
      eventId: "evt-1",
      groupOpenid: "B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5",
      memberOpenid: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
      username: "小明",
      content: "/今日天气 ",
    })
    const withImage = parseDispatch(
      parseGatewayPayload(dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageWithImage(), { id: "evt-2" }))!,
      false,
    )
    expect(withImage?.type).toBe("groupAtMessage")
    if (withImage && withImage.type === "groupAtMessage") {
      expect(withImage.content).toBe("看看这张风景照 ")
      expect(withImage.attachments[0]).toEqual({
        url: "https://multimedia.nt.qq.com.cn/download?appid=xxx&fileid=xxx&rkey=xxx&spec=0",
        contentType: "image/jpeg",
        filename: "photo.jpg",
        size: 256000,
        width: 1920,
        height: 1080,
      })
    }
  })

  test("GROUP_MESSAGE_CREATE is dropped unless receiveAll, C2C and robot/friend events parse", () => {
    const payload = parseGatewayPayload(dispatch("GROUP_MESSAGE_CREATE", groupAtMessageCreate(), { id: "evt-g" }))!
    expect(parseDispatch(payload, false)).toBeNull()
    expect(parseDispatch(payload, true)?.type).toBe("groupMessage")

    const c2c = parseDispatch(
      parseGatewayPayload(dispatch("C2C_MESSAGE_CREATE", c2cMessageCreate(), { id: "evt-c" }))!,
      false,
    )
    expect(c2c).toMatchObject({
      type: "c2cMessage",
      userOpenid: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
      content: "你好，今天有什么推荐的活动吗？",
    })

    const added = parseDispatch(
      parseGatewayPayload(dispatch("GROUP_ADD_ROBOT", groupAddRobot(), { id: "evt-add" }))!,
      false,
    )
    expect(added).toMatchObject({
      type: "groupAddRobot",
      groupOpenid: "B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5",
      opMemberOpenid: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4",
      timestamp: "1784570534",
      eventId: "evt-add",
    })

    const receive = parseDispatch(
      parseGatewayPayload(dispatch("GROUP_MSG_RECEIVE", groupMsgReceive(), { id: "evt-on" }))!,
      false,
    )
    expect(receive?.type).toBe("groupMsgReceive")

    const friend = parseDispatch(parseGatewayPayload(dispatch("FRIEND_ADD", friendAdd(), { id: "evt-f" }))!, false)
    expect(friend).toMatchObject({ type: "friendAdd", userOpenid: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4" })
  })

  test("READY / RESUMED / unknown types are not events", () => {
    expect(parseDispatch(parseGatewayPayload({ op: 0, t: "READY", d: {}, s: 1 })!, false)).toBeNull()
    expect(parseDispatch(parseGatewayPayload({ op: 0, t: "RESUMED", d: {}, s: 2 })!, false)).toBeNull()
    expect(parseDispatch(parseGatewayPayload({ op: 0, t: "GUILD_CREATE", d: { id: "x" }, s: 3 })!, false)).toBeNull()
    expect(GROUP_AND_C2C_EVENT).toBe(1 << 25)
  })
})

describe("RecentEventWindow — message d.id vs dispatch id", () => {
  test("message events dedupe by d.id; other events by the dispatch payload id; bound 2048", () => {
    const window = new RecentEventWindow()
    const msg = parseGatewayPayload(
      dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate({ id: "msg-1" }), { id: "evt-1" }),
    )!
    expect(ingestDispatch(msg, window, false)?.id).toBe("msg-1")
    expect(ingestDispatch(msg, window, false)).toBeNull()
    expect(
      ingestDispatch(
        parseGatewayPayload(dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate({ id: "msg-2" }), { id: "evt-1" }))!,
        window,
        false,
      )?.id,
    ).toBe("msg-2")

    const robot = parseGatewayPayload(dispatch("GROUP_ADD_ROBOT", groupAddRobot(), { id: "robot-1" }))!
    expect(ingestDispatch(robot, window, false)?.type).toBe("groupAddRobot")
    expect(ingestDispatch(robot, window, false)).toBeNull()
    expect(
      ingestDispatch(
        parseGatewayPayload(dispatch("GROUP_DEL_ROBOT", groupAddRobot(), { id: "robot-2" }))!,
        window,
        false,
      )?.type,
    ).toBe("groupDelRobot")

    const bounded = new RecentEventWindow(4)
    for (let i = 0; i < 6; i += 1) {
      ingestDispatch(
        parseGatewayPayload(dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate({ id: `m-${i}` }), { id: `e-${i}` }))!,
        bounded,
        false,
      )
    }
    expect(bounded.size).toBe(4)
    expect(RECENT_EVENT_LIMIT).toBe(2048)
  })

  test("with receiveAll, groupAtMessage wins over a same-id groupMessage in either arrival order", () => {
    const atFirst = new RecentEventWindow()
    const at = parseGatewayPayload(
      dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate({ id: "shared" }), { id: "e-at" }),
    )!
    const plain = parseGatewayPayload(
      dispatch("GROUP_MESSAGE_CREATE", groupAtMessageCreate({ id: "shared" }), { id: "e-plain" }),
    )!
    expect(ingestDispatch(at, atFirst, true)?.type).toBe("groupAtMessage")
    expect(ingestDispatch(plain, atFirst, true)).toBeNull()

    const plainFirst = new RecentEventWindow()
    expect(ingestDispatch(plain, plainFirst, true)?.type).toBe("groupMessage")
    expect(ingestDispatch(at, plainFirst, true)?.type).toBe("groupAtMessage")
    expect(ingestDispatch(at, plainFirst, true)).toBeNull()
  })
})
