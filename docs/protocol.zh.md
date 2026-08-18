*[English](protocol.md) · 中文*

# Loreweaver 联网 TUI —— 协议 2.3

这是 loreweaver 服务器（通过 `python -m app --serve` 启动）与 OpenTUI 终端客户端之间开放、带版本的协议。引擎本身（确定性内核加 AI 守秘人）和用什么传输无关；与传输无关的会话逻辑在 `net.session.SessionCore` 里，这份文档描述的是接口，不绑定任何编程语言。

控制流使用 `{"type": ...}` 形状的 JSON 帧，协议版本为 `"2.3"`。同一套帧和 `join` 握手可以跑在两种传输上：

- **Iroh** 是 `--serve` 实际启动的默认传输：点对点 QUIC，服务端打印可分享 ticket，不需要域名、证书或端口转发。控制帧是在长连接双向流上的 newline-delimited JSON；媒体字节使用同一连接上的额外双向流。
- **WebSocket**（`net.tui_server`）只留作离线测试和本机回环，不是 `--serve` 的一个选项。控制帧是文本消息，媒体字节是二进制消息。

两种传输驱动的是同一个 `SessionCore` / `RoomHub`。

**版本控制。**`"2.0"` 是对 1.x 的一次性破坏性整合——主版本号即兼容契约：客户端与服务端必须在主版本（`2`）上一致，`welcome.protocol` 主版本不同的客户端应拒绝连接（或明确警告）。`loreweaver-protocol` 自带这个判定（`protocolMismatch`），任何客户端都不必自己写；两个参考客户端——TUI 与 Loreweaver Studio——都取更强的那一档：**拒绝连接**、断开、并把两边的版本号都说出来。继续与主版本不同的服务端对话，结果是误读帧而不是失败，比拒绝难排查得多。版本号解析不出来时不算证据，不能当成版本不一致来处理。同一个主版本里，小版本只做增量；客户端忽略无法识别的帧类型与字段——但有**一条规范性例外：能拦下渲染的字段永远不可忽略**。客户端遇到带 `visible_when` 的面板模板块而无法对该条件求值（不实现这个字段、不实现语法的某个角落、或求值本身出错）时，**必须不渲染该块**：无视这个条件，等于把作者藏起来的内容画到屏幕上，所以判不出来的一律不画，和 `$var` 取不到值是同一条规矩。线上没有任何东西能让服务端核对这一点（`welcome.protocol` 报的是**服务端**版本，`join` 不携带客户端版本），因此这是一条客户端一致性要求，用到 `visible_when` 的包即以 2.1 为最低版本。同时也要看清它**不是**什么：带条件的块，内容无论条件成不成立都随清单下发——`visible_when` 决定的是块**何时**画出来，不是其内容是否到达客户端；保密靠 `audience`（服务端解析）与 `state` 变量过滤器。2.0 打破了哪些东西，各自了结了哪个老毛病：

- `dice` 帧围绕引擎的中立检定结果契约重新设计：1.x 的 CoC 形状 `rank:int(-2..4)` / `level:string` 字段删除；分级检定携带 `outcome:{id,label,success,critical,fumble,tier,margin?}`，客户端按语义标志上色，而不是内嵌某个规则系统的成功阶梯。1.x 的 `kind:"sanity"` 变为通用的 `kind:"subsystem"` + `subsystem` id；系统形状的附加数据（奖励/惩罚骰、SAN 损失、幸运消耗、优势候选骰）放入不透明的 `detail` 对象。
- 流式传输收敛为两种帧、一条规则：`narrative_delta` 帧携带草稿气泡的文本增量；同 `id` 的那一条收尾 `narrative` 帧携带**完整**最终文本并**替换**草稿。1.x 的尾缀式 `done` 帧、`stream`/`done` 布尔组合、以及“普通 narrative 顶替未完成草稿”的规则全部删除——生成后修正直接落在最终文本里。
- `state.character` / `state.party[]` 的生命体征改为一个通用 `resources:[{id,label,value,max}]` 列表；1.x 的按系统字段名（`hp`、`hpmax`、`san`……）与 `hpmax`/`hpMax` 大小写不一致一并删除。
- `dice` 帧只来源于工具绑定的结构化 payload；1.x 服务端“从工具的本地化文本反解析猜 rank”的回退路径不复存在。

客户端发的第一帧**必须**是 `join`。服务端回一个 `welcome` 或 `error`，出错就关连接。握手超时之内没等到 `join`（`TRPG_TUI__JOIN_TIMEOUT`，默认 10 秒），服务端会用 `error join_timeout` 把连接关掉，而不是一直等下去。离线的 WebSocket 传输还额外支持 `TRPG_TUI__MAX_CONNECTIONS` 并发上限；超出的连接在读 `join` 之前就会收到 `error too_many_connections`。

## 客户端 → 服务端

- `join` — 认证并将连接绑定到房间：
  `{type:"join", key:string, name?:string, client?:{name,version}}`
- `input` — 命令行或玩家言辞，正是玩家键入的内容：
  `{type:"input", text:string}`
- `media_offer` — 打开字节通道前先提交图片/音频元数据：
  `{type:"media_offer", name:string, mime:string, size:int, sha256:string}`
- `media_set_enabled` — 仅守秘人可用的房间媒体上传开关：
  `{type:"media_set_enabled", enabled:boolean}`
- `avatar_set` — 将本房间已经上传的一张图片绑定到调用者自己的当前角色头像。服务端会拒绝试图指定其他角色/用户的帧：
  `{type:"avatar_set", hash:string}`
- `panel_intent`— 一次模组面板交互。服务端先校验所指面板确在**这名成员自己的**清单里（否则 `error forbidden`），然后把 value 完全按“这名玩家自己敲的”来路由——面板特权模型一步到位：`choice` 与 `input` 把 `value` 原样送进普通输入那条通道（限速、回合锁、命令权限一样都不少）；`roll` 以该玩家身份执行公开的 `.r <value>`，由真实骰子引擎校验表达式。`value` 上限 2000 字符（超出 `error input_too_long`）：
  `{type:"panel_intent", panel:string, kind:"choice"|"input"|"roll", value:string}`
- `list_pack_cards`（v2.2）— 请求已安装扩展包携带的卡文件清单，是「从已安装包导入」选择器背后的结构化通道。对玩家开放：回复只携带**文件名**（运营者的安装横幅本来就打印过），绝不携带卡内容；world/companion 导入动词的守秘人门与引用的发现方式无关，照常生效：
  `{type:"list_pack_cards"}`
- `ping`: `{type:"ping", t:number}`

## 服务端 → 客户端

- `welcome` — 成功 `join` 时发送一次：
  `{type:"welcome", protocol:"2.3", features:["media","audio","imagegen"?,"demo"?,"update"?], room:string, you:{id:string,name:string,role:"player"|"keeper"}, locale:string, server:string, version?:string}`
  `version` 是服务端自己的发布版本（和客户端一比就能看出两边不一致）。`"update"` 特性仅在守秘人连接且服务端运维配置了自更新命令时出现，有它才允许发 `admin_update_server`。
  `demo` 表示服务端正在用离线示例守秘人、向量功能已启用，且本次检查时这个守秘人房间为空。服务端会在房间回合锁内再次检查，过期 flag 不会覆盖战役状态；客户端收到 `admin_config{using_demo:false}`（例如从模型页保存后）会立即移除入口，否则重连时重新计算，过期操作也会被服务端拒绝。
- `error` — 本地化的故障通知；`bad_key`、`join_timeout` 和 `too_many_connections` 关闭连接（它们仅在 `join` 握手期间或之前发生），其他不关闭：
  `{type:"error", code:"bad_key"|"bad_frame"|"input_too_long"|"rate_limited"|"server_error"|"join_timeout"|"too_many_connections"|"demo_unavailable"|媒体错误码, message:string}`
- `media_accept` — 上传被接受；若 `existing` 为 true，则无需 PUT：
  `{type:"media_accept", upload_id:string, existing?:boolean, media?:MediaFrame, audio?:AudioLibraryItem}`
- `media` — 媒体元数据广播和历史回放条目；字节按需拉取：
  `{type:"media", id:string, hash:string, mime:string, size:int, name:string, from:string, ts:number}`
- `media_enabled` — 房间的玩家上传政策。守秘人切换时向全房间广播；成员加入时若上传处于关闭态（非默认态）会在回放阶段补发一帧（加入时没有此帧即默认：允许上传）。客户端可以据此显示或禁用自己的上传入口：
  `{type:"media_enabled", enabled:boolean}`
- `audio_library_item` — 由上传音频 blob 生成的房间音频库条目：
  `{type:"audio_library_item", id:string, hash:string, mime:string, size:int, name:string, from:string, ts:number, title?:string, license?:string, source?:string, tags?:string[]}`
- `audio_control` — 客户端本地播放意图：
  `{type:"audio_control", id:string, action:"play"|"stop"|"pause"|"resume"|"volume", layer:"bgm"|"ambience"|"sfx", hash?:string, mime?:string, name?:string, title?:string, loop?:boolean, volume?:number, fade_ms?:int, position_ms?:int, server_ts?:number}`
- `audio_state` — 尽力持久化的 BGM/环境音状态，在加入房间时回放：
  `{type:"audio_state", layers:[{layer:"bgm"|"ambience"|"sfx", hash?:string, mime?:string, name?:string, title?:string, playing:boolean, volume?:number, loop?:boolean, started_at?:number}]}`
- `narrative` — 一行**完整的**故事/聊天文本：
  `{type:"narrative", id:string, speaker:"kp"|"player"|"system"|"npc", name?:string, text:string, format:"markdown"|"plain"}`
  对于 `speaker:"npc"`，`name` 携带 NPC 名称。`narrative` 帧永远携带完整的最终文本：当其 `id` 与客户端由 `narrative_delta` 累积出的草稿气泡匹配时，最终文本**替换**该草稿（生成后修正已折入）；否则就是一条普通的单发文本。**空的最终文本是撤销，不是消息**：服务器用它收掉被放弃的草稿（守秘人换了下一轮工具草稿、或回合中途夭折），客户端必须**移除**——绝不渲染——最终文本为空的气泡。
  **加入时的回放。** 每次加入，服务器都把房间最近的记录（最后 30 条对话历史）作为普通 `narrative` 帧回放——只回放故事通道，不回放点命令回显；自 v2.3 起，每条被回放的 AI 守秘人回复**之前**，先回放该回合现场产生的 `dice` 与 npc `narrative` 帧（见"回合流程"第 5–6 步）。回放帧与现场帧刻意不可区分：客户端按到达顺序渲染，并按 `id` 去重 `narrative`。
- `narrative_delta` — 草稿气泡的一段流式文本增量：
  `{type:"narrative_delta", id:string, speaker:"kp", name?:string, text:string}`
  客户端把共享同一 `id` 的增量拼接进草稿气泡（按 markdown 渲染）。流在**同 `id`** 的 `narrative` 帧到达时结束；服务端保证这条收尾帧一定会来（回合失败也会以已流出的文本收口）。服务端在 AI 守秘人生成的同时就往外发，并且边发边清理：拿不准的一律不发，机关和 MVU 块永远不会流出去。
- `dice` — 一次掷骰子/检定，由客户端渲染；**绝不**携带守秘人的秘密：
  `{type:"dice", actor:string, kind:"roll"|"check"|"subsystem"|"opposed"|"init", expr:string, rolls:number[], total:number, target?:number, effective_target?:number, subsystem?:string, outcome?:Outcome, detail?:object}`
  `Outcome = {id:string, label:string, success:boolean, critical:boolean, fumble:boolean, tier:number, margin?:number}`
  分级检定携带 `outcome`：`id` 是规则系统自己的等级词汇（仅用于展示——客户端绝不据此分支），`label` 是已本地化的显示标签，客户端按语义标志（`critical`/`fumble`/`success`）上色，可按 `tier`（阶梯序数，越高越好）做深浅。`kind:"subsystem"` 标记规则子系统检定（`subsystem` 命名之，如理智检定）；`kind:"opposed"` 在 `detail.left`/`detail.right`（`{name,total,target?,outcome?}`）与 `detail.winner:"left"|"right"|"tie"` 里携带双方。`detail` 的其余内容是系统声明的掷骰数据（奖励/惩罚骰、损失/剩余、优势候选……），客户端可原样展示、永远无需理解。
- `ui`— 房间事件钩子发出的声明式模组 UI（技能/卡片 `hooks.js` 里的 `emitUI(blocks, opts?)`，见 `docs/plugins.md`），在它所附着的那条守秘人 `narrative` 之后、`state` 快照之前广播。这些块在服务端（`core.hooks`）过白名单、做校验、按大小截断，客户端拿到就能直接画。内容是玩家可见的作者产出，信任层级与叙事相同：钩子绝不能把仅守秘人可见的秘密发进来，引擎也从不把守秘人工具结果写入此帧。不参与加入时的历史回放——想要常驻面板的钩子每回合重新发射即可：
  `{type:"ui", blocks:[UiBlock], panel:"inline"|"sidebar", id?:string, replace?:boolean}`
  `UiBlock = {kind:"meter", label:string, value:number, min:number, max:number}`
  `| {kind:"stat", label:string, value:number|string|boolean}`
  `| {kind:"badge", label:string, tone?:"info"|"warn"|"danger"}`
  `| {kind:"text", text:string, style?:"quote"|"warning"}`
  `| {kind:"divider"}`
  `| {kind:"choices", prompt?:string, options:[{id:string,label:string,input:string}]}`
  `| {kind:"image", hash:string, mime?:string, size?:int, caption?:string, alt?:string}`
  `| {kind:"letter", body:string, from?:string, to?:string, date?:string}`
  `| {kind:"clipping", headline:string, body:string, source?:string, date?:string}`
  `| {kind:"map_pin", hash:string, mime?:string, size?:int, label:string, x:number, y:number, note?:string}`
  `| {kind:"title_card", title:string, subtitle?:string, act?:string}`
  后四种是 M19 的**演出模板**：声明式，不是标记语言。富客户端把 `letter` 画成信笺、把 `title_card` 画成整幅幕卡；文本优先客户端把同样的字段打成几行。`map_pin` 的 `x`/`y` 是地图图片自身画框的**比例**（0..1），客户端按自己渲染的尺寸缩放标记。它们由房间的演出导演（`agent.stage_director`）在剧情节拍上发出，钩子与模组面板同样可用。
  `image` 块用**内容 hash** 指名一张图——正是媒体字节通道已经在应答的地址（`{op:"get", hash}`）。服务端只会发出**本房间**可取的 hash（房间自己的媒体，或本房间已启用包的资产），并盖上权威 `mime`，因此客户端可以像对待任何媒体一样拉取与缓存；取不到的 hash 在组帧前就已在服务端丢弃。文本优先客户端降级为 `caption`/`alt` 一行文字加自己既有的媒体查看方式。
  `panel:"inline"` 渲染进叙事流，`"sidebar"` 渲染进常驻侧栏区域。`id` 命名一个 UI 区域：后到的同 `id` sidebar 帧替换该区域内容；带 `replace:true` 的 inline 帧可以就地更新前一个同 `id` 的 inline 帧（不支持就地更新的客户端顺序追加即可）。玩家点选 `choices` 选项时，客户端把该选项的 `input` 原样作为普通 `input` 帧发回——不新增客户端→服务端帧类型。
- `ui_manifest`— **这名观看者**的完整模组面板清单：`join` 时紧随首个 `state` 帧下发，守秘人执行 `.panels enable|disable` 后向每个在线成员重新推送。全量替换语义：帧携带整张清单（空表 = 没有面板，重连时也借此清掉旧面板）。包声明的 `audience` 在服务端按观看者的 keystore 角色**先行**解析——仅守秘人可见的面板在结构上就不会出现在玩家清单里，`audience` 字段本身也永不上线。面板/模板形状见下文“模组 UI 面板”：
  `{type:"ui_manifest", panels:[UiManifestPanel]}`
- `panel_event`— 房间钩子经 `emitPanel(panelId, payload)` 发射的不透明 JSON 载荷（见 `docs/plugins.md`），供目标面板自己的代码（Tier 2）消费。在本回合 `ui` 帧之后送达，且**只**送达清单中含该面板的成员；每回合 ≤ 20 条（超额丢弃并记日志）、单条序列化 ≤ 32 KB。不运行面板代码的客户端（TUI）直接忽略：
  `{type:"panel_event", panel:string, payload:any}`
- `state` — 一个面板快照，在 `join` 时和每回合后发送：
  `{type:"state", character?:{name,system,resources:[Resource],attributes:{},status_effects:[],avatar?:{hash,mime,size,name?}}, party:[{name,online:boolean,active:boolean,initiative?:int,resources?:[Resource],ai?:boolean,avatar?:{hash,mime,size,name?}}], scene?:{name,focus?}, clock?:{time,round?}, initiative:[{name,value:int,current:boolean}], online:int, variables?:[{id:string,label:string,kind:"number"|"bool"|"text"|"enum",value:number|boolean|string,min?:int,max?:int,hidden?:boolean}], pregens?:[{name:string,claimed_by:string}], systems?:[{id:string,make_char?:string}], reset?:boolean}`
  `Resource = {id:string, label:string, value:number, max?:number}` — 规则系统的生命体征条（HP、理智、魔法值……）作为通用数据：客户端按列表渲染条形量表，无需知道任何系统的字段名。条目按渲染顺序到达。`label` 已按**本观看者**的语言解析：规则包的 `sheet.resources[].label` 可写成语言映射，于是同一个房间的 `en` 与 `zh` 连接各自读到自己那一版。
  `character.attributes`（v2.3）只含卡的**特征值**——规则系统 `sheet.attributes` 声明的那些键，按包自己的顺序（CoC 7e 的 `STR CON SIZ …`、D&D 5e 的 `STR DEX CON …`、社区包自己系统的自己那套）；生命体征**不**在这里重复（它们是 `resources`），派生值从不发送——客户端照线上顺序原样渲染，每个键都是 `.st <key>=<n>` 接受的名字。没有声明卡表规格的系统按存储原样发送。
  `variables`（v1.6，增量字段，可有可无——房间没有就整个省略）是房间的确定性模块变量，且只含玩家可见子集：仅守秘人可见的变量在引擎内部（`core.modvars.player_entries`）就被过滤，永远不会到达任何传输层。条目按定义顺序到达（按原样渲染，不要排序）；`label` 已按房间语言本地化；`min`/`max` 只出现在有界的 `number` 变量上（客户端可将其渲染为进度条）。导入的 SillyTavern MVU 卡片变量共用同一列表：`id` 带 `mvu.` 前缀、点分路径作为 `label`（只有标量叶子，数量由服务端封顶）——不新增帧类型，客户端无需改动。MVU 的叶子由**守秘人挑着放出来**（默认全部隐藏，没公开的一律不发）：玩家帧只携带守秘人公开过的路径（`.var expose`）；守秘人自己连接的帧额外携带未公开的其余叶子，每条带 `hidden:true` 标记（增量字段，可有可无——不认识它的客户端照常渲染，认识的可以画成置灰或者加把锁）。
  `systems`（v2.3，可有可无）是本服务端发现的全部规则系统，每条带上「在这个系统里建卡」用的方言词（`make_char`；规则包没声明就没有这个字段）。客户端要提供建卡入口，需要的就是这两样，不必认识任何一个规则系统——于是自带系统的内容包，不用等客户端发版就会出现在每个客户端的选择器里。
  `reset:true` 标记的是战役被清空（`.reset` / `admin_reset_room`）之后服务端推的那份快照：面板数据已经是最新的（空的），客户端还应该把本地攒下的聊天记录也清掉。
- `pack_cards`（v2.2）— 对 `list_pack_cards` 的单播回复：每个已安装扩展包携带的卡文件。`ref` 就是 `.import <ref>` 接受的引用；`pack` 与 `name`（文件名主干）用于展示。`kind`（v2.3）是这张卡的拆卡归类，它决定用哪个动词：`character` 走 `.import <ref> pc`，`world` 是模组机器部件，只能走守秘人的 `.import <ref> world`（面向玩家的选择器应把它标成守秘人专用，而不是当角色卡给出）。2.3 之前的服务端不发 `kind`，缺失按 `"character"` 处理。没有任何包携带卡文件时 `cards` 为空数组（不是缺省）：
  `{type:"pack_cards", cards:[{ref:string, pack:string, name:string, kind:"character"|"world"}]}`
- `presence` — 连接的玩家名单，在加入/离开时发送：
  `{type:"presence", players:[{id,name,online}], online:int}`
- `system` — 带外通知：`{type:"system", level:"info"|"warn", text:string}`
- `turn_status` — 临时的房间级 AI-KP 活动状态。`busy` 携带正在结算其行动的 actor，`idle` 清除状态。客户端应显示动画忙碌指示，并设置安全超时以防结束帧丢失：
  `{type:"turn_status", status:"busy", actor:string}` 或 `{type:"turn_status", status:"idle"}`
- `pong`: `{type:"pong", t:number}`

## 一个回合怎么走

当房间 `R` 中的客户端发送 `input` 帧时，服务器：

1. 从房间的 `SessionSource` 构建一个 `AgentCtx`（`chat_key = "tui:group:{room}"`，`user_id` = 客户端的密钥派生 id，`locale`）。
2. 前置层：`RateLimiter.allow(user)` + `allow(room)`；如果被阻止，仅向该客户端发送 `error rate_limited`（回合在此停止）。
3. 向整个房间广播 `narrative{speaker:"player", name, text}`（每个人都看到该操作，包括发送者）。
4. 如果 `CommandRouter.dispatch(ctx, text)` 返回非 `None`，该字符串是回复（一个 `.`/`/` 命令或 SealDice 风格的内联掷骰子）。
   否则，服务器先广播 `turn_status{status:"busy", actor:name}`，再由 `run_kp_turn(ctx, services, toolset, text, output_review=censor)` 驱动 AI 守秘人，返回一个 `KPTurnResult`。
5. AI 守秘人运行**期间**，每次工具调用的公开后果**即时**广播，顺序就是模型调用的顺序（v2.3——此前是回合结束后从完整 trace 里读出来再发，流式服务商上会让叙述排在它所叙述的那次掷骰**上面**）：掷骰/检定工具（`roll_dice`、`skill_check`、`sanity_check`、`opposed_check`、`initiative_tracker`）按分发时绑定的结构化 payload 逐一产生 `dice` 帧（未发射 payload 的工具没有 dice 帧——帧永不从工具文本反解析重建）；`speak_as_npc` 产生 `narrative{speaker:"npc", name, text, format:"markdown"}`，`name` 是工具调用的 `npc` 参数，`text` 是玩家安全的工具结果。因此在流式服务商上这些帧会夹在 `narrative_delta` 分片**之间**到达；客户端不得假设增量流是连续的。
6. 同一批 dice / npc 帧按回合**记录**（`turn_event_history`），加入房间时回放，各自紧接在所属回合的 `narrative` 之前——见上文 `narrative` 条目的加入回放说明。加入者看到的顺序与现场一致。
7. 将回复广播为 `narrative{text: reply}`——命令回复为 `speaker:"system"`，AI 守秘人的回复是 `speaker:"kp", format:"markdown"`。回复已经过配置好的输出词表；守秘人专用工具的原始结果不会被代码直接抄进这一帧，但主守秘人模型看过那些结果，仍有可能自己复述出来，所以这部分风险由真模型红线评测另行实测。
8. 对回合内事件钩子经 `emitUI` 缓冲的每条发射，各广播一个 `ui` 帧——服务端已经校验并截断过；没有钩子的房间完全不会出现此帧。
9. 对钩子经 `emitPanel` 缓冲的每条发射，各送达一个 `panel_event` 帧——**不是**广播：每条只送达自己清单里含目标面板的成员。
10. AI-KP 分支结束时（包括错误清理）广播 `turn_status{status:"idle"}`；命令回复不发送回合状态。
11. 重新构建并广播一个 `state` 帧（`net.state.build_room_state`）。

密钥映射到同一房间的多个客户端共享一个 AI-KP 会话；上述每个描述为“广播”的帧都发送给当前连接到该房间的每个成员。

## 模组 UI 面板

`.lwpack` 可以携带命名 UI 面板（`contents.panels` + `ui/panels.yaml`——创作指南见 `docs/plugins.md`）；守秘人用 `.panels enable <packId>` 才把已安装包的面板准入房间（安装 ≠ 启用，与技能完全一致）。房间清单按观看者解析后经 `ui_manifest` 下发（见上文）。特权模型一句话说完：**面板以正在观看它的玩家身份行事**——入站只收到该观看者过滤后的数据，出站（`panel_intent`）只能发出该玩家自己能敲出的东西。

`UiManifestPanel`（`audience` 永不出现——已在服务端解析）：

```jsonc
{"id": "<packId>/<panelId>", "title": {"en": "...", "zh": "..."}, "slot": "sidebar|tray|modal",
 "tier": 1, "blocks": [/* 模板块 */]}
// 或 tier 2：
{"id": "...", "title": {...}, "slot": "modal", "tier": 2,
 "entry": {"hash": "<sha256>", "size": 1234},
 "assets": [{"path": "app.js", "hash": "<sha256>", "size": 999, "mime": "text/javascript"}],
 "fallback": [/* 模板块 */] /* 或 null */}
```

**Tier-1 模板块**是 v1.7 `UiBlock` 词汇表加两个模板扩展，由**客户端**对照自己的 `state.variables` 解析（id 与该列表完全一致——modvar id、带 `mvu.` 前缀的叶子）：

- 任何标量字段可写 `{"$var": "<变量 id>"}`；该变量对本观看者不存在/未公开时**整块省略**（拿不准就不显示——面板永远没法让人多看见东西；线上那道 `state` 过滤器仍然是唯一的关口）；
- `{"repeat": {"prefix": "<id 前缀>", "block": <模板块>}}` 对每个 id 以该前缀开头的可见变量渲染一个实例（≤ 32 个）；块内 `{"$leaf": "id"|"label"|"value"}` 代入匹配变量的对应字段。

`image` 与 `map_pin` 是由服务端**改写**而非原样透传的模板块：作者写包内相对路径 `src`，清单里携带的是解析后的 `{hash, mime, size}` 加该块自己的（本地化）字段——寻址由打包过程决定，因此面板只可能指向**它自己这个包所附带**的图片。拉取方式与 Tier-2 资产一致，走媒体字节通道。其余演出模板都是普通的本地化文本；`map_pin` 的 `x`/`y` 可以绑定 `{$var}`，让标记随剧情移动。

**`visible_when`（2.1）**——任何模板块都可以带 `visible_when: "<条件>"`，由**客户端**针对本观看者自己的 `state.variables` 求值。`$var` 的「不存在即隐藏」表达不了**按值**开关（「day >= 46 之后才显示」），而值在运行时才变，服务端无法按观看者预先过滤。语法是一个刻意很小的**可移植子集**（子集之外的表达式在打包时就被拒绝，所以到达客户端的条件必然在子集内）：

- 比较 `=== !== == != >= <= > <`；逻辑 `&& || !`（也接受 `and`/`or`/`not`）；
- 字面量：数字、`'字符串'`、`"字符串"`、`true`/`false`/`null`/`undefined`；
- 引用：裸的点分路径（含中日韩文），按**变量 id** 在 `state.variables` 里查；查不到即 `null`。
- **不在子集内**：算术、函数调用（含 `getvar`）、方括号取值。

语义以参考实现为准，而非 JavaScript 自己的运算符：`==`/`!=` 会对数字字符串做强制转换，`===`/`!==` 是严格比较（布尔永远不严格等于数字），无法比较大小的组合（`"abc" > 5`、`null > 5`）是**错误**。**求值出错、或客户端无法求值的条件必须隐藏该块**——判不出来就不显示，和 `$var` 取不到值是同一条规矩，也是小版本新增字段里唯一一个不许被忽略的（见「版本控制」）。这条规则对条件可以落在的每一种块都成立，`repeat` 也不例外：条件写在 repeat 自己身上，整段就不展开；写在它内层的模板上，就一个实例一个实例地判。隐藏变量在求值前就被剔除，因此条件永远无法把线上过滤掉的东西试探出来；反过来说，带条件的块，内容无论条件成不成立都在清单里，所以 `visible_when` 是展示手段，绝不是保密手段。`tests/fixtures/visible_when_vectors.json` 是各实现共用的一致性向量表。

本地化文本是 `{en,zh}` 映射；客户端按自己语言选取（回退 `en`）。点选 Tier-1 `choices` 选项发送 `panel_intent{kind:"choice", value: <选项的 input>}`。文本客户端（TUI）用既有块渲染器画 Tier-1，`tray`/`modal` 收进侧栏分区，Tier-2 渲染其 `fallback` 块，对显式 `fallback: null` 显示一行本地化的“请在富客户端查看”。

**Tier-2 资产**按内容寻址：对清单里的每个 hash 走**既有**媒体字节通道拉取（`{op:"get", hash}`——见「媒体传输」）；线上 `path` 是相对 entry 文档所在目录的路径（每个面板是一个自包含静态根）。缓存前校验 sha256（不可变，按 hash 键）。

## 媒体传输（v1.2+）与音频（v1.3）

所有媒体都经服务器存储转发。JSON 控制流只传元数据；原始字节永远不进入 JSON，也不做 base64。支持上传的 MIME 为 `image/png`、`image/jpeg`、`image/webp`、`image/gif`、`image/svg+xml`、`audio/mpeg`、`audio/ogg`、`audio/wav`、`audio/flac`、`audio/mp4`、`audio/aac`。图片默认限制为单文件 8 MiB、每房间 512 MiB；音频默认限制为单文件 128 MiB、每房间 2 GiB。二者共用每成员每分钟 10 次上传限速。服务端只把媒体当不透明 blob 存储，解码和播放只发生在客户端。

SVG 是“不透明存储”的例外：服务端只接受静态安全子集（`svg`、`g`、`rect`、`line`、`polyline`、`text`、`tspan`、`title`、`desc`），会用 `error media_bad_svg` 拒绝脚本、foreignObject、事件属性、外链、data URL 和 CSS/url 执行面。TUI 的 SVG 预览只把这些静态绘图信息解析成终端文本，不会像浏览器那样执行 SVG 内容。

上传流程：

1. 客户端在控制流发送 `media_offer{name,mime,size,sha256}`。
2. 服务端校验 MIME、大小、房间配额、限速和房间上传开关，然后返回 `media_accept{upload_id}` 或 `error`。如果本房间已有相同 hash，可返回 `media_accept{upload_id:"", existing:true, media|audio}` 并直接广播元数据，无需 PUT。
3. 客户端通过 MediaChannel 发送 PUT：header `{op:"put", upload_id}` 加原始字节。
4. 服务端校验精确大小和 sha256，存入 `data_dir/media/<room>/<sha256>`，登记 `media_index(hash, room, mime, size, name, uploader, created_at)`；图片广播 `media`，音频广播 `audio_library_item`。

下载流程：

1. 客户端通过 MediaChannel 发送 GET：header `{op:"get", hash}`。
2. 服务端确认该 hash 属于调用者房间，然后返回 `{op:"get",hash,size,mime,name}` 加原始字节。客户端应校验 sha256，并可缓存到 `~/.loreweaver/cache/media/<hash>`。
3. 不属于房间媒体的 hash 会继续在**本房间已启用**包的已安装资产里解析——这就是面板资产的拉取路径。回复形状相同；服务端在返回前会把字节重新对照 manifest 摘要校验。房间没启用的包，它的 hash 仍然返回 `media_not_found`——这个接口不能被当成任意文件的下载口。

MediaChannel 的传输格式：

- Iroh：在同一连接上打开新的双向流。流以一行 JSON header 开头（`\n` 结尾）。PUT 时客户端随后按不超过 64 KiB 的块写入原始字节，服务端存好后回一行 `{op:"put_ok", hash}`（拒收则回一行 `{type:"error", code, message}`）；GET 时服务端先写一行 `{op:"get",hash,size,mime,name}` 响应 header，再按不超过 64 KiB 的块写入原始字节，出错则只回一行 `{type:"error", ...}`、无字节体。
- WebSocket：一条二进制消息为 `uint32_be header_length` + UTF-8 JSON header + 原始字节。PUT 发送 `{op:"put", upload_id}` 加 body，成功以房间广播的 `media` / `audio_library_item` 帧为准，拒收则以标准 `error` 文本帧返回。GET 发送 `{op:"get", hash}` 且无 body；服务端回复 `{op:"get",hash,size,mime,name}` 加 body。

音频控制与字节传输是分离的。上传音频文件只会创建或更新房间音频库。守秘人的命令，比如 `.bgm play <音频>`、`.ambience stop`、`.sfx <音频>` 会广播 `audio_control` 帧；TUI 客户端用同一套 GET 流程拉取字节并在本机播放。服务端自身不播放音频。

## 认证与密钥

没有注册。部署者运行离线管理员命令以创建绑定到房间的密钥：

```
python -m app --tui-key add --room R --name N [--role player|keeper]
```

密钥存在 TOML 文件（默认 `keys.toml`，可用 `--keys FILE` 或 `TRPG_TUI_KEYS` 环境变量覆盖），每个密钥一个表：

```toml
["<opaque-key>"]
room = "R"
name = "N"
role = "player"  # 或 "keeper"；默认为 "player"
```

在 `join` 时，服务器查找 `key`；未知的密钥被拒绝，返回 `error bad_key` 并关闭连接。已识别的密钥将连接绑定到 `SessionSource(platform="tui", chat_type="group", chat_id=room, user_id="tui:" + sha1(key)[:8], user_name=name)` —— 见 `net/keystore.py` 和附带的 `keys.example.toml`。

## 管理帧（v1.1，仅守秘人）

部署者（守秘人）可以在终端客户端的守秘人页面里，用**守秘人角色的密钥**在同一条连接上管理服务器。`join` 时绑在这条连接上的角色就是唯一的管理员判据，没有第二套认证。服务器只对 `keeper` 连接回答这些帧；其他连接得到 `admin_error{code:"forbidden"}`，且不会读取或修改数据。实现在 `net/admin.py`。

客户端 → 服务器：

- `admin_get_config` — `{type:"admin_get_config"}`
- `admin_set_model` — 切换实时 LLM provider/模型，并可设置该 provider 的 API key / `base_url`。字段省略时，只有 endpoint 未变才复用已保存凭据；显式空值会清空字段。提供新的 `base_url` 却不同时提供新 `api_key` 时，旧 key 会被清空，绝不会发往新 endpoint：
  `{type:"admin_set_model", provider:string, chat_model?:string, api_key?:string, base_url?:string}`
- `admin_set_imagegen` — 配置 OpenAI-compatible 生图 endpoint；遵循相同的 endpoint/key 隔离规则：
  `{type:"admin_set_imagegen", provider:string, base_url?:string, model:string, api_key?:string, size?:string}`
- `admin_list_models` — 获取某 provider 的实时模型列表。预览不同 `base_url` 时不会复用 saved/current key，除非同一请求明确提供 key；回复中也包含当前 `imagegen` 状态：
  `{type:"admin_list_models", provider?:string, api_key?:string, base_url?:string}`
- `admin_list_keys` — 只列出调用者 key 所绑定房间的访问 key：`{type:"admin_list_keys"}`
- `admin_mint_key` — 只为调用者所绑定的房间创建访问 key；`room` 可省略，指定其他房间会被拒绝：
  `{type:"admin_mint_key", room?:string, name?:string, role?:"player"|"keeper"}`
- `admin_update_key` — 按稳定的非秘密 id 更新一个密钥。把房间**最后一个**守秘人加入密钥降级会被拒绝并返回 `admin_error{code:"last_keeper"}`（防锁死——请先铸造第二个守秘人密钥）：
  `{type:"admin_update_key", id:string, room?:string, name?:string, role?:"player"|"keeper"}`
- `admin_delete_key` — 按 id 删除一个密钥；删除房间最后一个守秘人加入密钥同样被拒绝（`last_keeper`）：
  `{type:"admin_delete_key", id:string}`
- `admin_delete_room` — 删除绑定到房间的每个访问密钥；房间数据保持不变：
  `{type:"admin_delete_room", room:string}`
- `admin_export_room` — 在服务器上写一个房间备份 JSON 文件。如果省略 `path`，服务器在 `<data_dir>/room_backups/` 下写入：
  `{type:"admin_export_room", room:string, path?:string}`
- `admin_import_room` — 恢复服务器端备份 JSON。如果提供了 `room`，快照在恢复前被重映射到该房间：
  `{type:"admin_import_room", path:string, room?:string}`
- `admin_delete_room_data` — 删除这个房间的访问密钥、按房间存的 KV 状态、文档向量和世界书向量。`backup` 默认为 `true`；启用备份时，删除仅在备份写入成功后进行：
  `{type:"admin_delete_room_data", room:string, backup?:boolean, path?:string}`
- `admin_reset_room` — 原地重开战役，保留密钥、绑定、在线连接和房间设置（语言、房规、已启用的技能），所以这一桌不用重新配置就能重开。不做备份，也不踢任何人（这点和 `admin_delete_room_data` 相反）。`scope` 决定清到哪一步：`"story"`（默认）只清剧情和进度（角色、模组、设定、媒体都留着）；`"chars"` 连角色一起换（模组留着）；`"all"` 全部清空（角色、模组、设定、媒体）。仅守秘人可用，且限于调用者自己的房间：
  `{type:"admin_reset_room", room:string, scope?:"story"|"chars"|"all"}`
- `admin_update_server` — 守秘人请求服务端原地自更新。不带参数：服务端跑的是运维自己配好的那条命令（`TRPG_TUI__UPDATE_COMMAND`，比如 `git pull && uv sync`），绝不执行客户端递过来的东西，且需要 `welcome` 中通告的 `"update"` 特性。成功后服务端会 re-exec 到新代码，客户端应预期短暂断连后重连：
  `{type:"admin_update_server"}`
- `admin_list_skills` — 列出所有可发现的 KP 技能（Layer B.1），并按调用者自己的房间标记 `enabled`。可选 `locale`（`"en"`/`"zh"`，增量字段）请求按客户端自身界面语言返回技能显示名/描述（技能需带 `name-zh`/`description-zh` frontmatter），与服务端语言无关；缺省时按服务端语言返回：
  `{type:"admin_list_skills", locale?:string}`
- `admin_enable_skill` — 为调用者房间启用/停用一个技能；回复一份新的 `admin_skills`（同样支持可选 `locale`）：
  `{type:"admin_enable_skill", id:string, on:boolean, locale?:string}`
- `admin_list_rules` — 列出所有可发现的规则系统（Layer A）：
  `{type:"admin_list_rules"}`
- `admin_generate` — 通过对应的 `agent.forge` 自扩展引擎，从自然语言描述创作并安装全新的技能/规则系统/模组（Layer B.3）；`kind:"module"` 的生成会安装进调用者自己的房间。这是一次较慢的 LLM 调用，按普通请求/应答处理——客户端在等待 `admin_generated` 期间显示加载动画：
  `{type:"admin_generate", kind:"skill"|"rule"|"module", description:string}`

服务器 → 客户端：

- `admin_config` — 实时、显示安全的 LLM 配置（api_key 已遮蔽）加上提供商目录、已有保存凭据的 provider（`saved_providers`）、运行时覆盖是否活跃，以及显示安全的图像生成状态：
  `{type:"admin_config", provider:string, chat_model:string, base_url:string, api_key_masked:string, providers:string[], saved_providers:string[], override_active:boolean, imagegen?:ImageGenStatus, using_demo?:boolean, subscription_status?:""|"logged_in"|"logged_out"}`
  `using_demo` 表示现在是不是还由离线示例守秘人在应答，让客户端在热切到真模型之后立刻撤掉过期的入口。`true` 本身不授权载入；只有按房间计算的 `welcome.features` 才能添加入口。
  当前提供方实际走 ChatGPT / SuperGrok OAuth 时，`subscription_status` 为 `"logged_in"` 或 `"logged_out"`；空值或缺省表示经典 API-key 路径，包括显式配置代理 `base_url` 的 `chatgpt` / `gpt-subscription`。登录仍用私密聊天命令（`.model login`）；TUI 模型页只展示状态。
- `admin_models` — 某 provider 的实时模型列表：
  `{type:"admin_models", provider:string, models:string[], imagegen?:ImageGenStatus}`
- `ImageGenStatus` — `{provider:string, base_url:string, model:string, size:string, api_key_masked:string, has_key:boolean, configured:boolean, saved_providers?:string[]}`。API key 永不以明文返回。
- `admin_keys` — 仅含调用者自己房间的 key 名单；每个条目的 key 值被遮蔽。`mint` 请求会额外在 `minted` 里把新密钥明文返回一次，供守秘人复制：
  `{type:"admin_keys", keys:[{id:string, key_masked:string, room:string, name:string, role:"player"|"keeper"}], minted?:{key:string, room:string, name:string, role:"player"|"keeper"}}`
- `admin_room_op` — 导出/导入/完全删除房间操作的结果：
  `{type:"admin_room_op", action:"export"|"import"|"delete"|"reset", room:string, path?:string, keys:number, store_rows:number, vector_points:number, media_files?:number, scope?:"story"|"chars"|"all"}`
  （`scope` 只在 `reset` 时出现，回显这次用的清除范围。）
- `admin_update` — `admin_update_server` 的回复。`"restarting"`：命令成功、服务端正在 re-exec；`"failed"`：命令以非零码退出，`output` 为其合并 stdout/stderr 的末尾。（未配置命令时返回 `admin_error{code:"not_configured"}`。）
  `{type:"admin_update", status:"restarting"|"failed", output?:string}`
- `admin_skills` — 所有可发现技能，`enabled` 反映调用者房间的启用状态（`name`/`description` 已按请求的 `locale` 本地化）：
  `{type:"admin_skills", skills:[{id:string, name:string, description:string, content_rating:string, enabled:boolean}]}`
- `admin_rules` — 所有可发现的规则系统，`built_in` 区分内置系统（`coc7`/`dnd5e`）与生成/用户安装的系统：
  `{type:"admin_rules", systems:[{id:string, built_in:boolean}]}`
- `admin_generated` — 锻造引擎的结果；`ok` 为 `false` 时 `id`/`name` 为空、`error` 携带（未翻译的）诊断信息，且没有任何东西被安装。`detail` 携带按房间的安装结果——对 `kind:"module"` 它是模组是否真正落进房间的唯一信号（`ok` 只表示成功创作并写出了合法文档）；对 `skill`/`rule` 为空（无按房间安装步骤）：
  `{type:"admin_generated", kind:"skill"|"rule"|"module", ok:boolean, id:string, name:string, error:string, detail:string}`
- `admin_error` — 本地化的故障通知（不关闭连接）：
  `{type:"admin_error", code:"forbidden"|"unknown_provider"|"bad_request"|"set_failed"|"not_found"|"op_failed"|"not_configured"|"last_keeper", message?:string}`

`admin_set_model` 根据已知 provider 验证 `provider`（`infra.providers.is_known_provider`），通过 `services.runtime_config` 持久化覆盖，并热重配置共享的 `MutableLLM`——与 `.model set` 聊天命令走同一路径——然后回复新的 `admin_config`。API key / `base_url` 按 provider 成对保存在本地凭据簿；只有 endpoint 未变时才会复用。新 endpoint 必须在同一请求提供匹配 key，否则使用并持久化空 key。订阅 OAuth grant 也保存在同一凭据簿的规范 provider 名下。

提供商目录是递增的。`chatgpt` / `gpt-subscription` 有两种模式：没有 `base_url` 时使用 `.model login chatgpt` 获取的 ChatGPT 订阅 OAuth grant；显式设置 `base_url` 时仍走经典 OpenAI-compatible 代理及其 API key。`supergrok` 始终使用 SuperGrok 订阅 OAuth（`.model login supergrok`），且该 grant 可与 SuperGrok 生图共享。

房间备份快照包含房间的原始访问密钥以及战役状态和向量点。将导出的 JSON 视为 `keys.toml` 或 SQLite 数据库：这是敏感的服务器端数据，不应公开共享。

## NPC 帧（v1 新增）

这一组帧是给 AI 驱动、知识受限的 NPC 子角色用的（`agent/npc.py`、`agent/npc_actor.py`、`agent/kp_tools_npc.py`）。守秘人自己的叙述之前，服务端会把每一次 `speak_as_npc` 的结果单独发成一帧 `narrative{speaker:"npc", name:<npc>, format:"markdown"}`。不认识这个 speaker 值的客户端，把它当普通叙事行渲染就行。
