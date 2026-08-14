*[English](plugins.md) · 中文*

# Loreweaver 扩展契约：插件、技能与内容包

> 状态：**契约**（2026-08-07 更新；协议 **2.1**）。这份是贡献者照着建的规范。作者向的入口更友好：从零到发布的教程在 [authoring.zh.md](authoring.zh.md)，卡的细节在 [cards.zh.md](cards.zh.md)，钩子在 [hooks.zh.md](hooks.zh.md)。
>
> **已落地的层，以及各自的含义：**
>
> | 层 | 状态 |
> |---|---|
> | **A——数据插件** | 规则系统、卡、世界书、模组变量。`core/rulepacks.py` 是基于发现的数据加载器；M16 之后，一个规则包还拥有自己的**检定档位、卡表形状、子系统、命令写法和守秘人须知**，所以 coc7/dnd5e/wod 就是普通的包，删掉文件就删掉了系统 |
> | **B.1——KP 技能** | `SKILL.md` 加载器、提示段绑定、按房间 `.skill enable`、成人内容开关 |
> | **B.2——`allowed-tools`** | `@tool(gated=…)`：技能没要就看不见的额外工具；`romance-relationships` 跑在这套上 |
> | **B.3——自扩展 forge** | `generate_skill` / `generate_rulepack` / `generate_module` 三个工具，各自在对应的 forge 技能启用之前完全不可见。规则包 forge 说的是 M16 的 `resolution:` / `subsystems:` / `expertise:` 词汇 |
> | **B.4——TUI 管理页** | KP 技能页支持“描述一句话→生成” |
> | **C.1——事件钩子** | 沙箱 `hooks.js` 挂在回合生命周期上，带声明式 UI 输出 |
> | **C.2——Python 入口点插件** | **推迟**——唯一会以服务端权限运行的一层 |
> | **`.lwpack` 打包** | 清单 v2：完整文件清册、按真实载荷检测的卡类型、带迁移槽的 schema 版本；`gh:` release 分发 |
> | **D——模组 UI 面板（M15）** | 三个 tier 全落地：`ui/panels.yaml`、`.panels enable`、服务端解析的 `audience`、内容寻址的二级素材加强制的纯文本降级 |
> | **M16——规则外化** | 引擎与规则系统解耦；`agent/` 从不点名系统、也从不比较 rank id，由架构测试钉住 |
> | **M17——文档模型** | 房间里所有内容都是同一个 `Document` 类型；每种类型的 `project(doc, viewer)` 是信息隔离唯一的出线口 |
> | **M18——战役编年史** | `chronicle` / `campaign_summary` / `thread` 文档、确定性折叠策略、`.recap` / `.chronicle` |
> | **M19——演出导演** | 演出资料包（`ui/presentation.yaml`）、几种演出区块（`letter` / `clipping` / `map_pin` / `title_card` / `image`）、任何区块都能带 `visible_when`、资源条标签按人解析——协议 2.1 |

Loreweaver 是一个自托管的、世界与故事优先的 AI 守秘人，不是一个角色扮演聊天前端。它长期的杠杆是**成为一个被社区扩展的平台**，而不是一份人人 fork 的代码。这份文档定义“怎么扩展”。

## 指导原则：沿用惯例，不发明惯例

已经有广泛使用的格式的地方，我们刻意**不设计自己的**。一个写过酒馆卡或者 Claude Code 技能的人，应该能复用他已经会的东西；已有的素材应该几乎无摩擦地迁过来。具体来说：

| 扩展类型 | 我们沿用的惯例 | 为什么 |
|---|---|---|
| 人物卡 | **SillyTavern Character Card V2/V3** | 现成的素材库巨大，`core/charcard.py` 已经能解析 |
| 世界信息 / 设定 | **SillyTavern World Info / lorebook** | 卡里就内嵌它，已映射到 `core/worldbook.py` |
| KP 技能 | **Claude Code `SKILL.md`**（YAML frontmatter + Markdown + 渐进披露 + `allowed-tools`） | agent 工具作者熟悉，不用学新 schema |
| 规则系统 | Loreweaver **规则包 YAML**（唯一没有外部标准的地方） | TTRPG 的骰子／技能系统没有对应的现成标准，所以下面完整写出来 |
| LLM provider | OpenAI 兼容 + 一条 `PRESETS`（本来就是数据） | 标准 OpenAI API 面 |

必须自定义 schema 的地方（规则系统、插件清单），我们尽量保持最小、声明式、并且被校验。

## 信任边界（提议代码执行之前先看这节）

Loreweaver 跑在运营者自己的机器上，握有完整权限：文件系统、LLM key、keystore、网络。插件继承这份权限。所以这套分类法是按**风险**组织的，也按这个顺序发布：

- **数据插件（安全）：** 被校验的数据，*不执行代码*。卡、世界书、规则系统、provider 预设、本地化包。
- **声明式技能（安全）：** 提示文本 + 一份对已有内置工具的*白名单* + 可选数据。没有新代码运行。
- **代码插件（危险）：** 任意 Python。最后发布，只能显式开启，需要能力声明和明确的“来源可信”警告。

由此有一条推论，塑造了 A 层：任何声明式的“公式”能力（比如衍生属性）都只认**一套固定的写法，绝不 `eval` 任意字符串**——所以一个数据插件永远没法夹带代码。

第二条推论：**一个坏包绝不能让启动挂掉。** 发现机制会捕获并跳过一个畸形插件。

---

## A 层——内容与数据插件

把一个文件丢进发现目录就能用；不改代码，不重新部署内核。

### A.1 规则系统（`rulepacks/<id>.yaml`）

唯一没有外部标准的格式，所以完整写出来。一个规则包是纯数据，描述一个 TTRPG 系统的卡表和检定。发现机制扫 `rulepacks/*.yaml`，文件名主干就是系统 `id`。

```yaml
names: [coc, coc7, "call of cthulhu"]   # 解析别名（外加 id 和 set_keys）
set_keys: [coc, coc7]                    # 什么词能选中它
defaults:   { 力量: 50, ... }            # 初始属性／技能
alias:      { 力量: [str, STR, ...] }    # 规范名 -> 别名，用于技能解析
st_show:    { top: [...], itemsPerLine: 4 }  # 卡表显示布局
creation_constraints: { ... }            # 掷骰公式／点数购买／取值范围
derived:                                 # 混合式衍生属性——见下
  DB:   { computer: coc_db }             #  (a) 具名代码计算器（内置／过于奇怪的）
  闪避: { half_of: 敏捷 }                #  (b) 声明式写法（纯数据）
display:                                 # 可选，仅呈现用的本地化名字
  en: { 侦查: Spot Hidden, ... }
sheet:                                   # 卡表形状（属性／生命／资源条…）
  resources:
    - {id: hp,  label: HP, value: HP, max: HPMAX}         # 裸字符串 = 你自己的语言
    - {id: chao, label: {en: Tide, zh: 潮位},              # locale 映射 = 一根条，所有桌都读得懂
       value: CHAO, max: CHAOMAX}
```

`sheet.resources[].label` 是在线上**按观看者**解析的，所以同一个房间里 `en` 和 `zh` 的玩家各自看到自己那份读法。裸字符串不是错——HP/SAN/MP 这类缩写到哪儿都一样——但只要标签是一个真正的**词**，就该给一份 locale 映射。

`display` 从不影响结算：规范名始终是卡表／别名／衍生里唯一的身份；检定输出渲染 `display_name(canonical, locale)`，没映射到的名字／语言退回规范名。

**衍生属性是混合式的**（两条路都在，所以一个新系统*可以*是纯数据，而一个奇怪的系统*可以*用代码）：

- `{computer: <name>}`——注册过的 Python 计算器，用于内置（CoC 的伤害加值表）或者 DSL 搞不定的系统。
- `{computer_group: <system_id>}`——直接复用另一个系统整套生成结果。
- 声明式写法（安全，不 eval）：`{copy_of: <stat>}`、`{half_of: <stat>}`、`{floor_div: {of: <stat>, by: N}}`、`{sum_ranges: {of: [<stats>], ranges: [[lo, hi, value], ...], else: <value>}}`。

随包发的三个系统（`coc7`、`dnd5e`、`wod`）就是这个格式的普通包，也是参考词汇。“规则即数据”有一条字面意义上的验收标准：把 `rulepacks/coc7.yaml` 从一个部署里删掉，CoC 就没了，引擎里不留残渣。

**规则的行为也是包数据（M16）。** 规则外化之后，一个包不只声明卡表：它声明检定怎么结算、有哪些子系统、响应哪些点命令、以及要告诉守秘人什么。`agent/` 从不点名系统，也从不比较 rank id——它只读语义标志——所以一个包可以自造词汇而不碰代码。

```yaml
resolution:
  version: 1
  roll: 1d100                # 任意骰点表达式：2d20kh1、4dF、5d6!、{pool}d10>=8
  target: skill              # skill | attribute | dc | none | <表达式>
  compare: "<="
  params:   {deng: {min: 1, max: 9, default: 3}}   # 骰池参数，由检定工具传入
  modifiers:                 # 具名、可组合的掷骰变换
    bonus:   {tens_reroll: keep_lowest}
    penalty: {tens_reroll: keep_highest}
  difficulties: {hard: {target: "floor(target / 2)"}, …}
  ranks:                     # 有序的档位；第一个命中的赢；标志由包自己声明
    - {id: crit,   when: "roll == 1",      success: true, critical: true, tier: 5}
    - {id: hard,   when: "roll <= target && roll <= floor(raw_target / 2)", success: true, tier: 3}
    - {id: fail,   tier: 1}                #  没有 when: 的那条是兜底
  margin: successes
  variants:  {xipu_night: {ranks: [...]}}  # 房规档位，用 `.rule <variant>` 选
subsystems:  {sanity: {...}, luck: {...}, growth: {...}, opposed: {}, random_madness: {tables: {...}}}
commands:    {ra: {action: check}, sc: {tool: sanity}, xipu: {action: make_char}}
expertise:   {en: "…", zh: "…"}
labels:      {en: {crit: [Critical Success], …}, zh: {crit: [大成功], …}}
```

表达式里可用的名字是一个闭合集合——`roll`、`dice`（可按 `dice1`、`dice2` 取）、`target`（难度调整后）、`raw_target`（调整前）、`modifier`、`successes`、`ones`——并且在**加载时静态校验**，所以一个拼写错误会让包在构建时带着可定位的诊断失败，而不是在某人第一次检定时崩掉。在 `difficulties.*.target` 表达式里 `target` 是原始值，在 rank 的 `when:` 里是调整后的值。

**演进纪律：** DSL 绝不为了一个系统长语法。DSL 表达不了的系统走脚本通道（`resolution: {script: resolver.js}`，子系统流程则是 `subsystems: {<name>: {script: flow.js}}`）——QuickJS，和 `hooks.js` 同一条信任通道：引擎先掷好声明的骰子把点数递进去，脚本返回一个纯粹的判定，或者一份取自引擎自有闭合词汇的效果描述，再由引擎核对、把超界的值拉回范围内、然后施加。随机性和状态永远不出引擎。信任卡以 `has_rules_script` 披露它，安装时重新校验。只有一个模式在两三个走脚本通道的系统里反复出现，才会被提升为 DSL 语法。

上面这一切的可构建实例见 [authoring.zh.md](authoring.zh.md) 第 2–3 节。

**规则可以和世界耦合**（`extends:`）：一个需要定制规则的模组，发的是一份*补丁*而不是重写——`extends: coc7` 加上增量。解析是确定性深合并（子的赢；映射递归合并；显式 `null` 删掉继承键；列表整个替换），链条可以经过祖父（上限 4 层），环和未知父包会让解析失败。补丁必须有自己的新 id——发现机制不允许用户文件盖住内置 id。在一个 `.lwpack` 里，`extends:` 先在包自带的规则包里解析，再到宿主的发现目录，所以一个世界可以把基础和补丁一起带走。

### A.2 人物卡——SillyTavern V2/V3

Loreweaver 本来就导入酒馆卡（`core/charcard.py` → `char_from_persona.py` → `import_character` 工具）。我们把这条正式定为卡插件契约：一份 `chara_card_v2` / `chara_card_v3` JSON（或者带 `chara` tEXt chunk 的 PNG）。消费的字段：`name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, alternate_greetings, tags, creator, character_version, character_book, extensions`。未知字段被忽略而不是拒绝，对 V3 的新增保持前向兼容。

**拆卡。** 一张酒馆“重卡”把两件 Loreweaver 坚持分开的东西焊在了一起：**人物**（人设、记忆、能力、一张卡表）和**世界**（钩子脚本、`[InitVar]` 变量架构、可执行 EJS——会重编程整个房间的机制）。那种融合是上游单人架构的产物，不是需要保留的设计，所以导入会确定性地拆开每一张卡（`core.card_split`）：

- **人物导入**（`.import <文件> [pc|companion]`）只取人物那一半。世界机制被*结构性剥离*——钩子不安装，声明条目既不存储也不消费，EJS 片段从正文和设定里移除——结果消息会逐项列出剥掉了什么。这是玩家可以自己往共享房间里导入的东西。
- **世界导入**（`.import <文件> world`，仅守秘人，刻意不作为模型工具）把两半都作为模组内容带进来：机制那一半（完整世界书带守秘人信任、保密标志被尊重；`[InitVar]` 播种进房间变量树；钩子按房间安装），以及人物那一半——它会加入房间的预设角色池（`core.pregen_roster`），成为一个可认领、经规则校验的 PC（`.pc list/claim/release`；认领是排他的，释放会恢复原始卡表）。一次守秘人导入既带来模组的世界，也带来它的演员表；AI 扮演的同伴仍然是单独的 `.import <文件> companion`。

这条边界是房间的信任边界，不是能力削减：“作者自由高于把关”是**运营者**对自己那台机器的立场，而守秘人就是房间的运营者。任何会重编程共享玩法的东西——技能（`.skill enable`）、钩子、变量架构、规则——都要过守秘人的手；玩家上传的东西按构造无法执行、也无法改动共享状态。

### A.3 世界信息 / 设定——酒馆世界书

卡内嵌的 `character_book`，或者一份独立世界书，映射到 `core/worldbook.py`。尊重的条目字段：`keys`（主）、`secondary_keys`、`content`、`comment`、`constant`、`selective`、`insertion_order`、`enabled`、`position`、`case_sensitive`、`priority`、`extensions`。激活是“最近上下文里的关键词命中 + 预算内插入”，就是酒馆那套模型，所以一份已有的世界书原样就能用。

### A.4 模组变量（确定性追踪器）

引擎提供一套声明式的变量接口（`core.modvars`，灵感来自社区的 MVU 变量框架——同一个想法，但用函数调用 + schema 校验取代了解析文本协议）：守秘人（或者模组通过它的设置说明）用 `define_variable` 声明具名追踪器——类型（`number`/`bool`/`text`/`enum`）、可选边界、按语言的显示标签，以及 `player` 或 `keeper` 的可见性——然后用 `set_variable`/`adjust_variable` 更新。每一次写入都由真代码核对、超界就拉回范围内（铁律 #1）；当前值每回合拼进守秘人提示，玩家可见的那部分随 `state` 帧发给客户端。守秘人专属变量在引擎内部就被过滤，永远不到达任何传输（铁律 #3，结构性的）。这是状态不是代码：这里什么都不执行，所以它牢牢待在 A 层的风险等级里。

**导入卡的 MVU 树**从另一个方向得到同样的纪律：它是不透明的模组状态（重卡经常在里面藏剧情标志），所以它的叶子默认**不到任何玩家面板**。守秘人用 `.var expose <前缀|*>` / `.var hide <前缀>` / `.var list` 自己挑着放；守秘人连接会在自己的帧上看到未公开的剩余部分并标记 `hidden: true`，玩家则完全看不到。

### A.5 酒馆 MVU 与 EJS 兼容（导入的卡）

建立在社区 MVU 变量框架（MagVarUpdate）和 ST-Prompt-Template EJS 扩展上的卡，能导入也能**跑**，范围有明确文档：

- **`[InitVar]` / `[InitialVariables]` / `@@initial_variables` 条目**在导入时被消费进房间变量树（`core.mvu_compat`，容忍 JSON5 的解析、嵌套中文路径、`[value, "描述"]` 叶子；重复导入不会重置进度）——它们是数据不是设定，不会被存成条目。
- **MVU 文本协议端到端可用**：卡自己的脚手架条目按普通设定导入，模型发出 `<UpdateVariable>… _.set('path', old, new)…</UpdateVariable>` 块，`agent.loop` 用确定性代码解析（全部五种操作：set/insert/delete/add/move）、应用到树上、并把这些块从玩家可见的叙述里剥掉——就是上游扩展的契约，只是记账的是真代码。工具调用（`set_stat`/`adjust_stat`/`get_stat`）是同一棵树上首选的、有 schema 检查的通道。
- **完整 EJS——真的 JavaScript**（`core.ejs_full`，装了 `ejs` extra 时默认开；`TRPG_ENABLE_FULL_EJS=false` 关闭）：世界书／卡内容经过内嵌的官方 EJS 库 + lodash，在嵌入式 QuickJS 沙箱里跑——循环、函数、`await`、lodash 链、任意 JS 的 `@@if` 条件、模板 `setvar`/`incvar`（缓冲，渲染后由确定性代码应用到 MVU 树）、对预载房间快照的 `getwi`/`activewi`、`injectPrompt`/`getPromptsInjected`、`execvar`。这就是 SillyTavern 自己的信任模型：自托管、你的卡、你的机器。沙箱护栏是崩溃保护而不是限制：硬内存上限、单次求值时限（死循环会超时而不是挂死服务）、零宿主 I/O、每回合一个全新解释器（没有跨回合／跨房间状态），以及缓冲模板写入的上限。
- **EJS 子集降级**（`core.ejs_lite` 之上是 `core.condexpr` 的闭合表达式语法）：缺 `ejs` extra、开关关闭、或者某个模板报错时接管——`<% if/else if/else %>` 块、`<%= %>`/`<%- %>` 输出、`getvar()`/`variables.path`/`stat_data.path` 读取、`{{getvar::}}`/`{{var:}}` 宏、`@@if` → 条目的 `condition` 字段、`<#escape-ejs>` 透传。子集渲染是**只读**的（模板 `setvar` 在那儿是空操作），两种模式都 fail-safe：原始模板语法永远不会到达 LLM。
- **酒馆世界书触发语义**能导入也能跑：次要关键词的四种选择逻辑（AND ANY / AND ALL / NOT ANY / NOT ALL）、`probability`（由真代码掷）、大小写敏感与整词匹配、`scan_depth` 窗口、`position` 排序桶、定时效果（`sticky`/`cooldown`/`delay`，对着一个只有注入路径会推进的按房间回合计数器）、以及包含组（带权重，每组每回合一个成员）。V2 的 `character_book` 和 ST 原生 world-info 字段名都能映射。
- **宏**：`{{getvar::}}`/`{{var:}}`、`{{user}}`（当前 PC，渲染时解析）、`{{char}}`（卡导入时静态绑定）、`{{time}}`/`{{date}}`（**游戏**时钟）、`{{random}}`/`{{pick}}`、`{{newline}}`、`{{// 注释}}`，以及 `{{roll:XdY}}`——由真骰子引擎掷，绝不叙述出一个点数（铁律 #2）。
- **即便在完整模式下仍然是桩／惰性的**：`faker`（返回空串的桩，带警告）、`@INJECT` 按消息下标定位，以及渲染期 UI（`[RENDER:*]`、`@@render_*`、`@@iframe` 状态栏——服务端没有意义的前端特性；这些条目导入时就禁用，不会污染提示，TUI 的追踪面板显示变量树代替）。

导入的信任边界（作用域固定、constant 一律关掉、secret 只有守秘人导入才作数、条目 id 重新生成）在两种模式下都不变——而且这一节描述的全部是**守秘人世界导入之后**运行的东西（见 A.2 的拆卡）：玩家的人物导入压根不带这些机制。

### A.6 提示词预设与其它数据包

**守秘人风格的提示词预设是一等的包内容。**预设就是 SillyTavern 补全预设 JSON 文件（ST 用户已经在互相传的那种「预设」格式）；在 `contents.presets` 里声明后，构建时会用 `.preset import` 同一个解析器做校验。安装时每个文件落进共享预设库（`data_dir/presets/<id>.json`，id 取净化后的文件名主干），所以 `.preset list` 立刻能看到——但什么都不会自己生效：只有房间的守秘人执行 `.preset enable <id>`，这段风格文本才会折入该房间的提示词（和其它内容一样，安装 ≠ 启用）。信任卡会披露预设数量（`presets: N`）。`.preset import` 也认识包相对引用（`.preset import <packId>/presets/x.json`），可以单独挑选一个只以普通素材形式随包发的预设。

折叠尊重预设的**几何**，不只是文本：按三个在引擎里有真实对应物的锚点切成四段——所有标记之前的文本进稳定风格层；`worldInfoBefore`/`worldInfoAfter` 周围的文本包夹世界书注入段；`chatHistory` 之后的文本（酒馆里位置最关键的槽位）落在每回合状态消息的后段，是离生成最近的常驻文本。没有标记的预设折叠方式与从前完全一致。其余五个酒馆锚点只推进切分、不映射到任何位置——这是有意的：游玩体验优先于对酒馆的 1:1 复刻。

provider 预设（`infra/providers.py:PRESETS`）和本地化包（`locales/{lang}/*.json`）本来就是数据，加入同一套发现／清单模式。

---

## B 层——KP 技能（Claude Code `SKILL.md`）

一个**技能**把一种*玩法*——战斗裁判、谜案线索追踪、恋爱／关系动态、恐怖基调——打包成守秘人按房间启用的声明式包。我们**在形状上原样采用 Claude Code 技能格式**，让技能作者复用已有经验：

```
skills/<skill-id>/
  SKILL.md            # YAML frontmatter + Markdown 说明
  references/…        # 按需加载（渐进披露）
  assets/…            # 表格、世界书片段等
```

```markdown
---
name: romance-relationships
description: >
  以浪漫／亲密为核心的战役开启：追踪吸引与张力，提示同意节拍，把诱惑作为社交检定判定。
allowed-tools: [skill_check, kp_note, update_character_status]   # 收窄工具集
name-zh: 恋爱与关系             # 可选的本地化展示信息
description-zh: >
  为以浪漫/亲密为核心的战役开启。
metadata:
  scope: room                 # 按房间开关（守秘人启用）
  systems: [coc7]             # 适用的规则系统（可选）
  content-rating: mature      # 参与成人模式开关
---

# 恋爱与关系

<这段 Markdown 会作为 KP 提示段注入>
```

映射到已有的架构上（不引入任何新的运行时机制）：`description` 是给守秘人的启用提示；Markdown 正文是拼进系统提示的一段；`allowed-tools` 限制该房间的 `agent.tools.Toolset`；`references/*` 是按需取的渐进披露数据；`metadata.scope: room` 是按房间的开关；`metadata.content-rating` 接进成人模式开关。

渐进披露的意思是：顶层 `SKILL.md` 展示成本很低，沉重的参考材料只在技能真正触发时才加载。

---

## C 层——行为插件

### C.1 事件钩子（已落地）

> 作者向参考——事件、API、上限、失败语义、一个完整例子：**[hooks.zh.md](hooks.zh.md)**。本节陈述契约。

技能和卡现在可以携带**行为**，不只是数据和提示——沙箱里的 JavaScript 挂在回合生命周期上（`core.hooks` + `agent.hook_runtime`），和社区的 Tavern Helper 脚本是同一个运行时思路，和完整 EJS 是同一个信任立场（运营者的内容，运营者的机器）：

- **住在哪**：技能 `SKILL.md` 旁边的 `hooks.js`（在该技能对这个房间启用期间生效——已有的 `.skill enable` 就是开关），或者一张卡的钩子脚本——原生包的顶层 `hooks: [...]` 列表（format v1），或者一张酒馆形状的卡的 `extensions.loreweaver_hooks`（由**守秘人**的 `.import <文件> world` 安装；带钩子的卡就是世界卡，见 A.2 的拆卡；重复导入会替换它的脚本而不是叠加）。
- **API**：`on("turn_start"|"reply_ready"|"dice_rolled"|"variables_changed", handler)`，完整的变量桥（`getvar`/`setvar`/`variables`/`stat_data`，lodash 作为 `_`），以及效果发射器 `inject(text)`（给这一回合的守秘人提示加一段）、`narrate(text)`（追加到玩家可见回复）、`rewriteReply(text)`、`log(text)`、`emitUI(blocks, opts?)`——客户端渲染成 `ui` 帧的声明式区块（meter/stat/badge/text/divider/choices/image 等），比如 `emitUI([{kind:"meter", label:"Fear", value:3, min:0, max:10}], {panel:"sidebar", id:"hud"})`；区块 schema 见 [protocol.zh.md](protocol.zh.md)。发出的 UI 是**玩家可见的作者输出**（和 `narrate` 同一个信任立场）——永远不要往里面发守秘人秘密。配合模组 UI 面板（D 层）还有 `emitPanel(panelId, payload)`——给某一个包声明的面板的不透明 JSON 载荷（≤ 32 KB，每回合 ≤ 20 条），只投递给清单里含有那个面板的观看者。同样的信任立场，外加一条收紧：`audience: all` 面板的载荷会到达玩家——守秘人的秘密要放，也只能放进 `audience: keeper` 的面板。
- **契约（铁律 #1）**：钩子**请求**效果；确定性的引擎代码核对它们、把超界的值拉回范围内，然后施加——对已声明模组变量的 `setvar` 会走类型／边界校验，其余落进 MVU 树。每回合一个沙箱解释器（内存／时间受限、无宿主 I/O），`variables_changed` 每回合最多触发一次，所以钩子级联按构造会终止；任何失败——脚本坏了、死循环、缺 `ejs` extra——都降级成“钩子失效（已记录）”，绝不会变成一个坏掉的回合。
- **`globalThis` 只活一个回合——这个坑值得点名。** “每回合一个解释器”意味着解释器每回合都被*重建*，所以一个存在 JS 变量里的计数器每回合都会归零。它不报错，只是永远不往前走，而这是 bug 最糟糕的一种表现方式。一次 2026-08-07 的实测为它丢了一整场的计量条：

  ```js
  // 错的——永远读到 1/40，而且一声不吭。
  on('turn_start', () => {
    globalThis.__turns = (globalThis.__turns || 0) + 1;
    emitUI([{kind: 'meter', label: 'Tide sense', value: globalThis.__turns, min: 0, max: 40}])
  })

  // 对的——持久状态归引擎，钩子只是去要。
  on('turn_start', () => {
    incvar('tide_sense', 1);                       // 核对、卡在范围内、存下来
    emitUI([{kind: 'meter', label: 'Tide sense', value: Number(getvar('tide_sense')) || 0,
             min: 0, max: 40}])
  })
  ```

  这不是绕开沙箱生命周期的变通，这**就是**铁律 #1。任何需要跨回合活下来的东西都是真状态，而真状态属于确定性引擎。（在你的模组里把这个变量声明出来，它就能有边界和标签；不声明的名字也会持久化，作为一个 MVU 叶子。）`TRPG_ENABLE_FULL_EJS=false` 会连同其它所有沙箱 JS 面一起关掉它。

### C.2 Python 入口点插件（仍然推迟）

真正需要新的*服务端代码*的场合（KP 工具、适配器、provider、奇特的衍生计算器），我们会用 Python **入口点**（`loreweaver.plugins`），这样 `pip install loreweaver-plugin-x` 就能注册它。那一层以**服务端权限**运行——不像 C.1 的沙箱——所以它排在最后、默认关闭，并且要求：能力声明、运营者显式启用、显著的“以服务端权限运行不受信代码”警告，以及失败隔离。在 C.2 之前，代码贡献走正常的 in-tree PR。

### C.3 准备阶段脚本——先计划后执行的批量铺设（M20 F）

铺设一个模组常常是四十次几乎相同的工具调用：按名单铺一批 NPC、定义一族变量、批量导入。**准备脚本**是一个小 JavaScript 文件，它只做「计划」，不做「执行」：

```js
// prep/setup.js —— 跑在 QuickJS 沙箱里；plan 是唯一可调用的东西。
const guards = ["门房老周", "巡夜的李七", "更夫赵三"];
for (const name of guards) {
  plan("add_npc", { name: name, concept: "夜里见过五层的人" });
}
plan("define_variable", { var_id: "floor_seen", kind: "number", minimum: 0, maximum: 3 });
```

这套约定为什么可以放心交给守秘人：

- **脚本只能 `plan(工具名, 参数对象)`。**沙箱不暴露任何别的可调用对象，也读不到引擎状态——它不能调用工具、不能读房间、不能联网；它产出一张操作清单就结束。上限：脚本 20 000 字符、200 个操作、每个操作 8 KB 参数、CPU 1 秒。
- **引擎把每个计划中的调用走普通工具通道执行**——和模型发起的调用经过完全相同的参数校验、`keeper_only` 标记、技能解锁检查和准备阶段检查，因为用的就是同一段代码。
- **整体校验，按序执行。**计划里点名了这个房间够不着的工具，就**什么都不执行**（绝不执行一半）；执行期某个操作失败就停在那里，之前的操作保留。
- **预览免费。**`run_prep_plan` 带 `apply: false` 只显示完整操作清单，不碰任何东西。仅限准备阶段（`.phase prep`）；`.import … world` 和 `.var expose` 这类守秘人命令在结构上就够不着——它们是命令不是工具，计划无从点名。

**随包发布**：在 `contents.prep` 里声明（`.js`，惯例放 `prep/` 目录）。安装落在包主目录，守秘人按引用调用——`run_prep_plan(script_ref="<包id>/prep/setup.js")`——和内联脚本一样先预览。信任卡会计数（`准备脚本：N`）；它们**绝不自动运行**，安装时也不会。构建检查是静态的（扩展名、字数上限、UTF-8），这样没装可选 QuickJS 组件的机器也能构建出一致的包；语法错误在预览时暴露。

## D 层——模组 UI 面板（M15）

模组自己布置牌桌：一个包带上自己的界面——HUD、案情板、地图——由协议客户端渲染。这就是取代已退役聊天适配器的那个呈现方向。线上契约见 [protocol.zh.md](protocol.zh.md)。这一层按创作成本和风险分三个 tier：

- **Tier 0——声明式区块**（C.1 的 `emitUI`）：meter/stat/badge/text/divider/choices/image，由钩子按回合发出。每个客户端都原生渲染。
- **Tier 1——声明式面板**：一个包在 `ui/panels.yaml` 里声明**具名**面板（`pack.yaml` 的 `contents.panels`）——由 Tier-0 区块组成的布局，带活变量绑定（`{$var: id}`，对着观看者自己的 `state.variables`；`repeat` 可以按 id 前缀重复）加上 `slot`（`sidebar`/`tray`/`modal`）和 `audience`（`all`/`player`/`keeper`，**服务端**解析）。纯数据，每个客户端都能渲染，终端也包括在内。

  **不写二级页面也能上图。** 一份手作物——一组立绘、一张拓片、一封印好的信——就是一个 `image` 区块：

  ```yaml
  - {kind: image, src: assets/wen-portraits.png,
     caption: {en: The Wen portraits, zh: 温府画像组},
     alt: {en: Three hanging scrolls}}
  ```

  `src` 是包内相对路径（PNG/JPEG/WebP/GIF/SVG），构建时它会和二级面板的代码走同一条路：按内容哈希收进包里，清单里记着哈希。作者不写哈希，而一个面板也没法指向自己包外的图。纯文本客户端显示那行 caption。

  **按值开关：`visible_when`。** `{$var}` 在变量缺失时隐藏区块，`visible_when` 按**值**隐藏：

  ```yaml
  - {kind: text, text: {en: The survey is open., zh: 巡视开始了。}, visible_when: "day >= 46"}
  - {kind: badge, label: {zh: 已警觉}, visible_when: "stage === 2 && !alerted"}
  ```

  它由**客户端**求值，对着那个观看者自己的 `state.variables`——数值是运行时会动的，别无他法。这意味着每个客户端都是同一套语法的一个实现，所以这套语法被刻意做得很小：比较、`&& || !`、字面量、裸变量 id。**算术、`getvar()`、任何函数调用和 `a[0]` 在构建时被拒绝**——每一样都是两个客户端可能悄悄给出不同答案的地方，而“能不能看见”上的悄悄分歧就是剧透。需要 `day >= -1`？反过来写成 `day < 0`。

  两条作者守则：

  - **玩家面板的 `visible_when` 只能引用玩家可见的变量。** 条件字符串是跟包一起发的，每个观看者的客户端里都有——所以在玩家面板的条件里点名一个守秘人专属追踪器，等于泄漏了它的**名字**，哪怕它的值永远不会送到。（值确实不会：隐藏变量在求值前就被丢弃，所以那个区块只是永远不显示。）而且它是**整条**发出去的，被比较的那个字面量同样会漏：`visible_when: "mvu.内部.真凶 === '顾晚棠'"` 等于把答案递到每个玩家手里，变量名读起来再无辜也没用。要开关就拿一个玩家看得见的后果来开关，绝不要拿那个秘密本身。
  - **判不出来就藏。** 条件报错，或者点名了一个无法比较的缺失项，都会隐藏那个区块，绝不显示。写条件时让它在变量缺失的情况下也读得通。
- **Tier 2——沙箱定制视图**：锁死的 iframe 里的真 HTML/JS/CSS，用于可交互地图和定制卡表。`entry:` 把一个面板标成 tier 2；它必须声明自己带的每一个素材（构建时按内容哈希收进包里），以及一个显式的 tier-1 `fallback`（或者 `fallback: null`）给纯文本客户端。

让这一层安全的是同一批铁律，延伸到 UI 上：

- **拆卡的延伸**：面板进房间只能经由守秘人对一个已安装包执行 `.panels enable <packId>`（装上不等于启用）。玩家不能上传面板。
- **一个面板的身份就是在看它的那个玩家**：进来它只看到那个观看者过滤后的变量（`$var` 解析不出来就整块不画——拿不准就不显示）；出去（`panel_intent`）它只能发那个玩家自己也能打出来的东西——`roll` 意图会以那个玩家的身份走真的骰子引擎。
- **守秘人面板不会到玩家那里**：`audience` 在上线前就被解析成每个人自己的清单，一个守秘人专属面板结构上不会出现在玩家的清单里。
- **不多开一道权限口子**：面板只负责画和收集意图；判断全部留在服务端，守秘人专属操作留在命令那一侧。

守秘人命令：`.panels` / `.panels list`（谁都能看）、`.panels enable|disable <packId>`（守秘人）。钩子用 `emitPanel("<packId>/<panelId>", payload)` 寻址面板（C.1）。

### 演出资料包——给你的模组配一个导演（M19）

面板是牌桌上的乐器，**演出资料包**是给演奏它们那个演员的创作简报：演出导演在剧情**节拍**上醒来——场景切换、幕次翻篇、手作物出现、极端出目——决定这桌人看见什么、听见什么。它不叙事、不掷骰、不碰守秘人知识；它挑一种形式，用玩家已经读到的东西把它填满。

发一份 `ui/presentation.yaml` 并在 `contents.presentation` 里声明（一个包一份）：

```yaml
version: 2
generation: allow            # 或者 pack_only——见下面的宁缺毋滥
templates: [title_card, letter]      # 可选：导演可以上演的演出形态，取值
                                     # image/title_card/letter/clipping/text
                                     # （省略 = 全部允许；一屋两包时取交集）
style:
  keywords: {en: "ink wash, muted indigo, 1925 coastal China", zh: "水墨, 靛青, 一九二五浙东"}
  banned: [text overlays, modern clothing]
  palette: ["#16232e", wet slate blue, lantern amber]   # 可选：十六进制或颜色词，
                                     # 随每次生图和导演的简报一起下发
subjects:                    # 什么可以被画，以及怎么画
  - id: gu-wantang
    kind: npc                # npc | location | item
    name: {en: Gu Wantang, zh: 顾晚棠}
    ref: assets/gu-wantang.png          # 定妆参考图
    prompt: "a woman in her thirties, plain dark coat, wet hair"
audio:                       # 导演可以调用的音频提示
  - {id: chao-yong, layer: bgm, asset: assets/chao-yong.mp3, title: 潮涌}
```

三条规矩管着出图纪律，前两条是结构性的，不是模型可以忽略的请求：

- **定妆强制。** 没有 `ref` 的对象永远不会被生成。AI 美术在模组里难的不是接口而是**一致性**：你的参考图和风格关键词跟着*每一次*请求走，一个你没授权的对象根本没法被请求。想让一个对象能在字幕里被点名但永远不被画出来，就声明它但不给 `ref`。
- **宁缺毋滥。** `generation: pack_only` 是你的否决权——导演只用你自己的美术做舞台。运营方的设置覆盖不了它；一个房间跑两个模组时，只要有一个 `pack_only`，整个房间的生成就停了。
- **慢菜先备。** 导演会提前热身它预计很快要用的对象，所以一个节拍端上来的画，是在它之前那几个安静回合里做好的。这个不用配；把对象命名出来，就让它成为可能。

资料包引用的一切都走和面板代码同一条内容寻址素材流水线，信任卡会同时披露对象数量和“这个模组到底会不会花运营方的出图预算”。房间用**同一个** `.panels enable <packId>` 开启它——演出是模组在布置牌桌，不是第二个开关。运营方那侧的旋钮（用哪个模型、每个房间的出图上限）是 `TRPG_DIRECTOR__*`；一个房间启用的模组都不带资料包，就永远不会唤醒导演，所以在有作者提出要求之前，这一层不花任何钱。

---

## 发现、清单与版本——`.lwpack` 格式

- **发现目录**：仓库内（`rulepacks/`、`skills/`）和用户数据目录（`data_dir/skills`、`data_dir/rulepacks`），所以一个插件不必住在检出目录里。内置 id 永远赢过同名的用户目录文件。
- **一个可发布单元**：一整个作品——技能 + 规则包 + 卡 + 世界书 + 媒体素材——作为**一个自包含的 `.lwpack`** 一起走：一个带根 `pack.yaml` 清单的 zip（`core/pack.py`）。作者跑 `python -m app --pack <源目录>`，用户跑 `python -m app --install <ref> [--yes]`。没有“先装 X 插件”的说明，也没有素材要挂图床。
- **Git 就是仓库**：一个安装引用可以是本地路径、`https://` 直链，或者 `gh:owner/repo[@tag]`——由 `infra/pack_source.py` 通过匿名 GitHub API 解析到那个 release 的 `*.lwpack` asset（`@tag` 钉住一个 release，不写就是最新）。这里刻意没有中心化包仓库。
- **装上不等于启用**：技能落进用户技能目录、规则包落进用户规则包目录——立刻可发现，但房间仍然要自己点头（`.skill enable <id>` / 常规规则命令）。卡、世界书和素材落到 `data_dir/packs/<id>@<version>/`，供已有的房间内导入流程（`.import`、`.module`）消费；重装同一个 `id@version` 会整个替换那个包目录，绝不合并。
- **信任卡，不是关卡**：安装前 CLI 打印这个包自动生成的 `trust` 摘要——技能／规则包／卡／世界书数量、是否带沙箱 hooks JS 或 EJS 模板、素材有多少 MB——然后请求确认（`--yes` 跳过；非交互运行必须显式给）。和完整 EJS 同一个立场：运营者的机器，运营者的知情决定。
- **完整性与限域（红线）**：这是唯一一处不受信压缩包字节会落到磁盘的地方，所以安装在写任何东西**之前**校验：每个内容文件用真引擎解析器重新解析（`core.skills.parse_skill_text`、规则包加载器、`core.charcard`），每个素材的字节必须匹配清单里的 sha256，压缩包里不许有未声明的成员，条目名要通过路径穿越（zip-slip）检查，符号链接条目被拒绝，条目数量和大小都有硬上限。构建是字节确定性的（条目排序、zip 时间戳固定、清单稳定序列化），所以一个包的 sha256 可以从源码树复现。
- **依赖**：扁平且内联——一个包自带它需要的一切，没有包间依赖解析。`engine` 只声明**最低**版本（没有区间语法）；达不到就带着清晰的本地化消息拒绝安装。

### `pack.yaml` 字段

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 小写 slug（`[a-z0-9-]`，≤64）——决定 `packs/<id>@<version>` 安装目录名 |
| `version` | 是 | semver `MAJOR.MINOR.PATCH`（可带 `-pre`/`+build` 后缀） |
| `name`、`description` | 是 | 一个普通字符串，或者一个 `{en, zh}` 映射 |
| `authors` | 是 | 非空字符串列表 |
| `license` | 是 | SPDX id 或者一个简短名字 |
| `engine` | 否 | 最低版本：`protocol`（协议）和／或 `server`——只比较最低值 |
| `contents.skills` | 否 | 技能**目录**（`skills/<id>`），每个恰好是 `SKILL.md` + 可选 `hooks.js` |
| `contents.rulepacks` | 否 | 规则包 YAML 文件（`rulepacks/<id>.yaml`） |
| `contents.cards` | 否 | 酒馆卡（PNG 或 JSON）**或者原生包**（`*.lorecard.json`，按内容嗅探分派给原生解析器，好让它们的机制被如实检测）：可以是一个路径，也可以是 `{path, notes: {en, zh}}` 映射来附上安装说明。拆卡的 `kind` 是**检测出来的，不是声明的**：构建会从真实载荷把 `character`/`world` 盖进构建后的清单（hooks/`[InitVar]`/EJS/`secret` 设定/类型化规格 ⇒ `world`，需由守秘人 `.import <文件> world`），安装时再拿检测结果核对这个戳 |
| `contents.lorebooks` | 否 | 世界书 JSON（ST `character_book` / `{entries: [...]}` 形状） |
| `contents.panels` | 否 | 面板 YAML（`ui/panels.yaml`），声明模组 UI 面板（D 层）——每包 ≤ 16 个面板；二级面板的 `entry`/`assets` 文件，以及每个一级 `image`/`map_pin` 的 `src`，都在构建时按内容哈希收进包里（算 sha256，每个面板的代码不超过 2 MB） |
| `contents.presentation` | 否 | 演出资料包（`ui/presentation.yaml`，一包一份）——演出导演的创作简报；它的定妆参考图和音频提示加入同一条素材流水线，信任卡会披露这个模组会不会生成图片 |
| `contents.presets` | 否 | 守秘人风格提示词预设（ST 补全预设 `.json`），构建时用真解析器校验；安装落进共享 `data_dir/presets/` 库，id 取净化后的文件名主干（两个文件净化成同一个 id 会让构建失败）。信任卡披露数量；按房间用 `.preset enable <id>` 启用 |
| `contents.prep` | 否 | 准备阶段计划脚本（`.js`，C.3 层）：守秘人按引用运行的批量铺设——`run_prep_plan(script_ref="<包id>/<路径>")`，先整体预览再执行，绝不自动运行。构建做静态检查（扩展名、沙箱 20 000 字符上限、UTF-8）；信任卡计数 |
| `assets` | 否 | 媒体文件：`path` + 可选 `title`/`license`/`tags`/`mime`；`sha256`/`size`/`mime` 在打包时**填入**（手写的 `sha256` 必须与文件一致） |
| `trust` | 源码中禁止 | 打包时**生成**（含 `panels` 在内的计数、`has_hooks`、`has_ejs`、`has_rules_script`、`asset_bytes`）；手写这一块会让构建失败。安装时用同一批检测器从压缩包**重新推导**并拒绝不一致——一个手工拼装的包没法少报它带了什么 |
| `files` | 源码中禁止 | 打包时**生成**（清单 v2）：完整的压缩包清册——除清单自身外的每一个成员，带 `sha256`/`size`。安装会校验**集合相等**外加逐文件完整性，所以这份声明恰好就是发出去的那组字节，任何未声明的东西都搭不了车 |
| `manifest_version` | 源码中可省 | 清单 schema 版本；省略即当前（2）。构建出来的压缩包总是显式带上。旧版本经已注册的迁移升级；未知／更新的版本干净拒绝 |

`--pack` 用真解析器校验一切（一个坏技能／规则包／卡就意味着没有包），用算出来的完整性信息（`files` 清册）+ 检测出的卡类型 + trust 字段重写清单，然后产出 `<id>-<version>.lwpack`。

**稳定内容 id 与跨包引用。** 一个原生包的世界书条目可以带一个稳定的 `id`；它和包 id 一起构成跨包引用句柄 `<pack-id>#<entry-id>`（例如 `blackmoor#lighthouse-keeper`）——这就是一个连载模组的后续部分引用共享世界的规范条目、而不是复制它们的方式。id 归作者所有，必须跨版本保持稳定；studio 在导出时会生成它们。（引用**解析器**是后续工作；必须从第一天就存在的是这些句柄。）

**原生包格式 v1**（`*.lorecard.json`，`format: "loreweaver.card"`，`format_version: 1`）：原生最优的字段名——`opening`、`alternate_openings`、`dialogue_examples`、`author_notes`——外加顶层 `hooks: [...]`、类型化 `variables`、按条目的 `condition`/`secret`/`id`。`format_version` 是 schema 版本：更旧的文档经已注册迁移升级（v0 是冻结前的临时形状，刻意没有迁移），更新的干净拒绝。

## 迁移指南（把已有素材带过来）

- **从 SillyTavern：** 人物卡（V2/V3）和世界书原样可用（`import_character` / 世界书）。不需要转换。卡作者指南——什么能导入、什么真的会跑、哪里不一样——是 **[cards.zh.md](cards.zh.md)**。
- **从 Claude Code：** 一个 `SKILL.md` 技能保留 frontmatter + 正文就能移植；把它的 `allowed-tools` 接到 Loreweaver 的工具名上，再设好 `scope`/`systems`。假定有 shell／agent 运行时的脚本，要么变成 C 层代码插件（以后），要么重新表达成 `allowed-tools` + 数据。
