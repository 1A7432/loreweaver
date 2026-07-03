*[English](deploy.md) · 中文*

# 部署 Loreweaver

自托管网络化 Keeper（终端/网页/SSH 客户端连接的 WebSocket 服务器）。一条命令即可启动；玩家通过部署者颁发的密钥加入 —— 没有账户系统。

## TL;DR

```bash
# Docker（推荐）—— 构建并启动服务器，后台运行，监听 :8787
./scripts/deploy.sh

# 无 Docker —— venv + pip install + 前台运行
./scripts/deploy.sh --bare-metal
```

`deploy.sh` 在首次运行时从 `.env.example` 创建 `.env`，然后执行 `docker compose up -d --build` 或设置 `.venv`。重新运行是安全的。

## 选项 A —— Docker（推荐）

```bash
cp .env.example .env          # 然后设置 TRPG_LLM__* (或留空以使用离线演示)
docker compose up -d --build  # 构建镜像并在 :8787 启动服务器
docker compose logs -f        # 跟踪日志
docker compose down           # 停止
```

- 镜像基于 `python:3.12-slim`，以非 root 用户身份运行，启动 `python -m app --serve --host 0.0.0.0 --port 8787`。
- 配置从 `.env` 读取（见 [配置](#配置)）。该文件是可选的 —— 无 API 密钥时，运行绑定的**离线演示 Keeper**。
- 状态存储在挂载于 `/data` 的命名卷 `loreweaver-data` 中（`/data/loreweaver.db` + `/data/keys.toml`），因此战役和已颁发的密钥在重启和重新构建后保留。要改为绑定主机目录，请将 `docker-compose.yml` 中的卷行替换为 `./data:/data`。

### 生成访问密钥 (Docker)

镜像的 `ENTRYPOINT` 是 `python -m app`，因此仅传递应用程序参数：

```bash
docker compose run --rm loreweaver --tui-key add --room table --name Keeper --role keeper
docker compose run --rm loreweaver --tui-key add --room table --name Alice
```

每条命令打印一个新密钥并将其追加到 `/data/keys.toml`（服务器使用的同一卷），因此运行中的服务器在下一次客户端加入时会使用它 —— 无需重启。给所有人相同的 **`--room`** 来将他们安排在一个共享表中；`--role keeper` 授予仅限 Keeper 的权力（默认为 `player`）。

## 选项 B —— 裸机（无 Docker）

需要 Python >= 3.11。

```bash
./scripts/deploy.sh --bare-metal
```

这会创建 `.venv`，安装包（`pip install -e ".[anthropic,gemini]"`），确保 `.env` 存在，首次运行时为房间 `table` 生成初始 Keeper 密钥，打印连接行，并在前台启动服务器（Ctrl-C 停止）。

手动等效：

```bash
uv sync --extra anthropic --extra gemini   # env + 依赖；删除 --extra ... 以仅使用 OpenAI 兼容
export TRPG_DATA_DIR=./data TRPG_TUI_KEYS=./data/keys.toml
uv run python -m app --tui-key add --room table --name Keeper --role keeper   # 生成密钥
uv run python -m app --serve --host 0.0.0.0 --port 8787                       # 运行服务器
# 没有 uv？pip 也可以：python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[anthropic,gemini]"
```

## 配置

所有设置使用 `TRPG_` 环境变量前缀，`__` 用于嵌套（见 `.env.example` / `infra/config.py`）。Docker Compose 从 `.env` 注入它们。

| 变量 | 目的 | 默认值 |
|---|---|---|
| `TRPG_LLM__PROVIDER` | `openai`（+ 预设：`deepseek`、`groq`、`openrouter`、`together`、`ollama`、`lmstudio` 等），兼容代理的 `chatgpt` / `gpt-subscription`，或原生 `anthropic` / `gemini` | `openai` |
| `TRPG_LLM__API_KEY` | 提供商 API 密钥 —— **留空 = 离线演示 Keeper** | *（空）* |
| `TRPG_LLM__BASE_URL` | OpenAI 兼容的基础 URL；对于 `chatgpt` / `gpt-subscription` 代理别名为必需 | 提供商预设 |
| `TRPG_LLM__CHAT_MODEL` | 聊天模型 id | `gpt-4o` |
| `TRPG_LLM__EMBEDDING_MODEL` / `TRPG_LLM__EMBEDDING_DIM` | 检索嵌入 | `text-embedding-3-small` / `1536` |
| `TRPG_LOCALE` | 用户界面语言 `en` / `zh` | `en` |
| `TRPG_DATA_DIR` | 存储 + 密钥目录（db → `<data_dir>/loreweaver.db`） | `/data`（镜像） |
| `TRPG_TUI_KEYS` | 密钥存储文件路径 | `/data/keys.toml`（镜像） |
| `TRPG_ENABLE_VECTOR_DB` | 世界书 / 文档检索 | `true` |
| `TRPG_TUI__JOIN_TIMEOUT` | 未经身份验证的连接在关闭前必须发送 `join` 的秒数 | `10` |
| `TRPG_TUI__MAX_CONNECTIONS` | 全局并发连接上限（所有房间）；超过时立即拒绝。`0`/负数 = 无限制 | `200` |
| `TRPG_TUI__TLS_CERT_PATH` / `TRPG_TUI__TLS_KEY_PATH` | 可选的原生 TLS —— PEM 证书链 / 密钥路径；设置**两者**以直接提供 `wss://`。见 [TLS](#tls-wss) | *（空 = 明文 `ws://`）* |
| `TRPG_CENSOR__WORDLIST_PATH` | 内容审核词表：JSON 文件 `{"word": level, ...}`（等级 `1`-`5`，见 `gateway.ops.CensorLevel`）。见 [内容审核](#内容审核) | *（空 = 审核关闭）* |
| `TRPG_CENSOR__WORDLIST` | 内容审核词表，内联：`word[:level],word2[:level2],...` —— 文件的替代方案，方便用一个环境变量。如果两者都设置，将结合 `WORDLIST_PATH` | *（空 = 审核关闭）* |

平台机器人（可选）：`TRPG_DISCORD__TOKEN`、`TRPG_TELEGRAM__TOKEN`、`TRPG_QQ__APP_ID` / `TRPG_QQ__SECRET`、`TRPG_FEISHU__APP_ID` / `TRPG_FEISHU__APP_SECRET`。要在 WS 服务器旁边运行聊天机器人，请在 serve 命令中追加 `--platforms discord,telegram`（组合模式）—— 覆盖容器命令，例如 `docker compose run ... loreweaver --serve --host 0.0.0.0 --port 8787 --platforms discord`。

ChatGPT 订阅（chatgpt.com 上的 Free/Go/Plus/Pro/Business/Enterprise）不是 API 凭证，应用不使用 ChatGPT 浏览器会话、cookie 或非官方网页自动化作为模型后端。要通过订阅支持的服务路由，暴露或配置您部署控制的 OpenAI 兼容网关，然后设置 `TRPG_LLM__PROVIDER=gpt-subscription`、`TRPG_LLM__BASE_URL=<gateway /v1 endpoint>`、`TRPG_LLM__API_KEY=<gateway key>` 和 `TRPG_LLM__CHAT_MODEL=<gateway model id>`。

## TLS (wss://)

普通 `ws://` 是未加密的：长期持有的令牌（`--tui-key add`）和所有游戏内容 —— 包括仅限 Keeper 的模块机密 —— 以明文形式在网络上传输。**`ws://` 只有在绑定到 `127.0.0.1` 进行本地开发时才可接受。** 任何可从 localhost 之外访问的内容（公共服务器、`--host 0.0.0.0`、LAN）都需要 TLS。

### 推荐：在反向代理处终止 TLS

让应用继续监听明文 `ws://127.0.0.1:8787`（默认主机），在它前面放置 nginx/Caddy/traefik 以拥有证书（例如通过 Let's Encrypt/ACME）并与客户端通信 `wss://`。这是在生产中运行任何 WebSocket 服务的标准、久经考验的方式，也是这里推荐的方法。

Caddy（自动 HTTPS —— 最简选项）：

```
your-domain.example {
    reverse_proxy 127.0.0.1:8787
}
```

nginx：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example;
    ssl_certificate     /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

将客户端指向 `wss://your-domain.example/`。保持 `--host 127.0.0.1`（默认值），使应用端口本身永远不会从互联网直接访问 —— 仅通过代理。

### 备选：服务器中的原生 TLS

没有反向代理可用？服务器可以自己终止 TLS：将 `TRPG_TUI__TLS_CERT_PATH` 和 `TRPG_TUI__TLS_KEY_PATH` 设置为 PEM 证书链和私钥（两者都需要一起 —— 见 [配置](#配置)）。设置两者时，`--serve` 直接监听 `wss://`；将两者留空（默认值）以保持明文 `ws://`，这对于仅 `127.0.0.1` 的本地开发是可以的。

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
- **房间备份**从 Keeper 管理 UI 创建的是服务器端 JSON 快照，放在 `<data_dir>/room_backups/` 下，除非提供路径。它们包括原始访问密钥、房间状态和向量数据，所以要像保护 `keys.toml` 一样保护它们。
- **机密**（`.env`、`keys.toml`、`*.db`）被 git 忽略；只有 `*.example.*` 被跟踪。不要将它们烘焙到镜像中（`.dockerignore` 排除它们）。

## 连接客户端

客户端使用 [`docs/protocol.md`](protocol.md) 中的版本化 WebSocket 协议。将任何客户端指向 `ws://<host>:8787/` 和一个已生成的密钥：

```bash
# 终端 (OpenTUI)
cd clients/tui && bun install
bun run dev -- connect --host ws://localhost:8787/ --key <key> --name <name>

# 浏览器 (React)
cd clients/web && bun install && bun run dev

# SSH（零安装完整 TUI）—— 见 clients/ssh/README.md
```

对于实际部署，见上面的 [TLS](#tls-wss) —— 不要在 localhost 之外暴露明文 `ws://`。服务器是密钥门控的，但要将密钥视为机密。
