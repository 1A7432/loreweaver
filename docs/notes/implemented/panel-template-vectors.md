# Implemented: panel template instantiation is a shared vector table

- **Problem:** turning a panel's template blocks plus one viewer's variables into
  resolved blocks was implemented twice — `clients/tui/src/panelTemplates.ts`
  (`resolvePanelBlocks`, the reference client) and the server's `.panel` text fallback in
  `core/panels.py` — and the two were aligned BY HAND on 2026-08-18 (hidden variables,
  required vs optional fields, repeat filter-then-cap, choices). Hand alignment holds
  until the next edit: nothing failed when the halves drifted, and three of them already
  had (an empty `visible_when` showed server-side but hid client-side; a duplicate
  variable id resolved to the LAST entry server-side and the first client-side; a
  `{$var: …, extra: …}` dict was a binding client-side and a literal server-side). The
  owner's review of the first cut found a fourth, REACHABLE one the subagent had
  classed as unreachable: an exposed MVU array leaf bound with `$var` — the client
  treats any object as a locale map and picks the first string element, the engine saw
  a list, called it "no text" and hid the block. Every one of the four is now a row.
- **Verdict:** one table, `tests/fixtures/panel_template_vectors.json`, consumed by
  `tests/core/test_panel_template_vectors.py` and
  `clients/tui/src/panelTemplates.vectors.test.ts` — the shape
  `visible_when_vectors.json` established for the condition grammar. The engine grew a
  pure `core.panels.resolve_panel_blocks` mirroring the client rule for rule, and
  `render_panel_text` became a dumb stringify over its output, taking WIRE blocks
  (`gateway.panels.panel_wire_blocks`) so both halves start from the same input.
- **Reason:** a panel is instantiated in every client AND on the server, so "they agree"
  is a promise only a shared fixture can keep — a row that moves breaks both suites at
  once. The reference client is the ORACLE: where the two could differ, the engine
  copies it, oddities included (JavaScript's `String()` for numbers and bools, an
  invalid badge tone stripping rather than dropping, `mime`/`size` written through as
  `undefined` where the engine simply omits the key).
- **Rule home:** `core/panels.py` (the "Template instantiation, then text rendering"
  section); `docs/plugins.md` Layer D.
- **Date:** 2026-08-19.
