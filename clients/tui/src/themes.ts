export type ThemeName = "lamplight" | "df16" | "phosphor" | "amber" | "paperwhite"

export interface Palette {
  bg: string
  fg: string
  dim: string
  kp: string
  player: string
  npc: string
  system: string
  crit: string
  extreme: string
  hard: string
  success: string
  fail: string
  fumble: string
  hpFull: string
  hpLow: string
  sanFull: string
  sanLow: string
  border: string
  accent: string
}

export const themes: Record<ThemeName, Palette> = {
  // "灯下的牌桌 / lamplight": a warm, aged-parchment table lit by a single lamp.
  // Signature tokens (from the design brief): warm near-black bg, parchment fg,
  // faded副字 dim, brass accent, oxblood danger, verdigris ok, aged-leather border.
  // The cool player/SAN hues keep speaker roles + the sanity meter legible against
  // the warm ground without breaking the sepia mood.
  lamplight: {
    bg: "#17130E",
    fg: "#E7D8B5",
    dim: "#8A7B5E",
    kp: "#F2E4BC",
    player: "#7FA8B8",
    npc: "#C79B74",
    system: "#9C8A66",
    crit: "#F0C46A",
    extreme: "#7FB8A3",
    hard: "#5B9A86",
    success: "#5B9A86",
    fail: "#B8894A",
    fumble: "#A2432E",
    hpFull: "#5B9A86",
    hpLow: "#A2432E",
    sanFull: "#6FA5B0",
    sanLow: "#9B6A8C",
    border: "#4A3F30",
    accent: "#D19A3E",
  },
  df16: {
    bg: "#000000",
    fg: "#c0c0c0",
    dim: "#808080",
    kp: "#ffffff",
    player: "#55ffff",
    npc: "#ff55ff",
    system: "#aaaaaa",
    crit: "#ffff55",
    extreme: "#55ffff",
    hard: "#55ffff",
    success: "#55ff55",
    fail: "#ffff55",
    fumble: "#ff5555",
    hpFull: "#55ff55",
    hpLow: "#ff5555",
    sanFull: "#55ffff",
    sanLow: "#ff55ff",
    border: "#808080",
    accent: "#ffaa00",
  },
  phosphor: {
    bg: "#07120d",
    fg: "#9cffb1",
    dim: "#4f8f62",
    kp: "#d7ffd9",
    player: "#7de0ff",
    npc: "#ff9bd5",
    system: "#8ba99a",
    crit: "#f8ff7a",
    extreme: "#6ee7f2",
    hard: "#67d8ff",
    success: "#8dff8d",
    fail: "#e6d96b",
    fumble: "#ff6b6b",
    hpFull: "#88ff8a",
    hpLow: "#ff5f5f",
    sanFull: "#6ee7f2",
    sanLow: "#c58cff",
    border: "#2c5c3f",
    accent: "#f4d35e",
  },
  amber: {
    bg: "#120c05",
    fg: "#ffd58a",
    dim: "#9c7740",
    kp: "#fff0c4",
    player: "#8bd3ff",
    npc: "#d69cff",
    system: "#c09d6b",
    crit: "#fff36d",
    extreme: "#73d2de",
    hard: "#58c4dd",
    success: "#98e06f",
    fail: "#ffd166",
    fumble: "#ff686b",
    hpFull: "#9ae66e",
    hpLow: "#ff6b4a",
    sanFull: "#79d9ff",
    sanLow: "#d69cff",
    border: "#8b6532",
    accent: "#ff9f1c",
  },
  paperwhite: {
    bg: "#f5f0e6",
    fg: "#27231d",
    dim: "#7b7469",
    kp: "#111111",
    player: "#005f87",
    npc: "#8f2d56",
    system: "#5f5a50",
    crit: "#8a5a00",
    extreme: "#006d77",
    hard: "#0077a3",
    success: "#2f7d32",
    fail: "#9a6a00",
    fumble: "#b3261e",
    hpFull: "#2f7d32",
    hpLow: "#b3261e",
    sanFull: "#0077a3",
    sanLow: "#7b3fa1",
    border: "#b8ad9f",
    accent: "#8a5a00",
  },
}

// F1..F5 map 1:1 onto this order; lamplight leads and is the default — it IS the
// Loreweaver identity (warm near-black + parchment + brass), shared with the site,
// web client, and app icon. The others stay available as F-key alternates.
export const themeOrder: ThemeName[] = ["lamplight", "amber", "df16", "phosphor", "paperwhite"]

export const DEFAULT_THEME: ThemeName = "lamplight"
