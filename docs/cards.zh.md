*[English](cards.md) · 中文*

# 把你的酒馆卡带过来

你手里存着一堆角色卡和世界书。这一页讲清楚它们丢进 Loreweaver 之后会发生什么：什么能导入、什么真的能跑，以及哪些地方会和酒馆里不一样——因为卡现在活在一个掷真骰子的游戏引擎里。这是写给卡作者和卡玩家的；背后面向贡献者的完整契约在 [plugins.md](plugins.md)。

一句话总结：**卡和世界书原样导入，不需要转换；卡里依赖的变量、模板、触发机制都能跑**——跑在一个掷真骰、校验每个数值的引擎里。

## 什么能导入

- **角色卡**——SillyTavern **V2/V3**（`chara_card_v2` / `chara_card_v3`），JSON 或内嵌 `chara` 块的 PNG 都行。会读取的字段：`name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`、`system_prompt`、`post_history_instructions`、`alternate_greetings`、`tags`、`creator`、`character_version`、`character_book`、`extensions`。不认识的字段忽略、不报错——新版本酒馆导出的卡照样能进。
- **世界书**——卡内嵌的 `character_book`，或独立的世界书 JSON。V2 的 `character_book` 字段名和酒馆原生 world-info 字段名都认。
- **MVU 变量**——`[InitVar]` / `[InitialVariables]` / `@@initial_variables` 条目在导入时被读进按房间隔离的变量树（容忍 JSON5、支持中文嵌套路径、`[值, "说明"]` 叶子）。它们按数据处理，不算 lore——不占提示词预算，而且**重新导入同一张卡绝不会重置房间已有的变量进度**。
- **钩子**——卡可以带 `extensions.loreweaver_hooks`：挂在回合生命周期上的沙箱 JavaScript。这是 Loreweaver 自己的扩展点（Tavern Helper 的思路，由引擎校验落地），见 [hooks.zh.md](hooks.zh.md)。

## 怎么导入

- **在终端客户端里：** 建卡有四条路——掷骰、手填、AI 起草、**导入卡**。不管走哪条，最后的卡面都要过当前规则系统的校验；数值不合规则包的卡会被修正，不会蒙混过关。
- **用命令：** `.import <卡文件> [coc7|dnd5e] [pc|companion]`。玩家可以自己导入自己上传到房间的卡；从服务器路径导入、或把卡导成 AI **同伴**（它会拿自己的卡、掷自己的骰上桌玩），只有守秘人能做。独立世界书用 `.lore import <文件>`（仅守秘人）。
- **随内容包：** 卡和世界书可以装进 `.lwpack` 内容包——`python -m app --install gh:owner/repo`——和技能、规则包、素材一起走（见 [plugins.md](plugins.md)）。

## 什么真的能跑

导入的卡不只是贡献文案——机制是真的在转，账由确定性代码来记：

- **世界书触发语义。** 主 `keys`；`secondary_keys` 的全部四种选择逻辑（AND ANY / AND ALL / NOT ANY / NOT ALL）；`probability`——由真代码掷出来，不是嘴上说说；大小写敏感与整词匹配；`scan_depth` 窗口；`position` 排序桶；计时效果——`sticky`、`cooldown`、`delay`——挂在按房间的回合计数器上；分组抽选（按权重，每组每回合只出一个）；带预算的插入。
- **MVU 协议端到端。** 卡自带的脚手架条目按普通 lore 导入，模型输出 `<UpdateVariable>` 块，引擎用真代码解析——五种操作（`set` / `insert` / `delete` / `add` / `move`）全支持——应用到变量树，并把这些块从玩家可见的叙事里剥掉。带 schema 校验的工具调用（`set_stat` / `adjust_stat` / `get_stat`）是通往同一棵树的首选通道。
- **完整 EJS——真 JavaScript。** 装了 `ejs` extra（默认开启）后，世界书和卡内容经官方 EJS 库 + lodash 在内嵌 QuickJS 沙箱里渲染：循环、函数、`await`、lodash 链、任意 JS 的 `@@if` 条件、`setvar`/`incvar`（先缓冲，渲染后由引擎代码统一应用）、`getwi`/`activewi`、`injectPrompt`、`execvar`。信任模型和酒馆本身一致：你的机器，你的卡。
- **宏。** `{{user}}`（当前 PC，渲染时解析）、`{{char}}`、`{{time}}` / `{{date}}`、`{{roll:XdY}}`、`{{random}}`、`{{pick}}`、`{{newline}}`、`{{// 注释}}`、`{{getvar::}}` / `{{var:}}`。
- **玩家可见的变量**会实时出现在终端客户端的状态量面板里——标量叶子，前缀 `mvu.`，你这边不用做任何额外工作。

## 这里有什么不一样（排查问题前先读这段）

Loreweaver 是游戏引擎，不是聊天前端。所有差异都从这一点来：

- **骰子是真的。** `{{roll:XdY}}` 由骰子引擎掷出；检定走规则代码结算。卡不能把结局预先写死（「这一击命中了」）——引擎先掷骰，模型只负责把结果讲成故事。
- **角色数值要过校验。** 导入的卡会变成当前规则系统（CoC 7 版或 D&D 5e SRD）里的一张真卡，由规则包钳位、校验。
- **`{{char}}` 在导入时绑定**——卡的角色身份不会漂移。`{{user}}` 保持动态（渲染时是谁的 PC 就是谁）。
- **`{{time}}` / `{{date}}` 是游戏内时钟**，不是现实时间。你写的「午夜」在*故事里的*午夜触发。
- **`faker` 是空实现**（返回空字符串并记一条警告）——不确定的随机文案和可复现的跑团冲突，而且很少真正承重。
- **`@INJECT` 消息位置注入无效。** Loreweaver 用自己的 prompt builder 组装单一系统提示词，没有可以按下标插入的客户端消息数组。
- **状态栏/渲染类条目导入后是禁用状态。** `[RENDER:*]`、`@@render_*`、`@@iframe` 是前端特性，在服务端没有意义；这些条目会保留但禁用，绝不进提示词。替代品是内置的状态量面板和[钩子](hooks.zh.md)的 `emitUI`——在真实客户端里画进度条、徽章和选项按钮。
- **没装 `ejs` extra 时**（或设了 `TRPG_ENABLE_FULL_EJS=false`，或模板抛错时），渲染回退到安全的 EJS 子集：`<% if / else %>` 链、`<%= %>` 输出、`getvar()` / `variables.路径` 读取、`{{getvar::}}` 宏、`@@if` 条件。子集是**只读的**（模板里的 `setvar` 在那里不生效），而且两头都兜底：原始模板语法永远不会漏给模型。
- **沙箱事实**（完整模式）：每回合一个全新解释器——没有跨回合、跨房间状态；硬内存上限和单次求值时限（死循环会超时，不会挂掉服务器）；零宿主 I/O；每回合模板写入有上限。

## 导入信任边界

导入的文件没资格给自己挑权限：

- **作用域钉死**在导入它的房间——卡写不了全局 lore。
- **`constant` 一律强制关闭**，对谁都一样。always-on 条目会让任何一张卡永久占据提示词；导入的 lore 和其他条目一样靠关键词和预算激活。
- **`secret` 只在守秘人亲自导入时生效**——不受信的卡造不出「仅守秘人可见」的 lore。
- **条目 id 重新生成**，卡没法定位（进而覆盖）另一张卡的条目。
- **重新导入是替换**该卡的钩子和条目，不会叠加出重复——并且如上所述，绝不重置变量进度。

开着完整 EJS 时，导入的卡就是在上述沙箱里跑代码——这正是设计意图，也是服务器主人知情后自己做的决定。想要纯数据姿态的话，设 `TRPG_ENABLE_FULL_EJS=false` 或不装 `ejs` extra。
