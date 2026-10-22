# Implemented: the Anthropic adapter speaks adaptive thinking to the models that only take it

- **Problem:** `AnthropicLLM` mapped `reasoning_effort` to `thinking: {type: "enabled",
  budget_tokens: N}` on every Claude model. Opus 4.7/4.8 and the whole 5-series reject a
  budget with a 400, so setting the effort knob for `claude-opus-5-5` broke every call.
  With the knob blank the 5-series still thinks (no `thinking` field means adaptive), and
  thinking counts toward `max_tokens`, so the 4096 cap sized for a bare reply could cut a
  long Keeper turn off mid-thought. The no-sampling list also missed Opus 5 / Opus 5.5 /
  Haiku 5.5, which 400 on a non-default `temperature`.
- **Decision:** models in `ANTHROPIC_ADAPTIVE_ONLY_PREFIXES` get `{"type": "adaptive"}` +
  `output_config.effort` for the same knob; the ones in
  `ANTHROPIC_THINKS_BY_DEFAULT_PREFIXES` keep a thinking-sized cap (32000, streamed) even
  when the knob is blank; Opus/Sonnet 4.6 and older stay on the budget path, which they
  still accept. Forced tool choice still sends no thinking config.
- **Reason:** found while configuring the 2026-10-21 Studio playtest on Opus 5.5 medium —
  the engine had no way to say "medium" to that model.
- **Vendor verification:** both prefix lists were checked 2026-10-21 against the per-model
  table at platform.claude.com/docs/en/build-with-claude/thinking (Messages API): the
  "`enabled` with `budget_tokens`" column (400 for Opus 4.7 → 5.5, Sonnet 5/5.5, Haiku 5.5,
  Fable 5/5.1, Mythos 5/5.1), the "No `thinking` field" column (adaptive for the 5-series),
  and the sampling-parameter paragraph on the same page. Not covered: forced `tool_choice`
  is a 400 on Opus 5.5 / Sonnet 5.5 / Fable 5.1, but no production lane forces a tool
  (`agent/turn_checks.py` is Stop form), so nothing guards it here.
- **Date:** 2026-10-21. Rule home: the comments on the two prefix tuples in
  `infra/providers.py`.
