*[English](authoring.md) · 中文*

# 做一个 Loreweaver 模组

*从一个空目录，到一个能装的 `.lwpack`，全程拿一个真模组当例子。*

这是实操教程。规范性的契约——每个字段、每条上限、每条信任规则——在 [plugins.zh.md](plugins.zh.md)；两边说法不一致时以那份为准。这里给的是做事的顺序，和真文件而不是编出来的例子。

**例子**是《汐浦送灯》：一九二五年浙东渔镇的一个调查本，被真模型完整跑过两遍。它自己的文件没有随仓库发布（把一个已解的谜发出来就等于剧透），所以下面的路径请当成"一个包长什么样"来看，而不是可以直接 clone 的东西；每一段都是逐字引全的，这一页自己站得住。

---

## 0. 一个模组长什么样

一个目录，一份清单，其余全是可选的。

```
xipu-songdeng/
  pack.yaml                     清单——唯一必须有的文件
  cards/
    shipu.lorecard.json         模组本体：设定、演员表、追踪器、钩子
    chaomai-st.json             一张酒馆卡，原样导入
  rulepacks/
    coc7-xipu.yaml              CoC 7 版的补丁：一个新技能、一条夜间梯子、一张疯狂表
    chaozhan.yaml               一个独立的迷你系统，纯数据
  lorebooks/
    yuyan.json                  一份独立世界书
  skills/
    yingchao-zhuchi/
      SKILL.md                  守秘人该怎么"跑"这个模组（程序，不是故事）
      hooks.js                  沙箱里的回合生命周期行为
  ui/
    panels.yaml                 牌桌上的仪表
    presentation.yaml           演出导演的创作简报
    dengzhen/                   一个二级面板：真的 HTML/JS 页面
  assets/
    *.png *.mp3                 手作物、立绘、音乐
```

最小的清单是六个字段：

```yaml
id: harbour-bell            # 小写 slug；决定 packs/<id>@<version> 安装目录名
version: 0.1.0              # semver
name:
  en: The Harbour Bell
  zh: 港钟
description:
  en: A one-shot for two to four investigators.
  zh: 一个 2-4 人的单本。
authors: [ada]
license: CC-BY-4.0
contents:
  cards: [cards/harbour-bell.lorecard.json]
```

```console
$ uv run python -m app --pack harbour-bell/
Packed harbour-bell@0.1.0 -> …/harbour-bell/harbour-bell-0.1.0.lwpack
   sha256: caeb3bc8e949a887b1c9b64dcf8565413c8120ab7ef1a07658f585c93410cd98
📦 The Harbour Bell — harbour-bell@0.1.0
   A one-shot for two to four investigators.
   by ada · license: CC-BY-4.0
   contains: 0 skill(s), 0 rulepack(s), 1 card(s), 0 lorebook(s), 0 UI panel(s), 0 asset(s) (0.0 MB) · hooks code: no · EJS templates: no
Contains 1 WORLD card(s) — module machinery (hooks/variables/EJS); the keeper imports them with `.import <file> world`.
```

最后那行值得停一下，第 1 节会解释。另外注意你**没写**的东西：文件清单、哈希、信任声明。这些都是构建时算出来的，安装时会重新算一遍，对不上就拒绝——所以一个手工拼出来的压缩包没法少报它带了什么。

---

## 1. 模组文档：`*.lorecard.json`

原生卡是一个扁平的 JSON 对象。它是模组自己的格式，所以能装下酒馆卡没有安全位置放的东西：守秘人专属设定、类型化追踪器、可认领的演员表、按条件触发、稳定 id、钩子脚本。

```json
{
  "format": "loreweaver.card",
  "format_version": 1,
  "name": "汐浦送灯",
  "description": "一九二五年，浙东沿海渔镇汐浦。十二年一度的迎潮节为期三日……",
  "scenario": "调查员一行乘晚船抵达汐浦，入住望潮客栈，正逢迎潮节前夜。",
  "tags": ["调查", "民俗恐怖", "coc7", "三日祭"],
  "opening":  "…",
  "alternate_openings": ["…"],
  "author_notes": "…",
  "worldbook": [ … ],
  "variables":  [ … ],
  "pregens":    [ … ],
  "hooks":      [ "on('variables_changed', …)" ]
}
```

### 顶层字段

| 字段 | 必填 | 含义 |
|---|---|---|
| `format` | 是 | 必须是字面量 `"loreweaver.card"` |
| `format_version` | 是 | `1`。更老的文档会走已注册的迁移升上来；比当前构建更新的会干脆拒绝，而不是读一半 |
| `name` | 实际上要 | 模组名 |
| `description` | | 一句话说清这是什么 |
| `personality` | | 人物卡用的；模组一般留空 |
| `scenario` | | 第零回合时的处境 |
| `tags` | | 自由字符串 |
| `opening` | | 模组开场文本 |
| `alternate_openings` | | 别的切入方式 |
| `dialogue_examples` | | 语气示例，人物卡用 |
| `author_notes` | | 给守秘人的说明，不属于设定 |
| `worldbook` | | 设定条目，见下 |
| `variables` | | 类型化追踪器，见下 |
| `pregens` | | 可认领的演员表，见下 |
| `hooks` | | JavaScript 源码，或者 `{code: "…"}` 对象 |

要注意的上限：512 条世界书条目、每条 128 KB、256 个变量、8 个预设角色。撞上任何一条都是致命的。**条目级**的垃圾则不一样——一条坏掉的设定行、一个不可用的变量定义，会被跳过并记成警告，不会因为一行毁掉整次导入。

### `worldbook[]`——作者写下来的设定

```json
{
  "id": "xipu-town",
  "title": "汐浦镇概览",
  "content": "汐浦倚山面海，一条石板长街自码头通到山脚灯官祠。要处五所：望潮客栈…",
  "keys": ["汐浦", "镇", "街", "码头", "地图"],
  "category": "lore",
  "secret": false,
  "constant": true,
  "priority": 10,
  "enabled": true
}
```

| 字段 | 含义 |
|---|---|
| `id` | **稳定、归作者所有**，值得写。它和包 id 一起构成跨包引用句柄 `<pack-id>#<entry-id>`——连载模组的第二部就是靠这个指向共享世界的规范条目，而不是把它们复制一份。跨版本请保持不变 |
| `title` | 给守秘人看的标题，不写会变成 `Untitled Lore` |
| `content` | 条目正文。必填——空的会被跳过并给一条警告 |
| `keys` / `secondary_keys` | 触发关键词。次要关键词会给条目加门：`selective_logic` 可选 `and_any`（默认）/ `and_all` / `not_any` / `not_all` |
| `secret` | **守秘人专属。** 只在守秘人导入时生效；玩家路径的导入会结构性地丢掉它，所以把一条标成 secret 永远不可能扩大任何人的可见范围 |
| `constant` | 常驻。上传的文件会被强制关掉——一条常驻条目会不管关键词地往每一次提示里塞自己 |
| `condition` | 一个表达式，以 `@@if` 装饰行的形式带进去。超过 500 字符它就永远不会触发，并且你会收到一条这么说的警告 |
| `priority`、`enabled`、`probability`（0–100，由真代码掷）、`case_sensitive`、`match_whole_words`、`scan_depth`、`position`（`before`/`after`）、`sticky`、`cooldown`、`delay` | 酒馆世界书那套触发语义，都能导入也都生效 |

**把秘密写成 `secret: true` 的条目，而不是写成一段"请守秘人别说出去"的正文。** 投影层认的是这个标志。

### `variables[]`——归引擎管的追踪器

```json
{"id": "祭典日",   "kind": "number", "labels": {"en": "Festival Day", "zh": "祭典日"},
 "default": 1, "minimum": 1, "maximum": 3, "visibility": "player"},
{"id": "仪式警觉", "kind": "number", "labels": {"en": "Rite Alert", "zh": "仪式警觉"},
 "default": 0, "minimum": 0, "maximum": 5, "visibility": "keeper"}
```

`kind` 可以是 `number` / `bool` / `text` / `enum`。`visibility: player` 会把它放上队伍面板；`visibility: keeper` 的意思是它**根本不会到达任何玩家传输**——在引擎内部就被过滤掉了，不是靠客户端藏。每一次写入都会检查边界，包括模型要求的写入。id 可以是中文。

这就是"追踪器"和"笔记"的区别：追踪器是引擎会校验、夹紧、持久化并投影的状态。把你结局要卡的东西声明成追踪器。

### `pregens[]`——玩家可以认领的演员表

```json
{"name": "顾晚棠", "concept": "沪上小报记者，为'渔镇民俗'专栏而来",
 "notes": "侦查/图书馆见长,嘴快,潮汐学5"}
```

可以再加 `skills: {"侦查": 70}` 覆盖系统默认值。卡表是下游用目标系统的默认值加上这些覆盖确定性地生成的，不经过模型。玩家用 `.pc claim 顾晚棠` 认领；认领是排他的，释放会把卡表恢复成原样。

```console
$ .pc claim 顾晚棠
You now play “顾晚棠” (coc7-xipu) — the sheet is saved under you and set active.
```

### `hooks[]`——行为，不是文本

```js
on('variables_changed', (e) => { emitPanel('xipu-songdeng/dengzhen', {writes: e.writes}); });
```

沙箱里的 JavaScript，挂在回合生命周期上。完整 API 在 [hooks.zh.md](hooks.zh.md)。有一个坑值得在这里再说一遍，因为一次实测为它丢了一整场的计量条：

```js
// 错的——解释器每回合重建，所以这个数会永远读到 1，而且不报错。
on('turn_start', () => { globalThis.__turns = (globalThis.__turns || 0) + 1; … })

// 对的——持久状态归引擎，钩子只是去要。
on('turn_start', () => {
  incvar('潮感', 1);
  emitUI([{kind: 'meter', label: '潮感', value: Number(getvar('潮感')) || 0, min: 0, max: 40}]);
});
```

### 你的模组为什么是一张"世界卡"

再看一眼构建输出：`Contains 1 WORLD card(s)`。你从来没声明过这件事，是构建**检测**出来的——因为这张卡带了钩子、类型化变量、secret 设定或者 EJS，任何一样会重编程整张牌桌的东西。

由此而来的是**拆卡**。如果你从酒馆过来，这条大概是最让人意外的一条：

- **`.import <文件> pc|companion`**——谁都可以做。它只取人物那一半。世界机制会被*结构性剥离*，回执还会逐项列出剥掉了什么：

  ```console
  Imported "潮脉盘" as your player character (coc7-xipu). Key stats: STR 50, CON 45, …
  World machinery was left out of this character import: 0 hook script(s), 1 variable declaration(s),
  0 template block(s), 0 keeper-only entr(y/ies). Module content is keeper-imported: `.import <card file> world`.
  ```

- **`.import <文件> world`**——只有守秘人能做，而且刻意不是模型工具。这才是一个模组真正落地的方式：

  ```console
  Imported "汐浦送灯" as world content: 16 lore entries (keeper trust), 0 variable declaration(s) seeded,
  1 hook script(s) installed.
  Typed variables: 3 tracker(s) defined from the native bundle.
  Cast registered (3): 顾晚棠, 白榆生, 陈九鲤 — players claim with `.pc claim <name>`.
  ```

照着这条边界写。任何会改变整桌人怎么玩的东西都属于世界那一半，而放它进来的人是守秘人。

---

## 2. 房规：给系统打补丁，别 fork

你的模组要加一个技能，天黑之后大失败的区间还要更狠一点。这不是一个新规则系统，是一个补丁。`extends:` 会把你的文件深合并到父系统之上——子的赢，映射递归合并，显式的 `null` 删掉继承来的键，列表整个替换。

`rulepacks/coc7-xipu.yaml` 全文：

```yaml
extends: coc7
names: [coc7-xipu, 汐浦规则]      # 什么名字能解析到这个系统
set_keys: [xipu]                  # `.xipu` 之类用什么词选中它
defaults:
  潮汐学: 5                        # 一个新技能，起始值 5
alias:
  潮汐学: [tidology, tide lore, 观潮, 潮学]
display:
  en:
    潮汐学: Tidology              # 只影响显示，永远不参与结算
resolution:
  variants:
    xipu_night:                   # 节庆夜的房规梯子
      ranks:
        - {id: crit,    when: "roll == 1", success: true, critical: true, tier: 5}
        - {id: fumble,  when: "roll == 100", fumble: true, tier: 0}
        - {id: extreme, when: "roll <= target && roll <= floor(raw_target / 5)", success: true, tier: 4}
        - {id: hard,    when: "roll <= target && roll <= floor(raw_target / 2)", success: true, tier: 3}
        - {id: regular, when: "roll <= target", success: true, tier: 2}
        - {id: fumble,  when: "roll >= 93 && target < 50", fumble: true, tier: 0}
        - {id: fumble,  when: "roll >= 98", fumble: true, tier: 0}
        - {id: fail,    tier: 1}
subsystems:
  random_madness:
    tables:
      xipu:
        display: {en: Xipu festival madness, zh: 汐浦狂乱}
        aliases: [汐浦, xipu]
        entries:
          - 潮声入耳：调查员耳中潮声不退，旁人说话都像隔着一层水。
          - 灯影追随：调查员坚信有一盏无人提的灯在身后跟着自己。
          # …
commands:
  xipu: {action: make_char}                                # `.xipu` 在这个系统下建卡
  chaokuang: {tool: random_madness, args: {table: xipu}}   # `.chaokuang` 从上面那张表抽
```

这换来三件事，都是在终端里验过的：

```console
$ .xipu
Created coc7-xipu character: Adventurer

$ .rule
Current house-rule ladder: 0
Available: dg, rule1, rule2, rule3, rule4, rule5, xipu_night

$ .rule xipu_night
House-rule ladder set to xipu_night

$ .ra 潮汐学
Check Tidology: target 5 (effective 5), roll 13 -> Failure
```

注意最后一行：技能在数据里是中文，在屏幕上是英文，因为 `display` 只管呈现，规范名才是身份。一个包不需要在语言之间做选择。

> **一个命名空间上的细节。** 在 `difficulties.*.target` 表达式里，`target` 是**原始**值；在 rank 的 `when:` 表达式里，`target` 是难度调整之后的值——上面那些梯子同时用 `target` 和 `raw_target`，原因就在这儿。

**补丁必须有自己的 id。** 发现机制不允许用户文件盖住内置的 id，所以你没法"重定义 coc7"；你定义的是 `coc7-xipu`，你的模组跑那个。

---

## 3. 一整个系统，也是数据

有时候机制确实是新的。潮占——灯官的问潮之术——是一套数成功数的 d10 骰池，和 d100 一点关系没有，而它就是一个文件：

```yaml
names: [chaozhan, 潮占]
set_keys: [chaozhan]
defaults: {}
resolution:
  version: 1
  roll: "{deng}d10>=7"          # 骰池：掷 deng 个 d10，数 7 以上的
  target: none
  compare: ">="
  params:
    deng: {min: 1, max: 9, default: 3}
  ranks:
    - {id: nichao,   when: "successes == 0 && ones >= 2", fumble: true, tier: 0}
    - {id: gongming, when: "successes >= 3 && ones == 0", success: true, critical: true, tier: 3}
    - {id: yingchao, when: "successes >= 1", success: true, tier: 2}
    - {id: mochao,   tier: 1}
  margin: successes
  variants:
    miji:                        # 第三夜的密祭，判得更严
      ranks:
        - {id: nichao,   when: "ones >= 1 && ones >= successes", fumble: true, tier: 0}
        - {id: gongming, when: "successes >= 4 && ones == 0", success: true, critical: true, tier: 3}
        - {id: yingchao, when: "successes >= 2", success: true, tier: 2}
        - {id: mochao,   tier: 1}
labels:
  en: {nichao: [Adverse Tide], gongming: [Resonance],
       yingchao: {display: Favorable Tide, markers: []},
       mochao:   {display: Silent Tide,    markers: []}}
  zh: {nichao: [逆潮], gongming: [共鸣],
       yingchao: {display: 应潮, markers: []},
       mochao:   {display: 默潮, markers: []}}
expertise:
  en: "# Tide Divination (潮占)\nThe lantern-diviner reads the festival tide…"
  zh: "# 潮占\n灯官问潮：点起一至九盏灯掷占，数应答之水。"
```

**这套 DSL 一段话说完。** `roll` 是骰点表达式，引擎按种子掷它并记录。`ranks` 是一串有序的纯条件——第一个命中的赢，最后那条没有 `when:` 的是兜底。可用的名字是一个闭合集合：`roll`（总数）、`dice`（自然骰，可以按 `dice1`、`dice2` 取）、`target`（难度调整后）、`raw_target`（调整前）、`modifier`，以及骰池用的 `successes` / `ones`。`success` / `critical` / `fumble` 这几个标志是**你自己**声明的：引擎和 AI 只读这些标志和 `tier` 这个序数，从不读你的 rank id——所以一个系统可以自造词汇而不影响下游任何东西。`expertise` 是告诉守秘人该怎么跑它的那段话。

**骰池参数**（这里的 `deng`）由守秘人的检定工具传，仪式场景就是这么要一次"五盏灯"的问占。玩家侧的点命令那条通道把参数当技能名解析，所以骰池系统的参数是守秘人在设，不是玩家。

**打错字在构建时就炸，不会拖到牌桌上。** 引用到的名字是静态提取的，所以一个短路的 `&&` 藏不住拼写错误直到三场之后有人第一次检定：

```console
$ uv run python -m app --pack harbour-bell/
Pack build failed: rulepack bell: rulepack 'bell': resolution.ranks[0].when references unknown name(s) ['rol']
```

**删掉文件就等于删掉系统**——这是"规则即数据"的验收标准，对内置包同样成立：

```
with coc7 : ['coc7', 'dnd5e', 'wod']
deleted   : ['dnd5e', 'wod']
load coc7 : ValueError unknown rulepack: coc7
```

如果 DSL 确实表达不了你的系统，`resolution: {script: resolver.js}` 会落到 QuickJS 沙箱：引擎把声明好的骰子先掷了，把点数递进去，你的脚本返回一个判定，引擎校验并夹紧它。随机性和状态永远不出引擎，而信任卡会披露你这个包带了脚本。

---

## 4. 面板：牌桌上的仪表

`ui/panels.yaml`，在 `contents.panels` 里声明。每个包最多 16 个面板。下面是这个模组完整的面板文件，你需要的机制它基本都覆盖了：

```yaml
panels:
  - id: jieqing-richeng
    title: {en: Festival Schedule, zh: 节庆日程}
    slot: sidebar              # sidebar | tray | modal
    audience: all              # all | player | keeper——在服务端解析
    blocks:
      - {kind: stat,  label: {en: Festival Day, zh: 祭典日}, value: {$var: 祭典日}}
      - {kind: meter, label: {en: Tokens, zh: 信物}, value: {$var: 信物}, min: 0, max: 3}
      - {kind: divider}
      - {kind: text, text: {en: "Day 1 greet · Day 2 air · Day 3 send",
                            zh: "初一迎灯 · 初二曝灯 · 初三送灯"}}
      - {kind: text, style: warning, visible_when: "祭典日 >= 3",
         text: {en: "Tonight the lanterns go out on the tide. What you have counted is what you have.",
                zh: "今夜送灯。数到的就是数到的。"}}

  - id: shouzhong-wu
    title: {en: In Hand, zh: 手边物}
    slot: tray
    audience: all
    blocks:
      - {kind: image, src: ui/dengzhen/canlye.png,
         caption: {en: "Lantern manual, torn page", zh: 灯谱残页},
         alt: {en: "A brush-drawn array of nine lanterns, one of them unlit"}}
      - {kind: text, style: quote, text: {en: "Count them yourself.", zh: 自己数一数。}}

  - id: dengzhen
    title: {en: Lantern Array, zh: 灯阵图}
    slot: modal
    audience: all
    entry: ui/dengzhen/index.html                                  # 二级
    assets: [ui/dengzhen/index.html, ui/dengzhen/app.js, ui/dengzhen/canlye.png]
    fallback:                                                       # 必填
      - {kind: text, text: {en: "The lantern array chart is best viewed in a rich client;
                                the keeper will describe it.", zh: "灯阵图请在富客户端查看；终端下由守密人描述。"}}
      - {kind: badge, label: {en: "Nine lanterns", zh: "九灯之阵"}, tone: info}
```

**区块种类**：`meter`、`stat`、`badge`、`text`、`divider`、`choices`、`image`，再加上演出模板 `letter`、`clipping`、`map_pin`、`title_card`。全是声明式的。富客户端会把 `letter` 渲染成信纸，终端客户端把同样的字段打成几行。你不用写标记，也不用写两套。

**活的数值**：任何标量字段都可以写成 `{$var: <id>}`，对着看的人自己那份 `state.variables` 解析。这里是 fail-closed 的：如果那个变量对**这个人**不存在或被隐藏，**整个区块**都不显示。面板永远没法扩大可见范围。

**一张手作物就是一个 `image` 区块**，不用为它手写一个页面。`src` 是包内相对路径，构建会把它折进内容寻址的素材流水线，清单里带哈希。你不用写哈希，而一个面板也只能指向它自己包里的图。

**`visible_when`——按值开关。** `{$var}` 只能表达"不存在就藏"，`visible_when` 能表达"到第三天才显示"。它在**客户端**求值，因为数值是运行时会动的，服务端做不到按人预过滤。这意味着每个客户端都得是同一套语法的实现，所以语法被刻意做得很小：

- 比较 `=== !== == != >= <= > <`；逻辑 `&& || !`（也可以写 `and` / `or` / `not`）；
- 字面量：数字、带引号的字符串、`true` / `false` / `null` / `undefined`；
- 裸的点分路径（可以是中文），每一段都按变量 **id** 查；查不到读作 `null`。
- **构建时会拒绝的**：算术、任何函数调用（包括 `getvar()`）、方括号取下标。这些都是两个客户端可能悄悄给出不同答案的地方，而"能不能看见"上的悄悄分歧就是剧透。要写 `day >= -1`？反过来写成 `day < 0`。

两条作者守则：

1. **玩家面板的 `visible_when` 只能引用玩家可见的变量。** 条件字符串是跟你的包一起发的，每个人的客户端里都有——所以在玩家面板的条件里点名一个守秘人专属追踪器，等于泄漏了它的**名字**，哪怕它的值永远不会送过去。（值确实不会：隐藏变量在求值前就被丢掉了，所以那个区块只是永远不显示。）
2. **判不出来就藏。** 条件报错，或者客户端算不了，都会把区块藏掉。写条件的时候，让它在变量缺失时也读得通。

**二级面板**是关在沙箱 iframe 里的真 HTML/JS/CSS，用来做可交互的地图或者定制卡表。它必须声明自己带的每一个资源，以及一个显式的一级 `fallback`（或者 `fallback: null`，纯文本客户端会渲染成一行"请在富客户端查看"）。面板的身份就是在看它的那个玩家：进来的数据只有那个人过滤后的那份；出去时一个 `roll` 意图，会以那个玩家的身份走真的骰子引擎。

面板进房间要守秘人点头——装上不等于启用：

```console
$ .panels
Installed panel packs:
[off] xipu-songdeng — 4 panel(s)

$ .panels enable xipu-songdeng
Enabled UI panels from pack: xipu-songdeng
```

---

## 5. 演出资料包：给你的模组配一个导演

面板是乐器，**演出资料包**是给演奏它们那个演员的创作简报。演出导演在剧情*节拍*上醒来——场景切换、幕次翻篇、手作物出现、极端出目——决定这桌人看见什么、听见什么。它不叙事、不掷骰、不读守秘人知识：它的全部输入就是投影过的玩家可见流，加上这个文件。它泄不出它从来没收到过的东西。

`ui/presentation.yaml`，在 `contents.presentation` 里声明，一个包一份：

```yaml
version: 1
generation: allow            # 或者 pack_only——你的否决权，见下
style:
  keywords:
    zh: "水墨淡彩, 靛青与赭石, 一九二五年浙东渔镇, 湿冷海雾, 纸本质感"
    en: "ink wash with muted color, indigo and ochre, 1925 coastal Zhejiang fishing town, damp sea fog, paper grain"
  banned: [text overlays, modern clothing, photographic realism, visible light sources beyond lanterns]
subjects:
  - id: gu-wantang
    kind: npc                                     # npc | location | item
    name: {zh: 顾晚棠, en: Gu Wantang}
    ref: assets/gu-wantang.png                    # 定妆参考图
    prompt: "a woman in her thirties, dark plain jacket over a pale collar, hair damp, standing very still"
  # 没有 ref：可以在字幕里点名，但永远不会被画出来。
  - {id: shipu,   kind: location, name: {zh: 石埠, en: The stone quay}}
  - {id: zhu-deng, kind: item,    name: {zh: 主灯, en: The head lantern}}
audio:
  - {id: chao-yong, layer: bgm,      asset: assets/chao-yong.mp3, title: 潮涌}
  - {id: ye-wu,     layer: ambience, asset: assets/ye-wu.mp3,     title: 夜雾港湾}
  - {id: jing-xian, layer: sfx,      asset: assets/jing-xian.mp3, title: 惊弦}
```

出图这件事由三条规矩管着，前两条是结构性的，不是模型可以选择忽略的请求：

- **定妆强制。** 没有 `ref` 的对象永远不会被生成。AI 美术在模组里难的从来不是接口，是**一致性**：你的参考图和风格关键词会跟着*每一次*请求走，而一个你没授权的对象，根本没法被请求。
- **宁缺毋滥。** `generation: pack_only` 是你的否决权——导演只用你自己的美术做舞台。运营方的任何设置都覆盖不了它；一个房间跑两个模组时，只要有一个是 `pack_only`，整个房间的生成就停了。
- **慢菜先备。** 导演会提前把它预计要用的对象热起来，所以一个节拍端上来的画，是在它之前那几个安静回合里做好的。这个你不用配，你把对象命名出来，它就成为可能。

资料包和其它东西走同一条素材流水线，而信任卡会同时披露对象数量，以及你的模组到底会不会花运营方的出图预算。房间用**同一个** `.panels enable <packId>` 开启它——演出是模组在布置牌桌，不是第二个开关。一个房间里的模组都不带资料包，就永远不会唤醒导演，所以在有作者提出要求之前，这一层不花任何钱。

---

## 6. 一个技能：怎么"跑"这个模组

故事写在卡里，程序写在 `SKILL.md` 里——Claude Code 那个形状的技能，YAML frontmatter 加 Markdown，在房间启用它期间折进守秘人的提示。

```markdown
---
name: 迎潮节主持
description: Procedure guide for running 《汐浦送灯》 — act pacing, rule-system switching,
  festival-night house rules, madness table, ending-gate enforcement, and session-zero setup.
---

# 迎潮节主持（模组运行程序）

故事内容以导入的世界卡为准。本技能只管程序。

## 规则切换纪律
- 日常检定：coc7。**入夜后**切 `.rule xipu_night`，天亮切回 `.rule 0`——切换时给一句环境暗示，不解释规则。
- 理智：真正的恐怖暴露才掷。疯狂发作用汐浦狂乱表（`.chaokuang`）。

## 结局门（硬性，缺门不发）
C 断锚 = 信物满 3。玩家硬闯缺门结局时，在 fiction 内让门本身拦住。
```

可选的 frontmatter：`allowed-tools`（把这个房间的工具集收窄到一个白名单）、`name-zh` / `description-zh`（本地化显示）、`metadata.systems`、`metadata.content-rating`。同目录下的 `hooks.js` 在技能启用期间生效。守秘人按房间启用：

```console
$ .skill enable yingchao-zhuchi
Enabled KP skill: yingchao-zhuchi
```

**写程序，别写散文。** 上面那份里最好的一句是"切换时给一句环境暗示，不解释规则"——它告诉守秘人在某个具体时刻做什么。气氛属于设定条目，这份文件是操作手册。

---

## 7. 构建、安装、发布

### 构建

```console
$ uv run python -m app --pack xipu-songdeng/
Packed xipu-songdeng@1.0.0 -> …/xipu-songdeng-1.0.0.lwpack
   sha256: 8c34dd524911a6f1def97fff57a51f1e9d455e695f32668053e5c5302fd51e0e
📦 Xipu: The Lantern Sending — xipu-songdeng@1.0.0
   A 1925 coastal-town mystery for the Tide-Greeting Festival — three days, nine lanterns, one chosen guest.
   by loreweaver-playtest · license: MIT
   contains: 1 skill(s), 2 rulepack(s), 2 card(s), 1 lorebook(s), 4 UI panel(s), 9 asset(s) (0.3 MB) · hooks code: yes · EJS templates: no
Contains 2 WORLD card(s) — module machinery (hooks/variables/EJS); the keeper imports them with `.import <file> world`.
   presentation kit: 5 picturable subject(s) — the Stage Director MAY generate images (each call spends your image-provider budget)
```

`--out <文件>` 指定文件名；`--json` 会多输出一行给 CI 用的机器可读结果：

```json
{"ok": true, "id": "xipu-songdeng", "version": "1.0.0", "sha256": "8c34dd52…",
 "trust": {"skills": 1, "rulepacks": 2, "cards": 2, "lorebooks": 1, "assets": 9,
           "asset_bytes": 282853, "has_hooks": true, "has_ejs": false,
           "has_rules_script": false, "world_cards": 2, "panels": 4,
           "presentation": 5, "imagegen": true}}
```

有两条性质值得依赖：构建用**真的引擎解析器**校验一切（一个坏技能、坏规则包、坏卡就意味着没有包，而不是以后才崩的安装），并且它是**字节确定性**的——条目排序、时间戳固定、清单稳定序列化，所以同一份源码树永远给出同一个 sha256。把那个摘要发出去，别人就能核。

### 安装

```console
$ uv run python -m app --install ./xipu-songdeng-1.0.0.lwpack --yes
📦 Xipu: The Lantern Sending — xipu-songdeng@1.0.0
   …
Installed xipu-songdeng@1.0.0.
   skills: yingchao-zhuchi — a keeper enables one in-room with .skill enable <id>
   rulepacks: chaozhan, coc7-xipu — discoverable right away (switch systems with the usual rule commands)
   cards/lorebooks/assets: 2/1/9 file(s) under <data_dir>/packs/xipu-songdeng@1.0.0 — import in-room with .import <file> / .module
World cards (keeper-imported via `.import <file> world`): cards/shipu.lorecard.json, cards/chaomai-st.json
```

不加 `--yes` 就会打印信任卡并要求确认，非交互运行必须显式给这个参数。安装是在写任何东西**之前**校验的：每个内容文件用真解析器重新解析一遍，每个素材的字节要和清单里的 sha256 对上，压缩包里不许有未声明的成员，条目名会检查路径穿越，符号链接直接拒绝，数量和大小都有硬上限。信任块会用同一套检测器从压缩包里重新推导，对不上就拒绝。

**装上不等于启用。** 技能和规则包会变成可发现的，但房间还要自己点头（`.skill enable`、`.panels enable`、`.import … world`）。这层分离就是整个信任模型：一个包带的东西，不会因为它落到了磁盘上就开始跑。

### 发布

Git Release 就是仓库。没有中心商店，没有提交审核，没有把关人——你的分发链路上也没有任何一环是别人能收走的。

1. 在你自己的仓库里打一个 Release。
2. 把 `.lwpack` 作为 release asset 挂上去。（在 release notes 里贴上它的 sha256，别人就能自己核那份字节确定性构建。）
3. 玩家按引用安装：

```bash
uv run python -m app --install gh:owner/repo          # 最新 release
uv run python -m app --install gh:owner/repo@v1.2.0   # 钉住某一个
uv run python -m app --install https://example.com/my-module.lwpack
```

引用会通过匿名 GitHub API 解析到那个 release 的 `*.lwpack` asset——没有的话它也会直说：

```console
$ uv run python -m app --install "gh:1A7432/loreweaver@v1.0.0" --yes
Could not resolve the pack ref: release for 'gh:1A7432/loreweaver@v1.0.0' has no .lwpack asset
```

**依赖是扁平且内联的。** 一个包自带它需要的一切，没有包间依赖解析。`engine:` 只声明**最低**版本（`protocol`、`server`），达不到就明确拒绝安装，而不是半工作。

**做连载？** 从第一部就给每条世界书条目一个稳定的 `id`。后续installment 用 `<pack-id>#<entry-id>` 引用共享世界，而不是复制它；引擎按文档记录来源（`meta.source`），所以更新时分得清哪些是主人改过的、哪些应该跟着包走。

---

## 8. 在别人玩到之前先自己测

```bash
uv run python -m app --pack my-module/                 # 它至少能构建吗？
TRPG_DATA_DIR=/tmp/lw-test uv run python -m app --install ./my-module-0.1.0.lwpack --yes
TRPG_DATA_DIR=/tmp/lw-test uv run python -m app --cli --script my-run.txt
```

`--script` 会把文件里每一行喂给离线 CLI，它跑的是完整的真实链路，只是守秘人是脚本化的、骰子有固定种子——不用 key，不联网。一份把接线从头到尾走一遍的脚本：

```
.xipu
.rule
.rule xipu_night
.st
.ra 潮汐学
```

```console
Created coc7-xipu character: Adventurer
Current house-rule ladder: 0
Available: dg, rule1, rule2, rule3, rule4, rule5, xipu_night
House-rule ladder set to xipu_night
Adventurer: 力量 45, 敏捷 60, 体质 60, 体型 65, 外貌 45, 智力 55, 意志 45, 教育 85, 幸运 50, DB 0, …
Check Tidology: target 5 (effective 5), roll 13 -> Failure
```

（CLI 和其他玩家一样有速率限制，所以脚本别太长，长了就拆开。）

然后再查房间层面的接线——面板注册了没、技能开了没、世界卡落了没、演员表出来了没：

```
.panels enable <你的包 id>
.skill enable <你的技能 id>
.import <data_dir>/packs/<id>@<version>/cards/<你的卡>.lorecard.json world
.pc list
```

真上模型的时候，**跑两遍，并且把出问题的地方记下来**。这个模组第一次跑发现的是：一个叙事很强的模型完全没碰过状态层——书记官就是因此才存在的；第二次发现的是反过来的毛病，外加几处串台。两份记录都是趁着还疼的时候写下来的，也正因为这样才有用。

---

## 接着看哪份

| 主题 | 文档 |
|---|---|
| 完整扩展契约——每个字段、上限、信任规则 | [plugins.zh.md](plugins.zh.md) |
| 从酒馆搬过来：什么能跑、哪里不一样 | [cards.zh.md](cards.zh.md) |
| 钩子 API、事件、效果缓冲、失败语义 | [hooks.zh.md](hooks.zh.md) |
| 面板和区块在线上的形状 | [protocol.zh.md](protocol.zh.md) |
| 带着你的模组开一桌 | [operating.zh.md](operating.zh.md) |
