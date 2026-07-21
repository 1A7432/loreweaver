*[English](protocol.md) · 中文*

# loreweaver networked TUI — wire protocol v1

这是 loreweaver 服务器（通过 `python -m app --serve` 启动）与 OpenTUI 终端客户端之间开放、版本化的 wire protocol。引擎本身（确定性核心 + AI Keeper）不受传输方式影响；传输中立的会话逻辑位于 `net.session.SessionCore`，本文档是与语言无关的接口定义。

控制流使用 `{"type": ...}` 形状的 JSON 帧，协议版本为 `"1.5"`。同一套帧与 `join` 握手可搭载于两种 carrier：

- **Iroh** 是 `--serve` 实际启动的默认传输：点对点 QUIC，服务端打印可分享 ticket，不需要域名、证书或端口转发。控制帧是在长连接双向流上的 newline-delimited JSON；媒体字节使用同一连接上的额外双向流。
- **WebSocket**（`net.tui_server`）只保留作离线测试/loopback carrier，不是 `--serve` 选项。控制帧是文本消息，媒体字节是二进制消息。

两种 carrier 都驱动同一个 `SessionCore` / `RoomHub`。

版本控制是递增式的：`"1.5"` 新增房间级 AI-KP 回合状态；`"1.4"` 新增图像生成配置与头像绑定；`"1.3"` 新增房间音频库/播放控制帧；`"1.2"` 新增媒体元数据帧和字节通道；`"1.1"` 新增 Keeper 门控的 `admin_*` 帧（见下文"Admin frames"部分）。只理解 `"1"` 的客户端保持正常工作——它永远不会发送新帧、会忽略无法识别的服务端帧类型，并应将 `welcome` 的 `protocol` 字段视为不透明字符串（接受任何 `"1.x"`）。

客户端发送的第一帧 MUST 是 `join`。服务器回复 `welcome` 或 `error`，错误时关闭连接。如果在 join 握手超时内未到达（`TRPG_TUI__JOIN_TIMEOUT`，默认 10 秒），服务器将用 `error join_timeout` 关闭连接，而不是无限等待。离线 WebSocket 测试 carrier 另外支持 `TRPG_TUI__MAX_CONNECTIONS` 并发上限；超额测试连接会在读取 `join` 前收到 `error too_many_connections`。

## Client → Server

- `join` — 认证并将连接绑定到房间：
  `{type:"join", key:string, name?:string, client?:{name,version}}`
- `input` — 命令行或玩家言辞，正是玩家键入的内容：
  `{type:"input", text:string}`
- `media_offer` — 打开字节通道前先提交图片/音频元数据：
  `{type:"media_offer", name:string, mime:string, size:int, sha256:string}`
- `media_set_enabled` — Keeper 专用的房间媒体上传开关：
  `{type:"media_set_enabled", enabled:boolean}`
- `avatar_set` — 将本房间已经上传的一张图片绑定到调用者自己的当前角色头像。服务端会拒绝试图指定其他角色/用户的帧：
  `{type:"avatar_set", hash:string}`
- `ping`: `{type:"ping", t:number}`

## Server → Client

- `welcome` — 成功 `join` 时发送一次：
  `{type:"welcome", protocol:"1.5", features:["media","audio","imagegen"?,"demo"?], room:string, you:{id:string,name:string,role:"player"|"keeper"}, locale:string, server:string}`
  `demo` 表示服务端正在使用离线示例 Keeper、向量功能已启用，且本次检查时这个守秘人房间为空。服务端会在房间回合锁内再次检查，过期 flag 不会覆盖战役状态；客户端收到 `admin_config{using_demo:false}`（例如从模型页保存后）会立即移除入口，否则重连时重新计算，过期操作也会被服务端拒绝。
- `error` — 本地化的故障通知；`bad_key`、`join_timeout` 和 `too_many_connections` 关闭连接（它们仅在 `join` 握手期间或之前发生），其他不关闭：
  `{type:"error", code:"bad_key"|"bad_frame"|"input_too_long"|"rate_limited"|"server_error"|"join_timeout"|"too_many_connections"|"demo_unavailable"|媒体错误码, message:string}`
- `media_accept` — 上传被接受；若 `existing` 为 true，则无需 PUT：
  `{type:"media_accept", upload_id:string, existing?:boolean, media?:MediaFrame, audio?:AudioLibraryItem}`
- `media` — 媒体元数据广播和历史回放条目；字节按需拉取：
  `{type:"media", id:string, hash:string, mime:string, size:int, name:string, from:string, ts:number}`
- `media_enabled` — Keeper 切换上传开关后的回复：
  `{type:"media_enabled", enabled:boolean}`
- `audio_library_item` — 由上传音频 blob 生成的房间音频库条目：
  `{type:"audio_library_item", id:string, hash:string, mime:string, size:int, name:string, from:string, ts:number, title?:string, license?:string, source?:string, tags?:string[]}`
- `audio_control` — 客户端本地播放意图：
  `{type:"audio_control", id:string, action:"play"|"stop"|"pause"|"resume"|"volume", layer:"bgm"|"ambience"|"sfx", hash?:string, mime?:string, name?:string, title?:string, loop?:boolean, volume?:number, fade_ms?:int, position_ms?:int, server_ts?:number}`
- `audio_state` — 尽力持久化的 BGM/环境音状态，在加入房间时回放：
  `{type:"audio_state", layers:[{layer:"bgm"|"ambience"|"sfx", hash?:string, mime?:string, name?:string, title?:string, playing:boolean, volume?:number, loop?:boolean, started_at?:number}]}`
- `narrative` — 一行故事/聊天文本：
  `{type:"narrative", id:string, speaker:"kp"|"player"|"system"|"npc", name?:string, text:string, format:"markdown"|"plain", stream?:boolean, done?:boolean}`
  对于 `speaker:"npc"`，`name` 携带 NPC 名称。
  流式传输是多个帧共享同一 `id` 且 `stream:true`，以 `done:true` 的帧终止；非流式回复只是单个帧，两个字段都未设置。
- `dice` — 一次掷骰子/检定，由客户端渲染并按 `rank` 着色（`-2`..`+4`）；NEVER 携带 Keeper 秘密：
  `{type:"dice", actor:string, kind:"roll"|"check"|"sanity"|"opposed"|"init", expr:string, rolls:number[], total:number, target?:number, rank?:int, level?:string, success?:boolean}`
- `state` — 一个面板快照，在 `join` 时和每回合后发送：
  `{type:"state", character?:{name,system,hp,hpmax,mp,mpmax,san,sanmax,attributes:{},status_effects:[],avatar?:{hash,mime,size,name?}}, party:[{name,online:boolean,active:boolean,initiative?:int,hp?:int,hpMax?:int,san?:int,sanMax?:int,mp?:int,mpMax?:int,ai?:boolean,avatar?:{hash,mime,size,name?}}], scene?:{name,focus?}, clock?:{time,round?}, initiative:[{name,value:int,current:boolean}], online:int, reset?:boolean}`
  `reset:true` 标记战役清空(`.reset` / `admin_reset_room`)后服务端推送的快照：面板数据已是最新(空)，客户端还应清空本地累积的聊天记录。
- `presence` — 连接的玩家名单，在加入/离开时发送：
  `{type:"presence", players:[{id,name,online}], online:int}`
- `system` — 带外通知：`{type:"system", level:"info"|"warn", text:string}`
- `turn_status` — 临时的房间级 AI-KP 活动状态。`busy` 携带正在结算其行动的 actor，`idle` 清除状态。客户端应显示动画忙碌指示，并设置安全超时以防结束帧丢失：
  `{type:"turn_status", status:"busy", actor:string}` 或 `{type:"turn_status", status:"idle"}`
- `pong`: `{type:"pong", t:number}`

## Turn flow

当房间 `R` 中的客户端发送 `input` 帧时，服务器：

1. 从房间的 `SessionSource` 构建一个 `AgentCtx`（`chat_key = "tui:group:{room}"`，`user_id` = 客户端的密钥派生 id，`locale`）。
2. 前置层：`RateLimiter.allow(user)` + `allow(room)`；如果被阻止，仅向该客户端发送 `error rate_limited`（回合在此停止）。
3. 向整个房间广播 `narrative{speaker:"player", name, text}`（每个人都看到该操作，包括发送者）。
4. 如果 `CommandRouter.dispatch(ctx, text)` 返回非 `None`，该字符串是回复（一个 `.`/`/` 命令或 SealDice 风格的内联掷骰子）。
   否则，服务器先广播 `turn_status{status:"busy", actor:name}`，再由 `run_kp_turn(ctx, services, toolset, text, output_review=censor)` 驱动 AI Keeper 并返回一个 `KPTurnResult`。
5. 对于每个 `tool_trace` 条目，如果是掷骰子/检定工具（`roll_dice`、`skill_check`、`sanity_check`、`opposed_check`、`initiative_tracker`），从其结果中解析并广播一个 `dice` 帧。
6. 对于每个名为 `speak_as_npc` 的 `tool_trace` 条目，在最终 KP 回复之前广播 `narrative{speaker:"npc", name, text, format:"markdown"}`。`name` 是工具调用的 `npc` 参数，`text` 是玩家安全的工具结果。
7. 将回复广播为 `narrative{text: reply}`——命令回复为 `speaker:"system"`，AI Keeper 回复为 `speaker:"kp", format:"markdown"`。回复已通过所配置的输出词表；守秘人专用工具的原始结果不会被代码直接复制到此帧，但主 Keeper 模型看过这些结果，仍可能自行复述，因此另由真实模型红线评测测量这种行为风险。
8. AI-KP 分支结束时（包括错误清理）广播 `turn_status{status:"idle"}`；命令回复不发送回合状态。
9. 重新构建并广播一个 `state` 帧（`net.state.build_room_state`）。

密钥映射到同一房间的多个客户端共享一个 AI-KP 会话；上述每个描述为"广播"的帧都发送给当前连接到该房间的每个成员。

## Media transfer（v1.2+）与音频（v1.3）

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

MediaChannel 线格式：

- Iroh：在同一连接上打开新的双向流。流以一行 JSON header 开头（`\n` 结尾）。PUT 时客户端随后按不超过 64 KiB 的块写入原始字节，服务端存好后回一行 `{op:"put_ok", hash}`（拒收则回一行 `{type:"error", code, message}`）；GET 时服务端先写一行 `{op:"get",hash,size,mime,name}` 响应 header，再按不超过 64 KiB 的块写入原始字节，出错则只回一行 `{type:"error", ...}`、无字节体。
- WebSocket：一条二进制消息为 `uint32_be header_length` + UTF-8 JSON header + 原始字节。PUT 发送 `{op:"put", upload_id}` 加 body，成功以房间广播的 `media` / `audio_library_item` 帧为准，拒收则以标准 `error` 文本帧返回。GET 发送 `{op:"get", hash}` 且无 body；服务端回复 `{op:"get",hash,size,mime,name}` 加 body。

音频控制与字节传输是分离的。上传音频文件只会创建或更新房间音频库。Keeper/管理员命令如 `.bgm play <音频>`、`.ambience stop`、`.sfx <音频>` 会广播 `audio_control` 帧；TUI 客户端用同一套 GET 流程拉取字节并在本机播放。服务端自身不播放音频。

## Auth / keystore

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

## Admin frames (v1.1, keeper-gated)

部署者/Keeper 可以通过终端客户端的守秘人页面，在同一连接上用 **Keeper 角色 key** 管理服务器。`join` 时绑定到连接的 keystore role 就是管理员门控，没有第二套认证。服务器只对 `keeper` 连接回答这些帧；其他连接得到 `admin_error{code:"forbidden"}`，且不会读取或修改数据。实现在 `net/admin.py`。

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
- `admin_update_key` — 按稳定的非秘密 id 更新一个密钥：
  `{type:"admin_update_key", id:string, room?:string, name?:string, role?:"player"|"keeper"}`
- `admin_delete_key` — 按 id 删除一个密钥：
  `{type:"admin_delete_key", id:string}`
- `admin_delete_room` — 删除绑定到房间的每个访问密钥；房间数据保持不变：
  `{type:"admin_delete_room", room:string}`
- `admin_export_room` — 在服务器上写一个房间备份 JSON 文件。如果省略 `path`，服务器在 `<data_dir>/room_backups/` 下写入：
  `{type:"admin_export_room", room:string, path?:string}`
- `admin_import_room` — 恢复服务器端备份 JSON。如果提供了 `room`，快照在恢复前被重映射到该房间：
  `{type:"admin_import_room", path:string, room?:string}`
- `admin_delete_room_data` — 删除房间的访问密钥、房间作用域 KV 状态、文档向量和世界书向量。`backup` 默认为 `true`；启用备份时，删除仅在备份写入成功后进行：
  `{type:"admin_delete_room_data", room:string, backup?:boolean, path?:string}`
- `admin_reset_room` — 原地重开战役，保留密钥库钥匙、频道/守秘人绑定、在线连接与房间设置(语言、房规、启用技能)，让本桌无需重新配置即可重开。不做备份，也不驱逐任何成员(与 `admin_delete_room_data` 相反)。`scope` 决定清除范围：`"story"`(默认)只清剧情/进度(保留角色、模组、设定、媒体)；`"chars"` 连角色一起换(保留模组)；`"all"` 全部清空(角色、模组、设定、媒体)。仅守秘人可用，且限于调用者自己的房间：
  `{type:"admin_reset_room", room:string, scope?:"story"|"chars"|"all"}`

服务器 → 客户端：

- `admin_config` — 实时、显示安全的 LLM 配置（api_key 已遮蔽）加上提供商目录、已有保存凭据的 provider（`saved_providers`）、运行时覆盖是否活跃，以及显示安全的图像生成状态：
  `{type:"admin_config", provider:string, chat_model:string, base_url:string, api_key_masked:string, providers:string[], saved_providers:string[], override_active:boolean, imagegen?:ImageGenStatus, using_demo?:boolean, subscription_status?:""|"logged_in"|"logged_out"}`
  `using_demo` 跟踪当前是否仍由离线示例 Keeper 应答，使客户端能在热切到真实模型后立即移除过期入口。`true` 本身不授权载入；只有按房间计算的 `welcome.features` 才能添加入口。
  当前提供方实际走 ChatGPT / SuperGrok OAuth 时，`subscription_status` 为 `"logged_in"` 或 `"logged_out"`；空值或缺省表示经典 API-key 路径，包括显式配置代理 `base_url` 的 `chatgpt` / `gpt-subscription`。登录仍用私密聊天命令（`.model login`）；TUI 模型页只展示状态。
- `admin_models` — 某 provider 的实时模型列表：
  `{type:"admin_models", provider:string, models:string[], imagegen?:ImageGenStatus}`
- `ImageGenStatus` — `{provider:string, base_url:string, model:string, size:string, api_key_masked:string, has_key:boolean, configured:boolean, saved_providers?:string[]}`。API key 永不以明文返回。
- `admin_keys` — 仅含调用者自己房间的 key 名单；每个条目的 key 值被遮蔽。一个 `mint` 请求额外在 `minted` 下返回新 key 一次明文（供 Keeper 复制）：
  `{type:"admin_keys", keys:[{id:string, key_masked:string, room:string, name:string, role:"player"|"keeper"}], minted?:{key:string, room:string, name:string, role:"player"|"keeper"}}`
- `admin_room_op` — 导出/导入/完全删除房间操作的结果：
  `{type:"admin_room_op", action:"export"|"import"|"delete"|"reset", room:string, path?:string, keys:number, store_rows:number, vector_points:number, media_files?:number, scope?:"story"|"chars"|"all"}`
  (`scope` 在 `reset` 操作时出现，回显所应用的重置范围。)
- `admin_error` — 本地化的故障通知（不关闭连接）：
  `{type:"admin_error", code:"forbidden"|"unknown_provider"|"bad_request"|"set_failed"|"not_found"|"op_failed", message?:string}`

`admin_set_model` 根据已知 provider 验证 `provider`（`infra.providers.is_known_provider`），通过 `services.runtime_config` 持久化覆盖，并热重配置共享的 `MutableLLM`——与 `.model set` 聊天命令走同一路径——然后回复新的 `admin_config`。API key / `base_url` 按 provider 成对保存在本地凭据簿；只有 endpoint 未变时才会复用。新 endpoint 必须在同一请求提供匹配 key，否则使用并持久化空 key。订阅 OAuth grant 也保存在同一凭据簿的规范 provider 名下。

提供商目录是递增的。`chatgpt` / `gpt-subscription` 有两种模式：没有 `base_url` 时使用 `.model login chatgpt` 获取的 ChatGPT 订阅 OAuth grant；显式设置 `base_url` 时仍走经典 OpenAI-compatible 代理及其 API key。`supergrok` 始终使用 SuperGrok 订阅 OAuth（`.model login supergrok`），且该 grant 可与 SuperGrok 生图共享。

房间备份快照包含房间的原始访问密钥以及战役状态和向量点。将导出的 JSON 视为 `keys.toml` 或 SQLite 数据库：这是敏感的服务器端数据，不应公开共享。

## Additive v1 NPC frames

这添加了 AI 驱动、知识作用域的 NPC 子角色（`agent/npc.py`、`agent/npc_actor.py`、`agent/kp_tools_npc.py`）。服务器在 KP 自己的叙述之前将每个 `speak_as_npc` 工具结果表面化为额外的 `narrative{speaker:"npc", name:<npc>, format:"markdown"}` 帧。这是 v1 兼容和递增的：现有的 `speaker:"kp"|"player"|"system"` 帧和忽略未知说话者值的客户端不受影响。
