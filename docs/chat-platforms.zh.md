# 聊天平台适配器（实验性）

Discord、QQ 官方、Telegram、飞书与 OneBot 11 可以和 Iroh 终端客户端进入同一个逻辑
房间。它们共用确定性骰子、命令、媒体库、权限与 Keeper 核心；适配器只负责在平台原生事件
和共享 gateway 契约之间翻译。

五个网络适配器都只是经过 Mock 测试的 **Experimental**。离线测试覆盖事件解析、API
载荷、错误路径和自有生命周期清理，却不能证明真 Bot 权限、限流、gateway 差异或厂商 SDK
行为。下方真平台清单通过前，任何一个都不能称为稳定。**OpenTUI 仍是主力客户端。**

## 能力概览

| 平台 | 传输 | 已覆盖能力 | 有意保留的降级 / 限制 |
|---|---|---|---|
| Discord | Discord gateway | 斜杠命令、组件、面板、附件、私密 Interaction、语音 | 仍需真服务器验收；语音需要可选依赖 |
| QQ 官方 | 官方 gateway + HTTP API | 群 @/全量群消息/C2C、Markdown、Keyboard、富媒体、被动回复队列 | 富能力降级为纯文本/编号命令；单附件 20 MiB |
| Telegram | `python-telegram-bot` polling | 精确 mention、Bot 命令、话题、引用回复、媒体、typing、编辑、内联 callback、私聊 | Markdown 异常时重试纯文本；私密回复要求用户已打开 Bot 私聊 |
| 飞书 | `lark-oapi` 长连接 | 精确 mention、thread、引用回复、post/媒体、原生回复、私密投递 | embed/卡片内容和控件无损降级为纯文本与编号命令；**没有原生 interactive card** |
| OneBot 11 | 正向或反向 universal WebSocket | 群聊/私聊事件、CQ/数组消息段、回复、媒体、action/echo、Bearer 鉴权 | embed 与控件降级为编号文本；实现间有差异；附件硬上限 20 MiB，共享运行时限额可能更低 |

## 安装与启动

只安装实际运行的适配器 SDK extra。QQ 官方与 OneBot 使用核心依赖。

```bash
uv sync --extra discord --extra telegram --extra feishu
uv run python -m app --doctor
uv run python -m app --serve --platforms discord,qq,telegram,feishu,onebot
```

`--platforms` 接受任意逗号分隔子集。`--doctor` 会在进入常驻运行前报告凭据缺失、
Telegram/飞书 SDK 缺失和 OneBot endpoint 不完整。组合模式会在所选适配器旁继续运行 Iroh
服务端，共用 `TRPG_DATA_DIR`、密钥库和 RoomHub。缺少必需配置的平台会被跳过。

在群聊里，普通自然语言必须 @ Bot；能够识别的前缀/斜杠命令可以直接进入共享
`CommandRouter`。私聊无需 mention。生成文本不会主动制造 @全体，但平台权限和隐私配置仍由
运营者负责。

## Discord

```dotenv
TRPG_DISCORD__TOKEN=...
# 可选：把命令立即同步到一个开发服务器。
TRPG_DISCORD__GUILD_ID=...
# 可选；缺少语音条件时，文字和音频附件仍可用。
TRPG_DISCORD__FFMPEG=ffmpeg
```

OAuth scopes：`bot`、`applications.commands`。

Bot 权限：查看频道、发送消息、嵌入链接、附加文件、读取历史；语音播放再加连接与发言。
使用普通频道消息时开启 Message Content Intent。模型生成文本不会触发 mention。

原生命令包括 `/roll`、`/check`、`/sheet`、`/character`、`/panel`、`/language`、
`/help`、`/room`、`/model`、`/audio`。共享面板在每个频道只保留一条可编辑消息；个人角色
与 Keeper 结果使用私密 Interaction 响应。图片和音频作为 Discord 附件发送；
`/audio join|leave|play|pause|resume|stop|volume` 按逻辑房间控制一个播放器。

## QQ 官方机器人

```dotenv
TRPG_QQ__APP_ID=...
TRPG_QQ__SECRET=...
# 可选：自定义 Markdown 模板必须声明名为 `content` 的参数。
TRPG_QQ__MARKDOWN_TEMPLATE_ID=...
# 可选：没有内联 Keyboard 时，给富文本回复附加此静态 Keyboard 模板。
TRPG_QQ__KEYBOARD_ID=...
# 启用由 Loreweaver 控件动态生成的内联 Keyboard。
TRPG_QQ__KEYBOARD_ENABLED=true
```

在开放平台配置群聊 @、获权后的群消息和 C2C 事件。Markdown 回复必须配置
`MARKDOWN_TEMPLATE_ID`，适配器会把渲染后的文本写入模板的 `content` 参数。动态控件按钮还
要求 `KEYBOARD_ENABLED=true`；`KEYBOARD_ID` 只选择静态 Keyboard 模板，仅随已配置的
Markdown 模板发送，本身不会启用动态按钮。测试 Bot 还必须获得对应平台能力。

未配置或被拒绝的富能力会降级为纯文本和编号命令。图片/音频在获权后走 QQ 两步富媒体
上传。单个附件限制为 20 MiB，因为适配器不实现 QQ 大文件分块协议。QQ 不模拟 Discord
语音频道。

QQ 群回复窗口受平台限制。Loreweaver 使用按逻辑房间隔离的有界 FIFO outbox，在下一次
合法入站回复时刷新；叙事保持顺序，面板状态可合并，API 失败的消息不会被误标为已送达。

## Telegram

```dotenv
# 从 BotFather 获取。
TRPG_TELEGRAM__TOKEN=...
```

Telegram extra 按受控顺序运行 PTB 22.8 polling 生命周期：初始化 application、启动
application、开始 polling，退出时依次停止 polling/application 并 shutdown。它使用长轮询，
不需要公网 webhook 或监听端口。启动时还会解析 Bot 身份并注册本地化 Bot 命令列表。

适配器区分私聊、群组/supergroup、频道和论坛话题。话题 ID 会进入逻辑频道 key，回复留在
同一话题，引用消息文本会作为 quote 进入本轮。检测 mention 时遵守 Telegram 的 UTF-16
entity offset，只移除对本 Bot 的 mention；`/command@ThisBot` 会被规范化，也不会吞掉对别的
Bot 的 mention。编辑消息、频道 post 和内联 callback query 都会接收。

入站照片、文档、音频、语音、视频、动画、video note 与 sticker 会进入共享附件链路；下载
会遵守所配置的共享媒体/音频字节限额。出站媒体使用 Telegram 原生发送方法。过长 caption
会先且只发送一次正文，再发附件。KP
运行时持续刷新 typing，面板类消息可编辑，共享组件会变成 inline-keyboard callback 命令。
仅当 Markdown 引发 Telegram `BadRequest` 时才重试一次纯文本；网络/鉴权错误不会被这种
降级掩盖。

BotFather 隐私模式开启时，Telegram 通常仍会投递命令、回复和 mention，正好匹配
Loreweaver 的群 mention 门。只有部署明确需要看到全部群消息时，才关闭隐私模式并重新把
Bot 加入群。群内产生私密结果时，Bot 会改发到该用户 DM，并丢弃群回复/话题 metadata；用户
必须先打开 Bot 私聊、发送 `/start` 且没有屏蔽它。若 Telegram 拒绝该 DM，敏感结果会安全
失败，绝不会回退重发到群里。频道 post 与匿名管理员的 `sender_chat` 没有真实用户 ID，因此
私密回复会被拒绝，不会猜测目标或误发回频道。

## 飞书 / Lark

```dotenv
TRPG_FEISHU__APP_ID=...
TRPG_FEISHU__APP_SECRET=...
```

在开发者后台启用 Bot 能力，选择**长连接**事件投递，并订阅
`im.message.receive_v1`。授予应用接收群聊/P2P 消息、读取消息正文与资源、以应用身份
发送/回复、上传图片/文件所需权限；按租户要求发布版本，并把 Bot 加进目标会话。长连接不
需要公网 callback URL。

飞书 extra 有意精确 pin `lark-oapi==1.5.5`。可停止 supervisor 已针对该版本验证；由于 SDK
没有暴露完整的公共生命周期 API，它必须使用一部分私有 WebSocket 协议面。重新运行长连接
生命周期测试前，不要放宽或升级该 pin。

启动时必须成功解析自身 Bot `open_id`，才能让精确 mention 自己打开群门；请在日志中核对，
因为身份查询失败时会让适配器按失败关闭，绝不会用猜测身份接收消息。其他 mention 会留在
文本里。P2P 映射到 DM，飞书 `thread_id` 隔离 thread，`parent_id` 会在 SDK callback 之外补取成
quoted text。文本/post 和图片、文件、音频、视频、sticker 资源都进入公共媒体链路。公开响应
尽可能走原生 reply endpoint；群里的私密结果会投递给发送者 `open_id`，绝不会误发到群里。

入站资源按需懒下载，并且必须符合共享 gateway 本次请求的字节上限；下载失败或超限时会保留
资源映射，使之后符合限制的重试仍能成功。

出站图片上传前限制为 10 MiB，其他文件为 30 MiB。结构化 embed、卡片式内容与控件会被
有意渲染成无损纯文本，每个可操作组件都以带标签和原命令的编号行保留。本适配器**不声称
支持飞书原生 interactive card**。

受控 client 运行在自己的事件线程/current loop，完全不读写 SDK 模块全局 loop，因此两个
适配器实例彼此隔离。endpoint 查询为异步、可取消且有 timeout，WebSocket 的
connect/close/start/stop 都有界。supervisor 会等待首次 ready、重试瞬态首连/运行期失败、监督
receive task，并在永久 client 错误时如实失败，不会假装已经连接。关闭时先拒收新事件、停止
事件源，在有界时间内 drain 已接收工作，再取消剩余任务、关闭 transport 并 join thread；
停止后的 source 可以重新启动。这一生命周期已有 Mock 测试，但仍需在真实租户/公网长连接中
做重启验收。

同步 SDK callback 只等待主 loop 接受事件，不等待 Keeper turn。这个 handoff 只在进程内存
中，并不是持久化入站队列：callback 接受事件之后，如果进程在 turn 完成前崩溃，仍可能丢失
这项 in-flight 工作。进程存活期间，2,048 条消息的进程内窗口会抑制 timeout/重连重投
（重启后清空）；资源查询缓存同样有界。

## OneBot 11

OneBot 用同一条 universal WebSocket 承载事件与 action。必须且只能选择一种模式。

正向模式：Loreweaver 主动连接 OneBot 实现，断线后自动重连。

```dotenv
TRPG_ONEBOT__MODE=forward
TRPG_ONEBOT__WS_URL=ws://127.0.0.1:3001
TRPG_ONEBOT__ACCESS_TOKEN=replace-with-a-long-random-token
# 可选调优：
TRPG_ONEBOT__REQUEST_TIMEOUT=10
TRPG_ONEBOT__RECONNECT_DELAY=1
```

反向模式：OneBot 实现主动连接 Loreweaver。

```dotenv
TRPG_ONEBOT__MODE=reverse
TRPG_ONEBOT__LISTEN_HOST=127.0.0.1
TRPG_ONEBOT__LISTEN_PORT=6700
TRPG_ONEBOT__PATH=/onebot/v11/ws
TRPG_ONEBOT__ACCESS_TOKEN=replace-with-the-same-token-in-the-implementation
TRPG_ONEBOT__REQUEST_TIMEOUT=10
```

正向模式只接受 `ws://` 或 `wss://` URL。反向模式精确匹配配置的 path，只支持 Universal
WebSocket，不支持拆分的 API/event 两条 socket。配置 token 后，正向模式会发送
`Authorization: Bearer <token>`，反向模式会拒绝缺失或错误的 Bearer header。反向客户端若
发送 `X-Client-Role`，值必须为 `Universal`。除非已明确保护外围网络，否则监听地址保持
loopback；`LISTEN_HOST` 不是 loopback 时，配置/启动会强制要求 `ACCESS_TOKEN`，未鉴权的
非 loopback 反向 socket 会被拒绝。

适配器接收 OneBot 11 群聊和私聊的 `message` 事件，过滤自身发言，并解析数组消息段或
CQ-code 字符串。文本、精确 @自己、`image`/`record`/`video`/`file` metadata、回复消息段和
私聊投递都有覆盖。HTTP(S) 附件与内联 base64 媒体的 OneBot 硬上限为 20 MiB，但会先遵守
共享 `TRPG_TUI__MEDIA_MAX_FILE_BYTES` 或 `TRPG_TUI__AUDIO_MAX_FILE_BYTES` 限额，实际值可能
更低。远程附件只允许无内嵌凭据的公共 HTTP(S) 目标；每个 DNS 结果与重定向跳转都会重新
校验，loopback、私网、link-local、reserved 与 metadata 地址会被拒绝，request timeout
约束整条跳转/下载链。出站图片/音频/视频使用原生消息段；不支持的普通文件、embed 和控件会保留成可读
名称/URL 或编号纯文本命令，不会假装所有实现都有卡片 API。

每个 action 都带唯一 `echo`。response 只解析对应 request，绝不会再次当作玩家事件分发，
包括 timeout 后才到达的迟发 response。正向模式自己重连，反向模式接受实现方重连。有界
`(self_id, chat_type, chat_id, message_id)` 窗口抑制重放 turn，同时不会把不同聊天中复用的
message ID 混为一条。不同 OneBot 实现之间确有差异，请对实际部署的实现与版本同时核对
event shape 和 action response。

## Keeper 绑定

在已认证的终端 Keeper 会话中生成一次性 `chat_bind` token，再在 Bot 的直接会话中发送
`/bind <token>`（Discord DM、QQ C2C、Telegram DM、飞书 P2P 或 OneBot 私聊）。token 被
消费并把该平台用户绑定到 token 的房间；`/unbind` 撤销绑定。只有用户绑定房间与群当前逻辑
房间一致时，群命令才提权；仅仅私聊 Bot 不会获得 Keeper。Discord 的这两个命令需在 Bot
私聊中输入，不会注册到服务器命令树。

一个自托管进程就是一个运维信任域：所有已认证 Keeper 都可以修改部署级模型和图像提供商
配置。互不信任的 Keeper 应分别运行实例。不要在公开频道粘贴 provider key、邀请 key、
模组秘密、适配器 token 或备份文件。

## 真平台发布清单

每个所选适配器都先执行公共检查：

- 运行 `--doctor`，启动所选子集，再停止并重启两次；关闭后不应残留适配器 task、polling
  loop、SDK thread、socket 或 pending request。
- 在直接会话里绑定并撤销 Keeper；确认未绑定用户、绑定另一房间的用户/群都被拒绝。
- 把该适配器和至少一个 OpenTUI 客户端连到同一房间；核对玩家行动、真实骰子、叙事、个人
  状态，并确认私密结果只到目标收件人。
- 覆盖群 mention、无自然语言的前缀/斜杠命令、私聊、Bot 自己发出的事件和重复投递事件；
  确认没有机器人循环或重复 Keeper turn。
- 覆盖长叙事、引用回复、支持的入站/出站媒体、超限/被拒附件、API 失败及恢复；回复与日志
  不得泄漏凭据。
- 在 turn 进行中断网再恢复，确认适配器能重连且不会重复 turn；发送失败必须如实报告，不能
  静默标成已送达。有 outbox 的平台另行核对队列顺序。检查公开房间和日志：健康消息不得
  包含 provider key、邀请/绑定 token、适配器凭据、Keeper lore 或剧情正文。

然后执行平台专项检查：

- **Discord：**斜杠命令/组件、私密 Interaction 响应、重启后的面板恢复，以及有/无 ffmpeg
  时完整执行加入/离开/播放/暂停/恢复/停止/音量语音路径。
- **QQ 官方：**群 @、获权后的全量群消息与 C2C；Markdown/Keyboard 成功与纯文本降级；
  富媒体上传；被动窗口 outbox 顺序；heartbeat/resume 和无重复消息重连。
- **Telegram：**BotFather 隐私行为、论坛话题与父会话隔离、引用与编辑消息、typing 刷新、
  inline callback 确认、媒体、DM 私密结果，以及 polling 恢复后不重复 update。
- **飞书：**已发布应用权限、长连接上的 `im.message.receive_v1`、精确区分自己/他人 mention、
  thread 与 parent quote、P2P 私密结果、媒体上传/读取、明确的编号文本卡片降级、瞬态首连/
  receiver 重连、永久凭据失败、双实例隔离、重投去重及干净停止/重启。
- **OneBot 11：**分别跑正向与反向 universal WebSocket；拒绝错误/缺失 Bearer token；在
  事件到达期间正确关联 action/echo；断线重连；拒绝重复/自身事件；覆盖 CQ/数组消息段、
  回复、媒体、私聊、timeout、共享运行时附件限额与 20 MiB 硬上限。
