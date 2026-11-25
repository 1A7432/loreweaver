*[English](hooks.md) · 中文*

# 写 `hooks.js`——事件钩子作者参考

事件钩子让技能或卡能带上**行为**：挂在回合生命周期上的 JavaScript 处理器，跑在和完整 EJS 同一个 QuickJS 沙箱里。钩子可以读房间变量、跨回合保存自己的私有状态、给守秘人提供回合中途可调用的确定性机制（模组动作）、往本回合的守秘人提示词里加段落、追加或改写叙事，还能在已连接的客户端里画声明式 UI。这一页是作者参考——事件、API、限额、失败语义；架构层面的契约在 [plugins.md](plugins.md)（Layer C.1）。

两条事实框住其余一切：

1. **钩子只提请求，引擎负责落实。** 处理器发出的每个效果都先进缓冲区；处理器返回后，由确定性引擎代码校验、限量、应用。钩子做的任何事都绕不开规则。
2. **钩子永远坏不了回合。** 脚本写坏、处理器抛错、死循环、没装 `ejs` extra——统统退化成「钩子失效（留日志）」，回合照常进行，只是没有你参与。

前提：服务端装了 `ejs` extra 且 `TRPG_ENABLE_FULL_EJS` 没有设为 `false`。这个开关只管钩子和完整 EJS；规则脚本和筹备脚本不受它影响。

## 钩子放在哪

- **随技能：** 在技能的 `SKILL.md` 旁边放一个 `hooks.js`。技能为房间启用时它就生效——开关就是现成的 `.skill enable <id>`，不用学新东西。
- **随卡：** 原生包（`*.lorecard.json`，format v1）把脚本放在顶层 `hooks` 列表里（字符串或 `{code: "…"}` 对象）；酒馆形状的卡用 `extensions.loreweaver_hooks` 脚本字符串列表。带钩子的卡就是**世界卡**：由管理员以 `.import <文件> world` 导入时装上（玩家的人物导入会剥掉它们——见 [cards.zh.md](cards.zh.md)）；**重新导入这张卡会替换它的脚本**，不会叠加出重复。

一个房间最多跑 **16 个脚本**，每个最多 **1,000,000 字符**、合计最多 **8,000,000 字符**（超过合计的脚本按顺序跳过）；超出的直接跳过并记警告。

## 事件

用 `on(事件, 处理器)` 注册：

```js
on("turn_start",        (event) => { ... });  // event.user_message、event.actor
on("reply_ready",       (event) => { ... });  // event.reply
on("dice_rolled",       (event) => { ... });  // event.rolls: [{tool, result}]
on("variables_changed", (event) => { ... });  // event.writes: [{path, op: "set"|"insert"|"delete"|"add"|"move"}]
on("clock_advanced",    (event) => { ... });  // event.from、event.to、event.delta
on("tool_use",          (event) => { ... });  // event.tool、event.arguments——可 denyTool(理由)
```

- **`turn_start`**——守秘人开始思考之前触发，带着玩家输入。这是 `inject()` 唯一有意义的事件：注入的段落会进入**本**回合的守秘人提示词。它的 `narrate()` 文本会先被留住，再作为所有钩子叙述中的第一条追加到回复后面（见下表）；`rewriteReply()` 和 `denyTool()` 在这里不起作用。
- **`reply_ready`**——守秘人的叙事已经完成，`event.reply` 是全文。`narrate()` / `rewriteReply()` 该在这里用。
- **`dice_rolled`**——本回合有骰子工具结算了。
- **`variables_changed`**——本回合发生了变量写入：钩子自己的写入、回复自带的 `<UpdateVariable>` 命令、守秘人的 `set_variable`／`adjust_variable`／`set_stat`／`adjust_stat` 工具调用，一律计入。**每回合最多触发一次**，所以一个「响应变量变化又去写变量」的钩子不可能无限连锁——终止是构造出来的，不是靠自觉。
- **`clock_advanced`**——守秘人本回合推进了游戏内时钟（`game_clock advance`），每次推进触发一次，带着旧钟面、新钟面和原始增量文本。模组侧历法该写在这里：日期计数、死线倒计时、定时凶兆。
- **`tool_use`**——每次守秘人工具调用**之前**触发，带着工具名和参数。唯一能拒绝的事件：`denyTool(理由)` 拦下这次调用，理由会回喂给模型（例如 `on("tool_use", (e) => { if (e.tool === "game_clock") denyTool("此景时间冻结"); })`）。字段名必须读准——守卫读了本事件不携带的字段就永远不会触发，无声无息，它本该守住的门一直敞着。事件名要照字面写（`on("tool_use", …)`）：书记官只为脚本里出现 `tool_use` 这段文字的房间构建它的否决解释器，所以运行时拼出来的事件名挡得住守秘人，却挡不住书记官。

每个事件还带着 **`event.seed`**——见下文[种子](#种子eventseed)。

处理器可以是 `async` 的；Promise 被拒绝会被捕获并记为警告。某个处理器抛错只会丢掉它自己的效果，其他处理器照常跑。处理器错误和 `log(text)` 的内容都会以警告级写进服务器日志，标明房间和事件。

## 处理器里有什么

完整的模板桥都在：

- **变量：** `getvar(名)`、`setvar(名, 值)`、`incvar(名, 增量)`，外加 `variables` / `stat_data` 两个树视图，以及作为 `_` 的 lodash。
- **写入走校验路由：** 名字命中用 `define_variable` 声明过的模组变量时，走它的类型/边界校验（有钳位的数值始终被钳住）；其他名字落进导入卡（MVU）变量树。写失败就跳过并报告，绝不致命。每次事件分发最多应用 **64 次写入**。
- **快照语义：** 变量在本回合解释器构建时快照，并在每次[模组动作](#模组动作defineaction)之前从存储重新读取（所以动作能看到守秘人回合中途的写入，本回合排在它之后的处理器看到的是该动作时刻的存储）。处理器能看到**自己**先前的写入——但那是**请求值**、未经校验（越界的 `setvar` 在沙箱里读回来是原样，库里存的才是被夹回边界的值）；除非中间有动作刷新过视图，否则看不到本回合中途守秘人工具的写入，也看不到回复自带 `<UpdateVariable>` 协议的写入。特别地：在 `variables_changed` 处理器里，对引擎应用的写入 `getvar(path)` **不能保证**返回新值；事件只告诉你改了什么、怎么改（`{path, op}`），从不携带值。到下一回合一切重新一致。
- **信任层级：** 钩子是模组逻辑，看到的是变量的**守秘人视图**，包括仅守秘人可见的状态量。你选择发给玩家的内容属于作者产出——绝不要把守秘人专属材料放进 `narrate` / `emitUI`。
- **私有状态：** `getstate(key)` / `setstate(key, value)`——根本不是变量的机制状态（见下一节）。

效果发射器：

| 发射器 | 作用 | 限额（除注明外按每次事件分发计） |
|---|---|---|
| `inject(text)` | 往本回合守秘人提示词里加一段（仅 `turn_start`） | 8 × 4,000 字符 |
| `narrate(text)` | 追加到玩家可见回复后面，按事件顺序：`turn_start`、`dice_rolled`、`clock_advanced`、`reply_ready`、`variables_changed`（后面的处理器在 `event.reply` 里能看到前面的叙述）。在 `tool_use` 和模组动作里被忽略；provider 失败的回合一条都不送出 | 8 × 2,000 字符 |
| `rewriteReply(text)` | 替换玩家可见回复 | 1 × 4,000 字符 |
| `emitUI(blocks, opts?)` | 在客户端画声明式 UI（见下） | 8 次发射 |
| `emitPanel(panelId, payload)` | 把一份不透明的 JSON 载荷发给某个模组面板自己的代码（`panel_event` 帧） | 每**回合** 20 次，每次 32 KiB |
| `log(text)` | 往服务器日志写一行警告级记录 | — |

## 私有状态——`getstate` / `setstate`

钩子的 JavaScript 全局变量只活一个回合（见下文「沙箱」）。凡是要跨回合活下来的东西都是引擎持有的状态，而它有两种。按**谁来读它**来选：

- **牌桌或守秘人应该看到的状态量 → 变量**（`setvar`/`incvar`，能声明就用 `define_variable` 声明）。变量会进守秘人提示词、面板、条件、`variables_changed` 和书记官（Scribe）——这本来就是它的职责。
- **只有你的钩子自己读的机制状态 → `setstate`。** 账本、队列、按角色的表、骰子历史、状态机内部。它永远不会渲染进守秘人提示词，永远不会出现在任何玩家或管理员的线上帧里，永远不算一次 `variables_changed` 写入，也不进回合的钩子写入列表；书记官看不见它，条件、面板 `$var` 绑定和 `getvar` 也都解析不到它。

```js
on("dice_rolled", (event) => {
  const ledger = getstate("crossing") ?? { hours: [] };   // 一份新拷贝，或 undefined
  ledger.hours.push(event.rolls.length);
  setstate("crossing", ledger);                           // 先进缓冲；由引擎持久化
});
```

- **API（只有钩子有——世界书 EJS 模板拿不到）：** `getstate(key)` 返回存储值的一份新拷贝，键不存在时返回 `undefined`。改这份拷贝什么都不会变，除非你再 `setstate` 回去。`setstate(key, value)` 存任意 JSON 值（对象、数组、字符串、数字、布尔），存的是调用那一刻的样子；`setstate(key, null)` 或 `setstate(key)` 删除这个键。不是 JSON 的值——函数、循环引用、内部任何位置的 `NaN`/`Infinity`——当场拒绝并留日志。
- **契约和 `setvar` 一样：** 写入先缓冲在沙箱里，分发结束后由引擎校验、限量、持久化。处理器立刻就能看到自己先前的 `setstate` 写入。每次分发之后，沙箱都会重新同步到引擎实际存下的内容，所以被引擎拒绝的写入只在发出它的那次分发结束前可见。要在处理器里调用它：脚本顶层的 `setstate` 不属于任何事件，会被丢弃（留日志）。
- **快照：** 沙箱里的状态视图在每个阶段开始时都等于已持久化的状态：本回合解释器构建时读一次，回复阶段开始时再读一次，每次模组动作之前也再读一次。（钩子是这个存储唯一的写入者，但同伴的嵌套回合会在它自己的解释器上运行房间的钩子，所以真相在存储里，不在快照里。）本回合的每个事件——`turn_start`、`dice_rolled`、`clock_advanced`、`reply_ready`、`variables_changed`——的写入都会持久化。**`tool_use` 不会：** 它只有 `denyTool` 生效，所以它的 `setstate` 写入被丢弃（留日志）、沙箱视图回滚，和它那里的变量写入同样不被应用是一致的。
- **限额：** 键为 1–64 个 `A–Z a–z 0–9 _ . : -` 字符，且不能是 `__proto__`、`constructor` 或 `prototype`；每个值 ≤ 1 MiB（紧凑 JSON 的 UTF-8 字节数）；每个房间 ≤ 64 个键、总计 ≤ 4 MiB；每次事件分发 ≤ 32 次 `setstate` 写入。超限的写入被跳过并记为钩子警告——绝不致命，其余写入照常落地。存储中被损坏的值读出来就是不存在。
- **生命周期：** 它是房间状态，所以 `.undo` 会随回合一起回退它，房间导出会带上它，`.reset all` 会清掉它（和清掉模组变量是同一级；`.reset story` 和 `.reset chars` 会保留它，正如保留变量）。开发房间（`.dev mount`）重载会保留它。

## 模组动作——`defineAction`

事件围着守秘人触发；**模组动作**则是守秘人去调用的机制。回复阶段的事件（`dice_rolled`、`reply_ready`……）在叙述定稿之后才运行，所以在那里记一小时行军的钩子记得太晚了：守秘人早已自己叙述出了一个数。动作在回合之内作答——它的返回值就是守秘人下一轮读到的工具结果。

```js
defineAction("book_hour", {
  description: "Book one march hour of the crossing and return the booked line",
  params: '{pace: "fast"|"slow"}',
  rolls: { march: "8d10" },                    // 处理器运行之前由引擎掷出
}, (args, event) => {
  const ledger = getstate("crossing") ?? { crossed: 0, hours: 0 };
  const faces = event.rolls.march.dice;        // event.rolls.march = {expr, total, dice}
  const successes = faces.filter((d) => d >= (args.pace === "fast" ? 7 : 6)).length;
  const gain = successes * (args.pace === "fast" ? 30 : 25);
  ledger.crossed += gain;
  ledger.hours += 1;
  setstate("crossing", ledger);                // 机制状态：只有钩子可见
  setvar("crossed_count", ledger.crossed);     // 牌桌看得到的状态量
  emitUI([{ kind: "meter", label: "Crossed", value: ledger.crossed, min: 0, max: 800 }],
         { panel: "sidebar", id: "crossing" });
  return `Hour ${ledger.hours} (${args.pace}): ${successes} successes, +${gain}; ${ledger.crossed} of 800 across.`;
});
```

守秘人看到的是一个工具 `module_action(action, args)`，它的描述按注册顺序把每个动作列成 `名字 — 描述 [params]`；`action` 是这些名字的枚举。已经过了 325 时，`module_action({action: "book_hour", args: {pace: "slow"}})` 掷出 `[10, 8, 6, 4, 6, 2, 4, 10]`，返回 `"Hour 4 (slow): 5 successes, +125; 450 of 800 across."`——守秘人叙述的就是**这个**。

- **注册：** 在任意钩子脚本里调用 `defineAction(name, spec, handler)`。`name` 为 `[a-z][a-z0-9_]{0,31}`。`spec.description` 必填（≤ 200 字符）；`spec.params` 是可选的参数形状自由文本提示（≤ 400 字符）；`spec.rolls` 可选，把至多 8 个标识符槽位映射到骰子表达式。未知的 spec 键被忽略。不合格的注册被丢弃并记加载警告；重名时第一个合格的注册生效；每个房间至多 **24** 个动作。
- **处理器** 收到 `args`（模型给的 JSON 对象，≤ 8 KiB）和 `event`——`{actor, seed, rolls, source}`，其中 `source` 是 `"keeper"` 或 `"player"`（见下文），`rolls` 是由真实骰子引擎掷出的 `{槽位: {expr, total, dice}}`（牌桌会看到骰子帧；没声明 `rolls` 的动作不发骰子帧）。处理器可以是 `async` 的。返回字符串就原样使用，返回其他值就用紧凑 JSON 字符串化，什么都不返回则守秘人得到一行简短的“已完成”。结果在 4,000 字符处截断，并带可见的截断标记。
- **效果** 立即生效，走的路径和事件一样：`setvar`（经过校验，并算作本回合的钩子写入——`variables_changed` 会报告它们，书记官不会去碰）、`setstate`、`emitUI`、`emitPanel`（每回合上限照旧）。`inject`、`narrate`、`rewriteReply` 和 `denyTool` 在动作里被忽略（留日志）：返回结果就是动作的声音。
- **新鲜视图：** 每次调用之前，引擎都从存储重新读取变量和私有状态，所以动作能看到守秘人回合中途的写入，以及之前每个动作的写入。
- **失败什么都不应用。** 处理器抛错、超时（1 秒）、始终不落定，或者返回不是 JSON 的东西，守秘人就会收到一行带错误文本的失败信息；它的效果一律不应用，沙箱视图回滚。回合照常继续。
- **守卫：** `tool_use` 处理器能像看到其他工具调用一样看到 `module_action` 调用（`e.arguments.action`、`e.arguments.args`），并可以 `denyTool`。每个守秘人回合至多 **16** 次动作调用；超过之后工具会告诉守秘人用已有的结果来叙述。调用从不并发执行。
- **工具什么时候存在：** 只在本回合的钩子注册了至少一个动作时才有；钩子关闭（`TRPG_ENABLE_FULL_EJS=false`）就没有这个工具。准备阶段和游玩阶段都提供。动作的骰子不会触发 `dice_rolled`——动作已经处理过它们了。

### 玩家动作——`player: true`

> **玩家动作的结果是玩家可见的。** 成员执行它时，处理器返回的一切都会广播给整张牌桌——和 `narrate`、`emitUI` 是同一个信任立场。`player: true` 的动作在玩家路径上绝不要返回守秘人专属的内容；一个动作要同时服务两种受众，就按 `event.source` 分支。

再加两个可选的 spec 字段，动作就成了任何房间成员都能直接执行、不需要守秘人跑一轮的东西——给重模拟的模组用的 MUD 节奏小动作：

```js
defineAction("forage", {
  description: "Search the hedgerow for food",
  params: "{where?: string}",
  player: true,                                  // 成员可以用 `.act` 执行
  label: { en: "Forage", zh: "采集" },           // 每个 ≤ 60 字符；也可以是一个普通字符串
  rolls: { find: "1d6" },
}, (args, event) => {
  const pantry = (getstate("pantry") ?? 0) + event.rolls.find.total;
  setstate("pantry", pantry);
  setvar("food", pantry);
  return event.source === "player"
    ? `You find ${event.rolls.find.total} handfuls. The pantry holds ${pantry}.`
    : `Forage booked: +${event.rolls.find.total}, pantry ${pantry}.`;
});
```

- **`.act`** 列出房间里的玩家动作（`显示名（id）— 描述 [params]`，只发给调用者）；**`.act <名字> [参数]`** 执行其中一个。能解析成 JSON 对象的参数就是 args；其他内容以 `{"text": "<输入的文字>"}` 送达；什么都不写就是 `{}`。未知的名字和没有 `player: true` 的动作得到同样的回复，所以守秘人专属的动作永远不会被报给玩家。
- 处理器拿到 `event.source: "player"`（守秘人的 `module_action` 工具传 `"keeper"`）；两条路径上 `event.actor` 都是发起调用的成员。
- 它像 `.ra` 一样运行：在房间的回合锁和输入频率限制之内，结果是一条全房间可见的 `system` 消息（声明了 `rolls` 时带骰子帧，入房回放时也会重放），失败只发给调用者。效果走和工具相同的路径；`emitUI`/`emitPanel` 帧会送达，房间的 `state` 会刷新。它写了变量时，事后会触发一次 `variables_changed`（其中 `narrate()` 的内容并入回复），所以模组逻辑在两条路径上表现一致。
- **没有每回合上限**（普通的输入频率限制管着它），也**不经过 `tool_use` 检查**：它不是工具调用，所以 `denyTool` 守卫看不到它。
- **守秘人会知道：** 每个结果（最近 8 条，每条 400 字符）会进入守秘人下一次提示词里一小段「自你上一回合以来，玩家执行了……」，随后清空。
- **种子：** `.act` 在守秘人回合之外运行，所以它的种子流是 `command:action:<n>`，`n` 是房间内 `.act` 调用的计数器（撤销会把它回退）。
- **客户端：** 协议 2.6 在每个 `state` 帧上列出玩家动作（`state.actions`），客户端可以把它们做成按钮；这份列表在每次构建房间钩子引擎时缓存（每个守秘人回合、每次 `.act`、安装钩子、开关技能），可能短暂落后于变化。

## 种子——`event.seed`

每次分发——六个事件以及每次动作调用——都带着 `event.seed`：一个小于 2^53 的非负整数，由房间、进行中的回合以及这次分发在本回合里的位置推导出来。不存任何新东西：同样的房间状态推出同样的种子，所以 `.undo` 之后重试这个回合会重放出同样的种子。这是有意为之——它让钩子的随机性可以重放。`Math.random()` 不可重放；钩子需要自己的随机数时，用 `event.seed` 给一个小 PRNG 播种：

```js
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
on("turn_start", (event) => { const rand = mulberry32(event.seed); /* … */ });
```

对牌桌有意义的骰子归骰子引擎（`spec.rolls`），不归 PRNG。书记官的 `tool_use` 检查跑在它自己的解释器上、有自己的种子流，所以那里的 `tool_use` 种子和本回合的不同。

## `emitUI`——声明式模组 UI

`emitUI(blocks, opts?)` 把校验过的 UI 块作为 `ui` 帧发给客户端（线上 schema 见 [protocol.zh.md](protocol.zh.md)）。块类型：

```js
{kind: "meter",   label, value, min, max}          // 有界仪表
{kind: "stat",    label, value}                    // 一个带标签的值
{kind: "badge",   label, tone?}                    // tone: "info" | "warn" | "danger"
{kind: "text",    text, style?}                    // style: "quote" | "warning"
{kind: "divider"}
{kind: "choices", prompt?, options: [{id, label, input}]}
{kind: "image",   hash, mime?, caption?, alt?}     // 按 sha256 内容哈希（64 位十六进制）引用图片
// 四种演出模板：
{kind: "letter",     body, from?, to?, date?}
{kind: "clipping",   headline, body, source?, date?}
{kind: "map_pin",    label, hash, x, y, note?}     // x、y：占地图图片的 0..1 比例
{kind: "title_card", title, subtitle?, act?}
```

`image` 和 `map_pin` 按内容哈希引用图片，该哈希必须在房间媒体里可达，否则这个块在上线前就被丢弃。缺必填字段的块被丢弃；可选字段不合规只剥掉该字段，块保留。

选项（第二个参数）：`panel: "inline" | "sidebar"`（默认 `"inline"`——插进叙事流；`"sidebar"` 渲染成常驻面板）、`id`（给 UI 区域命名——后来的同 `id` 侧栏帧会替换该区域内容）、`replace: true`（行内帧可以原地更新前一个同 `id` 行内帧）。

玩家点了 `choices` 的某个选项，该选项的 `input` 字符串会**像玩家自己敲的一样**发回服务器——就是一个普通输入帧，没有新协议机制。

UI 帧**不会在入房时重放**：想要常驻面板的钩子每回合重发一次就行（开销很小，配合固定 `id` 天然幂等）。

限额：每次事件分发 8 次发射 × 每次 16 块；每个 `choices` 最多 12 个选项；label 120 字符、text 2,000、prompt 200、选项 input 200、`id` 64。不合 schema 的块被丢弃，同次发射的其余块保留。

## 失败语义（出问题时会发生什么）

- **加载时：** 沙箱时限在你的顶层代码运行*之前*就已上膛——顶层死循环会超时，不会挂住服务器。加载时抛错的脚本被跳过（留日志），其他脚本照常加载。
- **分发时：** 处理器异常变成警告（写进服务器日志）；整次分发失败（内存/时限）返回空结果。无论哪种，回合都会完成。失败的模组动作什么都不应用，并告诉守秘人它失败了。
- **环境：** 没装 `ejs` extra、`TRPG_ENABLE_FULL_EJS=false`、或没有注册任何脚本→本回合钩子失效，留日志，绝不致命。
- **沙箱：** 每回合一个全新解释器（没有跨回合、跨房间状态）、硬内存上限（64 MiB）、单次求值时限（1 秒）、零宿主 I/O。所以存在 JavaScript 全局变量里的计数器每回合都会悄无声息地归零：牌桌应该看到的，放进变量（`incvar`）；只有你的钩子读的，放进 `setstate`。
- **状态写入：** 失败的分发会连同其他效果一起丢掉它的 `setstate` 写入，沙箱视图退回到已存储的内容；持久化时存储出错会留日志，回合照常继续。

## 完整例子

给恐怖模组做一个恐惧仪表：每次掷骰上涨、常驻侧栏显示、越过阈值就开始影响守秘人。先在模组设置里声明这个状态量（`define_variable`：类型 `number`、0–10、玩家可见），写入就会被引擎钳位；然后钩子是：

```js
on("dice_rolled", (event) => {
  incvar("fear", event.rolls.length);
  emitUI(
    [{ kind: "meter", label: "恐惧", value: getvar("fear"), min: 0, max: 10 }],
    { panel: "sidebar", id: "fear-hud" }
  );
});

on("turn_start", () => {
  if (getvar("fear") >= 8) {
    inject("小镇已经失去理智：天一擦黑就闩门，敲多久都没人应。");
  }
});
```

例子里的每一步都走契约：`incvar` 被状态量的边界钳在 0–10，仪表先过 schema 校验才会被任何客户端看到；哪天脚本坏了，模组照跑不误——只是少了它的恐惧仪表。
