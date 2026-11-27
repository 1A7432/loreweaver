# Loreweaver

*[English](README.md) · 中文*

<!-- owner 待填：下面三句英雄句是已锁定的旧稿（landing-redesign.md「用户锁定」）。
     要换新句子改这里；正文其余部分不写口号，只写事实。 -->

**「你喜欢的角色，不该只活在对话框里。」**

带上 TA，去经历一个完整的世界：骰子决定成败，规则守住真实，留下共同历经世事的痕迹。你们一起冒险、一起失败、一起把故事走完。

你们都不知道剧本——**你们共同创造故事。**

Loreweaver 是一个开源的 **AI RPG 引擎与开放标准**。你和朋友出人，AI 守秘人读模组、记世界、扮演每个 NPC、看住每条线索。它和“和 AI 聊天”最大的区别是**骰子是真的**：检定、伤害、理智，以及卡表上的每一个数，都由代码按规则掷出并结算，模型负责把结果讲成故事。**故事归 AI，账归代码。**

一个世界的规则、设定、演员表、界面和演出，都是写成文件的公开格式，而不是写死在引擎里的功能——所以一个世界可以打包带走，也可以交给别人。服务器跑在你自己的电脑上。《克苏鲁的呼唤》7 版和 D&D 5e（SRD）随包发，中英双语都是一等公民。

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![server](https://img.shields.io/badge/server-TypeScript%20%2F%20Bun-black) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black) [![protocol](https://img.shields.io/badge/protocol-3.0-informational)](docs/protocol.zh.md)

**链接：**[项目主页](https://1a7432.site) · [路线图](docs/roadmap.zh.md) · [部署](docs/deploy.zh.md) · [GitHub](https://github.com/1A7432/loreweaver)

> **实话实说：**项目还很年轻，基本是一个人带着 AI 写出来的。确定性那一半——骰子、规则、卡表、投影——是最扎实的部分，由五千多个离线测试盯着。AI 守秘人的**行为**是另一回事，我们只拿数据说话，不打包票；下面[现状那一节](#诚实的现状)会把哪些证明了、哪些没证明说清楚。

---

## 五分钟开一局

3.0 是用 Bun 和 TypeScript 重写的 Loreweaver。**3.0 还没有发布任何版本**：现在要从这个仓库的源码运行，机器上需要装好 [Bun](https://bun.sh)。桌面客户端 Loreweaver Studio 的 3.0 版本在[它自己仓库](https://github.com/1A7432/loreweaver-studio)的 `v3` 分支上，还没有发布（已发布的 Studio 连不上 3.0 的服务器）；在那之前，用这个仓库里的终端客户端玩。

### 1. 取代码

```bash
git clone https://github.com/1A7432/loreweaver && cd loreweaver
bun install
```

Windows 上请在 **Windows Terminal** 或 **WezTerm** 里跑客户端——老式控制台会把边框画烂、吞掉鼠标。

### 2. 开服

```bash
cd clients/tui && bun run dev
```

在连接屏选「**⌂ 本地开服并开玩**」。没有第二步：它用这份源码把服务器拉起来（数据放在「本地服务器目录」，默认 `~/.loreweaver`），给你签一把管理员钥匙，然后直接把你以房间管理员身份送进主菜单。

**没配模型，服务器也照样起得来**，骰子、卡表、命令都能用；配好模型之后守秘人才会回话。可以在开服前把源码根目录的 `.env.example` 复制成 `.env`、填好 `TRPG_LLM__*`；也可以随时以房间管理员身份在主菜单打开「**模型**」来设，正在运行的服务会立刻切过去。

### 3. 叫人

在主菜单打开「**访问钥匙**」，给每个朋友新建一把钥匙。屏幕上会同时给出 **ticket**（p2p 地址）和他的钥匙；他在连接界面里把两样都贴进去，起个昵称，就进来了。

**不用域名、不用证书、不用端口转发。** 连接是走 [Iroh](https://www.iroh.computer/) 的点对点 QUIC——NAT 打洞、中继兜底、端到端加密。服务器把自己的身份存在数据目录里，所以 ticket 重启不变，**发一次就一直能用**。这里没有账号：钥匙本身就是入场券。掉线会自己重连。

管理员钥匙是这个房间的管理员凭证——它能读守秘人材料、管这个房间的钥匙，而模型/provider 设置对整个服务器生效。只发给你敢把笔记本交出去的人。

### 4. 开玩

用大白话说你的角色要干什么。碰到不确定的事，守秘人会要一次检定，引擎把骰子掷了。第一回合先知道三件事就够：

```
.r 3d6+2          自己掷骰      ->  ⚄ Alice 3d6+2 11
.ra spot hidden   发起一次检定  ->  ⚄ Alice 1d100 13 vs 25 -> Success
?                 打开帮助浮层  （按键和骰子）
```

两套指令写法同时生效：骰娘系的中文写法（`.ra 侦查`、`.st 力量50`）和 Avrae 系的英文写法（`/roll 4d6kh3`）。完整的玩家上手指南——按键、面板、成功等级、`.recap`——在 **[docs/play.zh.md](docs/play.zh.md)**；房间里能用的命令在房间里就能查（`.help`，终端客户端里按 F7），引擎的全部命令在[协议的命令表](docs/protocol.md#68-the-engines-commands)里。

---

## 一个回合到底怎么走

一张 Loreweaver 牌桌上有**四个角色在干活**。只有一个负责写故事，而管数字的那个不是模型。

```
   你打的字 ───────────────────────────────────────────────────────────────────────────────────────┐
                                                                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  KP · 守秘人             模型，每回合        叙事、NPC 说话、裁定、接下来发生什么                │
│  engine · 引擎           代码，永远在        骰子、卡表、时钟、追踪器、校验、权限，              │
│                                              以及下面所有的投影                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                                                   │
   回复已经流式发到桌上 ───────────────────────────────────────────────────────────────────────────┤
                                                                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  书记官 · Scribe         小模型，每回合      拿叙事去对账本、把判断悄悄递给 KP 的下一回合，      │
│                                              顺手把这回合的剧情节拍分类                          │
│  演出导演 · Director     模型，只在节拍      幕卡、信笺、剪报、音频提示、生成图，                │
│                                              也就是这桌人真正看到的东西                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**书记官**是被一次实测逼出来的。一场实跑里，一个叙事极强的模型跑完了整个模组，却一次都没碰过状态层：追踪器停在默认值，而剧情已经往前冲了三天。记账这件事靠模型自觉是靠不住的，于是它有了一个安静的帮手——它只负责提议，引擎负责核对，超出范围的写入直接拉回来。换上书记官之后重跑同一个模组，追踪器跟着剧情走了，掷骰密度也上了好几倍。

**演出导演**是最新、也是管得最严的一个。它做出来的东西全都是玩家能看见的，所以它按 NPC 的规格来造：输入只有玩家视角那一份投影，加上模组自带的演出资料包。没给过它的东西，它漏不出来。

### 所有秘密只有一个出口

房间里的一切内容——设定、NPC、卡表、预设角色、追踪器、笔记——都是同一张表里的 `Document`。每种文档类型注册一个 `project(document, viewer)`，**任何东西要发出去，都得先从这儿过**。只有一个出口而不是五个，这也是我们敢信它的主要原因。

| 谁在看 | 看到什么 |
|---|---|
| 守秘人 | 完整文档——它必须知道谜底才能主持 |
| 玩家 | 投影：没有秘密设定、没有 NPC 的暗盘、没有守秘人专属追踪器、没有未公开的变量叶子 |
| NPC / 演出导演 | 只有它自己的记录和卡表，别的什么都不拿 |

有一组专门盯泄漏的测试，逐条确认某些秘密永远不会从 `project()` 里出来；另一组架构测试不许 `gateway/`、`net/` 直接读整份存储文档。这**证明不了**的是：主守秘人为了主持谜案看过一条秘密之后，永远不会把它说出来。那是行为，[另有实测](#诚实的现状)。

---

## 有什么

**规则是数据，不是代码。** 一个规则系统就是一个 YAML 文件：卡表长什么样、衍生属性怎么算、检定分几档、有哪些子系统、认哪些点命令、各语言怎么显示。随包发的 CoC 7e / D&D 5e / WoD 就是同一种格式写的普通规则包（`rulepacks/`），编译进服务器；引擎本身不含 CoC 的规则。检定结算是骰子引擎之上的一小段声明式 DSL：

```yaml
resolution:
  roll: 1d100
  target: skill
  ranks:
    - {id: crit,    when: "roll == 1",          success: true, critical: true}
    - {id: extreme, when: "roll <= target / 5", success: true}
    - {id: hard,    when: "roll <= target / 2", success: true}
    - {id: regular, when: "roll <= target",     success: true}
    - {id: fail}
```

骰池（`7d10>=8`）、命运骰（`4dF`）、爆炸骰（`5d6!`）都是引擎自带的，所以数成功数的系统同样只是数据。2.x 里 DSL 表达不了的，交给沙箱里的一段脚本；3.0 不跑这条脚本通道，需要它的规则包会被拒绝。模组要加房规就发一份*补丁*：`extends: coc7` 加上要改的那几行，别的什么都不写。

**拆卡。** 一张酒馆「重卡」把两样东西焊在了一起，而 Loreweaver 坚持把它们分开：*人物*（人设、卡表、记忆）和*世界*（钩子脚本、变量架构、可执行模板）。玩家导入人物那一半时，世界机制会被**结构性剥掉**，回执还会逐项告诉你剥了什么。世界机制进房间只有一条路——房间管理员自己导入世界（终端客户端里的「导入世界卡」，或 `.import world …`），因为它改的是整张桌子的玩法。导入的变量树，在管理员公开之前不上玩家面板（`.var expose`）。卡里原本靠前端脚本去拨的那些开关，在这里由你自己拨：`.lore enable <标题>`，或者 `.lore bind <标题> | <条件>` 让一个变量来决定——全程不动那张卡。

**能撑过上下文窗口的战役记忆。** 跑团过程被记成编年史文档。当拼出来的提示超过模型上下文窗口的 60%，最老的记录成批折叠进滚动摘要，直到降回 40% 以下；最近四回合永远不折（正在演的这场戏还不算历史）。配了向量模型的话，折叠过的记录会进向量索引，所以第三场的一个细节到第十二场仍然找得回来。玩家这边是 `.recap`——同一段故事，守秘人的剧透批注在投影这一层就已经不在里面了。

**它是一个演出层，不只是聊天记录。** 模组可以自己布置牌桌。模组能发声明式区块（进度条、徽章、选项、图片）；内容包可以声明具名面板，绑上会动的视图、用 `visible_when` 按值显示或隐藏，放进侧栏、托盘或弹窗，谁能看见由服务端说了算；页面面板是给富客户端沙箱框架跑的真 HTML，而且必须声明一份用同样区块写的降级版（或者明说没有）。现在还没有客户端会跑页面，终端客户端画的是降级版。再往上是演出导演那套演出模板——`title_card`、`letter`、`clipping`、`image`、`text`——都是声明式的：富客户端把它画成一张信纸，终端客户端把同样的字段打成几行，作者只写一份。

**三层音频。** `bgm`、`ambience`、`sfx` 是三条独立的轨，各有自己的播放/停止/淡入淡出状态，进房间会重放。内容包带自己的音频；房间管理员手动放，或者让导演在节拍上放。

**自托管，运维意义上的“无服务器”。** 没有云、没有账号系统、没有反向代理、没有证书。服务器就是你机器上的一个进程，朋友通过 p2p QUIC 拨 ticket 进来。战役数据库、模组文件、钥匙、媒体，全在本地。

**一整个战役就是一个文件。** 模组、技能、规则包、卡、面板、演出资料包和媒体，打成一个 `.lwpack`：

```bash
bun server/src/cli/main.ts pack my-campaign/             # -> <id>-<版本>.lwpack 和它的 sha256
bun server/src/cli/main.ts install gh:owner/repo --yes   # 或者本地路径、https 链接
```

安装前先打印信任卡——这个包里有什么、跑不跑代码、是哪几个模组、加了哪些规则系统、技能、卡和面板、素材多少 MB、哪些东西被忽略了——并且在写任何东西之前把整个包校验一遍；不加 `--yes` 就只看信任卡。模组是在服务器进程里跑的真代码，所以内容包由跑服务器的人安装，或者由房间管理员在牌桌上装（`.pack install`）；装上不等于启用，管理员在房间里启用之后才生效。Git Release 就是仓库：没有要投递的中心商店，作者和读者之间也没有人（包括我们）挡着。

---

## 诚实的现状

**扎实的部分。** 确定性引擎：骰子、检定档位、卡表与衍生属性、每条写入路径上的角色规则校验、时钟、权限、文档投影契约、内容包和它的完整性校验、协议。四千九百多个服务端测试，加上约四百个客户端和 SDK 测试，全部离线跑——脚本化的模型、固定随机种子，不联网、不要 key。构建单文件服务器时会跑它自带的自检：用脚本化的模型把一个真实回合端到端走一遍。

**只有实测数据的部分。** *活的*模型行不行是另一个问题，CI 绿了也回答不了。有一个真模型实测（`server/eval/playtest.ts`），让脚本化的玩家去对真模型：由另一个真模型当裁判，拿桌上这一回合看到的全部内容对照世界的保密材料逐条评审（正当赢得的揭示不算漏，裁判打不通也按漏算）；每回合检查该掷骰的地方有没有掷；每一次工具调用连同参数和结果都记下来。它是手动跑的，一次一场，3.0 还没有每晚自动跑。结论只对那个模型、那一次运行有效，不是一张长期保票。

**年轻的部分。** 联网多人对一桌熟人来说够用了，但边角还粗糙。3.0 还没有发布版本，桌面客户端的 3.0 版本（[配套仓库](https://github.com/1A7432/loreweaver-studio)的 `v3` 分支）也还没有发布。旗舰模组在做。往前的计划、公开讨论过的设计问题、以及最缺人手的地方，都在 **[docs/roadmap.zh.md](docs/roadmap.zh.md)**。

---

## 给开发者

```bash
bun install                                         # 在仓库根目录装一次（整个仓库是一个工作区）
bun server/src/cli/main.ts serve                    # 起 p2p 服务；打印 ticket，第一次还会打印一把管理员钥匙
bun server/src/cli/main.ts key main player Alice    # 给房间 main 再签一把钥匙（服务器停着的时候）
```

`serve` 就绪时打印一行 JSON——`{"ok":true,"version":"3.0.0","ticket":"endpoint…","notes":[…]}`，数据目录是新的话还带一个 `"first_key"`——然后一直跑到被中断。接真模型：把 `.env.example` 复制成 `.env`（Bun 会从你启动时所在的目录读它）：

```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=high
```

服务器会说三种接口：OpenAI 兼容的 Chat Completions、Anthropic 的 Messages API、OpenAI 的 Responses API。`openai`、`anthropic`、`deepseek`、`openrouter`、`moonshot` 是预设；别的服务给出 base URL 就能用。`.model set <provider> [model]` 可以中途换模型，不用重启。**模型能力影响很大**：守秘人的一切都通过工具调用完成，便宜模型倾向于不掷骰就说“你成功了”。模型、配额与提示缓存的实践指南在 **[docs/operating.zh.md](docs/operating.zh.md)**。

**测试，全离线：**

```bash
cd server && bun run check            # 类型检查 + 服务端测试
cd sdk && bun run check               # 模组 SDK
cd clients/protocol && bun test       # 协议包
cd clients/tui && bun run check       # 终端客户端
cd server && bun run build            # 编出单文件服务器，再跑它的自检
```

**目录：**

```
server/src/   infra < core < agent < gateway < net，外加 cli/ 和 worker/
              infra     存储 · 配置 · i18n · llm · 媒体 · 内容包 · 召回
              core      确定性引擎：骰子、规则包、卡表、文档、内容包、面板
              agent     守秘人的回合、它的工具和提示、NPC / 书记官 / 演出导演 / 折叠这几条车道
              gateway   房间、命令、房间里的内容包、敏感词过滤
              net       Iroh p2p + 会话、钥匙库
              worker    模组代码：每个房间一个 worker
sdk/          模组 SDK                clients/   protocol · tui
```

层级契约、铁律，以及怎么加规则包 / provider / 工具 / 客户端：**[AGENTS.md](AGENTS.md)**（英文）。

**要写客户端或机器人？** 协议是公开的，也有版本号：**[docs/protocol.zh.md](docs/protocol.zh.md)**（3.0）。带类型的帧、解码器和一个参考客户端会话在 [`clients/protocol`](clients/protocol) 里，发到 npm 上叫 [`loreweaver-protocol`](https://www.npmjs.com/package/loreweaver-protocol)，它的 `major.minor` 跟着协议版本走；3.0 的包还没发到 npm。

**要写模组？** 模组是随内容包发的一个 TypeScript 文件；接口约定和测试宿主在 **[sdk/README.md](sdk/README.md)**（英文）。

**要跑常驻服务器？** 多数牌桌用笔记本 p2p 就够了；要 7×24，见 **[docs/deploy.zh.md](docs/deploy.zh.md)**（systemd、钥匙、备份、信任边界）。

## 标准

Loreweaver 读的这些格式有一份独立的规范，在 **[docs/lwf/](docs/lwf/README.md)**：Loreweaver World Format（LWF，英文）。它规定了 `.lwpack` 内容包（连同打包进去的模组）、卡片和人物/世界拆分、规则包、技能、模组面板——内容包和面板是 3.0 草案，其余是 LWF 2.0；通信协议是它的第六部分。本引擎是参考实现。[loreweaver-dsh](https://github.com/1A7432/loreweaver-dsh) 是规则包格式的第二个独立实现，拿从本引擎导出的对照表逐条核对。规范文本采用 CC BY 4.0 许可。

## 文档地图

| 给谁 | 看哪份 |
|---|---|
| 玩家 | [docs/play.zh.md](docs/play.zh.md) — 五分钟上手、按键、骰子、面板、前情提要 |
| 模组作者 | [docs/authoring.zh.md](docs/authoring.zh.md) — 从零做一个 `.lwpack`，全程拿一个真模组当例子 |
| 模组代码 | [sdk/README.md](sdk/README.md) — 模组 SDK：事件、效果、视图、命令、测试（英文）|
| 房间管理员 / 运维 | [docs/operating.zh.md](docs/operating.zh.md) — 模型、配额、缓存、备份、重置 |
| 服务器运维 | [docs/deploy.zh.md](docs/deploy.zh.md) — 常驻部署、钥匙、信任边界 |
| 卡作者 | [docs/cards.zh.md](docs/cards.zh.md) — 什么能导入、什么真的会跑、和酒馆有什么不同 |
| 扩展契约 | [docs/plugins.zh.md](docs/plugins.zh.md) — 完整分层规格 |
| 客户端作者 | [docs/protocol.zh.md](docs/protocol.zh.md) — 带版本的协议 |
| 格式实现者 | [docs/lwf/](docs/lwf/README.md) — 格式规范（LWF，英文）|
| 贡献者 | [AGENTS.md](AGENTS.md) — 架构、铁律、工程约定（英文）|
| 设计沿革 | [docs/notes/](docs/notes/) — 定下的决策与否掉的提案，每条五行；[docs/defensive-patterns.md](docs/defensive-patterns.md) — 用 bug 换来的实现规矩；设计 spec 默认不公开，公开的进 [docs/specs/](docs/specs/)（英文）|

每份文档顶上都有中英切换链接。除 `AGENTS.md`、`sdk/README.md`、格式规范和设计沿革类文档之外，用户和作者会看的文档都有中文版。

## 参与贡献

欢迎 PR 和 issue。提交前请把这些跑绿：`server/`、`sdk/`、`clients/tui/` 里的 `bun run check`，`clients/protocol/` 里的 `bun test`，以及 `server/` 里的 `bun run build`。遵守 [AGENTS.md](AGENTS.md) 里的铁律——最重要的两条是：每一句给人看的文字都来自中英两份文案表，信息隔离一次都不能破。规则内容必须是开放授权的（SRD / Miskatonic Repository）；模组请自己在运行时带。最缺人手的地方列在[路线图](docs/roadmap.zh.md)里。

## 安全

自托管让引擎、战役数据库、钥匙和文件都在你手上。但它**不会**顺带让模型流量也留在本地：远程大模型会收到守秘人的提示（里面有守秘人专属设定）、相关历史，以及当前这条玩家输入；按描述生成角色、导入角色卡时，那段文字也会发过去。语义召回默认关闭；你配了向量模型的话，设定条目和编年史记录会发到那个接口。这些内容必须留在你自己掌控的机器上的话，就用 Ollama 或 LM Studio 这类本地的 OpenAI 兼容接口。Iroh 的端到端加密管的是玩家到服务器这一段，和模型服务商那条边界是两回事。

管理员在运行时设的 API key（`.model`、`.imagegen`）**以明文存在本地 SQLite** 里，好让它们扛住重启。数据目录和里面的密钥文件在支持 POSIX 权限的文件系统上只有本人可读，但这不是密码保险箱：请保护好主机账号、备份、`.env`、`keys.json`、`transport.key`、`loreweaver.db`，以及用 `.save` 导出的房间存档，并且永远不要提交它们。

这里没有账号找回，也没有中心身份服务——一个随机钥匙就是凭证，把持有者绑到一个房间和一个角色（玩家、管理员或旁观者）。丢了就吊销；每一把管理员钥匙都要当成“这个房间的管理员 + 整个服务器的模型配置权”来对待。完整信任模型见 [docs/deploy.zh.md](docs/deploy.zh.md#数据流向与信任边界)。

发现漏洞？请在 GitHub 上开私有安全公告，不要开公开 issue。

## 许可与致谢

MIT——见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。包含 **D&D 5e SRD 5.1**（CC-BY-4.0）材料；克苏鲁内容仅限开放 / Miskatonic Repository 授权范围。骰子写法沿用 **avrae/d20**（MIT）；中文指令写法、CoC 成功等级函数与技能别名表参考 **SealDice**（MIT）重写；终端客户端基于 **OpenTUI**。本仓库不包含任何有版权的模组正文。

社区：[LINUX DO](https://linux.do/)。
