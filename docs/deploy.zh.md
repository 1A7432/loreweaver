*[English](deploy.md) · 中文*

# 部署 Loreweaver

绝大多数桌都是**从一台笔记本上 p2p 开的**——在终端客户端的连接界面点一下「本地开服并开玩」，或者跑一句 `bun server/src/cli/main.ts serve`（见 [README](../README.zh.md)）。这一页讲的是**常驻服务器**：7×24 开着的局，加一个固定的 ticket。Loreweaver 走 **Iroh** 的点对点 QUIC，用 ticket 拨号，**不需要域名、证书、端口转发或者反向代理**。玩家拿房间管理员发的钥匙进来，没有账号系统。没有 Docker 镜像，3.0 也没有 WebSocket 通道。

3.0 还没有发布版本：服务器要从源码运行，机器上需要装好 [Bun](https://bun.sh)。

## 直接跑起来

```bash
git clone https://github.com/1A7432/loreweaver && cd loreweaver
bun install
cp .env.example .env          # 然后填 TRPG_LLM__*（不填也能启动，只是守秘人回不了话）
bun server/src/cli/main.ts serve
```

就绪时服务器打印一行 JSON，然后一直跑到被中断：

```json
{"ok":true,"version":"3.0.0","ticket":"endpoint…","notes":["recall_off"],"first_key":{"room":"main","key":"…"}}
```

数据目录是新的话，它会给房间 `main` 签一把**管理员钥匙**，只在这里打印这一次——`first_key` 以后不会再出现。用 ticket 和这把钥匙连进去，剩下的钥匙在客户端的「访问钥匙」屏里新建（或者用 `.key mint`），不用再碰服务器。`notes` 是启动时的提示，写成代码：`model_not_configured`、`context_window_unknown`、`recall_off`。有设置项用不了的话，服务器在打开任何东西之前就会停下：`{"ok":false,"code":"bad_settings","problems":[…]}` 会把出问题的变量一次全列出来。

其他命令在 shell 里跑，每条都打印一个 JSON 对象，方便脚本读：

```bash
bun server/src/cli/main.ts key <room> <admin|player|observer> <name>   # 新签一把钥匙；它的值只打印这一次
bun server/src/cli/main.ts import-world <room> <card-file>             # 把一张酒馆卡导入成房间的世界
bun server/src/cli/main.ts packs                                       # 已安装的内容包
bun server/src/cli/main.ts install <path|https-url|gh:owner/repo[@tag]> [--yes] [--force]   # --force：替换 id 和版本都相同的已装内容包
bun server/src/cli/main.ts uninstall <id>
bun server/src/cli/main.ts selftest                                    # 这个构建能不能把一个回合完整跑通
bun server/src/cli/main.ts --version
```

`key` 和 `import-world` 要在服务器**停着**的时候跑：正在运行的服务器手里有一份自己的钥匙文件和房间。从 shell 装上或卸掉的内容包，正在运行的服务器要下次启动才看得到。钥匙上写着房间名；给一个还不存在的房间签钥匙，那个房间就开起来了。

### 用一个文件代替整份源码

`cd server && bun run build` 会把服务器编成一个可执行文件 `server/dist/loreweaver`，并跑一遍它的自检。命令都一样（`loreweaver serve`、`loreweaver key …`），运行它的机器上不需要装 Bun。设置用环境变量给它，或者写在启动它的那个文件夹里的 `.env` 文件里。

终端客户端也能这样编（`cd clients/tui && bun run compile` → `clients/tui/dist/loreweaver-tui`）。不在源码目录里运行时，它的「本地开服并开玩」跑的是和它放在同一个文件夹里的 `loreweaver`；没有的话是 `TRPG_LOCAL_SERVER_BIN` 指的那个；再没有就是 `<本地服务器目录>/server-bin/loreweaver`。一次发布就是每个平台这两个文件，外加把它们装到一起的安装脚本——见 [releasing.md](releasing.md)。

### 一个数据目录只跑一个服务器

正在运行的服务器会在数据目录里放一个 `server.lock`。对同一个目录再起一个 `serve` 会被拒绝（`data_dir_in_use`），而且是在它打开任何东西之前；有服务器在跑的时候，`key` 和 `import-world` 也会被拒绝（`server_running`），因为它们直接写钥匙文件和数据库。服务器被强杀后留下的锁指向一个已经不存在的进程，下次启动会直接接管。

### 由别的程序来托管

把服务器当子进程启动的程序（比如客户端的「本地开服」），加上 `--until-stdin-closes`，并让子进程的标准输入保持为一条打开的管道。父进程一旦消失——崩溃、被杀都算——管道就断，服务器像收到 SIGTERM 一样停下，不会在没人管的情况下一直跑着。`serve` 不管成败都只回一个 JSON 对象：就绪行（`ok: true`、ticket、提示，以及新目录的第一把管理员钥匙），或者带 `code` 的拒绝（`bad_settings`、`data_dir_in_use`、带 `detail` 的 `startup_failed`）。

### 重启后仍然有效的 ticket

服务器的身份是数据目录里的 `transport.key`：同一个 key，重启之后还是同一个 ticket。留好它（复制数据目录就带上了）；删了它，服务器就换一个新 ticket，每个玩家都得拿新的。

## 让它一直开着（systemd）

```ini
# /etc/systemd/system/loreweaver.service  —— 把 YOU 换成你的用户名
[Unit]
Description=Loreweaver server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOU
WorkingDirectory=/home/YOU/loreweaver
EnvironmentFile=/home/YOU/loreweaver/.env
Environment=TRPG_DATA_DIR=/home/YOU/loreweaver-data
ExecStart=/home/YOU/.bun/bin/bun server/src/cli/main.ts serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now loreweaver
journalctl -u loreweaver -f       # 跟日志——就绪那一行（ticket、第一把钥匙）启动时打印
```

服务器收到 `SIGTERM` 和 `SIGINT` 都会干净地停下：先关掉所有连接和数据库，再退出。

## 更新

3.0 没有自更新。手动更新：

```bash
cd ~/loreweaver && git pull && bun install && sudo systemctl restart loreweaver
```

ticket 不变。客户端的协议主版本号必须和服务器一致：太旧或太新的客户端会被拒绝，并告诉你是哪一边落后了——所以客户端也从同一份源码更新。

## 配置

所有设置都是 `TRPG_*` 环境变量，层级之间用 `__` 连接（读它们的只有 `server/src/infra/config.ts` 一处；[`.env.example`](../.env.example) 全列出来了）。用 `bun` 启动时，服务器还会读启动目录下的 `.env`。

| 变量 | 用途 | 默认 |
|---|---|---|
| `TRPG_LOCALE` | 房间自己没设语言之前用的语言：`en` / `zh` | `en` |
| `TRPG_DATA_DIR` | 数据目录：数据库、钥匙文件、服务器身份、媒体、已安装的内容包 | `./data` |
| `TRPG_LLM__PROVIDER` | 预设——`openai`、`anthropic`、`deepseek`、`openrouter`、`moonshot`——或者你自己起的名字，配上 `TRPG_LLM__BASE_URL` | *（无）* |
| `TRPG_LLM__BASE_URL` | 接口地址；优先于预设的地址 | 预设的 |
| `TRPG_LLM__API_KEY` | 服务商的 API key | *（无：没有模型）* |
| `TRPG_LLM__CHAT_MODEL` | 模型 id | *（无：没有模型）* |
| `TRPG_LLM__WIRE` | `openai-compatible`、`anthropic` 或 `openai-responses` | 预设的，否则 `openai-compatible` |
| `TRPG_LLM__REASONING_EFFORT` | `low`、`medium`、`high`、`xhigh` 或 `max` | 服务商的 |
| `TRPG_LLM__CONTEXT_WINDOW` | 模型的上下文长度（token）；编年史折叠拿它当分母 | 认识的模型用它自己的；否则按 32000 算 |
| `TRPG_LLM__MAX_OUTPUT_TOKENS` | 单次回复的上限 | 服务商的 |
| `TRPG_LLM__TIMEOUT_MS` | 一次模型调用最多等多久 | SDK 的 |
| `TRPG_LLM__PROMPT_CACHE_KEY` | 设成 `false`，两种 OpenAI 接口就不发 `prompt_cache_key` | `true` |
| `TRPG_NPC__*`、`TRPG_SCRIBE__*`、`TRPG_DIRECTOR__*`、`TRPG_MEMORY__*` | 一条车道自己的那十项；只写模型或推理强度就沿用守秘人的接口和密钥，写了服务商或 base URL 就是一个单独的接口，要配自己的密钥 | 用守秘人的客户端 |
| `TRPG_TURN__MAX_ROUNDS` | 守秘人一回合最多几轮工具调用 | `12` |
| `TRPG_SCRIBE__ENABLED` | 书记官 | `true` |
| `TRPG_DIRECTOR__ENABLED` | 演出导演 | `true` |
| `TRPG_DIRECTOR__IMAGES` | `false`：导演只展示内容包里的图，从不生成 | `true` |
| `TRPG_DIRECTOR__MAX_IMAGES` | 一段故事最多生成几张图 | `24` |
| `TRPG_DIRECTOR__PREGEN_PER_BEAT` | 一个节拍最多预先准备几个接下来可能出场的对象 | `2` |
| `TRPG_CHRONICLE__ENABLED` | 编年史折叠 | `true` |
| `TRPG_CHRONICLE__FOLD_TRIGGER` / `__FOLD_FLOOR` / `__FOLD_EMERGENCY` | 上下文窗口的比例（下限 < 触发 ≤ 紧急） | `0.60` / `0.40` / `0.85` |
| `TRPG_CHRONICLE__LAG_TURNS` | 最近几回合永远不折 | `4` |
| `TRPG_CHRONICLE__SUMMARY_MAX_CHARS` | 战役摘要的长度上限 | `4000` |
| `TRPG_IMAGEGEN__BASE_URL`、`__API_KEY`、`__MODEL` | 生图；三个都填，或者都不填 | *（关）* |
| `TRPG_IMAGEGEN__SIZE` | `宽x高` 或 `auto` | `1024x1024` |
| `TRPG_IMAGEGEN__DIALECT` | `openai` 或 `xai` | `openai` |
| `TRPG_EMBEDDINGS__API_KEY`、`__MODEL`、`__DIMENSIONS` | 语义召回（一个 OpenAI 兼容的向量接口）；不配的话，设定只按关键词触发 | *（关）* |
| `TRPG_EMBEDDINGS__BASE_URL` | 这个接口的地址 | OpenAI 的 |
| `TRPG_CENSOR__WORDLIST` / `TRPG_CENSOR__WORDLIST_PATH` | 敏感词过滤：见[内容过滤](#内容过滤) | *（关）* |
| `TRPG_STORE__UNDO_DEPTH` | `.undo` 最多能往回倒几回合 | `4` |
| `TRPG_MODULES__CALL_TIMEOUT_MS` | 一次调用房间的模组 worker 最多等多久，超时就结束那个 worker | `5000` |
| `TRPG_TUI__AUDIO_MAX_FILE_BYTES` | 单个音频的大小上限（字节） | 128 MiB |
| `TRPG_TUI__AUDIO_ROOM_QUOTA_BYTES` | 一个房间所有音频加起来的上限（字节） | 2 GiB |

房间管理员可以在运行时改模型车道和生图（`.model`、`.imagegen`，或者「模型」屏）；这些改动存在数据库里，在 `.model reset` 之前优先于环境变量。

## 加密

Iroh 的玩家连接是**端到端加密的，什么都不用配**（QUIC/TLS，每一端用自己的公钥认证），也没有证书要管。它保护的是客户端和 Loreweaver 服务器之间的流量；服务器发给你配置的模型服务商的内容，不归它管。

## 数据流向与信任边界

- 确定性的规则引擎、SQLite 里的战役状态、媒体、房间钥匙和备份，都留在你运营的那台服务器上。需要用到 Iroh 中继时，中继转的是加密流量，不会终结应用层会话。
- **远程**大模型接口是另一个数据处理方。它会收到守秘人的提示（按设计里面就有世界的守秘人专属设定）、相关的对话历史，以及当前这条玩家输入；按描述生成角色、导入角色卡时，那段文字也会发过去。语义召回默认关闭；你配了向量接口的话，设定条目和编年史记录会发到那里。这些内容必须留在你自己掌控的机器上的话，就选 Ollama 或 LM Studio 这类本地接口。
- 玩家和每一个 NPC 都靠代码本身和守秘人材料隔开：NPC 只用它自己的档案和卡表拼出来，演出导演只拿桌上已经看到过的东西。主守秘人是故意不一样的——它要看到秘密才能主持谜案。提示里的要求和真模型实测能降低、也能量出它泄密的风险，但证明不了每个模型都守规矩。
- 模组是真代码，在房间的 worker 线程里跑，没有安全沙箱：装一个内容包，就是决定让它的代码在这台机器上跑。写入任何东西之前，信任卡会先把这一点说清楚。内容包由跑服务器的人安装，或者由房间管理员在牌桌上装（`.pack install`）。
- 钥匙按房间划分。管理员钥匙能读守秘人级别的状态、能管的钥匙也只限自己的房间，但模型配置和内容包安装是整个服务器的。管理员钥匙只发给完全信得过的共同管理者。
- 运行时设的 API key 以明文存在本地 SQLite 里，好让它们扛住重启。它们只作为授权发给选定的服务商接口，从不发给玩家。请把主机账号和它的备份当成可信计算基的一部分来看待。

## 内容过滤

敏感词过滤（`server/src/gateway/review.ts`）是一个实打实、不好绕过的匹配器——NFKC 和大小写归一，词里的字母之间可以夹空格、点、星号、连字符、间隔号或零宽字符，整词匹配，打码落在原文字符上——但它**不自带词表，默认关闭。** Loreweaver 故意不内置脏话/歧视词表：维护一份词表、把多语言覆盖做对，是每个运营者自己该拿主意的政策问题，不该写死在引擎里。没配词表时，过滤是一个明确的空操作——它没有在悄悄过滤任何东西。

要打开它，设 `TRPG_CENSOR__WORDLIST`（直接写：`词[:等级],词2[:等级2],…`）或 `TRPG_CENSOR__WORDLIST_PATH`（一个文本文件，每行一个 `词[:等级]`），两个都设就合在一起用。词表文件读不了，服务器就不启动：运营者要了过滤，就不能给他一台不过滤的服务器。

```
某个脏词:5
某个轻微的词:2
```

等级从 `1`（提示）到 `5`（禁止）；不写等级就是 `1`。命中一律打码；命中等级 `4`（危险）及以上，守秘人的这条回复就不发出去，这一回合改成一条提示结束。匹配和语言无关——要过滤什么文字就写什么。

**目前的范围——依赖它之前先看完：**

- 它只筛引擎自己摆到桌上的文字：守秘人的叙事、模组发到桌上的事实，以及模型给新角色写的文字（`.genchar`、导入角色卡）。**玩家输入不过滤。**
- 管理员启用了成人内容技能的房间，完全不过滤。
- 它是词表匹配，不是语义分类——只抓词表里有的词（以及它们简单的变形），没告诉它的一概不管。

别把它当成开箱即用的审核方案——它是一个可配置的零件，你不给词表它就什么都不做。

## 钥匙和数据

- **钥匙**把一个随机密钥绑到一个房间和一个角色（`player`、`admin` 或 `observer`）。它们存在数据目录的 `keys.json` 里。用客户端的「访问钥匙」屏或 `.key mint` 新建；服务器停着的时候，也可以用 `loreweaver key`。钥匙的值只在新建时显示一次，列表里一律打码。吊销一把钥匙，持有者的连接会立刻断开。房间最后一把管理员钥匙不能吊销，也不能降级。
- **数据**是一个 SQLite 文件 `loreweaver.db`，装着所有房间的状态。留住数据目录，进度就在。
- **运行时凭证**（用 `.model`、`.imagegen` 设的 API key）以明文存在这个文件里，好让它们扛住重启。像保护 `.env`、`keys.json` 一样保护这个数据库。
- **用 `.save` 导出的房间存档**里有这个房间的全部秘密，像保护数据库一样保护它们。
- **本地权限：**在支持 POSIX 权限的文件系统上，数据目录建成 `0700`，数据库、钥匙文件和服务器身份是 `0600`。在 Windows 或不支持 POSIX 权限的文件系统上只是尽力而为，它不是 ACL 管理器。
- **密钥类文件**（`.env`、`data/` 目录）已经被 git 忽略。永远不要提交它们。

## 让客户端连进来

客户端在 Iroh 上说 [`docs/protocol.md`](protocol.md) 里那套带版本的协议。用服务器的 **ticket** 和一把钥匙让终端客户端连进来：

```bash
cd clients/tui && bun run dev connect --host <ticket> --key <key> --name <名字>
# 或者直接 `bun run dev`，在连接界面里贴 ticket 和钥匙
```

连接是端到端加密的；服务器靠钥匙把门，但钥匙要当成机密对待。
