*[English](deploy.md) · 中文*

# 部署 Loreweaver

绝大多数桌都是**从一台笔记本上 p2p 开的**——一句 `python -m app --serve`，或者在连接屏点一下「本地开服」（见 [README](../README.zh.md)）。这一页讲的是**常驻服务器**：7×24 开着的公共局，加一个固定的 ticket。Loreweaver 走 **Iroh** 的点对点 QUIC，用 ticket 拨号，**不需要域名、证书、端口转发或者反向代理**。玩家拿部署者发的密钥进来，没有账号系统。（没有 Docker 镜像，也没有给玩家用的 WebSocket 通道——老的 TUI WebSocket 只留作离线测试。）

## 直接跑起来

需要 Python 3.11 以上和 [uv](https://docs.astral.sh/uv/)。

```bash
git clone https://github.com/1A7432/loreweaver && cd loreweaver
cp .env.example .env          # 然后填 TRPG_LLM__*（留空就是离线示例守秘人）
uv sync                       # 环境和依赖（iroh 是默认依赖）
uv run python -m app --serve --keys ./data/keys.toml
```

第一次启动时，服务器会**自动生成一个守秘人密钥**，并打印一个可以直接发出去的 **Iroh ticket**——这两样也会写在密钥文件旁边的 `keeper-key.txt` / `iroh-ticket.txt` 里。把 ticket 和守秘人密钥发给自己，连进去之后，剩下的邀请码和房间都在客户端的「房间与邀请」页里发，不用再碰服务器。数据（SQLite 和密钥）就存在 `--keys` 旁边。

> 用 SOCKS 代理连境外模型？装一下 `uv pip install socksio`。国内能直连的服务商（比如 DeepSeek）不用代理，干净环境跑就行。

## 让它一直开着（systemd）

```ini
# /etc/systemd/system/loreweaver.service —— 把 YOU 换成你的用户名
[Unit]
Description=Loreweaver Iroh server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOU
WorkingDirectory=/home/YOU/loreweaver                 # .env 从这里读
ExecStart=/home/YOU/.local/bin/uv run python -m app --serve --keys /home/YOU/loreweaver-data/keys.toml
Restart=on-failure
RestartSec=10
TimeoutStartSec=120                                   # Iroh 的中继握手要花一会儿

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now loreweaver
journalctl -u loreweaver -f       # 跟日志——ticket 和守秘人密钥在启动时打印
```

## 更新

守秘人在客户端的「房间与邀请」页里就能更新服务器，不用 SSH。上面那种 git 部署**默认就是开着的**：只有守秘人能看到服务端和客户端的版本，客户端比服务端新的时候会多出一个「更新服务器」按钮。按下去，服务器跑的是 `TRPG_TUI__UPDATE_COMMAND`（默认 `git pull --ff-only && uv sync`），然后把自己**换成新代码继续跑**——进程号不变，所以 Iroh ticket 不变，也不用 `systemctl restart`（和上面那个 `Restart=on-failure` 的配置是兼容的）。客户端会断一下再自己接上。

`loreweaver update` 默认会先重装客户端，再用你保存的守秘人连接做同样的服务端更新，一条命令让两边同步；`loreweaver update --client-only` 只更新客户端。

不是 git 部署的话可以换成自己的命令，也可以彻底关掉这个功能：

```bash
# 写在 ~/loreweaver/.env 里
TRPG_TUI__UPDATE_COMMAND=git pull --ff-only && uv sync   # 默认（git 部署）
# TRPG_TUI__UPDATE_COMMAND=docker compose pull && docker compose up -d   # 换成你自己的
# TRPG_TUI__UPDATE_COMMAND=                              # 留空 -> 按钮消失，功能关闭
```

想手动更新，随时可以：

```bash
cd ~/loreweaver && git pull && uv sync && sudo systemctl restart loreweaver
```

安全性在于：那条命令是你自己在服务端配的，客户端只能请求服务器跑**它自己配好的**那条，永远递不进去一条命令。默认那条也只从这个 git 目录自己的远端拉。信任边界就是守秘人密钥，和 `.model`、密钥管理是同一条。要是你根本不想让它跑，把 `TRPG_TUI__UPDATE_COMMAND` 留空。

## 配置

所有设置都用 `TRPG_` 前缀的环境变量，`__` 表示嵌套（见 `.env.example` 和 `infra/config.py`）。默认从工作目录的 `.env` 读；设了 `TRPG_ENV_FILE` 就从那个文件读。终端客户端一键本地开服会自动把 `TRPG_ENV_FILE` 指到 `<本地服务器目录>/.env`。

| 变量 | 作用 | 默认值 |
|---|---|---|
| `TRPG_LLM__PROVIDER` | `openai`（外加预设：`deepseek`、`groq`、`openrouter`、`together`、`ollama`、`lmstudio` 等）、双模式的 `chatgpt` / `gpt-subscription`、订阅制的 `supergrok`，或者原生的 `anthropic` / `gemini` | `openai` |
| `TRPG_LLM__API_KEY` | 服务商或代理的 API key。订阅制的 OAuth 通道不用它；对普通的 API key 服务商来说，**留空就是离线示例守秘人** | *（空）* |
| `TRPG_LLM__BASE_URL` | OpenAI 兼容接口的地址。对 `chatgpt` / `gpt-subscription` 来说，显式填了就走代理，留空就走订阅 OAuth | 按服务商预设 |
| `TRPG_LLM__CHAT_MODEL` | 对话模型 id | `gpt-4o` |
| `TRPG_LLM__EMBEDDING_MODEL` / `TRPG_LLM__EMBEDDING_DIM` | 检索用的 embedding | `text-embedding-3-small` / `1536` |
| `TRPG_LOCALE` | 界面语言 `en` / `zh` | `en` |
| `TRPG_ENV_FILE` | 启动前要读的 `.env` 文件 | 工作目录下的 `.env` |
| `TRPG_DATA_DIR` | 战役和运行时数据目录（数据库在 `<data_dir>/loreweaver.db`） | `./data` |
| `TRPG_TUI_KEYS` | 密钥文件路径（也可以用 `--keys` 覆盖；和 `TRPG_DATA_DIR` 无关） | `./keys.toml` |
| `TRPG_LOCAL_SERVER_HOME` | 一键本地开服的根目录：服务器程序和源码缓存、`.env`、数据、密钥、ticket 都在这儿 | `TRPG_HOME`，没有就是 `<用户目录>/.loreweaver` |
| `TRPG_RELEASE_TAG` | 把安装脚本、客户端和一键开服下载都钉到某个 GitHub Release，例如 `release-0.5.1.dev29+g0cf542b` | 最新的 release |
| `TRPG_SERVER_RELEASE_TAG` | 只钉一键开服要下的服务器程序或源码；正式发布的安装脚本会自动写好 | 跟 `TRPG_RELEASE_TAG`，没有就是最新 |
| `TRPG_ENABLE_VECTOR_DB` | 世界书和文档检索 | `true` |
| `TRPG_TUI__JOIN_TIMEOUT` | 一个还没认证的连接必须在几秒内发出 `join`，否则关掉 | `10` |
| `TRPG_CENSOR__WORDLIST_PATH` | 敏感词表文件：JSON 格式 `{"词": 等级, ...}`（等级 `1`–`5`，见 `gateway.ops.CensorLevel`）。说明在[内容过滤](#内容过滤) | *（空 = 过滤关闭）* |
| `TRPG_CENSOR__WORDLIST` | 敏感词表，直接写在环境变量里：`词[:等级],词2[:等级2],...`。两个都设了就合并 | *（空 = 过滤关闭）* |

ChatGPT 订阅不是 API key。要走订阅通道，先把服务器起起来，在私聊里对守秘人发 `.model login chatgpt`，走完设备码流程，再 `.model set chatgpt [模型]`。这条路要把 `TRPG_LLM__BASE_URL` 留空；Loreweaver 用的是保存下来的 OAuth 授权，不是浏览器 cookie，也不是模拟网页操作。SuperGrok 同理：`.model login supergrok` 之后 `.model set supergrok [模型]`，同一份授权还能用来出图。

已有的兼容网关照样支持：provider 填 `chatgpt` 或 `gpt-subscription`，显式设 `TRPG_LLM__BASE_URL=<网关的 /v1 地址>`，再给上网关的 API key。只要显式写了 `base_url`，走的就一定是这条经典代理通道，而不是订阅 OAuth。

正式发布的每个客户端和服务端压缩包旁边都带一份 `.sha256`。安装脚本会先校验客户端的摘要再解压，一键开服也会校验它选中的那个服务端包。老版本的二进制没有这个附带文件、或者摘要读不到、格式不对时，一键开服会退回到源码方式。摘要拿到了但和包对不上，就直接终止——不解压，也不换个包接着装。没打 tag 的 `main` 构建和纯数字的 `v*` tag 都会成为 GitHub 上的 Latest；明确标了预发布的 tag 仍然是预发布。HTTP 镜像除了给一键安装留一份根目录的兼容副本，还会把每次发布固定存一份在 `releases/<tag>/`，所以一个正式版或者被钉住的安装脚本，它的备用包不会被后来的开发版顶掉。内嵌的摘要只在“选的 tag 就是安装脚本内嵌的那个 tag”时才用；换了别的版本就去读那个包自己的摘要文件。安装脚本默认用 `https://registry.npmjs.org`，只有你确实想换源时才去设 `TRPG_REGISTRY`。

## 加密

Iroh 的玩家连接**天生就是端到端加密的**（QUIC/TLS，每个对端用自己的公钥认证），也没有证书要管。它保护的是终端客户端到 Loreweaver 服务端这一段，和“服务端会往模型服务商那边发什么”是两回事。

## 数据流向和信任边界

- 确定性规则引擎、SQLite 里的战役状态、媒体文件、房间密钥和备份，都留在你自己运营的这台服务器上。需要 Iroh 中继的时候，中继只转发加密流量，不会解开你的会话。
- **远程**大模型接口是另一家数据处理方。它会收到用于分析的模组正文、守秘人的系统提示（目前包含近乎完整的守秘人材料）、相关的历史对话，以及这一轮玩家的输入。默认配置用的是本地哈希 embedding；只有你自己刻意换成了远程的 embedding 后端，文档分块才会一起发过去。这些东西必须留在你自己掌控的机器上的话，就选 Ollama、LM Studio 这类本地接口。
- 玩家知识池和每个 NPC、同伴，在结构上就是各管各的：一个子角色只由它自己的档案和卡表拼出来。主守秘人是故意不一样的——它得看得见秘密，才主持得了谜案。提示里的约束和每晚的真模型红线评测能降低并测量泄漏风险，但证明不了任何模型都不会说漏嘴。
- 玩家密钥只对一个房间有效。守秘人密钥能读守秘人那一侧的状态，也只能管自己房间的密钥；但模型和服务商的配置是整台部署共用的。所以守秘人密钥只发给你完全信得过的共管人。有人填了一个新的自定义服务商地址时，系统不会把之前存的 API key 顺手带到新地址去，除非他自己为新地址填了 key。
- 服务商的 API key 和订阅 OAuth 授权，**以明文存在本地 SQLite 里**，这样运行时改的配置能扛住重启。它们只作为鉴权信息发给你选的那个服务商，不会发给玩家。宿主账号和它的备份都算在可信范围里。

## 内容过滤

`gateway.ops.Censor` 是一个真的、不容易被绕过的词表匹配器（NFKC 归一化加大小写折叠、能识破加空格/加标点/用全角写的变体、按整词边界匹配、掩码时保持原有位置）——但**它默认不带词表，也默认是关的。** Loreweaver 故意不随包带脏话和辱骂词表：维护一份词表、还要做好多语言覆盖，这是每个部署者自己的政策选择，不该写死在引擎里。没配词表的时候，`Censor` 每次调用都明确走一条什么都不做的路径——它不会在你不知道的情况下悄悄过滤任何东西。

要打开它，`TRPG_CENSOR__WORDLIST_PATH`（JSON 文件）和 `TRPG_CENSOR__WORDLIST`（直接写在环境变量里）选**一个**——见上面的[配置](#配置)表。文件长这样：

```json
{ "some-slur": 5, "some-mild-word": 2 }
```

等级从 `1`（`NOTICE`）到 `5`（`FORBIDDEN`）。命中 `DANGER`（`4`）及以上会拦下整条消息（回复被替换掉），低于这个等级就地打码。匹配和语言无关——需要过滤什么词、什么文字，写进去就是。

**它现在管到哪，指望它之前先看清：**

- 它只检查 **AI 守秘人自己说的话**（`agent.loop.run_kp_turn` 里的 `output_review`，在 `gateway.runner.GatewayRunner` 和 `net.tui_server.TuiServer` 里接上）。**玩家输入不检查。** 玩家想打什么打什么，被检查的只有守秘人回的内容。
- 它是词表匹配，不是语义分类器——它抓的是你列出来的词（以及这些词的简单变形），你没告诉它的东西它一概不管。

所以别把它当成开箱即用的审核方案——它是一块可配置的积木，你不给词表，它就什么都不做。

## 密钥和数据

- **密钥**把一串随机串绑定到一个房间（共享的 `chat_key`）和一个角色上。用 `--tui-key add` 生成；不认识的密钥在进房间时就被拒。密钥存在一个 TOML 文件里（`keys.toml`）——永远别提交它。
- **数据**是一个 SQLite 文件（`loreweaver.db`），按房间分隔，装着全部战役状态。想保住进度，就保住 `/data` 这个目录。
- **运行时填的服务商凭据**（包括订阅 OAuth 的 access / refresh 授权）以明文存在同一个 SQLite 文件里，这样重启之后还能接着用。请像保护 `.env` 和 `keys.toml` 一样保护这个数据库。
- **房间备份**是守秘人在管理界面里生成的服务端 JSON 快照，固定写在 `<data_dir>/room_backups/` 下面；就算填了路径，也只当成这个目录里的一个文件名。备份里有原始的访问密钥、房间状态、向量数据和内嵌的媒体，所以要按 `keys.toml` 的标准来保护。
- **本地权限**：在支持 POSIX 权限的文件系统上，新建的敏感文件会收紧到 `0600`，专用的数据和备份目录收紧到 `0700`。Windows 或者不支持 POSIX 权限的文件系统上只能尽力而为，它不是一个 ACL 管理器。
- **秘密文件**（`.env`、`keys.toml`、`keeper-key.txt`、`*.db`、备份）都在 git 忽略列表里，只有 `*.example.*` 会被跟踪。永远别提交它们。

## 让客户端连进来

客户端走 [`docs/protocol.zh.md`](protocol.zh.md) 里那份带版本的协议，经 Iroh 连接。把终端客户端指向服务器启动时打印的 **ticket**，再配一个生成好的密钥：

```bash
cd clients/tui && bun install
bun run dev -- connect --host <ticket> --key <key> --name <name>
# 或者直接跑装好的 `loreweaver`，在连接屏粘 ticket 和密钥
```

连接是端到端加密的；服务器靠密钥把门，所以密钥要当机密对待。
