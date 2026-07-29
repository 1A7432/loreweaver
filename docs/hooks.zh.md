*[English](hooks.md) · 中文*

# 写 `hooks.js`——事件钩子作者参考

事件钩子让技能或卡能带上**行为**：挂在回合生命周期上的 JavaScript 处理器，跑在和完整 EJS 同一个 QuickJS 沙箱里。钩子可以读房间变量、往本回合的守秘人提示词里加段落、追加或改写叙事，还能在已连接的客户端里画声明式 UI。这一页是作者参考——事件、API、限额、失败语义；架构层面的契约在 [plugins.md](plugins.md)（Layer C.1）。

两条事实框住其余一切：

1. **钩子只提请求，引擎负责落实。** 处理器发出的每个效果都先进缓冲区；处理器返回后，由确定性引擎代码校验、限量、应用。钩子做的任何事都绕不开规则。
2. **钩子永远坏不了回合。** 脚本写坏、处理器抛错、死循环、没装 `ejs` extra——统统退化成「钩子失效（留日志）」，回合照常进行，只是没有你参与。

前提：服务端装了 `ejs` extra 且 `TRPG_ENABLE_FULL_EJS` 没有设为 `false`（这一个开关管住所有沙箱 JS 面）。

## 钩子放在哪

- **随技能：** 在技能的 `SKILL.md` 旁边放一个 `hooks.js`。技能为房间启用时它就生效——开关就是现成的 `.skill enable <id>`，不用学新东西。
- **随卡：** 卡的 `extensions.loreweaver_hooks` 是一个脚本字符串列表，导入卡时装上；**重新导入这张卡会替换它的脚本**，不会叠加出重复。

一个房间最多跑 **16 个脚本**，每个最多 **40,000 字符**；超出的直接跳过并记警告。

## 事件

用 `on(事件, 处理器)` 注册：

```js
on("turn_start",        (event) => { ... });  // event.user_message、event.actor
on("reply_ready",       (event) => { ... });  // event.reply
on("dice_rolled",       (event) => { ... });  // event.rolls: [{tool, result}]
on("variables_changed", (event) => { ... });  // event.writes: [{path, value}]
```

- **`turn_start`**——守秘人开始思考之前触发，带着玩家输入。这是 `inject()` 唯一有意义的事件：注入的段落会进入**本**回合的守秘人提示词。
- **`reply_ready`**——守秘人的叙事已经完成，`event.reply` 是全文。`narrate()` / `rewriteReply()` 该在这里用。
- **`dice_rolled`**——本回合有骰子工具结算了。
- **`variables_changed`**——本回合发生了变量写入。**每回合最多触发一次**，所以一个「响应变量变化又去写变量」的钩子不可能无限连锁——终止是构造出来的，不是靠自觉。

处理器可以是 `async` 的；Promise 被拒绝会被捕获并记为警告。某个处理器抛错只会丢掉它自己的效果，其他处理器照常跑。

## 处理器里有什么

完整的模板桥都在：

- **变量：** `getvar(名)`、`setvar(名, 值)`、`incvar(名, 增量)`，外加 `variables` / `stat_data` 两个树视图，以及作为 `_` 的 lodash。
- **写入走校验路由：** 名字命中用 `define_variable` 声明过的模组变量时，走它的类型/边界校验（有钳位的数值始终被钳住）；其他名字落进导入卡（MVU）变量树。写失败就跳过并报告，绝不致命。每回合最多应用 **64 次写入**。
- **快照语义：** 变量每回合快照一次。处理器能看到**自己**先前的写入，但看不到本回合中途守秘人工具做的写入——到下一回合一切重新一致。
- **信任层级：** 钩子是模组逻辑，看到的是变量的**守秘人视图**，包括仅守秘人可见的状态量。你选择发给玩家的内容属于作者产出——绝不要把守秘人专属材料放进 `narrate` / `emitUI`。

效果发射器：

| 发射器 | 作用 | 每回合限额 |
|---|---|---|
| `inject(text)` | 往本回合守秘人提示词里加一段（仅 `turn_start`） | 8 × 4,000 字符 |
| `narrate(text)` | 追加到玩家可见回复后面 | 8 × 2,000 字符 |
| `rewriteReply(text)` | 替换玩家可见回复 | 1 × 4,000 字符 |
| `emitUI(blocks, opts?)` | 在客户端画声明式 UI（见下） | 8 次发射 |
| `log(text)` | 往服务器日志写一行警告级记录 | — |

## `emitUI`——声明式模组 UI

`emitUI(blocks, opts?)` 把校验过的 UI 块作为协议 v1.7 的 `ui` 帧发给客户端（线上 schema 见 [protocol.zh.md](protocol.zh.md)）。块类型：

```js
{kind: "meter",   label, value, min, max}          // 有界仪表
{kind: "stat",    label, value}                    // 一个带标签的值
{kind: "badge",   label, tone?}                    // tone: "info" | "warn" | "danger"
{kind: "text",    text, style?}                    // style: "quote" | "warning"
{kind: "divider"}
{kind: "choices", prompt?, options: [{id, label, input}]}
```

选项（第二个参数）：`panel: "inline" | "sidebar"`（默认 `"inline"`——插进叙事流；`"sidebar"` 渲染成常驻面板）、`id`（给 UI 区域命名——后来的同 `id` 侧栏帧会替换该区域内容）、`replace: true`（行内帧可以原地更新前一个同 `id` 行内帧）。

玩家点了 `choices` 的某个选项，该选项的 `input` 字符串会**像玩家自己敲的一样**发回服务器——就是一个普通输入帧，没有新协议机制。

UI 帧**不会在入房时重放**：想要常驻面板的钩子每回合重发一次就行（开销很小，配合固定 `id` 天然幂等）。

限额：每回合 8 次发射 × 每次 16 块；每个 `choices` 最多 12 个选项；label 120 字符、text 2,000、prompt 200、选项 input 200、`id` 64。不合 schema 的块被丢弃，同次发射的其余块保留。

## 失败语义（出问题时会发生什么）

- **加载时：** 沙箱时限在你的顶层代码运行*之前*就已上膛——顶层死循环会超时，不会挂住服务器。加载时抛错的脚本被跳过（留日志），其他脚本照常加载。
- **分发时：** 处理器异常变成警告；整次分发失败（内存/时限）返回空结果。无论哪种，回合都会完成。
- **环境：** 没装 `ejs` extra、`TRPG_ENABLE_FULL_EJS=false`、或没有注册任何脚本→本回合钩子失效，留日志，绝不致命。
- **沙箱：** 每回合一个全新解释器（没有跨回合、跨房间状态）、硬内存上限（64 MiB）、单次求值时限（1 秒）、零宿主 I/O。

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
