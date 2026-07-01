// The palettes themselves live in themes.css (CSS variables on body[data-theme]).
// This module only carries the theme-name list used by the picker + <body> switch.
export type ThemeName = "df16" | "phosphor" | "amber" | "paperwhite"

export const THEME_ORDER: ThemeName[] = ["df16", "phosphor", "amber", "paperwhite"]

export const DEFAULT_THEME: ThemeName = "df16"

export function applyTheme(theme: ThemeName): void {
  if (typeof document !== "undefined") document.body.dataset.theme = theme
}
