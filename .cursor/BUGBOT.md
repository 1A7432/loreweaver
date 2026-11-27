# Bugbot review guide — Loreweaver

Loreweaver is a self-hosted AI Game Master engine for tabletop RPGs: a
deterministic engine (dice, rules, state) wrapped around model-driven narration.
Version 3.0 is one Bun workspace in strict TypeScript: `server/` (the server;
its layers are directories under `server/src/`), `sdk/` (the module SDK),
`clients/protocol` and `clients/tui`. `AGENTS.md` is the full contributor
contract; this file tells a reviewer what to look for in a diff and what NOT to
flag. Cite `file:line` and describe the concrete failure scenario for every
finding. Label each finding as either a RED LINE (below) or an improvement.

## Red lines — flag any diff that crosses one

1. **Deterministic vs generative.** Dice, success levels, character math, random
   tables, permissions and the word filter are real code. `server/src/core/`
   makes no model calls at all. Flag: a model call added under `core/`; a rule
   outcome (a success level, a stat change, a table result) produced or
   "interpreted" by the model instead of the engine.
2. **Dice-first.** A check rolls real dice, then narrates the outcome per the
   result. Flag: any path that narrates a check result without a dice tool
   having fired, or that lets the model state a roll it did not make
   (`server/src/agent/turn/checks.ts` is the runtime guard; do not weaken it).
3. **Information isolation.** Room content is documents, and
   `project(document, viewer)` (`server/src/core/documents/`) is the only way
   content leaves toward a connection; a view is built by picking named public
   fields. Whole stored documents (`core/documents/raw.ts`) are for `core/` and
   `agent/` only. An NPC actor is built from its OWN record and sheet only; the
   Stage Director only from what the table has seen. Flag: a new path that sends
   a stored document, or a field of one, without its projection; a new document
   type without a sentinel test (a marker in each non-public field must not
   appear in a view it does not belong to); secret lore, NPC secrets,
   keeper-only variables or unexposed variable-tree leaves reaching a
   player-grade view; imported world machinery reaching a room by any path other
   than the room admin's world import. Do NOT propose scoping, tiering or
   staging the main Keeper's module knowledge — the Keeper holding the full
   module is deliberate and permanent
   (`docs/notes/rejected/keeper-knowledge-scoping.md`).
4. **English-first + catalogs.** Identifiers, comments and commits are English.
   Results are data with stable codes; nothing in `server/src` writes a sentence
   a person reads. Text for people comes from `server/locales/{en,zh}/<area>.json`
   through `server/src/infra/i18n.ts` (`translate(catalog, locale, key, params)`),
   with an entry in BOTH languages; client-side through the typed
   `tt()`/`messages` dict in `clients/tui/src/i18n.ts`, both languages. Flag: a
   hardcoded natural-language string on a user-facing path; a key added to one
   language only. CJK game DATA (skill names, aliases) is exempt; English-only
   model instructions (tool descriptions, the Scribe's and the Director's
   prompts) live as constants beside the code that sends them.
5. **One prompt assembler per lane.** The Keeper's context is assembled only in
   `server/src/agent/prompt/` and a Keeper turn is one function,
   `runKeeperTurn` (`server/src/agent/turn/engine.ts`). Every other model call is
   a declared lane (NPC, Scribe, Director, the chronicle fold, character
   generation). Flag: any other module building or extending the Keeper's
   context; a new `.chat(` call site not listed with its lane in
   `server/test/architecture/model_lanes.test.ts`.

## Budget, locking and lifecycle — the paid-for rules

- One Keeper turn is at most **21** model calls (3 fold batches + 12 tool rounds
  + 5 check rounds or 1 finalizer + 1 overflow re-send), held by
  `server/test/agent/turn/budget.test.ts`; a player turn adds 1 Scribe and, on a
  beat, 1 Director. A new model-driven path must update AGENTS.md AND that test.
- Only a line of speech opens a turn. A command runs under the room's lock in
  arrival order with speech, opens no turn, and its writes belong to the latest
  turn. Undo, reset and import do not wait for the lock: the old generation's
  work in flight ends as `stale` by itself. Flag any cancel-and-wait, and any
  code under the lock that takes it again.
- Every write to a room goes through a `RoomWriter` bound to the room's
  generation and a turn (`server/src/infra/store.ts`). A background lane keeps
  the `RoomContext` it was scheduled with and commits in one synchronous block.
  Flag: a fresh writer fetched when a lane finishes; a turn index read at commit
  time; anything that waits on the post-turn chain (`server/src/gateway/chain.ts`).
- The store is synchronous: a turn suspends only at a model call, a room-worker
  exchange or outbound network, and holds no room state across one. Flag state
  read before a suspension and trusted after it.
- What the prompt consumes from the room (Scribe whispers, pending module facts,
  the record of players' commands) is cleared in the turn's final commit block,
  by value — never when read.
- New room data declares its lifecycle (`server/src/infra/lifecycle/`): a new
  document type in `server/src/core/registry.ts`, a room-state key as its own
  declaration, an external storage when it registers. A new server-lifetime part
  is wired in `server/src/cli/compose.ts`.
- Before lifecycle / locking / provider / replay changes,
  `docs/defensive-patterns.md` applies; check the diff against it.

## Layers, modules, packs and protocol

- `server/test/architecture/imports.test.ts` holds the import rules: layer
  direction `infra < core < agent < gateway < net`; Bun-specific APIs (`bun:*`,
  the `Bun` global) only under `server/src/infra/runtime/`; nothing reachable
  from `worker/` imports the database; relative imports name their `.ts`
  extension. Flag a diff that works around them.
- TypeScript is strict with erasable syntax only: no enums, namespaces or
  parameter properties.
- Content code runs in the room's worker (`server/src/worker/`), never on the
  main thread. A module answers through effects; the engine validates and
  applies them (`server/src/agent/modules.ts`). Flag a module path that reaches
  the room some other way.
- Names, ids, titles and keys from packs, cards or players are content: held in
  `Map`s or ordered pair lists (never plain objects), counted in code points,
  matched with the `u` flag where CJK may occur, parsed strictly, and capped by a
  named constant — over the cap is refused with a coded result, never truncated
  silently.
- A tool whose result carries secrets must be flagged `keeperOnly`;
  skill-unlocked tools `gated`; tools whose calls for different values of one
  argument touch different documents `concurrentBy`. Flag a secret-returning
  tool without `keeperOnly`.
- Rule systems are rule pack DATA (`rulepacks/*.yaml`). Flag rule-system-specific
  words or logic added to `core/` or `agent/`.
- `server/src/infra/zip.ts` is the security boundary of pack installation, and
  `server/src/core/packs/` validates a whole pack as data. A pack format change
  updates the matching `docs/lwf/formats/*.md` in the same commit.
- The wire has one description, `docs/protocol.md`. A protocol change lands in
  `clients/protocol/src/v3/`, the server, the document and
  `server/test/net/client_roundtrip.test.ts` in one change. Flag a partial one.
- The terminal client's one source of server data is the protocol package's
  `Session` snapshot; flag a component that keeps its own copy of a view or of
  the log.
- Settings are `TRPG_*` variables read in `server/src/infra/config.ts` only.
- Never re-add chat-platform adapters or bridges; clients build against
  `docs/protocol.md`. Never create a directory named `cards/` or `modules/`
  (ignored by `.gitignore` everywhere).

## Decision records are binding

`docs/notes/rejected/` holds mechanisms the owner rejected; a diff that
reintroduces one (chat adapters, keeper knowledge scoping, chronicle dup
suppression, the sole-active card mechanism, a pack-install shadowed gate) is a
finding regardless of code quality. A non-trivial change should add or update a
note in `docs/notes/` in the same PR — say so if it does not.

## Tests

- The suites are offline and deterministic (scripted models, seeded dice). Flag
  a test that needs network, keys or wall-clock timing.
- Flag deleted or weakened sentinel tests, architecture tests
  (`server/test/architecture/`), the turn budget test, and any assertion
  loosened to make a red test pass.
- Behavioural claims about the live model belong to the live-model play-test
  (`server/eval/playtest.ts`), not to unit tests.

## Do not flag

- File length or function count — there is no line-count rule here.
- Missing backward-compatibility shims: 3.0 has no compatibility with 2.x by
  design, and breaking changes are sanctioned pre-ecosystem, as long as the
  commit names what breaks.
- Cosmetic style already covered by the type checker.
- Comments that state a constraint the code cannot show — those are wanted;
  comments that narrate the change or justify it to the reviewer are not.
