import { expect, test } from "bun:test";

import { decodeEventFrame, decodeServerFrame, inspectServerFrame, MAX_BLOCKS, MAX_SHORT_CHARS, MAX_TEXT_CHARS } from "./decode";
import { matchesSchema } from "./schema";
import { ME_VIEW_SCHEMA, PARTY_VIEW_SCHEMA } from "./views";

const welcome = {
  type: "welcome",
  protocol: "3.0",
  server: { name: "loreweaver", version: "3.0.0" },
  room: { id: "table", locale: "en" },
  you: { id: "m1", name: "Ada", role: "player" },
  features: [],
  epoch: 1,
  head: 0,
};

const narrative = { type: "event", seq: 1, id: "e1", ts: 1, kind: "narrative", turn: 1, data: { speaker: "kp", text: "Hi", format: "markdown" } };
const dice = {
  type: "event",
  seq: 2,
  id: "e2",
  ts: 2,
  kind: "dice",
  data: { actor: "Ada", kind: "check", expr: "1d100", rolls: [42], total: 42, target: 50, outcome: { id: "regular", label: "Success", success: true, critical: false, fumble: false, tier: 1 }, detail: { anything: [1] } },
};

test("every known frame decodes, and unknown fields are dropped", () => {
  expect(decodeServerFrame({ ...welcome, extra: 1, you: { ...welcome.you, more: true } })).toEqual(welcome as never);
  expect(decodeServerFrame({ ...narrative, extra: 1, data: { ...narrative.data, mood: "dark" } })).toEqual(narrative as never);
  expect(decodeServerFrame(dice)).toEqual(dice as never);
  const frames = [
    { type: "event", seq: 3, id: "e3", ts: 3, kind: "blocks", data: { blocks: [{ kind: "divider" }, { kind: "meter", label: "HP", value: 3, min: 0, max: 10 }], replace: true } },
    { type: "event", seq: 4, id: "e4", ts: 4, kind: "media", data: { hash: "ab", mime: "image/png", size: 3, name: "a.png", from: "m1" } },
    { type: "event", seq: 5, id: "e5", ts: 5, kind: "rewind", data: { to: 2, epoch: 2 } },
    { type: "event", seq: 6, id: "e6", ts: 6, kind: "reset", data: { scope: "story", epoch: 3 } },
    { type: "signal", kind: "draft", data: { id: "d", text: "par" } },
    { type: "signal", kind: "draft", data: { id: "d", discard: true } },
    { type: "signal", kind: "turn", data: { status: "busy", actor: "Ada", activity: "dice", round: 2 } },
    { type: "signal", kind: "turn", data: { status: "idle" } },
    { type: "signal", kind: "audio", data: { id: "a", action: "play", layer: "bgm", hash: "h", loop: true, volume: 0.5 } },
    { type: "signal", kind: "notice", data: { level: "warn", code: "turn_failed", text: "Oops", spinner: false } },
    { type: "view", name: "me", rev: 1, at: 0, data: null },
    { type: "result", rid: "r1", ok: true },
    { type: "result", rid: "r1", ok: true, data: { x: 1 }, text: "t" },
    { type: "result", rid: "r1", ok: false, error: { code: "nope", message: "No." } },
    { type: "error", code: "bad_key", message: "Bad key.", fatal: true },
    { type: "pong", t: 5 },
  ];
  for (const frame of frames) expect(decodeServerFrame(frame)).toEqual(frame as never);
});

test("an unknown frame type, event kind or signal kind is 'unknown, ignore', never an error", () => {
  expect(inspectServerFrame({ type: "hologram", x: 1 })).toEqual({ kind: "unknown", type: "hologram" });
  expect(inspectServerFrame({ type: "event", seq: 9, id: "e", ts: 1, kind: "smell", data: { odour: 1 } })).toEqual({ kind: "unknown", type: "event", sub: "smell", seq: 9 });
  expect(inspectServerFrame({ type: "signal", kind: "vibrate", data: 7 })).toEqual({ kind: "unknown", type: "signal", sub: "vibrate" });
  expect(decodeServerFrame({ type: "hologram" })).toBeNull();
  // An unknown block kind is skipped; the event stands.
  expect(decodeServerFrame({ type: "event", seq: 3, id: "e", ts: 1, kind: "blocks", data: { blocks: [{ kind: "hologram" }, { kind: "divider" }] } })).toMatchObject({ data: { blocks: [{ kind: "divider" }] } });
  // An unknown activity is presentation only: left out.
  expect(decodeServerFrame({ type: "signal", kind: "turn", data: { status: "busy", actor: "A", activity: "dancing" } })).toEqual({ type: "signal", kind: "turn", data: { status: "busy", actor: "A" } });
});

test("every malformed shape is refused", () => {
  const bad: unknown[] = [
    null,
    42,
    "welcome",
    [welcome],
    {},
    { type: 7 },
    { ...welcome, protocol: 3 },
    { ...welcome, you: { ...welcome.you, role: "keeper" } },
    { ...welcome, features: [1] },
    { ...welcome, epoch: 1.5 },
    { ...welcome, head: -1 },
    { ...welcome, room: null },
    { ...narrative, seq: 0 },
    { ...narrative, seq: "1" },
    { ...narrative, ts: Number.NaN },
    { ...narrative, turn: -1 },
    { ...narrative, data: null },
    { ...narrative, data: { ...narrative.data, speaker: "god" } },
    { ...narrative, data: { ...narrative.data, format: "html" } },
    { ...narrative, data: { ...narrative.data, text: 5 } },
    { ...narrative, data: { ...narrative.data, name: 5 } },
    { ...narrative, data: { ...narrative.data, text: "x".repeat(MAX_TEXT_CHARS + 1) } },
    { ...dice, data: { ...dice.data, kind: "tarot" } },
    { ...dice, data: { ...dice.data, rolls: ["4"] } },
    { ...dice, data: { ...dice.data, total: Number.POSITIVE_INFINITY } },
    { ...dice, data: { ...dice.data, outcome: { id: "x" } } },
    { ...dice, data: { ...dice.data, detail: [] } },
    { type: "event", seq: 3, id: "e", ts: 1, kind: "blocks", data: { blocks: "no" } },
    { type: "event", seq: 3, id: "e", ts: 1, kind: "blocks", data: { blocks: Array.from({ length: MAX_BLOCKS + 1 }, () => ({ kind: "divider" })) } },
    { type: "event", seq: 3, id: "e", ts: 1, kind: "blocks", data: { blocks: [{ kind: "meter", label: "HP" }] } },
    { type: "event", seq: 3, id: "e", ts: 1, kind: "blocks", data: { blocks: [{ kind: "choices", options: [{ id: "a", label: "A" }] }] } },
    { type: "event", seq: 3, id: "e", ts: 1, kind: "blocks", data: { blocks: [], replace: "yes" } },
    { type: "event", seq: 4, id: "e", ts: 1, kind: "media", data: { hash: "", mime: "x", size: 1, name: "n", from: "f" } },
    { type: "event", seq: 4, id: "e", ts: 1, kind: "media", data: { hash: "h", mime: "x", size: -1, name: "n", from: "f" } },
    { type: "event", seq: 5, id: "e", ts: 1, kind: "rewind", data: { to: "2", epoch: 2 } },
    { type: "event", seq: 6, id: "e", ts: 1, kind: "reset", data: { scope: "everything", epoch: 2 } },
    { type: "event", seq: 6, id: "x".repeat(MAX_SHORT_CHARS + 1), ts: 1, kind: "reset", data: { scope: "all", epoch: 2 } },
    { type: "signal", kind: "draft", data: { id: "d" } },
    { type: "signal", kind: "draft", data: { id: "", text: "x" } },
    { type: "signal", kind: "draft", data: { id: "d", discard: false } },
    { type: "signal", kind: "turn", data: { status: "busy" } },
    { type: "signal", kind: "turn", data: { status: "napping" } },
    { type: "signal", kind: "audio", data: { id: "a", action: "scratch", layer: "bgm" } },
    { type: "signal", kind: "audio", data: { id: "a", action: "play", layer: "bgm", volume: "loud" } },
    { type: "signal", kind: "notice", data: { level: "error", text: "x" } },
    { type: "signal", kind: "notice", data: "x" },
    { type: "signal", data: {} },
    { type: "view", name: "me", rev: 1, at: 0 },
    { type: "view", name: "", rev: 1, at: 0, data: 1 },
    { type: "view", name: "me", rev: -1, at: 0, data: 1 },
    { type: "result", ok: true },
    { type: "result", rid: "r", ok: "yes" },
    { type: "result", rid: "r", ok: false },
    { type: "result", rid: "r", ok: false, error: { code: "x" } },
    { type: "result", rid: "r", ok: true, text: 5 },
    { type: "error", code: "x", message: "y" },
    { type: "error", code: "x", message: "y", fatal: "true" },
    { type: "pong" },
    { type: "pong", t: "5" },
  ];
  for (const value of bad) {
    const decoded = inspectServerFrame(value);
    if (decoded.kind !== "malformed") throw new Error(`accepted: ${JSON.stringify(value).slice(0, 200)}`);
    expect(decodeServerFrame(value)).toBeNull();
  }
});

test("a log page entry decodes as an event only", () => {
  expect(decodeEventFrame(narrative)).toEqual(narrative as never);
  expect(decodeEventFrame(welcome)).toBeNull();
  expect(decodeEventFrame({ ...narrative, kind: "smell" })).toBeNull();
});

test("the view schema checker takes extra fields and refuses missing or mistyped ones", () => {
  const me = { member: { id: "m", name: "Ada", role: "player", roleLabel: "Player" }, character: null };
  expect(matchesSchema(me, ME_VIEW_SCHEMA)).toBe(true);
  expect(matchesSchema({ ...me, extra: 1 }, ME_VIEW_SCHEMA)).toBe(true);
  expect(matchesSchema({ ...me, member: { ...me.member, role: "keeper" } }, ME_VIEW_SCHEMA)).toBe(false);
  expect(matchesSchema({ member: me.member }, ME_VIEW_SCHEMA)).toBe(false);
  expect(matchesSchema({ members: [], characters: [], initiative: { round: 1.5, acting: null, order: [] } }, PARTY_VIEW_SCHEMA)).toBe(false);
  expect(matchesSchema({ members: [], characters: [], initiative: null }, PARTY_VIEW_SCHEMA)).toBe(true);
});
