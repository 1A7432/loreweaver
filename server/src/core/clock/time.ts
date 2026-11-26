// Moving a game clock's text forward. A clock is whatever text the table keeps time in;
// the engine can move two families of it by itself and keeps the family it was given:
//   - day faces, the relative counters imported module cards use: `D3 14:00`,
//     `第3天 14:00` (an optional short period word around the time, `D1 上午 09:30`, is
//     accepted and dropped on advancing — narration re-adds flavour, while a stale
//     "morning" carried past nine at night would simply be wrong);
//   - calendar dates with or without a time: `1926-03-15 14:00`, `1926/03/15`,
//     `1926-03-15T14:00`, `1926年3月15日 14:00`. A date without a time gains one, so a
//     sub-day advance stays visible.
// Any other text (a module's own calendar, "the third day of the long rain") is still a
// valid clock: the engine just cannot move its text, and says so (`moved: false`).
//
// Deltas: a signed whole number and a unit — minutes (`分钟`, `分`, `min`, `mins`,
// `minute`, `minutes`), hours (`小时`, `时`, `hour`, `hours`, `hr`, `hrs`) or days (`天`,
// `日`, `day`, `days`, `d`) — case and spaces ignored: `+2 hours`, `-30min`, `+1天`.
// The units are game data in both languages, like a pack's aliases.

/** The largest advance, either way: a century, in minutes. */
export const MAX_ADVANCE_MINUTES = 36_500 * 24 * 60;
/** The largest day a day face counts to (four digits, as the face is written). */
export const MAX_FACE_DAY = 9999;

const MINUTES_PER_DAY = 24 * 60;

const UNIT_MINUTES: ReadonlyMap<string, number> = new Map([
  ["分钟", 1],
  ["分", 1],
  ["min", 1],
  ["mins", 1],
  ["minute", 1],
  ["minutes", 1],
  ["小时", 60],
  ["时", 60],
  ["hour", 60],
  ["hours", 60],
  ["hr", 60],
  ["hrs", 60],
  ["天", MINUTES_PER_DAY],
  ["日", MINUTES_PER_DAY],
  ["day", MINUTES_PER_DAY],
  ["days", MINUTES_PER_DAY],
  ["d", MINUTES_PER_DAY],
]);

const DELTA_RE = /^([+-]?\d{1,12})(分钟|分|minutes|minute|mins|min|小时|时|hours|hour|hrs|hr|天|日|days|day|d)$/u;

/** A delta in minutes, or null when it is not one (or exceeds `MAX_ADVANCE_MINUTES`). */
export function parseDelta(text: string): number | null {
  const match = DELTA_RE.exec(text.toLowerCase().replaceAll(" ", ""));
  if (match === null) return null;
  const unit = UNIT_MINUTES.get(match[2] ?? "");
  if (unit === undefined) return null;
  const minutes = Number(match[1]) * unit;
  return Number.isSafeInteger(minutes) && Math.abs(minutes) <= MAX_ADVANCE_MINUTES ? minutes + 0 : null;
}

// --- day faces --------------------------------------------------------------

const DAY_FACE_RE = /^(?:[Dd](\d{1,4})|第(\d{1,4})[天日])\s*(?:[^\d\s:：]{1,3})?\s*(\d{1,2})[:：](\d{2})\s*(?:[^\d\s:：]{1,3})?$/u;

interface DayFace {
  readonly style: "D" | "第";
  /** Minutes since day 1, 00:00. */
  readonly minutes: number;
}

function parseDayFace(text: string): DayFace | null {
  const match = DAY_FACE_RE.exec(text.trim());
  if (match === null) return null;
  const day = Number(match[1] ?? match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  if (day < 1 || day > MAX_FACE_DAY || hour > 23 || minute > 59) return null;
  return { style: match[1] !== undefined ? "D" : "第", minutes: (day - 1) * MINUTES_PER_DAY + hour * 60 + minute };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

function formatDayFace(style: DayFace["style"], minutes: number): string {
  const day = Math.floor(minutes / MINUTES_PER_DAY) + 1;
  const ofDay = minutes - (day - 1) * MINUTES_PER_DAY;
  const time = `${pad(Math.floor(ofDay / 60))}:${pad(ofDay % 60)}`;
  return style === "D" ? `D${day} ${time}` : `第${day}天 ${time}`;
}

// --- calendar dates ---------------------------------------------------------

type DateStyle = "zh" | "dash" | "slash";

const DATE_FORMS: readonly (readonly [RegExp, DateStyle])[] = [
  [/^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:(\d{1,2}):(\d{1,2}))?$/u, "zh"],
  [/^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:\s+|T)(\d{1,2}):(\d{1,2}))?$/u, "dash"],
  [/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?$/u, "slash"],
];

/** Proleptic Gregorian days since 1970-01-01 (Howard Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

interface CalendarTime {
  readonly style: DateStyle;
  /** Minutes since 1970-01-01 00:00. */
  readonly minutes: number;
}

// Years a four-digit calendar face can hold.
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function parseCalendar(text: string): CalendarTime | null {
  const trimmed = text.trim();
  for (const [re, style] of DATE_FORMS) {
    const match = re.exec(trimmed);
    if (match === null) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] === undefined ? 0 : Number(match[4]);
    const minute = match[5] === undefined ? 0 : Number(match[5]);
    if (year < MIN_YEAR || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
    const days = daysFromCivil(year, month, day);
    // Rejects 02-30 and friends: the day must survive the round trip.
    if (civilFromDays(days).day !== day) return null;
    return { style, minutes: days * MINUTES_PER_DAY + hour * 60 + minute };
  }
  return null;
}

function formatCalendar(style: DateStyle, minutes: number): string | null {
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const ofDay = minutes - days * MINUTES_PER_DAY;
  const { year, month, day } = civilFromDays(days);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const time = `${pad(Math.floor(ofDay / 60))}:${pad(ofDay % 60)}`;
  if (style === "zh") return `${pad(year, 4)}年${pad(month)}月${pad(day)}日 ${time}`;
  const sep = style === "dash" ? "-" : "/";
  return `${pad(year, 4)}${sep}${pad(month)}${sep}${pad(day)} ${time}`;
}

// --- advancing --------------------------------------------------------------

/** Whether the engine can move this clock text by itself. */
export function isReadableClock(text: string): boolean {
  return parseDayFace(text) !== null || parseCalendar(text) !== null;
}

export type TimeAdvance =
  /** `moved` is false when the text is not a family the engine can move: it is kept as written. */
  | { readonly ok: true; readonly now: string; readonly minutes: number; readonly moved: boolean }
  | {
      readonly ok: false;
      /** `bad_delta`: not a delta (or too large); `before_start`: a day face would go before day 1;
       * `out_of_range`: past day `MAX_FACE_DAY`, or a date outside years 1–9999. */
      readonly code: "bad_delta" | "before_start" | "out_of_range";
    };

/** `now` moved by `delta`, in the family it is written in. */
export function advanceTime(now: string, delta: string): TimeAdvance {
  const minutes = parseDelta(delta);
  if (minutes === null) return { ok: false, code: "bad_delta" };
  const face = parseDayFace(now);
  if (face !== null) {
    const moved = face.minutes + minutes;
    if (moved < 0) return { ok: false, code: "before_start" };
    if (moved >= MAX_FACE_DAY * MINUTES_PER_DAY) return { ok: false, code: "out_of_range" };
    return { ok: true, now: formatDayFace(face.style, moved), minutes, moved: true };
  }
  const calendar = parseCalendar(now);
  if (calendar !== null) {
    const text = formatCalendar(calendar.style, calendar.minutes + minutes);
    return text === null ? { ok: false, code: "out_of_range" } : { ok: true, now: text, minutes, moved: true };
  }
  return { ok: true, now, minutes, moved: false };
}
