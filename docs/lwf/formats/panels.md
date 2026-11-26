# LWF: panels

**Version 3.0 · draft.** Requires wire protocol **3.0**. This is a breaking revision of
panels 1.0 (see §9): a panel's data now comes from **views**, never from variables.
Reference implementation, in the Loreweaver engine: `server/src/core/panels/` (the format
and its checks, a panel as a viewer's `panels` view lists it), `server/src/core/packs/read.ts`
(panels in a pack), `server/src/gateway/packs.ts` (panels in a room) and, shared by every
client, `instantiate` in the protocol package (`clients/protocol/src/v3/panels.ts`, imported
as `loreweaver-protocol/v3`). The reference text client is `clients/tui`. The wire is
defined in the engine's `docs/protocol.md` §10.

A pack can dress the table with persistent interface beside the story: a character
dashboard, a clock, a faction tracker, a case board, a map. A panel shows what its viewer's
views hold — nothing else — and acts only as the member viewing it.

## 1. Two kinds

| Kind | What | Who renders it |
|---|---|---|
| **template** | Declarative blocks whose fields read paths inside named views. Pure data. | Every client. |
| **page** | One self-contained HTML file, run in a rich client's sandboxed frame. | Rich clients. Every other client renders the page's template `fallback`, or one "needs a rich client" line. |

## 2. Boundary, enablement and privilege

- **Slots.** A panel mounts into `sidebar`, `tray` or `modal`, slots the client shell owns.
  A text client MAY fold `tray` and `modal` into sidebar sections. The member can always
  collapse or close a panel.
- **Enablement.** Panels reach a room only from an installed pack the room's admin enabled
  ([pack.md](pack.md) §8). Every panel of an enabled pack is **on** by default; the room's
  admin switches single panels off and on again (`panels disable|enable <pack>/<panel>` in
  the reference), and that choice is a room setting that survives every reset.
- **Data comes from views.** A panel declares the views it reads. A client subscribes to
  them and instantiates the template against the values it holds for **its own viewer**;
  a page receives those same values. There is no other data path: a panel can never show
  more than its viewer's views hold.
- **Acting.** A `choices` option, and anything a page does, is a `command.run` made as the
  member viewing the panel — with that member's privileges, rate limits and turn order.

## 3. The panels file

A pack lists its panels files under `contents.panels` ([pack.md](pack.md) §4). Each is YAML
(`ui/panels.yaml` by convention), at most 256 KiB, read with a loader that refuses anchors
and aliases. Its root is `{panels: [...]}` with 1 to 16 panels; ids are unique **across all
of the pack's panels files**, and a pack ships at most **16** panels in all. Every object is
**closed**: an unknown key is an error.

### 3.1 Panel

| Key | Req | Meaning |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9-]{0,63}$`. On the wire it is `<pack-id>/<panel-id>`. |
| `title` | yes | A string (read as English) or `{en, zh}`. At most 120 characters. No bindings. |
| `slot` | yes | `sidebar`, `tray` or `modal`. |
| `audience` | no | `all` (default), `player` (everyone but admins) or `admin` (admins only). |
| `views` | no | A mapping of **handle → view name**, at most 8 (§4.1). |
| `blocks` | template | 1 to 32 template blocks (§5). |
| `entry` | page | The page's `.html` or `.htm` file. Its presence makes the panel a page. |
| `fallback` | page | **Required** for a page: 1 to 32 template blocks, or an explicit `null`. |

A template MUST NOT declare `entry` or `fallback`; a page MUST NOT declare `blocks`.

A **template**'s `views` are exactly what its blocks read: a declared view no path reads is
refused (`unused_view`), so a panel never costs a subscription it does not use. A page's
`views` are what the page reads; its fallback may use any of them.

**Who is listed a panel.** `audience` decides first. A panel that declares any `admin/*`
view is listed to admins only, whatever its audience — a member can subscribe only to views
they may see — and `audience: player` together with an `admin/*` view is refused
(`audience_conflict`). The decision is the runtime's, per viewer, before the `panels` view is
sent: a panel not listed to a member is not in their view at all.

### 3.2 A complete example

```yaml
panels:
  - id: tide
    title: { en: The tide, zh: 潮汐 }
    slot: sidebar
    views: { me: me, tide: harbor/tide }      # a built-in view and a module view
    blocks:
      - { kind: meter, label: { en: Tide, zh: 潮位 }, value: { $view: tide.level }, min: 0, max: { $view: tide.max } }
      - { kind: image, src: art/chart.png, caption: Harbor chart }
      - repeat:
          each: me.character.resources
          as: r
          block: { kind: meter, label: { $view: r.label }, value: { $view: r.value }, min: 0, max: { $view: r.max } }
      - kind: choices
        prompt: Ring the bell?
        options:
          - { id: ring, label: Ring it, command: harbor/ring, args: { times: 2 } }
        visible_when: "tide.level >= 5"
  - id: chart
    title: Sea chart
    slot: modal
    views: { tide: harbor/tide }
    entry: ui/chart.html
    fallback:
      - { kind: text, text: { $view: tide.phase } }
```

## 4. Views and paths

### 4.1 Declaring views

`views` maps a **handle** — a short local name, `^[a-z][a-z0-9_]{0,31}$` — to a **view name**:

- a built-in view: `me`, `party`, `scene`, `variables`, `characters`, `commands`, `room`,
  `usage` or `packs` (not `panels`);
- an admin view: `admin/<name>`;
- a module view: `<module>/<name>`, both parts `^[a-z][a-z0-9_]{0,63}$`.

Any other name is refused (`bad_view_name`). A module view the room does not have is **not**
an error — its module may not be enabled there. The client simply holds no value for it,
and every block that reads it is absent (§6).

### 4.2 The path grammar

Bindings, `repeat.each` and the references of `visible_when` conditions all name a **path**:

```
path     = handle *( "." segment )       at most 200 code points, at most 8 parts
handle   = [a-z][a-z0-9_]{0,31}          a declared handle, or inside a repeat its `as`
segment  = name / index
name     = [\p{L}_][\p{L}\p{N}_]*         letters (CJK included), digits, underscore
index    = "0" / [1-9][0-9]*
```

Reading a path from the view the handle names, one segment at a time:

- on a **record**, a segment names its own property (never an inherited one);
- on a **list**, an `index` picks that element, and a `name` picks the **first element whose
  key equals it** — an element's key is its `id`, else its `key`, else its `path`, whichever
  is the first string present;
- a list is always read **without its elements flagged `hidden: true`** (an admin's view
  marks what players do not see; a panel does not show it on any screen);
- anything else is absent.

Examples, against the built-in views ([protocol.md](../../protocol.md) §10.4):

| Path (with `views: {me: me, vars: variables}`) | Reads |
|---|---|
| `me.member.name` | the viewer's name |
| `me.character.resources.hp.value` | the resource whose `id` is `hp`, its value |
| `me.character.resources.0.label` | the first resource's label |
| `me.character.attributes.STR.value` | the attribute whose `key` is `STR` |
| `vars.module.dread.value` | the declared variable `dread` |
| `vars.module.mood.valueLabel` | that enum's option label, in the viewer's language |

And against a module view `harbor/tide` declared as `tide`: `tide.level`, `tide.boats.0.name`,
`tide.boats.gull.crew`.

A tree leaf's `path` usually contains dots and cannot be one segment: walk the tree with a
`repeat` and its `prefix` (§5.2).

## 5. Template blocks

The block kinds are the protocol's `Block` vocabulary.

**Localized strings.** A text field is a plain string (read as English) or `{en, zh}`; the
runtime picks the viewer's language, then English, then whichever is present, and sends the
viewer one string. Every value is non-empty and within the field's cap.

**Bindings.** Any field marked *bindable* below MAY instead be `{$view: <path>}` — exactly
that one key. A binding to a text field shows a string as it is, a number as JavaScript prints
it (`3`, `2.5`) and a boolean as `true`/`false`; a list, a record or nothing at all is a miss.
A numeric field takes a finite number only.

| Kind | Required | Optional |
|---|---|---|
| `meter` | `label`, `value`, `min`, `max` (numbers, `max > min`) — all bindable | — |
| `stat` | `label`, `value` (number, boolean or text) — both bindable | — |
| `badge` | `label` (bindable) | `tone`: `info`, `warn` or `danger` (bindable) |
| `text` | `text` (≤2,000, bindable) | `style`: `quote` or `warning` |
| `divider` | — | — |
| `choices` | `options`: 1 to 12 `{id (≤64), label (bindable), command, args?}` | `prompt` (≤200, bindable) |
| `image` | `src` (a picture of the pack) | `caption` (≤300), `alt` (≤120), bindable |
| `letter` | `body` (≤4,000) | `from`, `to`, `date` — all bindable |
| `clipping` | `headline`, `body` | `source`, `date` — all bindable |
| `map_pin` | `src`, `label`, `x`, `y` (numbers) — all but `src` bindable | `note` (≤300, bindable) |
| `title_card` | `title` | `subtitle` (≤300), `act` — all bindable |

A label, headline, title, `from`, `to`, `date`, `source` or `act` is at most 120 characters.
`src` and `style` are never bound.

**Pictures.** `src` is the pack path of an image; it joins the pack's assets whether the
manifest lists it or not, and MUST be an image the pack ships (`panel_asset_missing`,
`panel_asset_type`). On the wire it becomes the picture's `{hash, mime, size}`.

**Choices.** `command` is a command id (`help`, `rules.sanity_check`, `harbor/ring`); `args`
is a plain JSON object of at most 2,000 bytes, keys `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, at
most 4 levels deep, never bound. Picking the option is `command.run {id: command, args}` as
the member viewing the panel.

### 5.1 `visible_when`

Any block MAY carry `visible_when: "<condition>"` — a repeat block and a repeat's inner block
included. The condition is at most 500 characters and MUST parse **and** stay inside the
portable subset of the condition language ([rulepacks.md](rulepacks.md) §3): comparisons
`=== !== == != >= <= > <`, `&& || !` (or `and`, `or`, `not`), parentheses, number, string,
`true`, `false`, `null` and `undefined` literals, and references. Arithmetic, unary minus,
function calls (including `getvar`) and bracket segments are refused. Every reference is a
**path** (§4.2) whose handle is in scope.

A reference reads its path as a binding does, except that a condition sees **scalars only**:
a list or a record reads as whether it holds anything (`me.character`, `party.initiative`,
`tide.boats` — a list without its hidden elements), and an absent path reads as `null`.
Comparison semantics are the condition language's, not JavaScript's: `"abc" > 5` is an error.

### 5.2 `repeat`

```yaml
- repeat:
    each: <path to a list>
    as: <handle>          # optional, default `item`
    prefix: <text>        # optional, at most 128 characters
    block: <one template block>
  visible_when: <condition>   # optional, decides for the whole list
```

`block` is instantiated once for each element of the list (hidden elements removed first),
with the element readable under the handle `as` — in its bindings and in its own
`visible_when`. With `prefix`, only the elements whose key (§4.2) starts with it are kept:
`{each: vars.tree, as: leaf, prefix: "mvu.party.", block: …}` walks one branch of the
variable tree. Repeats do not nest; `as` MUST NOT be a declared handle (`handle_shadowed`).

## 6. Instantiation (normative)

Every client instantiates a template — a template panel's `blocks`, a page's `fallback` —
for its own viewer, against the views it holds. The protocol package's `instantiate` is the
reference; the shared table `clients/protocol/src/v3/panels.vectors.json` is the contract,
and every implementation MUST produce exactly the blocks it lists.

1. **Fail closed.** A binding whose path is absent — its view not held, its handle not
   declared, its segment not there — is a miss. A miss, or an unusable value, in a
   **required** field drops the whole block; in an **optional** field, only that field.
   A `choices` option whose label misses, or with no command, is dropped; a `choices` block
   left with no option is dropped. A `meter` whose `max ≤ min` is dropped. An unknown block
   kind is dropped.
2. **`visible_when`** hides its block when the condition is false, when it errors, and when
   the client cannot evaluate it. A gate on a repeat hides the whole expansion; a gate on the
   inner block decides each instance on its own. A client that does not implement
   `visible_when` MUST NOT render a block that carries it.
3. **`repeat`** keeps at most **32** instances, in list order, counted after the `prefix`
   filter — the 33rd element on is not shown.
4. **Caps.** A template of more than 32 blocks, or a panel of more than 8 views, shows
   nothing; a path over 200 code points or 8 parts is a miss.
5. **Coordinates.** A `map_pin`'s `x` and `y` are fractions of the map's own box, clamped to
   [0, 1].
6. **An empty result is legitimate.** A text client leaves a panel with nothing to show out
   of its sidebar.

**`visible_when` is presentation, never secrecy.** A gated block's content and the condition
ship to every viewer the panel is listed to. Secrecy is what each viewer's **views** hold —
computed per viewer by the runtime (and, for a module view, by its module) — together with
`audience`.

## 7. Pages

A page is **one self-contained HTML file**: its scripts, styles and pictures are inline (a
`data:` URI for a picture). At most 2 MiB, UTF-8. It is not code the server runs: the server
validates it as a file, digests it, and when its pack is enabled registers it as the room's
**unlisted media** — fetchable over the byte channel by the room's members, or by its admins
only when the panel is listed to admins only, and by nobody outside the room. The `panels`
view gives its `{hash, size, mime: "text/html"}`.

A client that runs pages MUST:

- run each page in an isolated frame with an **opaque origin** and no access to the host
  application beyond the bridge below;
- give the page **no network capability**: it holds room data;
- hand it only the values of the views its panel declared, for the member viewing it, and
  the events of the room's log;
- let it act only through `command.run`, as that member.

**Bridge.** The reference bridge is the host object `window.loreweaver`; its shape is the
desktop client's to define and is not fixed by this version. A client that does not run
pages renders the page's `fallback`, or one localized "needs a rich client" line for
`fallback: null`.

## 8. What is refused

A pack is refused, before anything is installed, when a panels file: does not parse
(`panels_invalid`, with the panel problem's code and path: `unknown_key`, `missing_field`,
`bad_field`, `bad_id`, `too_long`, `too_many`, `duplicate`, `bad_view_name`, `bad_binding`,
`bad_path_syntax`, `unknown_handle`, `unused_view`, `handle_shadowed`, `repeat_nested`,
`bad_condition`, `bad_path`, `audience_conflict`, or `replaced_2x` for a 1.0 field); is over
256 KiB (`panels_too_large`); repeats a panel id of another panels file (`panels_duplicate`);
brings the pack over 16 panels (`panels_too_many`); names a page that is missing
(`missing_file`), over 2 MiB or empty (`page_too_large`) or not UTF-8 (`not_utf8`); or names
a picture that is missing or not an image (`panel_asset_missing`, `panel_asset_type`). A
script file beside a page (`ui/chart.js`) is refused like any undeclared code
(`undeclared_script`).

## 9. From panels 1.0

| 1.0 | 3.0 | Why |
|---|---|---|
| `{$var: "day"}` | `{$view: "vars.module.day.value"}` with `views: {vars: variables}` | Data comes from views; a module's own state is better published as a module view (`{$view: "tide.day"}`). |
| `repeat: {prefix, block}` over variables, `{$leaf: id\|label\|value}` | `repeat: {each, as, prefix?, block}`, `{$view: "item.<field>"}` | A repeat walks a list inside a view. |
| `visible_when: "day >= 46"` (variable ids) | `visible_when: "vars.module.day.value >= 46"` (paths) | The same paths as bindings. |
| a bound enum showed its `value_label` | bind `….valueLabel` explicitly | One rule fewer: the view carries both. |
| choice `input` (typed text) | `command` + `args` | 3.0 acts through commands. |
| `audience: keeper` | `audience: admin` | 3.0's member roles are player, admin and observer. |
| tier 2 `entry` + `assets` (HTML, JS, CSS) | `entry`: one self-contained HTML file | A page travels as one content-addressed file; a pack carries no undeclared code. |
| `ui_manifest`, `panel_event`, `panel_intent`, `state.variables` | the `panels` view, other views, `command.run` | Views are the only channel for panel data. |

`hidden` elements stay out of every panel, as 1.0's hidden variables did.
