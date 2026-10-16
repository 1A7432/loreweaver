# LWF: module UI panels

**Version 1.0 · stable (additive-only).** Requires wire protocol **2.1** or later; the
current protocol is 2.4. Reference implementation: `core/panels.py` (schema and
template instantiation), `core/hooks.py` (the `ui` block vocabulary), `core/pack.py`
(pack-level panel rules) and `gateway/panels.py` (per-viewer manifests) in the
Loreweaver engine. The reference text-first client is `clients/tui`. The wire frames are
defined in the engine's `docs/protocol.md`, "Module UI panels".

A pack can dress the table with its own interface: HUDs, case boards, maps, handouts.
Panels render in protocol clients, not in the runtime.

## 1. Tiers

| Tier | What | Who renders it |
|---|---|---|
| 0: blocks | `ui` frames of declarative blocks, emitted per turn by hooks ([skills-hooks.md](skills-hooks.md) §4) or by the runtime | Every client. |
| 1: declarative panels | Named layouts of blocks with live variable bindings, declared in a panels file. Pure data. | Every client. |
| 2: custom views | Real HTML/JS/CSS in an isolated sandbox. | Rich clients. Every other client renders the panel's declared tier-1 `fallback`. |

## 2. Boundary, enablement and privilege

- **Slots.** Panels mount only into the play-surface slots `sidebar`, `tray` and `modal`,
  which the client shell owns. Module code never touches application chrome, and the
  player can always collapse or close a panel. A text-first client MAY fold `tray` and
  `modal` into sidebar sections.
- **Enablement.** Panels reach a room only from an installed pack that the room admin
  enabled for that room. Install ≠ enable ([pack.md](pack.md) §6.5). Players cannot
  upload panels. Enabling a pack's panels also enables its presentation kit.
- **A panel acts as the player viewing it.** Inbound, it receives only that viewer's
  filtered data: the same per-viewer state the wire already carries. Outbound, it can
  send only what that player could have typed (§4.4). Every judgment stays with the
  runtime.

## 3. The panels file

The panels file is YAML (`ui/panels.yaml` by convention, listed under `contents.panels`),
at most 256 KiB, parsed with a safe loader. Its root is `{panels: [...]}` with 1 to 16
panels, and ids MUST be unique. Every object in it is **closed**.

### 3.1 Panel

| Key | Req | Meaning |
|---|---|---|
| `id` | yes | Slug `^[a-z0-9][a-z0-9-]{0,63}$`. On the wire it becomes `<pack-id>/<panel-id>`. |
| `title` | yes | A string, or a mapping with `en` and/or `zh`. At most 120 characters. No bindings. |
| `slot` | yes | `sidebar`, `tray` or `modal`. |
| `audience` | no | `all` (default), `player` or `keeper` (§4.1). |
| `blocks` | tier 1 | 1 to 32 template blocks (§3.2). |
| `entry` | tier 2 | The panel's `.html` or `.htm` document. Its presence makes the panel tier 2. |
| `assets` | tier 2 | Every file the panel ships, **the entry included**. No duplicates, and at most 8 besides the entry. Every path MUST lie under the entry's directory. |
| `fallback` | tier 2 | **Required**: 1 to 32 template blocks, or an explicit `null`. |

A tier-1 panel MUST NOT declare `entry`, `assets` or `fallback`. A tier-2 panel MUST NOT
declare `blocks`. Each tier-2 panel's code payload is at most 2 MiB, and every image a
panel names MUST be an image asset of its own pack ([pack.md](pack.md) §3). Paths are
pack-relative. The builder folds them into the pack's content-addressed asset pipeline,
so an author never writes a hash, and a panel can never point at a file its pack does
not ship.

### 3.2 Template blocks

**Localized strings.** A localized string is a plain string, which is taken as `en`, or
a mapping with `en` and/or `zh` keys. Any other key is an error. Every value MUST be
non-empty and within the field's cap.

**Bindings.** Any scalar field MAY instead be a binding:

- `{$var: "<variable id>"}` reads the viewer's own variable;
- `{$leaf: id|label|value}` reads the matched variable, and is valid only inside a
  `repeat`.

`image` and `map_pin` paths can never be bound.

| Kind | Required | Optional |
|---|---|---|
| `meter` | `label`, `value`, `min`, `max` (numbers, with `max > min`) | — |
| `stat` | `label`, `value` (number, string or boolean) | — |
| `badge` | `label` | `tone`: `info`, `warn` or `danger` |
| `text` | `text` (≤2,000) | `style`: `quote` or `warning` |
| `divider` | — | — |
| `choices` | `options`: 1 to 12 entries `{id (≤64), label, input (≤200)}` | `prompt` (≤200) |
| `image` | `src` (a pack-relative image path) | `caption` (≤300), `alt` (≤120) |
| `letter` | `body` (≤4,000) | `from`, `to`, `date` |
| `clipping` | `headline`, `body` (≤4,000) | `source`, `date` |
| `map_pin` | `src` (a pack-relative image path), `label`, `x`, `y` (numbers or bindings) | `note` (≤300) |
| `title_card` | `title` | `subtitle` (≤300), `act` |

A label, headline, title, `from`, `to`, `date`, `source` or `act` is at most 120
characters.

**Constructs.**

- **`repeat`**: `{repeat: {prefix, block}}` renders `block` once for each visible
  variable whose id starts with `prefix` (at most 128 characters). A repeat block has no
  other keys, and repeats do not nest.
- **`visible_when`**: any block MAY carry `visible_when: "<condition>"`. That includes a
  repeat block and a repeat's inner block. The condition is at most 500 characters, and a
  builder MUST refuse it unless it parses **and** stays inside the portable subset (§5.2).

## 4. Wire contract

These frames are defined normatively in the engine's `docs/protocol.md`. This section
records the obligations a panel implementation depends on.

### 4.1 `ui_manifest`

`{type: "ui_manifest", panels: [UiManifestPanel]}` is this **viewer's** complete panel
list. The runtime sends it on join and again after the room's panel set changes. Each
frame replaces the previous list completely, and an empty list clears every panel.

- **Audience is resolved by the runtime, per viewer, before the frame is built.**
  `keeper` panels reach only keeper-role connections, `player` panels only other
  connections, and `all` panels everyone. An unknown audience reaches no one. `audience`
  itself never goes on the wire. A keeper-only panel therefore structurally never
  appears in a player's manifest; this is not hiding by CSS.
- Tier 1: `{id, title, slot, tier: 1, blocks}`.
- Tier 2: `{id, title, slot, tier: 2, entry: {hash, size}, assets: [{path, hash, size,
  mime}], fallback}`. Asset `path`s are relative to the entry document's directory, so
  each tier-2 panel is a self-contained static root.
- **Image rewriting.** In wire blocks, an `image` or `map_pin` carries the resolved
  `{hash, mime, size}` of its picture in place of `src`. All other fields pass through as
  authored.

### 4.2 Fetching assets

Every hash is fetched over the runtime's existing media byte channel. There is no
dedicated asset frame. A client MUST verify the sha256 before caching, and caches are
immutable and keyed by hash.

### 4.3 `panel_event`

`{type: "panel_event", panel, payload}` carries a hook's `emitPanel` payload: opaque JSON
of at most 32 KB, at most 20 per turn. The runtime delivers it only to viewers whose
manifest contains that panel, right after the turn's `ui` frames. A client that does not
run panel code ignores it.

### 4.4 `panel_intent`

`{type: "panel_intent", panel, kind: "choice"|"input"|"roll", value}` is the only thing a
panel sends. `value` is a string of at most 2,000 characters.

- The runtime MUST first check that the panel is in **that member's own** manifest, and
  refuse the intent otherwise.
- It then routes the value exactly as if the member had typed it, subject to the same
  rate limits, turn ordering and command privileges. `choice` and `input` submit `value`
  as input. `roll` runs a public roll of the expression `value` as that player, through
  the runtime's dice roller.
- Picking a tier-1 `choices` option sends `panel_intent{kind: "choice", value: <the
  option's input>}`.

A hook-emitted `choices` block in a `ui` frame works differently: the client sends the
option's `input` back as a normal `input` frame.

## 5. Template instantiation (normative)

Every client instantiates a panel's template blocks for its own viewer, against **that
viewer's own `state.variables`**. The runtime's text rendering does the same. Variable
ids are exactly the ids in `state.variables`: typed variable ids, and imported-tree leaves
prefixed `mvu.`.

### 5.1 Rules

1. **Hidden first.** Variables flagged `hidden` are removed before anything resolves.
   They reach keeper-role connections only.
2. **Fail closed.**
   - A binding that names an absent variable is a miss.
   - A miss, or an unusable value, in a **required** field drops the whole block.
   - In an **optional** field, it drops only that field.
   - A `choices` option whose label does not resolve is dropped, and a `choices` block
     left with no options is dropped.
   - A `meter` whose resolved `max ≤ min` is dropped.
   - A panel can never show more than the viewer's filtered state.
3. **`repeat`** first filters the visible variables by id prefix, then keeps at most
   **32** instances.
4. **`visible_when`** is evaluated against the same visible variables. An absent
   variable reads as null. A condition that errors, or that the client cannot evaluate,
   **MUST hide its block**, because the case that cannot be decided fails closed. A gate
   on a repeat suppresses the whole expansion, and a gate on the inner block suppresses
   each instance on its own. A client that does not implement `visible_when` MUST NOT
   render any block that carries it.
5. **Locale.** A localized value is picked by the viewer locale's first two characters,
   then `en`, then any non-empty value.
6. **Coordinates.** A `map_pin`'s `x` and `y` are fractions of the map image's own box,
   clamped to [0, 1].

### 5.2 The portable condition subset

`visible_when` uses the grammar of [rulepacks.md](rulepacks.md) §3, restricted to:

- comparisons `=== !== == != >= <= > <`;
- the logic operators `&& || !` (or `and`, `or`, `not`), and parentheses;
- number, string, `true`, `false`, `null` and `undefined` literals;
- bare dotted variable ids.

Arithmetic, unary minus, function calls (including `getvar`) and bracket segments are
outside the subset. Comparison semantics follow §3 of that document, not JavaScript's
own operators. For example, `"abc" > 5` is an error and therefore hides its block.

### 5.3 Secrecy and conformance

**`visible_when` is presentation, never secrecy.** A gated block's content, and the
condition string itself, ship to every viewer whose manifest holds the panel. A
condition in a panel that players receive MUST therefore reference only variables
players can see. Secrecy is `audience` together with the runtime's state projection
([cards.md](cards.md) §8).

The engine publishes two shared conformance tables:
`tests/fixtures/visible_when_vectors.json` for the condition grammar, and
`tests/fixtures/panel_template_vectors.json` for instantiation. Every implementation
MUST produce exactly the results they list.

## 6. Tier-2 runtime (client sandbox floor)

A client that runs tier-2 panels MUST:

- run each panel in an isolated frame with an **opaque origin** and no access to the
  host application beyond the bridge below;
- give panel code **no network capability**, as anti-exfiltration: a panel holds room
  state. Sub-resources come only from the panel's own verified, content-addressed
  assets;
- deliver inbound data only as the viewer-filtered shapes of the protocol `state` frame
  (hidden variables removed) and the `panel_event` payloads for that panel;
- accept outbound only `choice`, `input` and `roll` intents, validated against the
  `panel_intent` limits before they reach the wire.

**Bridge.** The host provides the typed bridge `window.loreweaver` to panel code. Its
surface is `ready()`, `onState(callback)`, `onEvent(callback)` and `send(kind, value)`,
where `send` maps to `panel_intent`. The platform pins this bridge, never a framework:
packs ship built static assets.

A client that does not run tier-2 panels renders the panel's `fallback` blocks, or a
single localized "available in a rich client" line for `fallback: null`.
