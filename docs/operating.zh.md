*[English](operating.md) · 中文*

# 开服带团

*给开服那个人看的：模型怎么选、账单怎么控、战役怎么别弄丢。*

这份讲的是**怎么运行一场游戏**。如果你要架一台常驻服务器——systemd、密钥落盘、信任边界——那是 [deploy.zh.md](deploy.zh.md)，两份配着看。

---

## 1. 模型

Loreweaver 可以同时挂三个模型客户端，它们干的活很不一样。把大小配对，是同时影响质量和花销最大的一个杠杆。

| 演员 | 什么时候跑 | 默认 | 想要什么模型 |
|---|---|---|---|
| **守秘人**（KP） | 每回合 | `TRPG_LLM__*` | 你愿意付钱的最强那个 |
| **书记官** | 每回合，在回复之后 | 复用守秘人的客户端 | 小、便宜、快 |
| **演出导演** | 只在剧情节拍上 | 复用守秘人的客户端 | 和守秘人同一个——节拍很稀疏，而这活儿吃的是品味 |

### 守秘人

```dotenv
TRPG_LLM__PROVIDER=deepseek
TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro
TRPG_LLM__REASONING_EFFORT=max
```

**这里别省。** 守秘人做每一件事都是通过工具调用——掷骰、读卡、写追踪器、推时钟。指令遵循强的模型会真掷骰、也会守着模组走；便宜模型倾向于不调检定工具就说“你成功了”，然后慢慢跑偏。就我们自己测下来，这是好一场和坏一场之间最稳定的那个差别。

关于 `REASONING_EFFORT` 有个坑：思考型模型上别再配 temperature。思考模式会忽略它，而一个低值反而会把推理链拉坏——干脆不写，让服务商用自己的默认值。

大多数厂商走 OpenAI 兼容路径加一个预设：

```console
$ .model list
Providers — OpenAI-compatible: deepseek, fireworks, groq, lmstudio, mistral, moonshot, ollama,
openai, openrouter, together, vllm, xai, zhipu; native: anthropic, gemini; subscription: chatgpt,
gpt-subscription, supergrok. Any OpenAI-compatible endpoint works by pointing base_url at it.
Subscription providers need `.model login` first.
```

换模型是热的——不用重启，跑到一半换也行：

```
.model                          看当前 provider / 模型（只回给你自己）
.model set <provider> [model]   切换
.model key <api_key>            给当前 provider 设 key
.model login chatgpt            ChatGPT 订阅的设备码 OAuth
.model login supergrok          SuperGrok 同理
.model reset                    丢掉运行时覆盖，回到 .env
```

key 是**按 provider 记住**的，所以换回一个用过的不会再问你要。但新的 `base_url` 永远不会配旧 key：要么你在同一条请求里把对应的 key 给上，要么这个端点拿到的是空 key。守秘人客户端在模型页也能做同样的事。

### 书记官——小模型，正经活

书记官默认开着，在守秘人每回合之后多跑一次调用。它拿这回合实际叙述出来的内容去对模组的追踪器（要求引用原文，引不出来就不许写）、把判断以悄悄话的形式塞进守秘人的**下一**回合（“看起来过了一天，该推时钟了”、“刚才那段恐怖暴露可能该掷一次理智”），顺便给演出导演分类这回合的剧情节拍。

`TRPG_SCRIBE__*` 留空就是复用主客户端——这没错，但意味着每一回合都在用旗舰价钱做文书工作。`--doctor` 会提醒你：

```console
$ uv run python -m app --doctor
Loreweaver doctor
Version: 1.0.1.dev17+g74c9efa
Mode: source
Locales: en (29 files), zh (29 files)
Rulepacks: coc7 (resolution: dsl +6 variants; subsystems: sanity_check, skill_growth, spend_luck,
opposed_check, random_madness), dnd5e (resolution: dsl; subsystems: opposed_check), wod (resolution: dsl)
KP skills: image-gen, mature-mode, module-forge, romance-relationships, rule-forge, skill-forge, svg-mapmaker (7)
Data dir: ./data
NOTE: the Scribe is paying flagship prices for ledger work (xai / grok-4.5). It runs one extra call
after every AI-KP turn. Point TRPG_SCRIBE__* at a small, cheap model — see .env.example.
OK: all checks passed
```

给它单配一个小模型：

```dotenv
TRPG_SCRIBE__PROVIDER=deepseek
TRPG_SCRIBE__CHAT_MODEL=deepseek-v4-flash
TRPG_SCRIBE__API_KEY=sk-…
TRPG_SCRIBE__REASONING_EFFORT=low
```

`TRPG_SCRIBE__ENABLED=0` 可以关掉。关之前先知道它为什么存在：一次实测里，一个叙事很强的模型跑完了整个模组，一次都没碰过状态层——追踪器停在默认值，而故事已经往前走了三天。开着书记官重跑同一个模组，追踪器就跟着剧情动了。记账这件事，靠模型自觉是撑不住的。

> `--doctor` 报的是**随包发的**那些目录——本地化、内置规则包、内置技能——外加解析出来的数据目录。装到数据目录里的内容包不会出现在这份清单里；那些用房间里的 `.panels` 和 `.skill` 看。

### 演出导演——可选，而且三重门

演出导演负责在剧情节拍上做舞台：幕卡、信笺、剪报、地图钉、音频提示、生成图。它默认用**主模型**，和书记官的建议正好相反——节拍很稀疏，而这活儿吃的是品味。

**有资料包它才会醒**：只有当房间启用的模组带了 `ui/presentation.yaml`，导演才上工。没有这种模组的桌子从不唤醒它，也就不会为它付钱。出图还要额外满足三个条件，缺一不可：

1. `TRPG_DIRECTOR__IMAGES=1`；
2. 配好了 `TRPG_IMAGEGEN__*` 端点；
3. 模组自己的资料包允许——如果作者写了 `generation: pack_only`，那是作者的否决权，你这边任何设置都覆盖不了。

```dotenv
# TRPG_DIRECTOR__ENABLED=1
# TRPG_DIRECTOR__CHAT_MODEL=          # 留空 = 主守秘人客户端
# TRPG_DIRECTOR__IMAGES=1
# TRPG_DIRECTOR__MAX_IMAGES=24        # 按房间算的终身上限，不是每场
# TRPG_DIRECTOR__PREGEN_PER_BEAT=2
```

`MAX_IMAGES` 是每个房间的终身上限（房间是长期战役，不是单场）。超了之后导演继续用包内美术和已经生成过的素材做舞台，只是不再花钱。

### 本地模型

提示不能出你这台机器的话，把 `TRPG_LLM__PROVIDER` 指向 `ollama` 或 `lmstudio`。只有这一种配置能让模组正文、守秘人设定和玩家输入都留在你自己掌控的基础设施上——自托管**服务器**本身并不会让模型流量也变成本地的。

---

## 2. 配额、延迟和 token 账单

### 看顶栏那两个数

每个客户端的顶栏上有两个数，基本就够你判断了：

```
● 在线 · 上下文 34% · 缓存 71%
```

- **`上下文`**——最近这一回合守秘人的上下文窗口用了多满。一场下来它会往上爬，但你应该能看到它自己掉回去（下面那节）。如果它只涨不落，说明折叠出了问题。
- **`缓存`**——这次提示里从服务商提示缓存取到的比例。越高越便宜也越快。一场健康的长团这个数会一直挺高；如果它反复塌下去，说明提示的前缀每回合都在被打断。

### 提示为什么要那样排

系统提示被刻意分成**稳定头**和**易变尾**。身份、系统专长、交互风格、模组知识池、已启用的技能排在前面，它们很少变；检索出来的世界设定、前情提要、活的追踪器这些会动的排在后面。在支持显式提示缓存的服务商那边，这两段之间就是缓存断点。

对你来说的实际影响是：**任何改动稳定头的操作都会把整个缓存作废**。换模型、开关一个技能、中途导入模组，都会——而且都合理。只是要有心理准备：下一回合是一次完整的 cache miss，别没事就来一下。

### 被限流的时候

所有 provider 路径遇到 429 或 overloaded 都会带抖动地退避重试。被限流的回合会**变慢，但不会死**。留意服务端日志里的 `LLM throttled`。如果这行经常出现，说明这桌的节奏超过了你套餐的速率上限。第一个该做的不是升级套餐，而是给书记官（以及导演，如果你开了）单独配小模型和自己的 key，别都挤在守秘人那把钥匙上。

### 战役记忆会自己折叠

长团活得比任何上下文窗口都久。跑团过程被记成编年史文档；当拼好的提示超过模型上下文窗口的 **60%**，最老的记录成批折叠进滚动摘要，直到投影降回 **40%** 以下。**85%** 是应急天花板，会在下一次调用之前先折——这个天花板存在的理由，是让折叠本身那次调用永远有余量。最近 **4** 回合从不折叠：正在进行的这场戏还不算可以概括的历史。

用的是比例，不是绝对 token 数，这样任何窗口大小表现都一致：

```dotenv
# TRPG_CHRONICLE__FOLD_TRIGGER=0.60
# TRPG_CHRONICLE__FOLD_FLOOR=0.40
# TRPG_CHRONICLE__FOLD_EMERGENCY=0.85
# TRPG_CHRONICLE__LAG_TURNS=4
# TRPG_CHRONICLE__SUMMARY_MAX_CHARS=4000
```

这套默认值刻意压得比编程 agent 的压缩阈值更早一些：叙事比代码耐概括得多，而游戏每一回合都要把上下文重发一遍——花销、延迟、上下文腐烂，都是跟着“你把它塞得多满”一起涨的。

你也可以手动来：

```
.chronicle             列出记录                    -> No chronicle records yet.
.chronicle summary     滚动的"故事到此为止"        -> No campaign summary exists yet — it is created by the first fold.
.chronicle threads     未收的线：伏笔、已上膛的后果
.chronicle fold        现在就折，不管满到哪
.chronicle edit <文本> 直接替换摘要——它就是一份普通的可编辑文档
.chronicle note <文本> 加一条守秘人侧的批注
.recap                 玩家看到的那一版：同一段故事，剧透批注被拿掉
```

`.chronicle` 的回复只发给调用者，因为它可能带着守秘人批注；`.recap` 是同一批文档投影出来的、给玩家看的那一面。

**小窗口模型**：能缩的只有可折叠那部分。如果你的固定段落——模组加系统提示——本身就超过了地板线，那折叠只能尽力，房间会一直是满的。这是模型／模组的尺寸问题，不是折叠的 bug；解法是换更大的窗口，或者换更小的模组。

### token 大致花在哪

粗略地按回合算：一次守秘人调用（大，但前缀多半命中缓存）、一次书记官调用（小模型，小提示），以及只在节拍上的一次导演调用。折叠是偶发的，用主客户端。账单如果超出预期，按这个顺序查：（1）书记官是不是还挂在主模型上？（2）`缓存` 是不是很低？（3）`上下文` 是不是一直很高，因为折叠阈值被调高了？

---

## 3. 别把战役弄丢

### 东西都在哪

| 东西 | 位置 | 当成什么对待 |
|---|---|---|
| 战役状态（全部） | `<data_dir>/loreweaver.db` | 就是战役本身 |
| 媒体文件 | `<data_dir>/media/<room>/` | 就是战役本身 |
| 已安装的内容包 | `<data_dir>/packs/<id>@<version>/` | 可以重装 |
| 访问密钥 | `keys.toml`（或 `--keys` / `TRPG_TUI_KEYS`） | 密码文件 |
| Provider 凭据 | 在 SQLite 里，**明文** | 密码文件 |
| 房间备份 | `<data_dir>/room_backups/` | 密码文件——里面有原始密钥 |

`TRPG_DATA_DIR` 能挪走前三样。keystore 的路径是独立的。

### 备份

守秘人客户端的“房间与邀请”页里有**导出房间备份**和**导入房间备份**。备份是服务端生成的 JSON 快照，限制在 `<data_dir>/room_backups/` 里；路径留空会自动命名。它包含房间状态、向量数据、内嵌的媒体二进制，**以及这个房间的原始访问密钥**。请完全按 `keys.toml` 的标准保护它，别丢进公开仓库或者聊天窗口。

导入时可以把快照重映射到另一个房间名，这就是克隆一份战役来做测试的办法。

还有个笨办法，一直好用：停服，把整个数据目录拷走，再起服。

### 重置——不用重新拉人的重开

重置是**原地**重开战役，保留 keystore、绑定、在线连接和房间设置（语言、房规、已启用技能），所以不用重新邀请任何人。三个范围：

```console
$ .reset
This will permanently clear the story and progress only (keeping your characters, the module, lore
and media). Room settings (language, house rules) and connections survive. Send `.reset confirm`
within 120s to proceed.

$ .reset all
This will permanently clear EVERYTHING — characters, the module, lore, media and story. Room settings
(language, house rules) and connections survive. Send `.reset confirm` within 120s to proceed.
```

- `.reset`——只清故事和进度。角色、模组、设定、媒体都留着。
- `.reset chars`——顺便重掷角色，模组留着。
- `.reset all`——全部抹掉。

每一种都要在 120 秒内补一句 `.reset confirm`。**不会自动备份**——你要是可能还想要，先自己导一份。客户端会收到一个标了 `reset` 的状态帧，顺便把本地聊天记录也清掉，所以每块屏幕上看起来都是干净的重开。

如果你想要的是把房间**删掉**而不是重开，守秘人页上的“删除整个房间”默认会先备份，再清掉密钥、房间状态和向量。

### 自更新

守秘人在“房间与邀请”页里就能更新服务器，不用 SSH。那页会显示服务端和客户端的版本，客户端更新时给出**更新服务器**按钮。按下去，服务器跑的是它**自己**配置的命令（`TRPG_TUI__UPDATE_COMMAND`，默认 `git pull --ff-only && uv sync`），然后把进程 re-exec 进新代码——**PID 不变，所以 Iroh ticket 不变**，谁都不用换邀请码。客户端闪一下就重连上了。

```dotenv
TRPG_TUI__UPDATE_COMMAND=git pull --ff-only && uv sync    # 默认（git 检出）
# TRPG_TUI__UPDATE_COMMAND=                               # 留空 -> 按钮消失，功能关闭
```

让这件事可以接受的安全性质是：客户端只能请求服务器跑**它自己**配好的那条命令，永远不能把命令传过去。信任边界是守秘人密钥，和 `.model` 一样。

在你自己机器上，`loreweaver update` 会先重装客户端，再通过你保存的守秘人连接做同样的服务端更新，一条命令让两边同步；`loreweaver update --client-only` 跳过服务端那一半。

**钉版本。** 安装脚本跟的是最新发布的 Release，而开发版就是作为普通 Release 发布的——所以 "latest" 的意思是最新，不是最新稳定。想把一桌人按在某个已知构建上，就在运行安装脚本的环境里设 `TRPG_RELEASE_TAG=<tag>`，或者去取那个 Release 自带的安装脚本（它会把自己钉住）。`TRPG_SERVER_RELEASE_TAG` 只钉一键开服的服务器。

---

## 4. 一份简短的开团清单

开场前：

- `uv run python -m app --doctor`——目录都能加载，数据目录是你以为的那个，没有书记官花销警告。
- `.model`——provider 对，key 还能用。
- `.panels` / `.skill`——模组的面板和它的守秘人技能是**已启用**，不只是装上了。
- 上一场要是重要，先备份。

进行中：

- 偶尔瞄一眼 `上下文` 和 `缓存`。`上下文` 应该是锯齿状的，不该一路只涨。
- 回复变慢先去日志里找 `LLM throttled`，再怪模型。
- 守秘人专属的回复（`.model`、`.lore`、`.chronicle`、`.var`）按设计只发给你自己。哪天你看见这类回复落进了房间日志，那是个值得报的 bug。

结束后：

- `.report` 导出战报。
- `.chronicle` / `.recap` 对一遍，看账本和实际发生的事对不对得上。如果某个追踪器要么停在过去、要么跑到了剧情**前面**，那正是我们做实测想抓的那类问题，值得开个 issue。

---

## 相关

| 主题 | 文档 |
|---|---|
| 常驻部署、systemd、密钥、信任边界 | [deploy.zh.md](deploy.zh.md) |
| 每一项设置和它的默认值 | [`.env.example`](../.env.example) · [deploy.zh.md](deploy.zh.md) |
| 玩家看到什么、打什么 | [play.zh.md](play.zh.md) |
| 给你这桌做一个模组 | [authoring.zh.md](authoring.zh.md) |
| 内容过滤（默认关，以及为什么） | [deploy.zh.md](deploy.zh.md) |
