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

1. 一个 OneBot 11 实现——按 [NapCat](https://github.com/NapNeko/NapCatQQ) 来写、
   也照着它的源码探针验过；[LLOneBot](https://github.com/LLOneBot/LLOneBot) 走同一套线。
   Lagrange 的主分支现在只带 Milky 协议，不再有 OneBot 11（OneBot 11 那一版只留在
   已停更的 `v1` 分支），别把桥指到现在的 Lagrange 上。
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
`onebot.mode` 设为 `forward`，`ws_url` 必须是 `ws://` 或 `wss://`。

`access_token` **两种模式都必填**，以 `Authorization: Bearer <token>` 发出。2026 年
那批空 token 的 NapCat 实例被批量利用，背后的 QQ 号被封；请用一段够长的随机 token，
并把同一段填进实现端的 `token` 字段。正向模式下桥启动时会调一次 `get_login_info`，把登录的
QQ 号打进日志；token 填错会让启动直接失败并报清楚原因，因为 NapCat 和 LLOneBot 是在
WebSocket 握手*之后*才拒绝 token 的，连接打开了不代表什么。之后每次重连也会再查一次。

**反向**：由实现连进来。设 `listen_host` / `listen_port` / `path`（默认
`/onebot/v11/ws`）。对端如果带 `X-Client-Role`，必须是 `Universal`。监听口请放在
回环上，除非外围网络已经收紧。桥只从 `Authorization: Bearer` 请求头读 token——NapCat
和 LLOneBot 就是从各自的 `token` 字段这样发的；把 token 拼进 URL 的 `?access_token=`
会被拒。被拒的握手会在响应体里给一个 `onebot.reverse.rejected.*` 代码并打一行日志：
`token_in_query`（把 token 挪进实现端的 token 字段）、`missing_authorization`、
`wrong_token`、`path`、`role`。实现端自己的日志永远只有一句「Expected 101 status code」。
反向模式下监听一起来启动就算成功，那时还没有任何实现连进来；`get_login_info` 那次检查改在
每次接受连接时跑，实现端 token 填错只会表现为上面那种被拒的握手。

NapCat / LLOneBot：打开 OneBot 11 的 websocket，填同一段 token，正向把 URL 指到
实现，反向把 host/port 指到这个进程。

## 管理员

管理员是群配置里 `admins` 列出的 QQ 号。运行时也可以用 `.bridge admin add|remove <qq>`
增删（仅管理员，由桥自己处理，不会转给引擎）。运行时的名单存在 `<group>.settings.json` 里，
从那以后以它为准、配置文件里的不再生效，所以桥不允许移除最后一个管理员：先加一个再删。
增删管理员改的是这个人现有密钥的角色（`admin_update_key`）——座位和他认领的角色卡都还是他的；
新角色从他下一条消息起生效。

所有需要守秘人权限的引擎命令，在守秘人角色的链路上本来就能用：导入、`.skill`、
`.panels`、`.pack install`、`.model`、`.save`、`.reset`、`.module`、`.rule`、
`.preset`、`.phase`、`.var expose`、`.dev mount`、`.language`、`.chronicle`、
`.lore`、`.imagegen`、`.forge`。

命令的回复落在哪里，由引擎决定，和任何客户端看到的一样。引擎**广播给整桌**的回复
（`.pack install` 的回执、`.st show`、`.pc claim`）会发在群里；如果命令是在私聊里打的，
私聊里也会收到一份。引擎**只回给你一个人**的回复（`.help`、`.lore`、`.var`、`.model`，
以及任何失败的命令）一律走你的私聊——玩家和管理员都一样，就算命令是在群里打的；这类回复
绝不会发进群。机器人不会把你打的命令复述回来。私聊回执会带上它来自哪个群，
所以管理员和机器人不是好友时 NapCat 走**群临时会话**送达（群设置需允许成员发起临时会话），
是好友时照常走好友私聊。带上群号之前，桥会先向 NapCat 确认它认得这位成员；认不出时改发普通
私聊，因为 NapCat 那时会退回成「发进群里」。私聊仍然发不出去时，群里只会提示去加好友，内容
绝不会改发到群里。机器人自己不会处理好友申请（`request` 事件一律忽略），需要时请在登录着
机器人账号的 QQ 客户端里手动通过。

会读到秘密的命令（`.lore`、`.var`，以及任何会带出守秘人材料的）请用**私聊**发给机器人。
文档里也是这句：答案走私聊，提问也请走私聊。

只给玩家本人的 `system` / `error` 提示（「你的输入已排队」）按**那句话打进去的频道**
回：私聊问的仍走私聊，即使同一个人随后在群里说了话。`.imagegen` 和 `.forge` 是这一版
的引擎命令，桥不用为它们多做什么。

桥自己的命令（仅管理员）：`.bridge status`、`.bridge members`、`.bridge kick <qq>`、
`.bridge admin add|remove <qq>`、`.bridge mode all|mention`、`.bridge notice on|off`。

群默认是 `mention` 模式：能认出的命令（`.`、`/`、`r `、中文方言）一定转发；故事散文
只有 @ 了机器人才转发，除非这桌设了 `.bridge mode all`。在 QQ 里「回复」守秘人的消息会
自动带上 @；把 @ 删掉再发的回复，就是刻意不找守秘人，桥不会碰它。

## 玩家与名字

玩家的密钥在他第一条消息时签发，**名字就是他的群名片**（没有名片用昵称；事件里两者都没有
才用 `qq:<QQ号>`）。守秘人看到、叫的就是这个名字；玩家领了角色之后，守秘人会把他的话标成
`角色名（群名片）`。名字在第一次见面时定下：之后改群名片不会改座位名。名字会去掉控制字符、
合并空白并截到 32 个字符；名片撞上别的座位、或长得像 `qq:` 那种兜底形式，就退回用
`qq:<QQ号>`。两个名片相同的玩家仍然是两个座位。

守秘人的长输出——超过一条 QQ 消息的——会以**一张合并转发卡片**送达（每段一个节点，署名是
机器人自己），不再是连发好几条刷屏。卡片带不了引用和 @：对玩家命令的长回答不会引用他那条消息。

## 唯一的缺口

**二层 HTML 面板在聊天群里画不出来。** 这是结构上的那一个缺口。`.panel <id>`
打出来的是文字版，群里拿到的也是这个。进度条、徽章、选项、信件、剪报以及其余 `ui`
块都会退化成一行行字。音频只报标题。

## 一回合要好几分钟

玩家的一回合不是聊天回复。守秘人可能掷骰、读卡、写追踪器、用 NPC 说话，还要等同伴的
子回合。最坏大约是**五分钟**，不是五秒。`busy_notice` 默认开着，回合开始时群里会有
一句「守秘人正在思考」。那就是心跳。群里安静，不要当成机器人卡死。

## 日志会告诉你什么

- `OneBot 还没起来……`——启动时正向地址没有应答。NapCat 要等 QQ 登录后才开端口，所以比它先
  起来的桥（宿主重启、正在重新扫码）会一直等，一应答就启动；只打一次。token 填错仍然立刻失败。
- `OneBot 已就绪：登录账号 QQ …`——token 被接受了，这就是应答的那个账号；启动时打一次，
  每次重连后再打一次。
- `OneBot 连接断了，正在重连。` / `OneBot 连接已离线。`——连接掉了；重连风暴期间每种
  每分钟最多一行。
- token / 自检那两条报错启动之后也可能出现：重连或反向模式接受的连接上 `get_login_info`
  失败时，会打出和启动期一样的那句，每分钟最多一次。
- 一行「正在重连」而别的都正常，多半是心跳看门狗触发了：实现端会告知心跳间隔，超过 2.5 倍
  间隔一帧都没来，就当连接已经假死（路由器超时、宿主休眠）而重连。实现端关掉心跳时看门狗
  不会启动。
- `附件 … 没有转发（原因）`——玩家的图片取不下来（没有直链、签名链接过期、超大、地址不安全、
  房间的媒体策略）。文字已照常送达。原因是机器码；URL 永远不进日志，因为 NapCat 的链接
  带着签名密钥。

## 信号

`SIGINT` / `SIGTERM` 会关掉每条 Iroh 连接（包括只用来签发和删除密钥的控制连接）、
关掉 OneBot 的套接字或反向监听，并刷盘状态文件。
