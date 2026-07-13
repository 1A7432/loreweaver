*[English](deploy.md) · 中文*

# 部署 Loreweaver

大多数桌都是**从笔记本 p2p 开的**——`python -m app --serve`,或连接屏一键「本地开服」(见 [README](../README.zh.md))。本页讲**常驻服务器**(7×24 的公共局 + 一个稳定 ticket)。Loreweaver 走 **Iroh**——点对点 QUIC、用 ticket 拨号,**无需域名、TLS、端口转发或反向代理**。玩家用部署者颁发的密钥加入,没有账户系统。(不再有 Docker 镜像和 WebSocket 服务路径——WebSocket 仅作离线测试传输保留。)

## 裸机运行

需要 Python ≥ 3.11 和 [uv](https://docs.astral.sh/uv/)。

```bash
git clone https://github.com/1A7432/loreweaver && cd loreweaver
cp .env.example .env          # 然后设置 TRPG_LLM__*(或留空以使用离线演示)
uv sync                       # env + 依赖(iroh 是默认依赖)
uv run python -m app --serve --keys ./data/keys.toml
```

首次运行服务器会**自动发一个守秘人 key** 并打印一个可分享的 **Iroh ticket**——两者也写到 keystore 旁的 `keeper-key.txt` / `iroh-ticket.txt`。把 ticket + 守秘人 key 发出去;连进去后,在客户端的「房间与邀请」界面发更多 key / 建房,不用碰服务器。状态(SQLite + key)存在 `--keys` 旁边。

> 非国内 LLM 走 SOCKS 代理?`uv pip install socksio`。国内直连的 provider(如 DeepSeek)不用代理,干净 env 跑即可。

## 常驻(systemd)

```ini
# /etc/systemd/system/loreweaver.service  —— 把 YOU 换成你的用户名
[Unit]
Description=Loreweaver Iroh server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOU
WorkingDirectory=/home/YOU/loreweaver                 # .env 从这里加载
ExecStart=/home/YOU/.local/bin/uv run python -m app --serve --keys /home/YOU/loreweaver-data/keys.toml
Restart=on-failure
RestartSec=10
TimeoutStartSec=120                                   # Iroh 的中继握手要一会儿

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now loreweaver
journalctl -u loreweaver -f       # 跟日志——ticket + 守秘人 key 启动时打印
```

## 配置

所有设置使用 `TRPG_` 环境变量前缀，`__` 用于嵌套（见 `.env.example` / `infra/config.py`）。默认从工作目录的 `.env` 加载；如果设置了 `TRPG_ENV_FILE`，就从该文件加载。TUI 一键本地开服会自动设置 `TRPG_ENV_FILE=<本地服务器目录>/.env`。

| 变量 | 目的 | 默认值 |
|---|---|---|
| `TRPG_LLM__PROVIDER` | `openai`（+ 预设：`deepseek`、`groq`、`openrouter`、`together`、`ollama`、`lmstudio` 等）、双模式 `chatgpt` / `gpt-subscription`、订阅模式 `supergrok`，或原生 `anthropic` / `gemini` | `openai` |
| `TRPG_LLM__API_KEY` | 提供商/代理 API 密钥；订阅 OAuth 路径不使用它；对普通 API-key provider 而言，**留空 = 离线演示 Keeper** | *（空）* |
| `TRPG_LLM__BASE_URL` | OpenAI-compatible 基础 URL；对 `chatgpt` / `gpt-subscription` 显式设置时选择代理路径，留空时选择订阅 OAuth | 提供商预设 |
| `TRPG_LLM__CHAT_MODEL` | 聊天模型 id | `gpt-4o` |
| `TRPG_LLM__EMBEDDING_MODEL` / `TRPG_LLM__EMBEDDING_DIM` | 检索嵌入 | `text-embedding-3-small` / `1536` |
| `TRPG_LOCALE` | 用户界面语言 `en` / `zh` | `en` |
| `TRPG_ENV_FILE` | 明确指定启动时读取的 `.env` 文件 | 工作目录下的 `.env` |
| `TRPG_DATA_DIR` | 战役与运行时数据目录（db → `<data_dir>/loreweaver.db`） | `./data` |
| `TRPG_TUI_KEYS` | 密钥存储文件路径（也可用 `--keys` 覆盖；独立于 `TRPG_DATA_DIR`） | `./keys.toml` |
| `TRPG_LOCAL_SERVER_HOME` | TUI 一键本地开服根目录：服务器程序/源码缓存、`.env`、数据、钥匙和 ticket sidecar 都在这里 | `TRPG_HOME`，否则 `<用户目录>/.loreweaver` |
| `TRPG_RELEASE_TAG` | 将安装器/客户端和一键开服下载固定到某个带版本的 GitHub Release，例如 `release-0.5.1.dev29+g0cf542b` | 最新稳定 release |
| `TRPG_SERVER_RELEASE_TAG` | 只固定一键开服下载服务器程序/源码的 release tag；正式 release 安装器会自动写入 | `TRPG_RELEASE_TAG`，否则最新稳定 release |
| `TRPG_ENABLE_VECTOR_DB` | 世界书 / 文档检索 | `true` |
| `TRPG_TUI__JOIN_TIMEOUT` | 未经身份验证的连接在关闭前必须发送 `join` 的秒数 | `10` |
| `TRPG_CENSOR__WORDLIST_PATH` | 内容审核词表：JSON 文件 `{"word": level, ...}`（等级 `1`-`5`，见 `gateway.ops.CensorLevel`）。见 [内容审核](#内容审核) | *（空 = 审核关闭）* |
| `TRPG_CENSOR__WORDLIST` | 内容审核词表，内联：`word[:level],word2[:level2],...` —— 文件的替代方案，方便用一个环境变量。如果两者都设置，将结合 `WORDLIST_PATH` | *（空 = 审核关闭）* |

聊天平台适配器（Discord/Telegram/QQ/飞书）**代码在树内,但无人维护、未对真平台实测**——见 [roadmap](roadmap.zh.md)。它们的 token（`TRPG_DISCORD__TOKEN`、`TRPG_TELEGRAM__TOKEN`、`TRPG_QQ__APP_ID` / `TRPG_QQ__SECRET`、`TRPG_FEISHU__APP_ID` / `TRPG_FEISHU__APP_SECRET`）仍在,`--serve --platforms discord` 可组合模式跑一个,但视为实验性。

ChatGPT 订阅不是 API key。要使用直接订阅路径，先启动服务器，在私密/本地 Keeper 聊天中运行 `.model login chatgpt`，完成设备码流程，再运行 `.model set chatgpt [model]`。此路径应让 `TRPG_LLM__BASE_URL` 保持为空；Loreweaver 使用保存的 OAuth grant，而不是浏览器 cookie 或网页会话自动化。运行 `.model login supergrok` 后再执行 `.model set supergrok [model]`，即可选择 SuperGrok 订阅路径；同一 grant 也可供其生图使用。

原有兼容网关仍然受支持：将 provider 设为 `chatgpt` 或 `gpt-subscription`，显式设置 `TRPG_LLM__BASE_URL=<gateway /v1 endpoint>`，并提供网关 API key。显式 `base_url` 始终选择这条经典代理路径，而不是订阅 OAuth。

Release 构建会为每个客户端与服务端压缩包发布相邻的 `.sha256`。安装器会先校验客户端摘要，一键开服也会校验所选服务端压缩包；遇到完整性错误时不会静默退回未校验的源码下载。稳定的 `v*` tag 才会成为 GitHub 的 Latest，开发构建只作为 pre-release 发布。HTTP 镜像除了给一键安装入口保留根目录兼容副本，还会把每次发布固定在 `releases/<tag>/`；正式或固定版本的安装器回退时只取对应 tag，之后的开发版发布不会覆盖它。内嵌摘要只在所选 tag 与安装器内嵌 tag 相同时使用；改选其他版本时会读取目标压缩包自己的 sidecar。摘要不匹配会立即终止，既不解压也不换一个 payload 继续。安装器默认使用 `https://registry.npmjs.org`；只有明确选择其他 registry 时才设置 `TRPG_REGISTRY`。

## 加密

Iroh 连接**天生端到端加密**（QUIC/TLS，每个对端由其公钥认证）——受支持的 serve 路径没有明文 `ws://` 可被嗅探，也没有证书要管理。它保护的是玩家客户端与 Loreweaver 服务端之间的流量，并不代表服务端不会向配置的模型 provider 发送数据。

## 数据流与信任边界

- 确定性规则引擎、SQLite 战役状态、媒体、房间 key 与备份留在你运营的服务端。需要 Iroh relay 时，中继只转发加密流量，不终止应用会话。
- **远程** LLM endpoint 是另一家数据处理方。它会收到用于分析的模组正文、Keeper system prompt（当前包含接近完整的守秘人资料）、相关对话历史和本轮玩家输入。标准应用使用本地 hash embedder；只有显式把 embedding backend 换成远程实现时，文档分块才会发往该 endpoint。如果这些内容必须留在自己控制的基础设施，请选 Ollama、LM Studio 等本地 endpoint。
- 玩家知识池及每个 NPC/同伴 actor 在结构上按作用域隔离：子 actor 只由自己的档案与角色卡构建。主 Keeper 不同——它为了主持谜团必须看到秘密。prompt 约束与每夜真实模型红线评测只能降低并测量泄漏风险，不能证明任意模型都不会泄漏。
- 玩家 key 按房间隔离。Keeper key 可以读取守秘人状态，并且只能管理自己房间的 key；但 provider/模型配置作用于整台部署。只给完全信任的共同管理员签发 Keeper key。调用者填入新的自定义 provider URL 时，系统不会把旧的已保存 API key 自动带到新 endpoint，除非调用者为新 endpoint 明确提供该 key。
- Provider API key 与订阅 OAuth grant 会以未加密形式保存在本地 SQLite，以便热配置在重启后继续生效。它们只作为鉴权信息发往所选 provider endpoint，不会发给玩家。宿主账号及其备份都属于可信计算边界。

## 内容审核

`gateway.ops.Censor` 是一个真实的、抗绕过的单词匹配器（NFKC + 小写折叠规范化、带空格/标点符号/全宽拼写的反混淆、整词边界、偏移保留掩码） —— 但**它默认没有词表且处于关闭状态。** Loreweaver 故意不捆绑脏话/辱骂词表：维护一个并获得正确的多语言覆盖是每个部署者应该拥有的政策选择，而不是烘焙在引擎中的东西。如果没有配置词表，`Censor` 在每次调用时都会采用明确的无操作路径 —— 它不会默默地过滤任何内容。

要打开它，设置 `TRPG_CENSOR__WORDLIST_PATH`（JSON 文件）或 `TRPG_CENSOR__WORDLIST`（内联列表）之一 —— 见上面的 [配置](#配置) 表。示例文件：

```json
{ "some-slur": 5, "some-mild-word": 2 }
```

等级从 `1`（`NOTICE`）到 `5`（`FORBIDDEN`）；在 `DANGER`（`4`）或更高等级的命中会阻止消息（响应被替换），以下则被就地掩码。单词匹配与区域设置无关 —— 列出任何需要审核的词/脚本。

**当前范围 —— 依赖前先阅读：**

- 它仅筛查 **AI Keeper 的自己叙述**（`agent.loop.run_kp_turn` 的 `output_review`，在 `gateway.runner.GatewayRunner` 和 `net.tui_server.TuiServer` 中连接）。**玩家输入不被筛查。** 玩家可以输入任何东西；只有 Keeper 回复的内容被检查。
- 它是一个词表匹配器，不是语义分类器 —— 它捕获列出的词（和它们的简单混淆），不是它没被告知的任何东西。

不要将其视为开箱即用的审核解决方案 —— 它是一个可配置的构建块，在您提供词表之前什么都不做。

## 密钥与持久化

- **密钥**将不透明令牌绑定到 `room`（共享的 `chat_key`）和角色。使用 `--tui-key add` 生成；未知密钥在加入时被拒绝。密钥存储是 TOML 文件（`keys.toml`） —— 永远不要提交它。
- **持久化**是一个 SQLite 文件（`loreweaver.db`），保存所有战役状态，由 `room` 作用域。保留 `/data` 卷以保持进度。
- **运行时 provider 凭据**（包括订阅 OAuth 的 access/refresh grant）会以未加密形式保存在该本地 SQLite 文件中，以便重启后继续使用。请像保护 `.env`、`keys.toml` 一样保护数据库。
- **房间备份**从 Keeper 管理 UI 创建的是服务器端 JSON 快照，始终限制在 `<data_dir>/room_backups/` 下；可选路径只作为该目录内的文件名。它们包括原始访问密钥、房间状态、向量数据和自包含媒体 blob，所以要像保护 `keys.toml` 一样保护它们。
- **本地权限**：在文件系统支持 POSIX mode 时，新建的敏感文件会收紧为 `0600`，专用数据/备份目录会收紧为 `0700`。Windows 或不支持 POSIX 权限的文件系统上仅为 best-effort，并不替你管理 ACL。
- **机密**（`.env`、`keys.toml`、`keeper-key.txt`、`*.db`、备份）被 git 忽略；只有 `*.example.*` 被跟踪。绝不提交它们。

## 连接客户端

客户端使用 [`docs/protocol.md`](protocol.md) 中的版本化协议,经 Iroh 连接。把终端客户端指向服务器的 **ticket**(启动时打印)+ 一个已生成的密钥:

```bash
cd clients/tui && bun install
bun run dev -- connect --host <ticket> --key <key> --name <name>
# 或直接 `loreweaver`(装好的客户端),在连接屏粘 ticket + 密钥
```

连接端到端加密;服务器是密钥门控的,但要把密钥当机密对待。
