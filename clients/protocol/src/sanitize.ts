// Shared sanitizer for untrusted, server-supplied strings.
//
// Terminal clients (TUI / SSH) render narrative text, speaker names, and
// scene/character fields straight to a real terminal. Without sanitization,
// raw ANSI/OSC/control bytes embedded by the WS server, another player, or the
// AI Keeper reach the terminal and enable clipboard hijack (OSC-52
// `\x1b]52;...`), title/screen spoofing (`\x1b]0;...`, `\x1b[2J`), or even
// stdin injection on permissive terminals.
//
// `stripControlChars` removes the C0 control range (`\x00`-`\x1f`) and the C1
// range (`\x7f`-`\x9f`, which includes the 8-bit CSI/OSC introducers), while
// KEEPING the two whitespace controls narration legitimately uses: tab (`\x09`)
// and newline (`\x0a`). It intentionally leaves the ESC (`\x1b`) / BEL (`\x07`)
// introducers out, so a sequence like `\x1b]0;PWNED\x07` loses its ESC + BEL
// and becomes inert visible text instead of an executable escape.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, "")
}
