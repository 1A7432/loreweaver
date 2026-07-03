*[English](protocol.md) · 中文*

# loreweaver networked TUI — WebSocket protocol v1

这是 loreweaver 服务器（通过 `python -m app --serve` 启动的 `net.tui_server.TuiServer`）与任何客户端之间的开放、版本化的网络协议——可以是随附的 OpenTUI 终端客户端，或社区构建的 React/Vue/Web 客户端。引擎本身（确定性核心 + AI Keeper）不受传输方式的影响；此文档是与语言无关的接口定义。

传输方式：WebSocket，JSON 文本帧，每帧一个 JSON 对象，每帧格式为 `{"type": ...}`。端点：`ws://host:port/`。协议版本：`"1.1"`。

版本控制是递增式的：`"1.1"` 仅ADDS Keeper 门控的 `admin_*` 帧（见下文"Admin frames"部分）。只理解 `"1"` 的客户端保持正常工作——它永远不会发送 `admin_*` 帧，应该将 `welcome` 的 `protocol` 字段视为不透明字符串（接受任何 `"1.x"`）。

客户端发送的第一帧MUST是 `join`。服务器回复 `welcome` 或 `error`，错误时关闭连接。如果在服务器的 join 握手超时内未到达（`TRPG_TUI__JOIN_TIMEOUT`，默认 10 秒），服务器将用 `error join_timeout` 关闭连接，而不是无限等待。超过服务器并发连接上限（`TRPG_TUI__MAX_CONNECTIONS`）的连接在读取 `join` 之前被拒绝：`error too_many_connections`，然后关闭。

## Client → Server

- `join` — 认证并将连接绑定到房间：
  `{type:"join", key:string, name?:string, client?:{name,version}}`
- `input` — 命令行或玩家言辞，正是玩家键入的内容：
  `{type:"input", text:string}`
- `ping`: `{type:"ping", t:number}`

## Server → Client

- `welcome` — 成功 `join` 时发送一次：
  `{type:"welcome", protocol:"1.1", room:string, you:{id:string,name:string,role:"player"|"keeper"}, locale:string, server:string}`
- `error` — 本地化的故障通知；`bad_key`、`join_timeout` 和 `too_many_connections` 关闭连接（它们仅在 `join` 握手期间或之前发生），其他不关闭：
  `{type:"error", code:"bad_key"|"bad_frame"|"rate_limited"|"server_error"|"join_timeout"|"too_many_connections", message:string}`
- `narrative` — 一行故事/聊天文本：
  `{type:"narrative", id:string, speaker:"kp"|"player"|"system"|"npc", name?:string, text:string, format:"markdown"|"plain", stream?:boolean, done?:boolean}`
  对于 `speaker:"npc"`，`name` 携带 NPC 名称。
  流式传输是多个帧共享同一 `id` 且 `stream:true`，以 `done:true` 的帧终止；非流式回复只是单个帧，两个字段都未设置。
- `dice` — 一次掷骰子/检定，由客户端渲染并按 `rank` 着色（`-2`..`+4`）；NEVER 携带 Keeper 秘密：
  `{type:"dice", actor:string, kind:"roll"|"check"|"sanity"|"opposed"|"init", expr:string, rolls:number[], total:number, target?:number, rank?:int, level?:string, success?:boolean}`
- `state` — 一个面板快照，在 `join` 时和每回合后发送：
  `{type:"state", character?:{name,system,hp,hpmax,mp,mpmax,san,sanmax,attributes:{},status_effects:[]}, party:[{name,online:boolean,active:boolean,initiative?:int,hp?:int,hpMax?:int,san?:int,sanMax?:int,mp?:int,mpMax?:int,ai?:boolean}], scene?:{name,focus?}, clock?:{time,round?}, initiative:[{name,value:int,current:boolean}], online:int}`
- `presence` — 连接的玩家名单，在加入/离开时发送：
  `{type:"presence", players:[{id,name,online}], online:int}`
- `system` — 带外通知：`{type:"system", level:"info"|"warn", text:string}`
- `pong`: `{type:"pong", t:number}`

## Turn flow

当房间 `R` 中的客户端发送 `input` 帧时，服务器：

1. 从房间的 `SessionSource` 构建一个 `AgentCtx`（`chat_key = "tui:group:{room}"`，`user_id` = 客户端的密钥派生 id，`locale`）。
2. 前置层：`RateLimiter.allow(user)` + `allow(room)`；如果被阻止，仅向该客户端发送 `error rate_limited`（回合在此停止）。
3. 向整个房间广播 `narrative{speaker:"player", name, text}`（每个人都看到该操作，包括发送者）。
4. 如果 `CommandRouter.dispatch(ctx, text)` 返回非 `None`，该字符串是回复（一个 `.`/`/` 命令或 SealDice 风格的内联掷骰子）。
   否则，`run_kp_turn(ctx, services, toolset, text, output_review=censor)` 驱动 AI Keeper 并返回一个 `KPTurnResult`。
5. 对于每个 `tool_trace` 条目，如果是掷骰子/检定工具（`roll_dice`、`skill_check`、`sanity_check`、`opposed_check`、`initiative_tracker`），从其结果中解析并广播一个 `dice` 帧。
6. 对于每个名为 `speak_as_npc` 的 `tool_trace` 条目，在最终 KP 回复之前广播 `narrative{speaker:"npc", name, text, format:"markdown"}`。`name` 是工具调用的 `npc` 参数，`text` 是玩家安全的工具结果。
7. 将回复广播为 `narrative{text: reply}` — 命令回复为 `speaker:"system"`，AI Keeper 回复为 `speaker:"kp", format:"markdown"`。回复已被审查；Keeper 专用工具输出永远不会到达此帧（循环保证——见 `agent/loop.py`）。
8. 重新构建并广播一个 `state` 帧（`net.state.build_room_state`）。

密钥映射到同一房间的多个客户端共享一个 AI-KP 会话；上述每个描述为"广播"的帧都发送给当前连接到该房间的每个成员。

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

部署者/Keeper 可以通过浏览器（Web 客户端的管理面板，用 `?admin=1` 打开）使用**Keeper 角色密钥**在SAME连接上管理服务器：在 `join` 时戳在连接上的密钥库角色是管理员门控——没有单独的认证。服务器仅对 `keeper` 连接回答这些；任何其他连接获得 `admin_error{code:"forbidden"}` 且没有读取或变异。在 `net/admin.py` 中实现。

客户端 → 服务器：

- `admin_get_config` — `{type:"admin_get_config"}`
- `admin_set_model` — 切换实时 LLM 提供商/模型：
  `{type:"admin_set_model", provider:string, chat_model?:string}`
- `admin_list_keys` — `{type:"admin_list_keys"}`
- `admin_mint_key` — 创建房间访问密钥：
  `{type:"admin_mint_key", room:string, name?:string, role?:"player"|"keeper"}`
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

服务器 → 客户端：

- `admin_config` — 实时、显示安全的 LLM 配置（api_key 已遮蔽）加上提供商目录以及运行时覆盖是否活跃：
  `{type:"admin_config", provider:string, chat_model:string, base_url:string, api_key_masked:string, providers:string[], override_active:boolean}`
- `admin_keys` — 房间密钥名单；每个条目的密钥值被遮蔽。一个 `mint` 请求额外在 `minted` 下返回新创建的密钥一次明文（以便 Keeper 可以复制）：
  `{type:"admin_keys", keys:[{id:string, key_masked:string, room:string, name:string, role:"player"|"keeper"}], minted?:{key:string, room:string, name:string, role:"player"|"keeper"}}`
- `admin_room_op` — 导出/导入/完全删除房间操作的结果：
  `{type:"admin_room_op", action:"export"|"import"|"delete", room:string, path?:string, keys:number, store_rows:number, vector_points:number}`
- `admin_error` — 本地化的故障通知（不关闭连接）：
  `{type:"admin_error", code:"forbidden"|"unknown_provider"|"bad_request"|"set_failed"|"not_found"|"op_failed", message?:string}`

`admin_set_model` 根据已知提供商验证 `provider`（`infra.providers.is_known_provider`），通过 `services.runtime_config` 持久化覆盖，并热重新配置共享的 `MutableLLM` —— 与 `.model set` 聊天命令相同的路径—— 然后回复一个新鲜的 `admin_config`。在此创建的密钥被写回服务器的密钥文件，因此它在重启后仍然存在。

提供商目录是递增的。`chatgpt` / `gpt-subscription` 仅作为 OpenAI 兼容代理别名被接受；它们需要 `TRPG_LLM__BASE_URL` 指向由部署控制的网关。它们不代表直接 ChatGPT Web 订阅登录/会话访问。

房间备份快照包含房间的原始访问密钥以及战役状态和向量点。将导出的 JSON 视为 `keys.toml` 或 SQLite 数据库：这是敏感的服务器端数据，不应公开共享。

## Additive v1 NPC frames

这添加了 AI 驱动、知识作用域的 NPC 子角色（`agent/npc.py`、`agent/npc_actor.py`、`agent/kp_tools_npc.py`）。服务器在 KP 自己的叙述之前将每个 `speak_as_npc` 工具结果表面化为额外的 `narrative{speaker:"npc", name:<npc>, format:"markdown"}` 帧。这是 v1 兼容和递增的：现有的 `speaker:"kp"|"player"|"system"` 帧和忽略未知说话者值的客户端不受影响。
