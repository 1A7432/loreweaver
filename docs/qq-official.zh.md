*[English](qq-official.md) · 中文*

# 在 QQ 群里玩 — 官方机器人 API

终端客户端可以作为一个普通的**协议客户端**坐进 QQ 群：
`loreweaver bridge --config <file>`，并设 `platform: "qqbot"`。它拨的是和其他客户端
一样的 Iroh ticket，以房间成员的身份加入，再把这一桌渲成文字。它**不是**引擎适配器：
`adapters/` 仍然只有本地 CLI，五个聊天平台适配器保持退役。

这是 QQ 的**主路径**。你只跑桥，不需要 NapCat、不需要 LLOneBot、也不需要一个私人
QQ 号。次路径（私人号挂 NapCat / LLOneBot 的 OneBot 11）见 [qq.zh.md](qq.zh.md)。

机器人**就是**守秘人（AI）。完成管理员领取的人拿的是守秘人角色的密钥：他们负责配桌，
同时自己也是这一桌的玩家。

## 要跑的东西

宿主机器上就**一件**事：

```bash
loreweaver bridge --config bridge.json
```

`bridge.json` 里没有 `ticket` 时，桥会走终端里同一个「本地开服并开玩」，拿它返回的
ticket 和守秘人密钥。Studio / 终端的玩家仍然可以用普通邀请码进同一个房间——桥只是
多一组成员，不是另一间房。

## 开放平台控制台步骤（q.qq.com）

1. 在 [q.qq.com](https://q.qq.com) 创建机器人应用。
2. 申请 `GROUP_AND_C2C_EVENT` 意图（`1 << 25`）。没有它，网关会拒绝 Identify
   （Invalid Session），桥也站不住。
3. 把 `AppID`（`app_id`）和 `AppSecret`（`client_secret`）写进配置。密钥不会出现在
   任何错误信息或日志行里。
4. 如果希望骰子和命令不用 @（`.ra 侦查`、`r 3d6`），再打开「**接收所有消息**」。
   文档里的默认是关：机器人听到的每一句都已经带了 @。即便打开，旁白仍然要 @。
5. 消息里需要链接时，在控制台的「**消息URL配置**」里加主机名，并在
   `qqbot.url_whitelist` 里列同一批。配置本身不授权任何控制台没放过的东西；两边
   名单对不上的 URL 会被替换成 `[链接]`。

Webhook 传输没有做。桥只走官方 WebSocket 网关。

## 未认证档

未认证机器人是文档里的目标形态：**只能进管理员作为群主的群**（控制台措辞大约是
「仅管理员使用，可添加到管理员作为群主的群内」）。个人认证是给公开桌用的（500
群上限），私人桌不需要。谁可以把机器人拉进群、拉群要不要审，以控制台当时的规则为准。

## 配置

一个桥接进程一份 JSON。超时是**秒**。

```json
{
  "platform": "qqbot",
  "ticket": "endpoint…",
  "keeper_key": "…",
  "locale": "zh",
  "qqbot": {
    "app_id": "102xxxxxx",
    "client_secret": "…",
    "transport": "websocket",
    "receive_all": false,
    "max_chunk_chars": 2800,
    "url_whitelist": [],
    "media_public_base_url": null,
    "bot_qpm": 30,
    "send_timeout": 5
  },
  "groups": [
    { "group_openid": "…", "room_keeper_key": "…", "mode": "mention", "admins": [] }
  ],
  "busy_notice": true,
  "idle_close_minutes": 30,
  "state_dir": "~/.loreweaver/bridge"
}
```

省略 `platform` 时默认 `"onebot"`，所有现有的 OneBot 配置继续能用。`onebot` 和
`qqbot` 两块互斥。

省略 `ticket`（和 `keeper_key`）即本地开服。一群一房；两个群不能共用一把
`room_keeper_key`。`group_openid` 从下面的首次接入链里读出来——它不是 QQ 群号。
内部它就是 OneBot 路径用的那个 `group_id`，状态文件名和重复检查都不变。

`admins` 是可选的 `member_openid` 种子（从 `.bridge members` 或上一次运行抄），
给不想走领取流程的时候用。种子管理员可以在群里跑 `.bridge` 命令；守秘人级的私聊
回复仍然需要走领取绑定，桥才知道该发到哪个 C2C 身份。

状态文件（`<group>.keyring.json`、`<group>.posted.json`、`<group>.settings.json`、
`<group>.identity.json`、`<group>.anchors.json`、`<group>.deferred.json`）以
0600 写在 `state_dir` 下。

## 首次接入链（按这个顺序）

官方世界里没有任何东西是 QQ 号，所以配置没法像 OneBot 那样事先写好。

1. **把机器人拉进群。** 群还没写进配置时，桥会打 `qqbot.group.unknown <openid>`
   然后忽略。不会自动收养。
2. **从那行日志里读 `group_openid`。** 填进 `groups[].group_openid`。
3. **重启桥。**
4. **领取，先私聊。** 控制台会给每个群打一个一次性领取码（8 位，30 分钟）。
   **私聊**机器人发送 `.bridge claim <code>`。机器人在同一条私聊里回一个第二次性
   的**绑定码**（6 位，5 分钟），并交代马上到群里打出来。
5. **到群里绑定：** `@bot .bridge claim <link>`。这会把你的 `member_openid` 和
   C2C 身份绑在一起，并签发守秘人角色的密钥。这是唯一一个回复留在群里的
   `.bridge` 命令。

领取码如果误打在群里会被立刻作废，再也不能当私聊凭证。码可以随时重发：重启桥，
或等下一次启动打出新的。当私聊和群事件带上同一段非空的 `union_openid` 时，绑定
那一步会跳过。

未绑定的私聊发送者只接受 `.bridge claim <code>`；其余一律忽略——不开席、不回。

## 群主的「机器人主动在群聊内发言」开关

这个开关是**群主的**，在该群里机器人的资料页上。不是房间管理员的。

- **开（推荐的开桌方式）。** 守秘人按输出到达的节奏、每 5 秒一窗，以主动消息发出，
  受群的频率限制（每群 20 条/分钟、每群 1000 条/天、未认证机器人 30 条/分钟）。
  只要当前这条 @ 还有被动回复额度，会先用被动回复——不占主动配额——所以一句短骰
  子仍然是引用回复。
- **关。** 每一行都必须挂在某条入站 @ 的**被动回复**上：5 条、5 分钟。一轮完整
  回合大概就是这个长度，所以迟到补发（「上回合补发：」）是常态。群里每天会收到
  一次如何打开这个开关的提示。一条没有锚点的发送会返回 **40034105**。

## 先 `.bridge name`，再领角色

席位名称来自事件里的 `author.username`（有的话），否则是 `玩家<后 4 位十六进制>`。
`.bridge name <名字>` 给席位改名，**只在该席还没有领取角色时可用**。领过角色之后
会回答「请用 `.rename` 改角色名」。先给自己起名，再领卡。没有这一步，这条路径上
每个席位整场都会是 `玩家a1b2`。

桥级命令：`.bridge status`、`.bridge members`、`.bridge kick`、
`.bridge admin add|remove`、`.bridge mode`、`.bridge notice`、`.bridge claim`、
`.bridge name`、`.bridge deferred`。`claim` 和 `name` 是两个不走管理员门禁的动词；
`claim` 也是「管理员回复走私聊」的唯一例外。

会读秘密的命令（`.lore`、`.var`，以及任何会带出守秘人材料的东西）请在领取之后
**私聊**发给机器人。这些回答永远不会走到群锚点。

## 这条路径做不到的

**关**的时候守秘人不能先开口（没有空闲旁白、没有时钟节拍）。伙伴子回合和演出
定妆图挂在当前这条 @ 上，或者进补发队列。

**开、关都一样：**

- 没有可点的选项（按钮是邀请制；选项仍是编号文本）。
- 超过 2 分钟不能撤回。
- 第二档 HTML 面板和 OneBot 路径是同一个缺口：`.panel <id>` 打出文字形式。
- 正文里的 URL 除非主机同时在控制台白名单和 `url_whitelist` 里，否则会被拒。
- `member_openid` 是按（机器人，群）计的。如果平台重新签发，席位会重铸，已领取
  的角色会变成孤儿。

## 回合要几分钟

玩家回合不是聊天回复。最坏大约是**五分钟**，不是五秒——和被动回复窗口一样长。
`busy_notice` 打开时（默认），一条 @ 的第一条回复是「守秘人正在思考…」。那是心跳。
不要因为群里安静就以为机器人卡死了。回合中第二个玩家的输入不会被转成「已入队」
提示（那会烧掉一个名额）；它会带着前缀迟到。

## 日志会告诉你什么

- `QQ 官方机器人已就绪：…（…）` — 访问令牌被接受，这是 Ready 里的机器人身份。
- `群 <openid> 的领取码：<code>（30 分钟有效）。…` — 每个群启动时打一次。请私聊
  发出去。
- `qqbot.group.unknown <openid>` — 机器人被拉进一个配置里没有的群；已忽略。
- `QQ 官方机器人连接断了，正在重连。` / `QQ 官方机器人连接已离线。`
- `附件 … 没有转发（reason）` — 玩家的图没能抓到（体积、不安全地址、或房间的媒体
  策略）。文字照常走。URL 不会进日志。
- 机器码（`qqbot.claim.issued`、`qqbot.c2c.unbound`、`qqbot.active.off`、
  `qqbot.audit.pending`，……）保持英文；给人看的句子跟 `locale`。

`client_secret` / `clientSecret` 的值永远不会进日志。

## 现场冒烟清单

在你自己当群主的小群里、用未认证机器人跑。按期望的返回码打勾。

| 检查 | 期望 |
|---|---|
| `@bot .r 3d6` | 五分钟窗口内一条回复 |
| 一轮完整回合 | 渐进若干条加一张定妆图，全部 `2xx` 且没有 `audit_id` |
| 回合中第二个玩家的 `@` | 他们的回复带着前缀迟到（「上回合补发：」） |
| 同一条 C2C 锚点上的第五条回复 | 第 5 条返回 **40034128**（用来裁定是 4 条还是 5 条） |
| 没有公网 URL 的分片上传 | 得到 `file_info` |
| 归档一条原始事件 JSON | 用来裁定 `username`、字段形状、`d.id` |
| 第二天重启后同一个人的 `member_openid` | 用来裁定是否稳定（A1） |
| 一段恐怖调性的段落 | 通过，或走出审核路径（`audit_id` / 40034006） |
| 私聊领取 → 群里绑定 → `.lore` | 只在私聊里回答 |
| 若能打开 `receive_all` → 不 @ 的 `.ra` | 听得到 |
| 群主「机器人主动在群聊内发言」**关** → 一条无锚点发送 | **40034105**，群里收到那一行提示 |
| 开关**开** → `GROUP_MSG_RECEIVE` | 一轮完整回合在一分钟内以主动消息发出 |
| 开关开着时一分钟内的第 21 条 | 被令牌桶拦住，不是被平台拒 |

## 信号

`SIGINT` / `SIGTERM` 会关掉每一条 Iroh 连接（包括只用来签发和删除密钥的控制连接）、
关掉 QQ 官方网关、关掉投递器和身份库，并刷盘状态文件。
