# Loreweaver

*[English](README.md) · 中文*

<!-- owner 待填：下面三句英雄句是已锁定的旧稿（landing-redesign.md「用户锁定」）。
     要换新句子改这里；正文其余部分不写口号，只写事实。 -->

**「你喜欢的角色，不该只活在对话框里。」**

带上 TA，去经历一个完整的世界：骰子决定成败，规则守住真实，留下共同历经世事的痕迹。你们一起冒险、一起失败、一起把故事走完。

你们都不知道剧本——**你们共同创造故事。**

Loreweaver 是一个开源的 **AI RPG 引擎与开放标准**。你和朋友出人，AI 守秘人读模组、记世界、扮演每个 NPC、看住每条线索。它和“和 AI 聊天”最大的区别是**骰子是真的**：检定、伤害、理智，以及卡表上的每一个数，都由代码按规则掷出并结算，模型负责把结果讲成故事。**故事归 AI，账归代码。**

一个世界的规则、设定、演员表、界面和演出，都是有文档的文件格式，而不是写死在引擎里的功能——所以一个世界可以打包带走，也可以交给别人。服务器跑在你自己的电脑上。《克苏鲁的呼唤》7 版和 D&D 5e（SRD）随包发，中英双语都是一等公民。

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black) [![protocol](https://img.shields.io/badge/wire%20protocol-2.1-informational)](docs/protocol.zh.md)

**链接：**[项目主页](https://1a7432.site) · [玩家指令手册](https://1a7432.site/commands.html) · [路线图](docs/roadmap.zh.md) · [部署](docs/deploy.zh.md) · [GitHub](https://github.com/1A7432/loreweaver)

> **实话实说：**项目还很年轻，基本是一个人带着 AI 写出来的。确定性那一半——骰子、规则、卡表、投影——是最扎实的部分，由两千多个离线测试盯着。AI 守秘人的**行为**是另一回事，只被度量、不被宣称；下面[现状那一节](#诚实的现状)会把哪些证明了、哪些没证明说清楚。

![Loreweaver 实机演示——终端里的一场真实跑团：邀请码 p2p 连入、模组开场回放、AI 守秘人叙事、一次侦查检定真骰结算](assets/demo-zh.gif)

*真实会话、真实模型、真实骰子——终端客户端实录。*

---

## 五分钟开一局

### 1. 装客户端

macOS / Linux：

```bash
curl -fsSL https://github.com/1A7432/loreweaver/releases/latest/download/install.sh | bash
```

Windows（PowerShell）：

```powershell
irm https://github.com/1A7432/loreweaver/releases/latest/download/install.ps1 | iex
```

> **粘贴之前先读这段。** 开发版是作为普通 GitHub Release 发布的，所以 `releases/latest` 指的是**最新的构建**，不是最新的*稳定版*——是一个 `release-<版本>.dev<N>+g<sha>` 形状的 tag，不是 `v1.0.0`。对一个迭代这么快的项目，这是对的默认值，但这该是你自己知情做出的选择，而不是"latest"这个词替你做的。想装某个确定的版本，就去取那个 Release 自带的安装脚本，它会把自己钉在那一版上：
>
> ```bash
> curl -fsSL https://github.com/1A7432/loreweaver/releases/download/v1.0.0/install.sh | bash
> ```
>
> `TRPG_RELEASE_TAG=<tag>` 可以覆盖任何安装脚本的选择，并且会把一键开服下载的服务器也钉到同一个 Release，客户端和服务端不会走散；`TRPG_SERVER_RELEASE_TAG` 只钉服务端。GitHub 连不上时，`TRPG_ORIGIN=https://1a7432.site/trpg` 走镜像。每个压缩包在解压前都会按发布的 SHA-256 校验一遍；对不上就直接失败，绝不退而求其次去装别的东西。

不想装进用户目录，就在安装前设 `TRPG_HOME`（客户端）和 `TRPG_LOCAL_SERVER_HOME`（一键开服的服务器状态，含它自己的 `.env`）。Windows 上请在 **Windows Terminal** 或 **WezTerm** 里跑——老式控制台会把边框画烂、吞掉鼠标。

### 2. 开服

```bash
loreweaver
```

在连接屏点绿色的「**本地开服并开玩**」。没有第二步：它会下载对应你系统的自包含服务器程序（**不用装 Python，不用配环境**），起服、发钥匙，然后直接把你以守秘人身份送进主菜单。

**不配 API key 也能先尝一口。** 没配模型且房间为空时，守秘人会看到「**试玩示例冒险**」——内置的脚本化守秘人会带着灯塔短篇走一遍真实的骰子和规则链路。服务端在载入前会再确认一次房间是空的，所以过期的菜单永远覆盖不了一个已经在跑的战役。准备好了随时在模型页填 provider，正在运行的服务会立刻切过去。

### 3. 叫人

屏幕上现在有两样东西：一个 **ticket**（p2p 地址）和一个**守秘人密钥**。在主菜单的「房间与邀请」里给每个朋友发一个邀请码。他们装好客户端，粘贴 ticket 和自己的码，起个昵称，就进来了。

**不用域名、不用证书、不用端口转发。** 连接是走 [Iroh](https://www.iroh.computer/) 的点对点 QUIC——NAT 打洞、中继兜底、端到端加密。ticket 存在本地且重启不变，所以**发一次就一直能用**。这里没有账号：邀请码本身就是入场券。掉线会自己重连并接上原处。

守秘人密钥是这个房间的管理员凭证——它能读守秘人材料、管这个房间的邀请码，而模型/provider 设置是整个部署级的。只发给你敢把笔记本交出去的人。

### 4. 开玩

用大白话说你的角色要干什么。碰到不确定的事，守秘人会要一次检定，引擎把骰子掷了。第一回合先知道三件事就够：

```
.r 3d6+2          自己掷骰      ->  Roll: 3d6+2 = [4, 4, 1]+2 = 11
.ra spot hidden   发起一次检定  ->  Check Spot Hidden: target 25 (effective 25), roll 13 -> Success
?                 打开帮助浮层  （按键、骰子、成功等级怎么读）
```

两套指令方言同时生效：骰娘系的中文写法（`.ra 侦查`、`.st 力量50`）和 Avrae 系的英文写法（`/roll 4d6kh3`）。完整的玩家上手指南——按键、面板、成功等级、`.recap`——在 **[docs/play.md](docs/play.md)**（英文）；全量指令表在[玩家指令手册](https://1a7432.site/commands.html)。

<p align="center">
  <img src="assets/tui-connect-zh.png" width="49%" alt=“连接屏：一键本地开服、已存服务器、ticket 登录” />
  <img src="assets/tui-character-zh.png" width="49%" alt=“建卡：四条路，手填模式实时校验点数预算” />
</p>
<p align="center">
  <img src="assets/tui-menu-zh.png" width="49%" alt=“守秘人主菜单：房间与邀请、导入模组、规则系统、KP 技能、模型配置” />
  <img src="assets/tui-skills-zh.png" width="49%" alt=“KP 技能：开关玩法包，或描述一句话当场生成一个新的” />
</p>

---

## 一个回合到底怎么走

一张 Loreweaver 牌桌上有**四个演员**。只有一个负责写故事，而管数字的那个不是模型。

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
│  演出导演 · Director     模型，只在节拍      幕卡、信笺、剪报、地图钉、音频提示、生成图，        │
│                                              也就是这桌人真正看到的东西                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**书记官**是被一次实测逼出来的。一场实跑里，一个叙事极强的模型跑完了整个模组，却一次都没碰过状态层：追踪器停在默认值，而剧情已经往前冲了三天。记账这件事靠模型自觉是靠不住的，于是它有了自己的一个安静演员——它只提议，引擎负责校验和夹紧。换上书记官之后重跑同一个模组，追踪器跟着剧情走了，掷骰密度也上了好几倍。

**演出导演**是最新、也是围得最紧的一个演员。它吐出来的东西全部是玩家可见的，所以它按 NPC 的方式造：全部输入只有投影过的玩家视角流，加上模组自带的演出资料包。它泄不出它从来没收到过的东西。

### 所有秘密只有一个出口

房间里的一切内容——设定、NPC、卡表、预设角色、追踪器、笔记、知识池——都是同一张表里的 `Document`。每种文档类型注册一个 `project(document, viewer)`，而**所有对外的出口都走它**。出口只有一个而不是五个，这也是我们敢信它的主要原因。

| 谁在看 | 看到什么 |
|---|---|
| 守秘人 | 完整文档——它必须知道谜底才能主持 |
| 玩家 | 投影：没有秘密设定、没有 NPC 的暗盘、没有守秘人专属追踪器、没有未公开的变量叶子 |
| NPC / 同伴 / 演出导演 | 只有它自己的记录和卡表，别的什么都不拿 |

哨兵测试断言特定的秘密永远不会穿过 `project()`，架构测试禁止 `agent/`、`gateway/`、`net/` 直接读任何保密字段。这**不能**证明的是：主守秘人为了主持谜案被看过一条秘密之后，永远不会把它复述出来。那是行为，[另有度量](#诚实的现状)。

---

## 有什么

**规则是数据，不是代码。** 一个规则系统就是一个 YAML 文件：卡表形状、衍生属性、检定梯子、子系统、点命令方言、本地化标签。随包发的 CoC 7e / D&D 5e / WoD 就是普通的规则包——把 `rulepacks/coc7.yaml` 从一个部署里删掉，CoC 就干净消失、不留残渣。检定结算是骰子引擎之上的一小段声明式 DSL：

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

骰池（`7d10>=8`）、命运骰（`4dF`）、爆炸骰（`5d6!`）都是引擎原语，所以数成功数的系统同样只是数据。DSL 真表达不了的，落到 QuickJS 沙箱解算器：引擎把预掷好的点数递进去，脚本返回一个纯粹的判定——随机性和状态永远不出引擎。模组需要房规就发一份*补丁*：`extends: coc7` 加上增量，别的什么都不写。

**拆卡。** 一张酒馆“重卡”把两样东西焊在了一起，而 Loreweaver 坚持把它们分开：*人物*（人设、卡表、记忆）和*世界*（钩子脚本、变量架构、可执行模板）。玩家导入人物半时，世界机制会被**结构性剥离**，回执还会逐项列出剥掉了什么。世界机制进房间只有一条路——守秘人自己的 `.import <文件> world`，因为它重编程的是整张桌子。导入的变量树在守秘人公开之前不上玩家面板（`.var expose`）。

**能撑过上下文窗口的战役记忆。** 跑团过程被记成编年史文档。当拼好的提示超过模型上下文窗口的 60%，最老的记录成批折叠进滚动摘要，直到降回 40% 以下；最近四回合永远不折（正在进行的这场戏还不算历史），折叠过的记录进入向量索引，所以第三场的一个细节到第十二场仍然找得回来。玩家这边是 `.recap`——同一段故事，守秘人的剧透批注由投影契约结构性地拿掉了。

**这是一个演出层，不只是聊天记录。** 模组可以自己布置牌桌。钩子发声明式区块（进度条、徽章、选项、图片）；内容包声明命名面板，绑活变量、用 `visible_when` 按值开关、放进侧栏/托盘/弹窗，受众在服务端解析；二级面板是关在沙箱 iframe 里的真 HTML/JS，且必须带一份纯文本降级。再往上是演出导演的演出模板词汇——`letter`、`clipping`、`map_pin`、`title_card`、`image`——声明式的，富客户端把它渲染成信纸，终端客户端把同样的字段打成几行，作者只写一份。

**三层音频。** `bgm`、`ambience`、`sfx` 是三条独立的轨，各有自己的播放/停止/淡入淡出状态，进房间会重放。内容包带自己的音频；守秘人手动放，或者让导演在节拍上放。

**自托管，运维意义上的“无服务器”。** 没有云、没有账号系统、没有反向代理、没有证书。服务器就是你机器上的一个进程，朋友通过 p2p QUIC 拨 ticket 进来。战役数据库、模组文件、密钥、媒体，全在本地。

**想要什么，说一句就有。** 在管理页里描述一个规则系统、一种玩法或者一个剧本，守秘人当场写好、用真解析器校验、装上。它写出来的全是别人也能读的可移植格式。

**一整个战役就是一个文件。** 技能、规则包、卡、世界书、面板、演出资料包和媒体，打成一个 `.lwpack`：

```bash
uv run python -m app --pack my-campaign/        # -> my-campaign-1.0.0.lwpack 和它的 sha256
uv run python -m app --install gh:owner/repo    # 或者本地路径、https 链接
```

安装前先打印信任卡——这个包里有什么、带不带沙箱 JS、素材多少 MB、会不会花你的出图额度——然后在写任何东西之前把每一个声明过的字节校验一遍。Git Release 就是仓库：没有要投递的中心商店，作者和读者之间也没有人（包括我们）挡着。

---

## 诚实的现状

**扎实的部分。** 确定性引擎：骰子、检定梯子、卡表与衍生属性、每条写入路径上的角色规则校验、时钟、权限、文档投影契约、内容包和它的完整性校验、协议。两千两百多个 Python 测试加约 370 个客户端测试全部离线跑——脚本化守秘人、固定随机种子，不联网、不要 key。还有一个自对局测试把整条链路端到端跑一遍。

**被度量的部分，不是被证明的部分。** *活的*模型行不行是另一个问题，绿色 CI 不回答它。一个[每夜红线评测](https://github.com/1A7432/loreweaver/actions/workflows/redline-eval.yml)让脚本化玩家对真模型跑，逐回合给守密泄漏和“该掷没掷”打分；超阈值、provider 故障、鉴权失败都算红。结论只对那个模型、那一次运行有效，不是一张长期保票。

**年轻的部分。** 联网多人对一桌熟人来说够用了，但边角还粗糙。富客户端和制卡工作台在[配套仓库](https://github.com/1A7432/loreweaver-studio)，比这个仓库更早期。旗舰模组在做。往前的计划、公开讨论过的设计问题、以及最缺人手的地方，都在 **[docs/roadmap.zh.md](docs/roadmap.zh.md)**。

---

## 给开发者

```bash
uv sync --extra ejs                # 依赖；ejs = 跑导入卡自带 JS 的 QuickJS 沙箱
uv run python -m app --cli         # 离线示例守秘人 + 真骰子，不需要 API key
uv run python -m app --doctor      # 体检：本地化 / 规则包 / 技能 / 数据目录
uv run python -m app --serve       # 起 p2p 服务，打印 ticket 和守秘人密钥
```

接真模型：把 `.env.example` 复制成 `.env`：

```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=high
```

大多数厂商走 OpenAI 兼容路径加一个预设即可；Anthropic 和 Gemini 有原生客户端；ChatGPT 与 SuperGrok 订阅走 OAuth。`.model set <provider> [model]` 可以中途换模型，不用重启。**模型能力影响很大**：守秘人的一切都通过工具调用完成，便宜模型倾向于不掷骰就说“你成功了”。模型、配额与提示缓存的实践指南在 **[docs/operating.md](docs/operating.md)**（英文）。

**测试，全离线：**

```bash
uv run pytest -q                                  # 离线测试套件
uv run ruff check core infra agent gateway net adapters app.py lw_versioning.py scripts
uv run python scripts/i18n_lint.py                # 不许有硬编码的用户可见字符串
cd clients/protocol && bun test                   # 协议包
cd clients/tui && bun test                        # 终端客户端
```

**目录：**

```
core/   确定性引擎              infra/    存储 · 配置 · i18n · llm · embeddings · 向量 · providers
agent/  AI 演员们 + KP 工具     gateway/  commands · ops · hub · runner · director
net/    Iroh p2p + 会话核心     adapters/ CLI          clients/ protocol（npm）· tui
```

层级契约、铁律，以及怎么加规则包 / provider / 工具 / 客户端：**[AGENTS.md](AGENTS.md)**。

**要写客户端或机器人？** 线格式是开放且带版本的：**[docs/protocol.zh.md](docs/protocol.zh.md)**（2.1）。类型化帧和一个会自动重连的 WebSocket 客户端发布在 npm 上，包名 [`loreweaver-protocol`](https://www.npmjs.com/package/loreweaver-protocol)，它的 `major.minor` 跟随协议版本。

**要跑常驻服务器？** 多数牌桌用笔记本 p2p 就够了；要 7×24，见 **[docs/deploy.zh.md](docs/deploy.zh.md)**（systemd、密钥、备份、信任边界）。

## 文档地图

| 给谁 | 看哪份 |
|---|---|
| 玩家 | [docs/play.zh.md](docs/play.zh.md) — 五分钟上手、按键、骰子、面板、前情提要 |
| 模组作者 | [docs/authoring.zh.md](docs/authoring.zh.md) — 从零做一个 `.lwpack`，全程拿一个真模组当例子 |
| 守秘人 / 运维 | [docs/operating.zh.md](docs/operating.zh.md) — 模型、配额、缓存、备份、重置、自更新 |
| 服务器运维 | [docs/deploy.zh.md](docs/deploy.zh.md) — 常驻部署、密钥、信任边界 |
| 卡作者 | [docs/cards.zh.md](docs/cards.zh.md) — 什么能导入、什么真的会跑、和酒馆有什么不同 |
| 钩子作者 | [docs/hooks.zh.md](docs/hooks.zh.md) — 沙箱回合生命周期 API |
| 扩展契约 | [docs/plugins.zh.md](docs/plugins.zh.md) — 完整分层规格 |
| 客户端作者 | [docs/protocol.zh.md](docs/protocol.zh.md) — 带版本的协议 |
| 贡献者 | [AGENTS.md](AGENTS.md) — 架构、铁律、工程约定（英文）|

每份文档顶上都有中英切换链接。除 `AGENTS.md` 之外，用户和作者会看的文档都有中文版。

## 参与贡献

欢迎 PR 和 issue。提交前请把这些跑绿：`uv run ruff check …`、`uv run python scripts/i18n_lint.py`、`uv run pytest -q`，以及相关的 `bun test`。遵守 [AGENTS.md](AGENTS.md) 里的铁律——最重要的两条是：每一句用户可见的文案都走 i18n，信息隔离一次都不能破。规则内容必须是开放授权的（SRD / Miskatonic Repository）；模组请自己在运行时带。最缺人手的地方列在[路线图](docs/roadmap.zh.md)里。

## 安全

自托管让引擎、战役数据库、密钥和文件都在你手上。它**不会**自动让模型流量也留在本地：远程 LLM 会收到分析阶段的模组正文、守秘人系统提示（含守秘人专属设定）、相关历史，以及当前玩家输入。标准应用用的是本地哈希 embedding；如果你刻意接了一个远程 embedding 后端，文档分块也会发过去。这些提示必须留在你自己掌控的基础设施上，就用 Ollama 或 LM Studio 这类本地端点。Iroh 的端到端加密覆盖的是玩家到服务器这一段，那和模型 provider 是两条不同的边界。

Provider 的 API key 和 OAuth 授权**以明文存在本地 SQLite** 里，好让运行时配置能扛住重启。新建的密钥文件和数据目录在支持 POSIX 权限的文件系统上会收紧到仅本人可读，但这不是密码保险箱：请保护好主机账号、备份、`.env`、`keys.toml`、`keeper-key.txt` 和 `*.db`，并且永远不要提交它们。

这里没有账号找回，也没有中心身份服务——一个随机密钥就是凭证，把持有者绑到一个房间和一个角色（玩家或守秘人）。丢了就吊销；每一个守秘人密钥都要当成“这个房间的管理员 + 整个部署的模型配置权”来对待。完整信任模型见 [docs/deploy.zh.md](docs/deploy.zh.md)。

发现漏洞？请在 GitHub 上开私有安全公告，不要开公开 issue。

## 许可与致谢

MIT——见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。包含 **D&D 5e SRD 5.1**（CC-BY-4.0）材料；克苏鲁内容仅限开放 / Miskatonic Repository 授权范围。gateway 层脱胎于 **hermes-agent**（MIT，© 2025 Nous Research）；骰子引擎是 **avrae/d20**（MIT）；中文指令方言、CoC 成功等级函数与技能别名表参考 **SealDice**（MIT）重写；终端客户端基于 **OpenTUI**。本仓库不包含任何有版权的模组正文。

社区：[LINUX DO](https://linux.do/)。
