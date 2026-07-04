# Loreweaver

**自托管、终端优先的桌游 AI 守秘人(KP)——世界与故事优先。**

*[English](README.en.md) · 中文*

Loreweaver 跑的是一场**游戏**,不是一次聊天。AI **守秘人(KP)** 底下是一台真引擎:结构化的世界(模组、场景、NPC、线索、时间线、隐藏真相),确定性的规则内核(真骰子、成功等级、受规则校验的角色卡、游戏时钟、能留存的会话历史),外加一套严格的保密纪律,把剧情秘密挡在玩家视野外。KP 在这之上叙事、裁定、扮演 NPC——但骰子从不由它编。

你在一个**游戏式的终端界面**里玩:一条命令进大厅,连接、建角色、坐上牌桌。系统无关(**D&D 5e SRD** + **克苏鲁的呼唤 7 版**),运行时中英双语。

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black)

> **状态——早期,且诚实。** Loreweaver 还很年轻,基本是一人 + AI 协作搭起来的。确定性引擎(骰子、规则、角色数学)和它的离线测试套件是扎实的,终端客户端是打磨得最好的那条路。联网 p2p 多人、以及真模型的 KP 质量都还在积极完善中——哪些就绪、哪些还没,见 **[路线图](docs/roadmap.zh.md)**(聊天平台适配器代码在树内保留,但暂无力测试维护;重心是终端客户端)。

## 它凭什么不一样
市面上的工具,要么是**骰子机器人**(Avrae、SealDice:只自动化,没有 GM),要么是**人物卡聊天前端**(SillyTavern/酒馆:角色很好,但没有世界、没有因果、没有规则)。Loreweaver 把它们都没凑齐的那几样凑齐了:

| | 真骰子/规则 | AI 守秘人 | 持久世界+故事 | AI 队友 |
|---|:---:|:---:|:---:|:---:|
| 骰子机器人 | ✅ | ❌ | ❌ | ❌ |
| 人物卡聊天 | ❌ | ~ | ❌ | ~ |
| **Loreweaver** | ✅ | ✅ | ✅ | ✅ |

赌注是:一台真骰子/真规则的内核,加上一个知识受限的模型,能像人类 KP 那样**跑**一个模组。这个赌注兑现得好不好,很大程度取决于你接的模型(见[快速上手](#快速上手)的模型说明)——这是"系统无关、自带 LLM"设计的诚实代价。

## 怎么玩——终端大厅
敲一条命令,进的是游戏菜单,不是配置文件:

![Loreweaver TUI —— 真·终端截图:守秘人叙事、一次掷骰检定、右侧队伍花名册](assets/tui-zh.png)

- **四种方式建角色**:按规则公式掷骰、逐项手动设置(实时显示点数/技能点预算)、写一段人设描述让 AI 起草卡、或导入酒馆(SillyTavern)角色卡。**每一种都会对着规则系统校验**:超范围、超预算的值一律由确定性代码钳制,绝不由 AI 一句话说了算。
- **键盘鼠标都能用**,骰面光标,还有一个"KP 正在思考"的动态转圈提示(让你分得清是在跑,还是卡死/断网了);队伍花名册点开就是完整角色卡。**顶栏是一条 HUD**:场景名、游戏内时钟、本地时间,外加上下文占用 %、输入/输出 token 与缓存命中率;右上角一盏 🟢/🟡/🔴 连接灯——掉线(睡眠/换网/服务器重启)会**自动重连**,不用重开客户端。
- 发邀请码、热切模型、导入模组这些**守秘人专属**功能,只有用守秘人 key 连进来才会出现。

真骰子、能留存的故事,连浏览器都不用开——只要终端客户端。

## 开一局叫朋友来玩(自托管三步)

真正的玩法:你**自托管**服务器,发 ticket + 邀请码把朋友拉进来。**朋友只用装客户端、不用读任何文档**——你把 ticket 和邀请码发给他就行。默认走 **Iroh p2p(推荐)**:在**自己电脑上**跑一条命令,朋友直连——**不需要域名、证书、公网端口**。

**① 你(房主 / 守秘人)—— 起服务端 + 拿 ticket 和钥匙**
```bash
python -m app --serve   # 打印一个 p2p ticket(endpoint…)+ 首次自动发的守秘人 key(也写进 iroh-ticket.txt / keeper-key.txt)
```
运行 `loreweaver`,连接屏「Ticket / 主机」栏粘贴那个 ticket + 守秘人 key + 昵称。

**② 你 —— 建房 + 给每个朋友发一个邀请码**
进主菜单 →「房间与邀请」→ 填 **房间名 + 朋友昵称 + 角色(玩家)** → 发一个 key,发给他。("建房间"=给一个新房间名发 key,全程不碰服务器;想再要个副守秘人就发 keeper 角色的。)

**③ 朋友(玩家)—— 一行装客户端 + 连进来**
```bash
curl -fsSL https://1a7432.site/trpg/install.sh | bash   # Windows: irm https://1a7432.site/trpg/install.ps1 | iex
loreweaver     # 连接屏粘贴你给的 ticket + 邀请码 + 昵称
```
坐上同一张桌,开玩。没有账号系统——邀请码就是入场凭证。

> **传输**:Loreweaver 走 **Iroh**——点对点 QUIC 直连,用 ticket 拨号,无需域名/TLS/端口转发。服务端身份**持久化**:节点密钥存在数据目录,**重启后 ticket 不变**——分享一次,长期有效(常驻服务用 systemd,`stop`/`restart` 走 SIGTERM 干净收尾)。富媒体(图片/音频)在路线图上,将走这条传输(靠 iroh-blobs)。详见 [docs/protocol.zh.md](docs/protocol.zh.md)。

## 亮点
- **标准 function-calling 的 AI 守秘人**:60+ 个 KP 工具(掷骰、检定、理智、角色卡、模组知识、笔记、战报、先攻)。任何 OpenAI 兼容或原生模型都能接;推荐默认 **`deepseek-v4-pro` 开思考**。
- **用大白话扩展它**:守秘人在 TUI 的「规则系统 / 技能 / 模组」管理页里描述一句想要什么,KP 就**现场生成 → 真加载器校验 → 安装 → 生效**。不自造协议——规则包是数据驱动的 `rulepacks/*.yaml`,技能沿用 **Claude Code 的 `SKILL.md`** 约定(带 `allowed-tools` 工具门控),角色卡/世界书沿用 **SillyTavern** 生态(卡片 V2/V3 + lorebook),让现有工具零摩擦迁移。生成物先过校验再落到用户数据目录、绝不覆盖内置、绝不 `eval` 任意字符串(风险分层:数据 → 声明式技能 → 代码插件,详见 [docs/plugins.md](docs/plugins.md))。
- **关系轨(社交/浪漫向)**:开启 `romance-relationships` 技能后解锁一组门控工具,把**好感 / 情欲**当作**确定性数值**追踪、钳制、持久化(方向性、非对称),给社交战役一份真账面——数值是代码,叙事仍归模型。
- **确定性内核,生成式表层**:骰子/`d20`、CoC 成功等级、角色数学、**建卡规则校验**、内容审查匹配器与权限,全是真代码;只有叙事和 NPC 交给模型。检定永远先掷骰,再由 KP 按成功等级叙事。(审查默认词表为空——**默认关闭**,配置后也只审查 KP 自己的回复,不审查玩家输入——详见 [docs/deploy.zh.md](docs/deploy.zh.md#content-moderation)。)
- **角色卡一律合规**:无论手动、掷骰、AI 起草还是导入,成品都被确定性代码(`core/character_rules.py`)钳制在 rulepack 的范围与点数预算内——AI 只提议,校验器定稿。
- **AI NPC 与 AI 队友**:知识受限的子角色,照规矩玩——各自只凭自己该知道的信息行动,从构造上只由它自己的记录组装、绝不碰 KP 的秘密池,所以这些子角色无从元游戏。空座位能让 AI 队友补上,用它自己的卡掷自己的骰。
- **一场会话,同桌**:RoomHub 让所有玩家坐在同一张活桌上,并保留传输无关的接缝——将来实测通过的聊天平台玩家也能从这里接进来。
- **两套命令方言,一个掷骰器**:英文 Avrae/d20(`/roll 4d6kh3`、`[[1d20+5]]`、`adv/dis`)与中文 SealDice(`.ra 侦查`、`困难/极难`、`.st 力量50`)。
- **多家 LLM 任选**:一个环境变量切 `deepseek`、`groq`、`openrouter`、`ollama`……(OpenAI 兼容)或原生 `anthropic` / `gemini`。

## 快速上手
```bash
uv sync                                  # 建 .venv + 装依赖(含 dev 工具)

# 最快一瞥——离线、免 API key(内置演示 KP + 真 seed 骰子):
uv run python -m app --cli               # 试试  r 3d6+2 · /roll 4d6kh3 · .ra 侦查 · .setcoc 2

# 接真 KP——复制 .env.example → .env 填好模型,然后:
uv run python -m app --cli               # 自然语言回合现在由真 KP 来跑
# (没有 uv?python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev,anthropic,gemini]")
```
接真 KP 的 `.env`(以 DeepSeek 为例,任何 OpenAI 兼容或原生 provider 都行):
```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=max
```
> **模型选得对不对,很关键。** KP 极度依赖工具调用和指令遵从。能力强的模型(开思考的 deepseek-v4-pro、GPT-4 级、Claude)会通过工具真掷骰、并忠实地跑模组自己的场景;便宜的小模型往往光叙述检定结果却不真掷,还会跑偏模组。运行时 `.model set <provider> [model]` 热切,不用重启。

**在终端界面里玩(真正的体验):**
```bash
uv run python -m app --serve   # 起 Iroh p2p 服务端——打印一个 ticket + 首次自动发的守秘人 key
# 另开一个终端——客户端启动后停在连接屏:
cd clients/tui && bun install && bun run dev
```
把打印的 ticket + 守秘人 key 粘进连接屏(或直接点连接屏的「本地开服」,它替你全干)。无需注册——房主发放 key,把玩家绑到同一个房间。

**玩家一行安装(不用克隆/构建)。** 装好 `bun` + 拉取客户端 + 生成 `loreweaver` 启动器,一条命令搞定:
```bash
curl -fsSL https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh | bash   # Windows: irm https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.ps1 | iex
loreweaver          # 启动 → 在连接屏粘守秘人给你的 ticket + 邀请码
loreweaver update   # 自更新到最新客户端
```
> 🇨🇳 国内访问 GitHub 慢或不稳?用镜像源(会自动改从 1a7432.site 拉取客户端):
>
> ```bash
> curl -fsSL https://1a7432.site/trpg/install.sh | bash   # Windows: irm https://1a7432.site/trpg/install.ps1 | iex
> ```

### 跑一台常驻服务器(可选)
大多数桌都是从笔记本 p2p 开的(见上)。想要 7×24 的公共局,任意机器裸机跑:
```bash
uv sync && uv run python -m app --serve   # 用 systemd 服务保持常驻——见 docs/deploy.zh.md
```
首次运行会用 `.env.example` 生成 `.env`,并**自动发一个守秘人 key**(打印 + 存到 `keeper-key.txt`)。用它连进去,再在客户端的「房间与邀请」界面发更多 key / 建房。状态(SQLite + key)存在进程旁边。完整说明(配置、密钥、systemd、模型)见 **[docs/deploy.zh.md](docs/deploy.zh.md)**。

## 游玩入口
| 入口 | 状态 |
|---|---|
| **终端 · OpenTUI** | ✅ **主力**——上面那个游戏大厅;本地或联网 p2p(Iroh) |
| CLI(无头) | ✅ 开发 / 快速试玩 / 离线 demo |

系统:**D&D 5e SRD** 和 **CoC 7 版**以数据驱动的 rulepack(`rulepacks/*.yaml`)随附——加新系统不用改代码。(聊天平台适配器 Discord/Telegram/QQ/飞书 在树内保留,但**无人维护、未对真平台实测**,见 [roadmap](docs/roadmap.zh.md)。)

## 架构
```
core/  确定性引擎        infra/  store · config · i18n · llm · embeddings · vector · providers
agent/ AI-KP 大脑 + 工具  gateway/ 平台无关层:commands · ops · hub · runner · director
net/   Iroh p2p + 会话核心  adapters/ cli(聊天适配器在树内、无人维护)   clients/ protocol · tui
```
引擎用稳定的 `chat_key` 隔离全部状态;RoomHub 再叠一层跨端实时广播。分层契约、铁律(确定性 vs 生成、掷骰优先、信息隔离),以及怎么加 rulepack / 适配器 / provider / 工具 / 客户端,都在 **[CLAUDE.md](CLAUDE.md)**。客户端线格式见 **[docs/protocol.zh.md](docs/protocol.zh.md)**。

## 测试
```bash
uv run pytest -q                            # 离线:FakeLLM/FakeEmbeddings + seed 骰子,不联网、不用 key
uv run ruff check core infra agent gateway net adapters app.py scripts
uv run python scripts/i18n_lint.py          # 不许有硬编码的自然语言串
cd clients/tui && bun install && bun test   # (客户端:protocol · tui · web)
```
测试全程确定性、离线。自 play 测试用一个**脚本化**的 KP 贯穿整条栈(上传 → 分析 → 开团 → 玩家行动 → **真 seed 骰子**检定 → 战报),并直接单元测试那些确定性保证:守秘人/玩家知识分池(秘密**从构造上**不进玩家池)、子演员隔离(NPC/同伴的提示**只**由它自己的记录组装)、以及真 seed 骰子。因为离线 KP 是脚本化的,这证明的是**流程和脱敏本身是对的——证明不了真模型真的会守规矩**。真模型的表现另有一道**每夜真模型红线闸门**在盯(`.github/workflows/redline-eval.yml`,只按 schedule 跑,绝不卡 PR):它以 `--gate` 模式跑 `scripts/playtest.py` 和 `scripts/longrun.py`,用一个便宜的真模型给每一回合打分——泄密率(逐字**和**改述)与掷骰优先漏判率——任一项超过(可配置的)阈值就判负:非零退出 + 上传日志产物;没配 `EVAL_LLM_API_KEY` 这个 secret 时会干净地跳过(不会变红)。详见[路线图](docs/roadmap.zh.md)。CI(push/PR)跑 Python(3.11 · 3.12)+ 客户端各包,全程离线——真模型调用不会发生在那里。

## 参与贡献
欢迎 PR 和 issue。提 PR 前,`uv run ruff check …`、`uv run python scripts/i18n_lint.py`、`uv run pytest -q`(以及相关 `bun test`)都得过。守住 [CLAUDE.md](CLAUDE.md) 的铁律——尤其**不许硬编码面向用户的文案**(走 `infra.i18n` + `locales/`)和**信息隔离**红线。只能加开放、可自由分发的规则内容(SRD / 米斯卡塔尼克);模组请运行时自带。最需要人手的地方见 **[路线图](docs/roadmap.zh.md)**。

## 安全
绝不提交任何密钥——`.env`、发放的 key、SSH host key、数据库都已 gitignore(只提交 `*.example.*`)。房主发放的 key 把玩家绑到房间;没有账号系统。

没有账号系统:key 是 bearer token,把玩家绑到房间并带上玩家或守秘人角色。超出可信小圈子的场景,请把服务放在你自己的鉴权与 TLS(反向代理)之后,别直接开到公网——这是任何自托管服务的基本卫生。

发现漏洞?请在 GitHub 开私有安全公告,别开公开 issue。

## 许可与致谢
MIT——见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。含 **D&D 5e SRD 5.1**(CC-BY-4.0)材料;克苏鲁内容仅限开放 / 米斯卡塔尼克仓库许可范围。gateway/适配器层派生自 **hermes-agent**(MIT,© 2025 Nous Research);骰子引擎是 **avrae/d20**(MIT);中文命令方言、CoC 成功函数与技能别名表参照 **SealDice**(MIT)重写;终端客户端用 **OpenTUI**。本仓库不随附任何受版权保护的冒险/模组文本。

## 路线图
完整计划见 **[docs/roadmap.zh.md](docs/roadmap.zh.md)**。更长的一段路是生长世界引擎(生成式世界 · 活的因果时间线 · 设定一致性)、加入迟到玩家追进度与 D&D Beyond 角色卡导入、并把聊天适配器连到真机端到端实测。
