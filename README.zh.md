# Loreweaver

**自托管的桌面 RPG「AI 守秘人 / Game Master」——世界与故事优先。**

*[English](README.md) · 中文*

Loreweaver 跑的是一场**游戏**，而不是一次聊天。它维护一个结构化的世界（模组、场景、NPC、线索、时间线、隐藏真相）、一套确定性的规则引擎（真骰子、成功等级、角色卡、游戏时钟、持久的会话记录），外加一个用 function-calling 的 **AI 守秘人**在其上叙事、裁定、扮演 NPC——同时用一套硬性的保密纪律，把剧情秘密挡在玩家视野之外。Discord 优先，系统无关（**D&D 5e SRD** + **克苏鲁的呼唤 7 版**），英文优先、运行时 `en`/`zh` 双语。

![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black)

## 它凭什么不一样
市面上要么是**骰子机器人**（Avrae、SealDice、Dice Maiden——只自动化、没有 GM），要么是**人物卡对话前端**（SillyTavern/酒馆——角色很好，但没有世界、没有因果、没有规则）。Loreweaver 的切入点是它们都没有的组合：

| | 真骰子/规则 | AI 守秘人 | 持久世界+故事 | 跨平台同桌 | AI 队友 |
|---|:---:|:---:|:---:|:---:|:---:|
| 骰子机器人 | ✅ | ❌ | ❌ | ~ | ❌ |
| 人物卡对话 | ❌ | ~ | ❌ | ❌ | ~ |
| **Loreweaver** | ✅ | ✅ | ✅ | ✅ | ✅ |

## 亮点
- **标准 function-calling 的 AI 守秘人**——60+ 个守秘人工具（骰子、检定、理智、角色卡、模组知识、笔记、战报、先攻）。任意 OpenAI 兼容或原生模型皆可接入。
- **确定性内核，生成式表层**——骰子/`d20`、移植的 CoC 成功等级、角色数学、审查与权限是真代码；叙事/NPC/风味交给模型。检定先掷骰，再按结果叙事。
- **一场会话，任意平台同桌**——RoomHub 让 Discord 玩家、QQ 玩家、终端/网页/SSH 玩家坐在**同一张活桌**上。用 `.room` 把频道绑到房间。
- **四个终端/网页前端**——无头 CLI、[OpenTUI](https://opentui.com) 终端客户端、**浏览器网页版**（React）、**富 SSH**（`ssh 你@主机` → 完整 TUI，零安装），全部走同一套开放 [WebSocket 协议](docs/protocol.md)。
- **AI NPC 与 AI 队友**——知识受限的子演员，**照规矩玩**：它们只根据自己该知道的信息行动（绝不碰守秘人池），因此结构上杜绝元游戏。空座位可由 AI 队友补上，用它自己的角色卡掷真骰。
- **导入 SillyTavern 人物卡**——`import_character` 解析 `.png`/`.json` 人物卡，按模组所用规则自动生成合法角色卡，作为你的 PC 或 AI 队友加入；卡里的 `character_book` 灌进世界书。
- **两套命令方言，一个掷骰器**——英文 Avrae/d20（`/roll 4d6kh3`、`[[1d20+5]]`、`adv/dis`）与中文 SealDice（`.ra 侦查`、`困难/极难`、`b/p`、`.st 力量50`），外加原生 Discord/Telegram 斜杠命令。
- **多厂商 LLM**——一个环境变量切换：`deepseek`、`groq`、`openrouter`、`together`、`ollama`、`lmstudio`……（OpenAI 兼容预设）或原生 `anthropic` / `gemini`。

## 快速上手
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e .            # 只有用原生 anthropic/gemini 时才加 [anthropic,gemini] extras

# 1) 离线——无需 API key（内置演示 Keeper + 确定性骰子）：
python -m app --cli                     # REPL：试 r 3d6+2  /roll 4d6kh3  .ra 侦查  .setcoc 2
python -m app --cli --script tests/fixtures/selfplay_en.txt   # 离线 AI-KP 自play demo

# 2) 真 AI 守秘人——复制 .env.example → .env 并填你的模型：
#    TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-...   TRPG_LLM__CHAT_MODEL=deepseek-chat
python -m app --cli                     # 自然语言回合现在由真 Keeper 跑
```
> **模型选择很重要。** 守秘人重度依赖工具调用与指令遵从：能力强的模型（GPT-4 级、Claude、或强开源模型）会用工具真掷骰、并更忠实地跑模组自己的场景；便宜模型（如 `deepseek-chat`）非常适合压测/回归，但**倾向于只叙述检定结果而不真掷、并偏离模组自由发挥**。运行时用 `.model set <provider> [model]` 热切换，无需重启。

**联网/多人：** `scripts/tui_demo.sh` 发一个 key 并起服务、打印连接命令；另开终端 `cd clients/tui && bun install && bun run dev -- connect --host ws://127.0.0.1:8787/ --key <key>`。浏览器：`cd clients/web && bun install && bun run dev`。SSH：见 `clients/ssh/README.md`。无需注册——部署者发放 key 把玩家绑到共享房间。

## 游玩入口与系统
| 入口 | 状态 | 说明 |
|---|---|---|
| CLI（无头） | ✅ | 开发/自测/免凭证试玩 |
| 终端（OpenTUI） | ✅ | 本地或联网；DF-16 主题、实时骰子条、HP/SAN 条 |
| 浏览器（web） | ✅ | React + Vite，同一协议 |
| SSH | ✅ | `ssh key@主机` → 完整 TUI，零安装，公钥认证 |
| Discord | ✅ | 旗舰，斜杠优先 |
| Telegram | ✅ | setMyCommands 斜杠 |
| QQ（官方机器人） | ✅ | 订阅 **`GROUP_MESSAGE_CREATE`**（全量群消息）+ 每群主动模式 |
| 飞书 / Lark | ✅ | |

系统：**D&D 5e SRD** 与 **CoC 7 版**以数据驱动的 rulepack（`rulepacks/*.yaml`）随附；加系统无需改代码。四平台真机器人连接需凭证（适配器测试为离线 mock）。

## 架构
```
core/  确定性引擎        infra/  store·config·i18n·llm·embeddings·vector·providers
agent/ AI-KP 大脑+工具    gateway/ 平台无关层：commands·ops·hub·runner·director
net/   WebSocket 服务端    adapters/ cli·discord·telegram·qq·feishu    clients/ protocol·tui·web·ssh
```
引擎以稳定的 `chat_key` 隔离全部状态；RoomHub 再叠加跨传输的实时广播。分层契约、铁律（确定性 vs 生成、掷骰优先、信息隔离）、以及如何加 rulepack/适配器/provider/工具/客户端，见 **[CLAUDE.md](CLAUDE.md)**。客户端线格式见 **[docs/protocol.md](docs/protocol.md)**。

## 测试
```bash
pytest -q                                   # ~597 个离线测试（FakeLLM/FakeEmbeddings、seed 骰子）
ruff check core infra agent gateway net adapters app.py scripts
python scripts/i18n_lint.py                 # 无硬编码自然语言串
cd clients/<protocol|tui|web|ssh> && bun install && bun test   # （web 用 bun run test）
```
自play 测试贯穿整条栈（上传→分析→开团→玩家行动→**真 seed 骰子**检定→战报），并断言守秘人**绝不泄露**模组隐藏秘密。CI 跑 Python(3.12) + 四个客户端包。

## 参与贡献
欢迎 PR 与 issue。提 PR 前须过：`ruff check`、`python scripts/i18n_lint.py`、`pytest -q`（以及相关 `bun test`）。请守 [CLAUDE.md](CLAUDE.md) 的铁律——尤其**不硬编码面向用户的文案**（走 `infra.i18n` + `locales/`）与**信息隔离**红线。只可加入开放、可自由分发的规则内容（SRD / 米斯卡塔尼克）；模组请运行时自带。

## 安全
绝不提交任何密钥——`.env`、发放的 key、SSH host key、数据库都已 gitignore（只提交 `*.example.*`）。部署者发放的 key 把玩家绑到房间；无账号系统。发现漏洞？请在 GitHub 开私有安全公告，而非公开 issue。

## 许可与致谢
MIT——见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。含 **D&D 5e SRD 5.1**（CC-BY-4.0）材料；克苏鲁内容仅限开放/米斯卡塔尼克仓库许可范围。gateway/适配器层派生自 **hermes-agent**（MIT，© 2025 Nous Research）；骰子引擎为 **avrae/d20**（MIT）；中文命令方言、COC 成功函数与技能别名表参照 **SealDice**（MIT）重写；终端客户端用 **OpenTUI**。本仓库不随附任何受版权保护的冒险/模组文本。

## 路线图
世界书深化（生成式世界·活的因果时间线·设定一致性）· 更丰富的聊天卡片与迟到玩家回放 · 从 D&D Beyond 导入角色卡 · 抽牌表 · CI 发布产物。
