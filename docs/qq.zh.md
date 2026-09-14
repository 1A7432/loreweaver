*[English](qq.md) · 中文*

# 在 QQ 群里玩

终端客户端可以作为一个普通的**协议客户端**坐进 QQ 群：
`loreweaver bridge --config <file>`。它拨的是和其他客户端一样的 Iroh ticket，
以房间成员的身份加入，再把这一桌渲成文字。它**不是**引擎适配器：`adapters/`
仍然只有本地 CLI，五个聊天平台适配器保持退役。

机器人**就是**守秘人（AI）。名单上的管理员拿的是守秘人角色的密钥：他们负责配桌，
同时自己也是这一桌的玩家。

## 要跑的东西

宿主机器上就两件事：

1. 一个 OneBot 11 实现——按 [NapCat](https://github.com/NapNeko/NapCatQQ) 或
   [Lagrange](https://github.com/LagrangeDev/Lagrange.Core) 来写的，LLOneBot
   走同一套线。
2. 终端客户端的桥接模式：

```bash
loreweaver bridge --config bridge.json
```

`bridge.json` 里没有 `ticket` 时，桥会走终端里同一个「本地开服并开玩」，拿它返回的
ticket 和守秘人密钥。Studio / 终端的玩家仍然可以用普通邀请码进同一个房间——桥只是
多一组成员，不是另一间房。

## 配置

一个桥接进程一份 JSON。超时是**秒**（旧 OneBot 适配器的单位）；客户端内部会换成毫秒。

```json
{
  "ticket": "endpoint…",
  "keeper_key": "…",
  "locale": "zh",
  "onebot": {
    "mode": "forward",
    "ws_url": "ws://127.0.0.1:3001",
    "access_token": "换成一段够长的随机 token",
    "request_timeout": 10,
    "reconnect_delay": 1
  },
  "groups": [
    {
      "group_id": 123456789,
      "room_keeper_key": "…",
      "admins": [11111111],
      "mode": "mention"
    }
  ],
  "busy_notice": true,
  "idle_close_minutes": 30,
  "state_dir": "~/.loreweaver/bridge"
}
```

省略 `ticket`（和 `keeper_key`）就是本地开服。一个群对应一个房间；守秘人密钥是绑房间的，
所以每个群要写自己房间的密钥。两个群不能共用一把 `room_keeper_key`（也不能共用顶层的
`keeper_key`）。只有一个群时，顶层的 `keeper_key` 就是默认值。`locale` 可省略：不写就跟
房间 `welcome.locale` 走。`idle_close_minutes: 0` 会关掉玩家连接的空闲关闭（观察席和控制
连接本来就不会因空闲关掉）。

状态文件（`<group>.keyring.json`、`<group>.posted.json`、`<group>.settings.json`）
写在 `state_dir` 下，权限 0600。

## 正向和反向

OneBot 用一条通用 WebSocket 同时收事件和发动作。两种模式只选一种。

**正向**（同一台机器上跑 NapCat 时最常见）：桥向外连到实现，掉线会重连。
`onebot.mode` 设为 `forward`，`ws_url` 必须是 `ws://` 或 `wss://`。配了
`access_token` 就会带 `Authorization: Bearer <token>`。

**反向**：由实现连进来。设 `listen_host` / `listen_port` / `path`（默认
`/onebot/v11/ws`）。对端如果带 `X-Client-Role`，必须是 `Universal`。监听口请放在
回环上，除非外围网络已经收紧；非回环的反向监听**必须**带 `access_token`。

NapCat / Lagrange：打开 OneBot 11 的 websocket，填同一段 token，正向把 URL 指到
实现，反向把 host/port 指到这个进程。

## 管理员

管理员是群配置里 `admins` 列出的 QQ 号。运行时也可以用 `.bridge admin add|remove <qq>`
增删（仅管理员，由桥自己处理，不会转给引擎）。

所有需要守秘人权限的引擎命令，在守秘人角色的链路上本来就能用：导入、`.skill`、
`.panels`、`.pack install`、`.model`、`.save`、`.reset`、`.module`、`.rule`、
`.preset`、`.phase`、`.var expose`、`.dev mount`、`.language`、`.chronicle`、
`.lore`、`.imagegen`、`.forge`。**管理员的回复永远走私聊**，就算命令是在群里打的
也一样——包括「完成了」这类回执。这是故意往安全一侧收的。管理员必须先把机器人
**加为好友**：私聊发不出去时，群里只会提示去加好友，内容绝不会改发到群里。

会读到秘密的命令（`.lore`、`.var`，以及任何会带出守秘人材料的）请用**私聊**发给机器人。
文档里也是这句：答案走私聊，提问也请走私聊。

玩家专属的 `system` / `error`（`.st show`、「你的输入已排队」）按**那条命令打进去的频道**
回：私聊问的仍走私聊，即使同一个人随后在群里说了话。`.imagegen` 和 `.forge` 是这一版
的引擎命令，桥不用为它们多做什么。

桥自己的命令（仅管理员）：`.bridge status`、`.bridge members`、`.bridge kick <qq>`、
`.bridge admin add|remove <qq>`、`.bridge mode all|mention`、`.bridge notice on|off`。

群默认是 `mention` 模式：能认出的命令（`.`、`/`、`r `、中文方言）一定转发；故事散文
只有 @ 了机器人才转发，除非这桌设了 `.bridge mode all`。

## 唯一的缺口

**二层 HTML 面板在聊天群里画不出来。** 这是结构上的那一个缺口。`.panel <id>`
打出来的是文字版，群里拿到的也是这个。进度条、徽章、选项、信件、剪报以及其余 `ui`
块都会退化成一行行字。音频只报标题。

## 一回合要好几分钟

玩家的一回合不是聊天回复。守秘人可能掷骰、读卡、写追踪器、用 NPC 说话，还要等同伴的
子回合。最坏大约是**五分钟**，不是五秒。`busy_notice` 默认开着，回合开始时群里会有
一句「守秘人正在思考」。那就是心跳。群里安静，不要当成机器人卡死。

## 信号

`SIGINT` / `SIGTERM` 会关掉每条 Iroh 连接（包括只用来签发和删除密钥的控制连接）、
关掉 OneBot 的套接字或反向监听，并刷盘状态文件。
