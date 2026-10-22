# Implemented: a scene written beside the bookkeeping is handed back, not dropped

- **Problem:** only the last round with no tool calls reaches the table; a tool round's
  text is discarded on purpose. On 2026-10-21 (Studio play-test, Keeper
  `claude-opus-5-5`, effort medium, Anthropic Messages API) turn 14 ran 7 Keeper rounds:
  round 6 returned 2,034 completion tokens TOGETHER WITH `game_clock set` and
  `kp_note add world_changes` (the model wrote the whole archive scene after a failed
  Accounting check, then did its bookkeeping in the same response), and round 7 wrote
  ~430 tokens, three closing sentences, because the model's own context showed the scene
  as written. The players got three sentences for a 164-second turn. Nothing in the
  prompt told the model which of its messages the table sees.
- **Decision:** two halves. (1) The engine fact, once, as the first system guideline:
  only the last message without tool calls reaches the players; finish every tool call,
  state updates included, then narrate. (2) A structural end-of-turn row,
  `narration_lost`, first in the default table: when a tool round of this turn carried
  at least 150 estimated tokens of text (`core.chronicle.estimate_tokens`: ~600
  characters of English, ~150 of Chinese) and the final reply is under half of the
  longest such round, the turn is refused once (`max_rounds: 1`) with a corrective that
  quotes the lost text back (the check conversation drops tool rounds, so the model
  could not read it otherwise) and asks for the complete narration, or the same reply if
  that text was only working notes. The round comes out of the existing
  `MAX_ROUNDS_PER_TURN` (5); a pack may reword, reorder or disable the row like any
  other. The tool-round texts live in memory only, never in the published tool trace.
- **Reason:** the prompt half alone is a hope, and on the first-party API Opus 5.5 may
  return text-between-tools as thinking with empty text, so the check cannot see every
  case; the check half alone pays a round for every model that never learned the fact.
  Interim text still never reaches the table: "let me check the lore" chatter is the
  reason it is discarded, and streaming it would put that chatter in front of players.
  The default caps now sum to 6 against the ceiling of 5, so only a turn on which every
  row fires reaches it, and the cut lands on the last row, `stale_scene_hud`, after its
  bookkeeping round.
- **Rule home:** `agent/turn_checks.py` (module docstring, the condition and its
  thresholds, the table order); `agent/loop.py` (THE MAP step 7, `_check_fields`);
  `locales/*/prompt.json` `prompt.system.guidelines`;
  `tests/architecture/test_turn_check_budget.py` (why the caps may sum past the ceiling).
- **Date:** 2026-10-21.

## Follow-up: a tool round on a check's last round earns one more round (2026-10-22)

- **Problem:** Cursor Bugbot on #47. The runner looped `range(check.max_rounds)`, so a
  row whose last allowed round was answered with tool calls ended on that tool round and
  kept the reply it had fired on. `narration_lost` has one round: a model that restored
  the scene beside a bookkeeping call had it dropped a second time (`dice_contradicts`,
  also one round, kept its wrong numbers the same way).
- **Decision:** a row whose LAST allowed round is answered with tool calls gets exactly
  one round past its cap. That round re-sends the row's instruction with the tool results
  in view. It is one round and no more: if the model answers it with tools again, the row
  ends there. The first version of this fix kept following tool rounds until the turn-wide
  ceiling, and a review showed one row could then spend all five rounds and starve the
  dice rows after it. `MAX_ROUNDS_PER_TURN` (5) stays the hard stop, so the per-turn budget
  does not move. One consequence for the paragraph above: when rows answer with tools, the
  ceiling can be reached sooner and the cut can land on an earlier row than
  `stale_scene_hud`.
- **Rule home:** `agent/loop.py::_run_turn_checks` (docstring);
  `tests/architecture/test_turn_check_budget.py`; pinned by
  `tests/agent/test_turn_checks.py` (the one-round row and the one-round-past-the-cap tests).
