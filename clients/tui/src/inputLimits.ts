export const CHAT_INPUT_LIMIT = 4_000
export const CHAT_INPUT_COUNTER_THRESHOLD = Math.floor(CHAT_INPUT_LIMIT * 0.8)

export interface InputLimitState {
  count: number
  showCounter: boolean
  atLimit: boolean
}

export function inputLimitState(value: string): InputLimitState {
  const count = value.length
  return {
    count,
    showCounter: count >= CHAT_INPUT_COUNTER_THRESHOLD,
    atLimit: count >= CHAT_INPUT_LIMIT,
  }
}
