import type { Palette } from "../themes"

export interface MaskedInputProps {
  value: string
  focused: boolean
  placeholder: string
  maskedLabel: string
  theme: Palette
  onInput: (value: string) => void
  onSubmit: (value?: string) => void
}

// OpenTUI 0.4.2 has no password/mask option for InputRenderable. Keep the real
// buffer in a zero-width focused input so keyboard editing and submit semantics
// stay native, while the terminal receives only a constant-width mask. A fixed
// mask also avoids leaking the credential length.
export function MaskedInput({
  value,
  focused,
  placeholder,
  maskedLabel,
  theme,
  onInput,
  onSubmit,
}: MaskedInputProps) {
  return (
    <box flexDirection="row" flexGrow={1} minWidth={0}>
      <input
        width={0}
        value={value}
        focused={focused}
        showCursor={false}
        placeholder=""
        onInput={onInput}
        onSubmit={onSubmit}
      />
      <text fg={value ? theme.fg : theme.dim} wrapMode="none" truncate>
        {value ? `•••••••••••• · ${maskedLabel}` : placeholder}
      </text>
    </box>
  )
}

export default MaskedInput
