*[English](protocol.md) · 中文*

# Loreweaver 协议 3.0

这份文档是 Loreweaver 服务器与客户端之间开放、带版本的协议：客户端发什么，服务器回什么，按什么顺序。照着它就能写出一个客户端，不必去读服务器代码。协议版本：`"3.0"`。

以代码为准。所有客户端共用的帧类型、载荷形状和上限都在 `loreweaver-protocol` 包里，入口是 `loreweaver-protocol/v3`（`clients/protocol/src/v3/`）：`frames.ts`（帧、事件与信号的载荷、上限），`views.ts`（内置视图及其 JSON Schema），`bytes.ts`（字节通道），`decode.ts`（客户端接受什么、丢弃什么），`client.ts`（不做 I/O 的参考客户端会话）。这份文档和那个包说法不一致时，以包为准，是文档有错。

**3.0 是一个新协议。** 它和 2.x 不兼容：协议本身、房间数据库、扩展包和模组格式都不兼容。传输层的 ALPN 带着协议主版本号（`loreweaver/3`），所以 2.x 客户端会直接连不上，而不是误读帧。

## 目录

1. [概念](#1-概念)
2. [传输](#2-传输)
3. [帧](#3-帧)
4. [连接](#4-连接)
5. [请求与结果](#5-请求与结果)
6. [命令](#6-命令)
7. [事件日志](#7-事件日志)
8. [事件类型](#8-事件类型)
9. [信号](#9-信号)
10. [视图](#10-视图)
11. [字节通道](#11-字节通道)
12. [客户端守则](#12-客户端守则)
13. [会话示例](#13-会话示例)
14. [3.0 还没有的](#14-30-还没有的)

---

## 1. 概念

Loreweaver 让 AI 担任游戏主持人，带一桌人跑桌面角色扮演。协议只有四个概念：**事件日志**（桌上发生了什么，编号并存储）、**调用**（客户端要什么，每个调用回答一次）、**视图**（服务器为某个客户端持续更新的结构化值）和**字节通道**（文件，在控制流旁边传输）。

| 术语 | 含义 |
|---|---|
| 房间 | 一桌：它的成员、它的故事、它的日志。每把钥匙恰好属于一个房间。 |
| 钥匙 | 一个秘密字符串，持有者凭它以一个身份进入一个房间。没有注册。 |
| 身份 | `player`、`admin` 或 `observer`，由钥匙决定。见 [4.4](#44-身份)。 |
| 守秘人 | AI 游戏主持人。它不是成员，也不持有钥匙。 |
| 管理员 | 持有管理员钥匙的人。管理员也玩；“管理员”从来不指 AI。 |
| 成员 | 房间里的一条连接。一个人开两条连接，就是两个成员，共用一个成员 id。 |
| 成员 id | 由钥匙派生的稳定 id（`m:` 加 12 位十六进制数字）。不会泄露钥匙。 |
| 事件 | 房间日志里的一条：有编号（`seq`）、会存储、按顺序发给每个成员。 |
| 信号 | 发给桌面的临时消息：不存储，不回放。 |
| 视图 | 为某一个查看者计算的具名结构化值，变化时推送。 |
| 命令 | 人执行的唯一一种操作：引擎命令、规则包命令和模组命令都是命令。 |
| 回合 | 守秘人对一句发言的回答。回合按房间编号。 |
| `epoch` | 房间的代次。日志被改写时（撤销、重置、导入）它会前进。 |
| `seq` | 事件在所属房间日志里的编号。在一个房间里永不复用，撤销之后也不复用。 |
| `head` | 房间已经发出的最大 `seq`（从未记过日志的房间为 0）。 |
| `rid` | 客户端自选的请求 id；服务器对该请求的那一个 `result` 带着它。 |

## 2. 传输

### 2.1 Iroh

服务器通过 [iroh](https://iroh.computer) 通信：点对点 QUIC，凭 **ticket**（连接凭据，一个 iroh endpoint ticket 字符串）拨号。不需要域名、TLS 证书或开放端口。

- **ALPN：**`loreweaver/3`。随协议主版本变化。
- **控制流**是客户端在连接上打开的第一个双向流，与连接同生共死。客户端打开后立刻在上面写 `hello`（QUIC 流在客户端发送数据之前，服务器是看不到的）。
- **之后客户端在同一连接上打开的每个双向流**都是字节通道的一次操作（[第 11 节](#11-字节通道)）。字节流从不阻塞控制流。

运营者用 `loreweaver serve` 启动服务器，它打印一个 JSON 对象，里面有 `ticket`（第一次使用某个数据目录时还有 `first_key`：房间 `main` 的一把管理员钥匙）。更多钥匙用 `loreweaver key <room> <admin|player|observer> <name>` 签发。客户端需要一个 ticket 和一把钥匙；除此之外没有任何东西标识服务器或人。

### 2.2 分帧

控制帧是按行分隔的 JSON：每行一个紧凑的 JSON 对象，UTF-8，以 `\n` 结尾。空行跳过。每一帧都是一个对象，带一个字符串 `type`。一行连同换行符最长 `MAX_LINE_BYTES` = **8 MiB**：对方发了更多却不结束这一行，那就不是在发帧——接收方停止缓冲并结束连接（服务器会先回 `line_too_long`）。一行装不下的东西走字节通道（[11](#11-字节通道)）。

不是合法 JSON 的行按读不懂的帧处理（`bad_frame`，[4.5](#45-连接级错误)）。

### 2.3 Ping

客户端随时可以发 `{"type":"ping","t":<number>}`，`hello` 之前也可以；服务器立刻回 `{"type":"pong","t":<same number>}`。只有客户端发 ping：服务器从不发 ping，也不要求客户端发。用它测往返时间，或发现断掉的链路。

## 3. 帧

共 11 种帧。

客户端发往服务器：

| `type` | 字段 | 用途 |
|---|---|---|
| `hello` | `protocol`、`key`、`name?`、`locale`、`client {name, version}`、`caps`、`resume? {epoch, after}` | 第一帧：认证并加入钥匙所属的房间。 |
| `input` | `rid`、`text` | 人打的一行字：发言，或文本命令。 |
| `call` | `rid`、`method`、`params` | 客户端要的其他一切。 |
| `ping` | `t` | 测往返时间。 |

服务器发往客户端：

| `type` | 字段 | 用途 |
|---|---|---|
| `welcome` | `protocol`、`server {name, version}`、`room {id, locale}`、`you {id, name, role}`、`features`、`epoch`、`head`、`first` | 对 `hello` 的回答。 |
| `event` | `seq`、`id`、`ts`、`kind`、`turn?`、`data` | 房间日志的一条，发给每个成员，按 `seq` 顺序。 |
| `signal` | `kind`、`data` | 临时：不记日志，不回放。 |
| `view` | `name`、`rev`、`at`、`data` | 这条连接订阅的某个视图的当前值。 |
| `result` | `rid`、`ok`，然后是 `data?` 和 `text?`（成功）或 `error {code, message}`（失败） | 对一个 `input` 或 `call` 的唯一回答，只发给调用者。 |
| `error` | `code`、`message`、`fatal` | 只用于连接级：没有可回答的 `rid`。 |
| `pong` | `t` | 对 `ping` 的回答。 |

`rid` 是 1 到 64 个字符的字符串，由客户端选定，在它尚未得到回答的请求之间唯一。客户端帧里的未知字段，服务器忽略。

## 4. 连接

### 4.1 `hello`

```json
{"type":"hello","protocol":"3.0","key":"rT9vQ2xLm8Kc3PzW0aYbN5sEdF7gHjU1","name":"Ada","locale":"en","client":{"name":"my-client","version":"0.1.0"},"caps":[]}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `protocol` | string | `"3.0"`。只比较主版本。 |
| `key` | string | 访问钥匙。 |
| `name` | string，可选 | 显示用的名字。会去掉首尾空白；为空或缺省时用钥匙自己的名字。最多 64 个码点。 |
| `locale` | string | 客户端的语言，如 `en`、`zh`、`zh-CN`。只取 `-` 或 `_` 之前的部分；服务器没有该语言的文本时回退到 `en`。发给这个成员的结果、错误和视图都用这种语言写。 |
| `client` | `{name, version}` | 客户端自己的名字和版本，都是字符串。 |
| `caps` | string[] | 客户端能做什么。3.0 服务器没有定义任何取值，会忽略这个列表；发 `[]`。 |
| `resume` | `{epoch, after}`，可选 | 房间代次和这个客户端持有的最后一个 `seq`。整数。见 [7.4](#74-续传与回放上限)。 |

服务器按以下顺序检查，遇到第一个不通过的就以**致命** `error` 拒绝（然后关闭连接）：

1. `protocol` 的主版本是 3，否则 `protocol_mismatch`（消息里写出双方的版本）；
2. 钥匙是已知的，否则 `bad_key`；
3. 去掉首尾空白后的 `name` 最多 64 个码点，否则 `bad_name`（拒绝，从不截断）。

语言在这些检查之前就从 `hello` 里取出，所以即使是这些拒绝，也用客户端的语言写。

### 4.2 先 `welcome`，再回放

成功时，服务器按以下顺序发送，中间不夹任何别的东西：

1. `welcome`；
2. 回放：客户端应得的事件（[7.4](#74-续传与回放上限)），按 `seq` 顺序；
3. 此后是实时流量。

```json
{"type":"welcome","protocol":"3.0","server":{"name":"loreweaver","version":"3.0.0-alpha.0"},"room":{"id":"main","locale":"en"},"you":{"id":"m:15b5f3445045","name":"Ada","role":"player"},"features":[],"epoch":1,"head":2,"first":1}
```

| 字段 | 含义 |
|---|---|
| `protocol` | 服务器的版本。主版本不同时，客户端拒绝。 |
| `server` | 服务器的名字和版本。 |
| `room.id` | 钥匙所属的房间。 |
| `room.locale` | 房间的语言：事件和信号用它写。 |
| `you` | 你的成员 id、你显示的名字和你的身份。 |
| `features` | 服务器在协议之外提供什么。3.0 服务器发 `[]`。 |
| `epoch` | 房间当前的代次。 |
| `head` | 房间已经发出的最大 `seq`。 |
| `first` | 房间仍保存的**最早**事件的 `seq`（日志为空时为 0）。`head` 从不后退——重置之后不退，撤销之后也不退——所以它说明不了还有多少历史；`first` 能说明。 |

回放和加入在服务器上是一个不被打断的步骤，所以不会有实时事件落在两条回放事件之间，也不会漏掉。回放只有事件，没有视图。如果此刻正有守秘人回合在运行，服务器在回放之后紧跟一个 `turn` 信号（`busy`，带 `actor`），让在回合中途连上的客户端知道；没有回合在运行就什么都不发，客户端从空闲状态开始。

### 4.3 `welcome` 之后

已加入的连接上再发 `hello`，回一个非致命的 `bad_frame`。在成功的 `hello` 之前发其他帧（`input`、`call`），连接以致命的 `hello_first` 结束。`ping` 随时都回答。

视图不会自动订阅：想要视图的客户端在 `welcome` 之后调用 `view.subscribe`，每次重连之后都要再调一次（[10.2](#102-订阅)）。

### 4.4 身份

| 身份 | 可以 |
|---|---|
| `player` | 发言，运行玩家命令，订阅视图，上传（上传开启时），获取房间媒体。 |
| `admin` | 玩家能做的一切，加上管理员命令和仅限管理员的参数，以及获取仅限管理员的文件。 |
| `observer` | 观看：接收事件、信号和视图，运行少数标明旁观者可用的命令（`help`、`recap`、不带 `reveal` 的 `report`、只列出的 `panels`、不带参数的 `uploads`、只列服务商的 `model`，即不带 `provider` 和 `lane` 的 `list`），获取房间媒体。旁观者的发言被拒绝（`observer_speech`），上传也被拒绝（`observer_upload`）。 |

身份属于钥匙，不能从连接上更改。房间管理员用 `key` 命令（[6.8](#68-引擎的命令)）更改一把钥匙的身份：持有者现有的连接随即结束，客户端重连后在 `welcome` 里带着新身份回来。“守秘人”从来不是一种身份：守秘人是 AI。持有管理员钥匙的人是房间管理员。

### 4.5 连接级错误

`error` 帧回答没有 `rid` 的东西。带 `fatal: true` 时，服务器发完就关闭连接；客户端不得用同样的设置重新拨号（参考客户端把会话标记为已结束）。

| 错误码 | 致命 | 何时 |
|---|---|---|
| `protocol_mismatch` | 是 | `hello.protocol` 的主版本不同。 |
| `bad_key` | 是 | 钥匙未知。 |
| `bad_name` | 是 | `hello.name` 超过 64 个码点。 |
| `hello_first` | 是 | 在成功的 `hello` 之前收到了 `input` 或 `call`。 |
| `hello_timeout` | 是 | 连接打开后 15 秒内没收到 `hello`（`HELLO_TIMEOUT_MS`）。 |
| `line_too_long` | 是 | 控制流里的一行超过了 `MAX_LINE_BYTES`（[2.2](#22-分帧)）。 |
| `bad_frame` | `welcome` 之前是，之后不是 | 读不懂的帧：不是 JSON、不是对象、没有字符串 `type`、未知的 `type`、缺必填字段、`input` 或 `call` 没有合法的 `rid`，或第二个 `hello`。 |

格式有误但带着合法 `rid` 的 `input` 或 `call` 不算 `error`：它得到一个 `result` 拒绝（`input_too_long`、`invalid_params`）。

**致命错误之后连接怎样结束。** 服务器写出 `error` 这一行，结束自己这一侧的控制流，让连接保持打开，等客户端挂断——最多 3 秒，之后服务器自己关闭连接。客户端读到致命 `error` 后关闭连接。（如果服务器立刻关闭，还在路上的那一行可能丢失，客户端本该读到 `bad_key`，看到的却是链路断开。）

**等待第一句话。** 双方都以同样的 15 秒为限。没收到 `hello` 的服务器回 `hello_timeout` 并关闭。已发出 `hello`、却既没收到 `welcome` 也没收到致命 `error` 的客户端断开链路；和致命错误不同，这只是一次普通的连接失败，可以再次拨号。

## 5. 请求与结果

### 5.1 一个请求一个回答

每个 `input` 和每个 `call` 都恰好得到一个 `rid` 相同的 `result`，只发给调用者。拒绝是 `ok: false` 的 `result`；它从来不是事件，也不会到达其他任何人。

```json
{"type":"result","rid":"r3","ok":true,"data":{"totals":[10]}}
```

```json
{"type":"result","rid":"r5","ok":false,"error":{"code":"forbidden","message":"That is for the room admin."}}
```

- `ok: true` 可以带 `data`（结构化数据，因方法或命令而异）和 `text`（同一个回答写给人看的版本，用调用者的语言）。可以只有一个，两个都有，或都没有。纯文本客户端打印 `text`。
- `ok: false` 带 `error.code`（稳定，给程序用）和 `error.message`（给人看，用调用者的语言）。

结果之间没有顺序保证：排在守秘人回合后面的命令，会比之后发出的 `view.get` 更晚得到回答。按 `rid` 对应。

**结果去哪。** 桌上发生的事以**事件**发布，发给每个成员。只关乎调用者的事（成功与否、为什么失败、查询的答案、任何秘密，比如暗骰）是**结果**。一个命令常常两样都有：`.r 2d6` 在日志里放一个 `dice` 事件，并以 `data.totals` 回答调用者。

### 5.2 `input`

`{"type":"input","rid":"…","text":"…"}`。`text` 最多 8000 个码点；超过就以 `input_too_long` 拒绝。由服务器判断这一行是什么（[6.2](#62-两个入口)）：

- **文本命令**（前缀加命令词）：完全按 `command.run` 的方式运行，结果就是命令的回答。
- **发言**（其他一切）：这一行立刻被接受。先发布它的 `narrative` 事件和其中内联掷骰的 `dice` 事件，然后调用者得到 `ok: true`（`text` 里写出解析失败的内联掷骰）。守秘人的回合随后排在房间锁后面，回复稍后以事件的形式到达。结果不等回复。

### 5.3 方法

| 方法 | params | 成功时的 `data` | 拒绝 |
|---|---|---|---|
| `command.run` | `{id, args?}` | 命令自己的回答（[6](#6-命令)） | `invalid_params`（`id` 不是最多 200 个码点的非空字符串），以及所有命令拒绝 |
| `view.list` | `{}` | `{views: [{name, schema, title?}]}` | — |
| `view.subscribe` | `{names}` | `{problems: [{name, code}]}`；当前值随后以 `view` 帧发来 | `invalid_params`（`names` 不是最多 64 个字符串的列表） |
| `view.unsubscribe` | `{names}` | `{removed: [name]}` | `invalid_params` |
| `view.get` | `{name}` | `{name, rev, at, data}` | `invalid_params`、`unknown_view`、`view_failed`、`too_large` |
| `log.page` | `{before, limit?}` | `{events: [event frame]}`，最早的在前 | `invalid_params`（`before` 不是整数；`limit` 不是 1 到 100 的整数） |
| `media.offer` | `{name, mime, size, sha256, purpose?}` | `{upload_id}` 或 `{existing}` | 见 [11.2](#112-申报文件) |

未知方法以 `unknown_method` 拒绝。`params` 可以省略（此时为 `{}`）；给了但不是对象，以 `invalid_params` 拒绝。

### 5.4 限流

每个成员有一个令牌桶：突发 5 个，每两秒补一个（服务器默认值）。每个 `input` 和每个 `command.run` 花一个令牌；用完时请求以 `rate_limited` 拒绝，不排队。视图、`log.page` 和 `ping` 不限流。上传有自己的限制（[11.2](#112-申报文件)）。

## 6. 命令

### 6.1 命令模型

命令是人执行的唯一一种操作。引擎的命令、房间规则系统（它的“规则包”）的命令和房间模组的命令共用一张表，通过 `commands` 视图发现（[6.5](#65-发现命令commands-视图)）。

| 来源 | id 的样子 | 例子 |
|---|---|---|
| `engine` | 一个普通单词 | `roll`、`undo`、`help` |
| `pack` | `rules.<subsystem>` | `rules.sanity_check` |
| `module` | `<module>/<name>` | `duel/strike` |

### 6.2 两个入口

同一个命令有两条路可以到达，身份检查、参数校验、限流和排队都相同：

- 带文本形式的 `input`：`.r 2d6`；
- `call` `command.run`：`{"id":"roll","args":{"expr":"2d6"}}`。

文本形式的参数字符串被解析成和结构化调用传的完全一样的参数对象，然后两者都按命令的参数 schema 校验，到达同一个处理函数。命令在一个事务里运行：被拒绝时，房间保持原样。

**顺序。** 命令和发言排在每个房间的一把锁后面，按到达顺序执行。命令不开启守秘人回合。有三个命令是**房间生命周期**命令，不等锁：`undo`、`reset` 和 `save`（导出与导入）。它们立刻运行，守秘人回合进行到一半也一样；旧代次仍在进行的工作（等模型的回合、排队的发言）会自己提交失败，进行中的回合照常以 `turn idle` 信号结束。`pack install`、`model`、`imagegen` 和 `key` 也不等锁：它们作用于服务器（一次下载、一次换模型、一把吊销的钥匙），不能排在回合后面。`genchar` 和角色卡的 `import`（各自要等自己的一次模型调用）、`report`（读的是当下的日志）也不等锁。换模型时正在进行的回合，用它开始时的模型跑完。

### 6.3 文本形式

去掉首尾空白后，一行在满足以下条件时是文本命令：

1. 以三个等价前缀之一开头：`.`、`。`（U+3002）或 `/`；
2. 后面可以有空白，然后是**命令词**：第一段连续的非空白字符，大小写折叠后精确匹配。没有粘连写法：`.r3d6` 的命令词是 `r3d6`，不是任何命令；
3. 这个词是本房间的某个命令。

命令词之后的一切（去掉首尾空白）是参数字符串，最多 4000 个码点（超过就以 `too_long` 拒绝，从不截断）。

- 没有前缀、没有命令词，或命令词不是任何命令的行，是**发言**，原样在桌上说出。所以打错的命令会作为发言到达守秘人。
- 例外：某个已安装规则系统声明了、但本房间规则系统没有的命令词，以 `not_in_system` 拒绝，而不是变成发言。
- 引擎的形式优先于规则包的形式。每个命令都有一张英文别名表和一张中文别名表；两张总是都查，调用者的语言优先。
- 模组命令按它的模组声明的文字写法来打，写法以 `commands` 视图列出的为准（[6.5](#65-发现命令commands-视图)）：`.strike Bo`。引擎和规则包的命令词优先于模组的；本房间两个模组都用了的词，哪个都不运行；同一个词有两个写法都对得上一行时，字面词多的那个胜出。命令词归某个模组写法所有、但一个写法都对不上的行，以 `usage` 拒绝。打出来的词按对应参数声明的类型转换（整数、数、`true`/`false`，其余是文本），然后像任何参数一样校验。
- 每条模组命令也都能用完整 id 加一个 JSON 对象来打：`.duel/strike {"target":"Bo"}`（没有参数字符串即 `{}`；不是 JSON 对象的一律以 `module_args` 拒绝）。

**内联掷骰。** 发言里最多可以带 8 个写成 `[[expr]]` 的内联掷骰，如 `I swing the lantern [[1d6]]`。每个都会掷出，并紧跟在这一行的 `narrative` 事件之后作为 `dice` 事件发布。解析失败的掷骰被跳过，并在结果的 `text` 里写出；超过 8 个则一个都不掷。

### 6.4 拒绝

命令拒绝是一个带稳定错误码和调用者语言消息的 `result`。客户端最常遇到的错误码：

| 错误码 | 含义 |
|---|---|
| `unknown_command` | 本房间没有这个 id（或文本形式）的命令。 |
| `forbidden` | 这个命令，或给出的某个参数，是房间管理员专用的；或者旁观者试了一个没有标明旁观者可用的命令。 |
| `usage` | 文本形式的参数读不懂；消息里带着用法行。 |
| `unknown_arg`、`missing_arg`、`invalid_arg` | 参数对象不符合 schema；消息里写出路径（`expr`、`a.skill`、`writes.0.value`）。 |
| `too_long` | 文本形式的参数字符串超过 4000 个码点。 |
| `no_rule_system`、`not_in_system`、`no_media` | 这个命令此刻在本房间不可用（同样的词也出现在 `commands` 视图的 `reason` 里）。 |
| `stale_generation` | 命令等待期间，房间被回退、重置或替换了。请重试。 |
| `rate_limited` | 成员的突发额度用完了。 |
| `module_args`、`module_unavailable` | 模组命令的参数不是 JSON 对象；模组拒绝了（原样显示它自己的理由）。 |
| `command_failed` | 服务器出错；什么都没改。 |

命令还有自己的错误码（`bad_dice`、`no_character`、`name_taken`、`reset_not_armed`、`undo_out_of_range`、`undo_beyond_depth`、`not_uploaded`、`save_not_uploaded`、`not_a_card`、`last_admin`……）。没有专属文字的错误码，用一条包含该错误码的通用消息表述。不认识的错误码当作普通拒绝处理，显示 `message`。

### 6.5 发现命令：`commands` 视图

`commands` 视图（[10.4](#104-内置视图)）列出这个查看者能看到的命令，以及这个查看者此刻能怎样使用它们：

```json
{"id":"roll","source":"engine","title":"Roll dice","description":"Roll a dice expression for the table to see. A comparison straight after a dice group counts the dice that meet it (5d10>=7); compare a total in parentheses ((5d10)>6). d% is a d100. N# rolls N times; adv/dis keeps the better or worse of two.","params":{"type":"object","properties":{"expr":{"type":"string","minLength":1,"maxLength":1000},"repeat":{"type":"integer","minimum":1,"maximum":20},"mode":{"type":"string","enum":["adv","dis"]}},"additionalProperties":false},"role":"player","available":true,"text":{"forms":["roll","r"],"usage":".r [N#][expr] [adv|dis] — e.g. .r 3d6+2, .r 2#1d20 adv, .r 5d10>=7"}}
```

| 字段 | 含义 |
|---|---|
| `id` | `command.run` 接受的 id。 |
| `source` | `engine`、`pack` 或 `module`。 |
| `title`、`description` | 用查看者的语言（模组的按模组写的原样）。 |
| `params` | 参数，一个 JSON Schema 对象（[6.6](#66-参数-schema)）。 |
| `text` | 可选：`forms`（运行它的词，不带前缀）和 `usage`（一行用法说明）。没有文本形式的命令没有这个字段。 |
| `role` | `player`（玩家和管理员）或 `admin`（仅管理员）。 |
| `danger` | 破坏性命令带这个字段且为 `true`：运行前先确认（`undo`、`reset`、`save`；以及模组自己声明了 `danger` 的模组命令）。 |
| `available` | 这个查看者此刻能否在这里运行它。 |
| `reason` | 不可用时，是下面之一：`observer`（查看者是旁观者，而这个命令旁观者不能用）、`no_rule_system`（`check`：房间的规则系统不评级检定）、`not_in_system`（`opposed`：房间的规则系统没有对抗）、`no_media`（`uploads`、`audio`、`bgm`、`ambience`、`sfx`：服务器不存文件；`import`：不存文件，也没装扩展包）、`settings_unavailable`（`model`、`imagegen`、`key`：服务器运行时不能改设置）。模组命令对任何玩家都可用（见下）。 |

- 管理员命令根本不会列给非管理员。
- 有些玩家命令的某些参数需要管理员（`bot` 带 `on`，`rule` 带 `variant` 或 `system`，`uploads` 带 `on`，`init` 带 `name`，`lore` 的 `list` 以外的任何用法以及带 `disabled` 的 `list`，`import` 带 `as: "world"`，`model` 除不带 `provider` 和 `lane` 的 `list` 以外的任何用法，`report` 带 `reveal`）。条目写的是 `role: "player"`；仅限管理员的参数以 `forbidden` 拒绝。见 [6.8](#68-引擎的命令) 的表。
- `text.forms` 列出查看者语言的那张表（那张为空时列另一张）。服务器两张表的形式都接受。
- 模组命令的 `text.forms` 是此刻在本房间能运行它的词（模组声明的写法，去掉命令词是引擎或规则包的词、或者被本房间另一个模组也用了的那些），`text.usage` 是每个这样的写法打出来的样子（`.strike {target} | .strike at {target}`）；一个都没有时没有 `text`，这条命令就用 id 来打。它的 `available` 对任何玩家都是 `true`：模组在使用的那一刻回答。

### 6.6 参数 schema

引擎和规则包的参数 schema 用的是 JSON Schema 的以下子集，服务器严格校验：

| 关键字 | 用于 |
|---|---|
| `type` | `"object"`、`"string"`、`["string","null"]`、`"integer"`、`"number"`、`"boolean"`、`"array"` |
| `properties`、`required`、`additionalProperties` | 对象；`additionalProperties` 为 `false`（不允许其他名字）、`true`（任何对象）或一个适用于所有其他名字的 schema |
| `maxProperties` | 对象（默认上限 64 个名字） |
| `enum`、`minLength`、`maxLength` | 字符串（长度按码点计；默认上限 4000） |
| `minimum`、`maximum` | 整数和数 |
| `items`、`maxItems` | 数组（默认上限 64 项） |

schema 没列出的名字被拒绝（`unknown_arg`）；整数必须是没有小数部分的 JSON 数，数必须是有限的 JSON 数，都不能是文本 `"5"`；以 `null` 给出的参数只在类型允许 `null` 时有效；嵌套超过 8 层被拒绝。模组命令的 `params` 是模组声明的 schema；调用模组之前，参数先按它检查，用的是模组约定里的关键字（`type`、`properties`、`required`、`additionalProperties: false`、`enum`、`const`、`minimum`/`maximum`、`minLength`/`maxLength`、`minItems`/`maxItems`、`items`），不符合时以同样的错误码拒绝。

### 6.7 房间生命周期命令（客户端视角）

- **`undo`**（管理员）：把房间回退 `turns` 个回合（默认 1，最多 64，且不能超过服务器的撤销窗口，`undo_beyond_depth`）。桌面收到一个 `rewind` 事件（[8.5](#85-rewind)）；调用者的结果带 `data {turn, epoch, removedTurns}`。撤销一个回合，也会撤回该回合开始之后运行的每个命令。
- **`reset`**（管理员）：分两步。`{"scope":"story"}`（或 `chars`、`all`；默认 `story`）为这个成员、这个房间*预备*一次重置，有效 60 秒，回答 `data {armed: <scope>}`；此时什么都没变。在窗口内发 `{"confirm":true}` 才执行：桌面收到一个 `reset` 事件（[8.6](#86-reset)），调用者得到 `data {scope, epoch}`。没有预备就确认是 `reset_not_armed`；确认时指定了另一个范围是 `reset_scope_mismatch`。
- **`save`**（管理员）：整个房间是一个文件（存档包，JSON），走字节通道（[11](#11-字节通道)），从不放进帧里——一个房间可能比一行大得多。`{"op":"export"}` 把存档包存成房间的一个*不公开*文件，只有管理员能获取（里面有房间的所有秘密），并且只回答调用者 `data {documents, events, media: {hash, mime: "application/json", size, name}}`；客户端按 `hash` 获取它（[11.3](#113-get)）。房间只保留最新一次导出：下一次导出会删掉它，全部重置或导入也会清掉它——给出时就去取。`{"op":"import","file":"<hash>"}` 用调用者以 `media.offer {purpose: "save"}` 上传的存档文件替换房间（[11.2](#112-申报文件)）；这个管理员没有上传（或申报）过的哈希回答 `save_not_uploaded`。改动任何东西之前，文件会先整个检查一遍（`bad_bundle` 带第一个问题的路径、`undeclared_document_type` 等），读过之后文件就删掉，不管导入成功还是被拒（房间自己最新一次导出被申报回来的话，它留着）——要重试就重新申报。存档里没有文件：导入会清掉房间原有的所有文件（分享过的图片、上传的声音、团报网页），所以载入的日志里某条 `media` 事件指向的文件可能已经不在了（`media_not_found`）。导入会替换房间——换成另一份日志、另一套编号——所以没有事件宣布它：回答管理员之后，服务器**结束**房间里每个成员的连接（没有 `error` 帧；链路直接关闭）。每个客户端像任何一次断线后那样重新拨号；随后的 `welcome` 给出新的 `epoch`，客户端丢弃自己持有的日志，回放把房间现在的样子交给它。存档包里自带的 `rewind` 和 `reset` 事件不导入：它们是房间早先经历的标记。存档包不带任何指向原房间文件的引用（最新一次导出、团报页面、音频库里上传的声音、正在播放的内容）：载入它的房间里没有这些文件，载入后也没有声音在播放。在不保存文件的服务器上，`save` 回答 `no_media`。

### 6.8 引擎的命令

由服务器的命令表（`server/src/gateway/commands/`）生成。这里的每个 id 也都列在 `commands` 视图里，带完整的参数 schema；`?` 表示可选参数。文本形式写作“英文表 / 中文表”；前缀可用 `.`、`。`、`/` 中任意一个。

| id | 身份 | 文本形式 | 参数 | 说明 |
|---|---|---|---|---|
| `roll` | player | `roll`, `r` / `r`, `rd` | `expr?`（1–1000，默认 `1d20`）、`repeat?`（1–20）、`mode?`（`adv`\|`dis`）、`reason?`（1–100） | 每次掷骰一个 `dice` 事件；`data {totals}`。`reason` 是这次掷骰的理由：它是事件的 `label`，也写在 `text` 的开头。文本形式：表达式后面的文字（`.r 1d8 砍门`）。 |
| `hidden_roll` | player | `rh`, `hroll` / `rh` | `expr?`、`mode?` | 没有事件：桌面不会知道。`text` 和 `data {expr, rolls, total}` 只给调用者。 |
| `check` | player | `check`, `attack`, `cast`, `ra`, `rc` / `ra`, `rc`，加上规则系统自己的检定词 | `skill?`、`target?`、`difficulty?`、`bonus?`（0–10）、`penalty?`（0–10）、`mode?`、`proficient?`、`params?`（整数对象，≤16）、`repeat?`（1–20） | 房间的规则系统能评定检定时可用（`no_rule_system`）。每次检定一个 `dice` 事件。 |
| `opposed` | player | `opposed`, `rav`, `rcv` / `rav`, `rcv` | `a` `{skill?, value?, bonus?, penalty?}`、`b?`（同上） | 规则系统有对抗时可用（`not_in_system`）。 |
| `init` | player；`name`：admin | `init`, `initiative`, `ri` / `ri`, `init` | `op`（`show`\|`roll`\|`next`\|`clear`）、`value?`、`name?` | 先攻顺序。 |
| `sheet` | player | `sheet`, `st` / `st` | `op`（`show`\|`set`\|`clear`\|`finalize`）、`writes?`（≤32 个 `{name, op: "="\|"+="\|"-=", value}`） | 你的角色卡。 |
| `rename` | player | `rename`, `nn` / `nn` | `name`（1–64） | 给你扮演的角色改名。 |
| `new_character` | player | 已安装规则系统的建卡词（内置的有：`coc`、`coc7`、`dnd`、`dnd5e`） | `system`、`name?` | 创建并入座一个角色；一个 `narrative` 系统事件；`data {id, name, system, violations}`。 |
| `genchar` | player | `genchar` / `genchar`, `生卡`, `生成角色` | `description`（字符串；为空是 `genchar_empty`，超过 2000 个码点是 `genchar_too_long`）、`name?`（1–64；默认同 `new_character`）、`system?`（1–64：规则系统的 id 或名字；默认房间的） | 按描述生成角色。服务器的模型把描述当作数据读，用一次调用提出一个构想——职业或职阶、侧重的属性、几项技能、一行背景；角色卡由规则系统掷出、数值由它分配（模型一个数都不写），模型写的内容经过服务器的词语过滤，角色的创建和入座与 `new_character` 相同（同样一个 `narrative` 系统事件；没有规则系统的房间采用这次指定的系统）。`text` 是用文字写出的角色卡；`data {id, name, system, method: "rolled"\|"standard_array", violations, dropped}`（`dropped`：模型回答中超出上限的部分）。不排在房间的回合后面。每个成员每小时最多 5 次，角色导入也算在内（`genchar_rate_limited`）。拒绝：`genchar_no_system`、`unknown_system`、`name_taken`、`genchar_no_model`（没有配置模型）、`genchar_failed`（模型出错，或它的回答不能用；消息里说明是哪种）。文本形式：`genchar [system] [name] \| <description>`、`genchar [system] <description>`（第一个词是规则系统名时选中它；`｜` 等同 `\|`）。 |
| `pc` | player | `pc`, `roster` / `pc`, `角色池`, `预设角色` | `op`（`list`\|`claim`\|`release`）、`name?`（≤128） | 可供选用的角色池。`claim` 先把 `name`（去掉首尾空白）当作角色池里某个角色的 id（`characters` 视图列出的那个）来找，找不到再当作它的名字找，不分大小写（`unknown_character`）。 |
| `recap` | player, observer | `recap` / `recap`, `前情提要`, `前情` | — | 不剧透的前情提要。 |
| `lore` | player；`list` 以外的全部，以及带 `disabled` 的 `list`：admin | `lore` / `lore`, `设定`, `設定` | `op`（`list`\|`add`\|`enable`\|`disable`\|`bind`\|`unbind`\|`restore`）、`title?`（≤200）、`content?`（≤16000）、`condition?`（≤500）、`disabled?` | 房间的设定。玩家的 `list` 只有正在用、且公开的条目：秘密的条目，或被关掉的条目（文件里自己关的，或管理员 `disable` 的），对玩家不存在，标题和内容都没有。`enable` / `disable` / `bind` / `unbind` / `restore` 是管理员按准确标题对导入设定做的开关。 |
| `var` | admin | `var`, `vars` / `var`, `变量`, `變量` | `op`（`list`\|`expose`\|`hide`\|`set`\|`add`）、`path?`（≤200）、`value?`（≤4000）、`delta?` | 房间的变量；`expose` 把一个分支展示给玩家。`set` 和 `add` 只写已有的叶子：路径指向一个分支时被拒绝（`var_branch`，消息里列出它下面的叶子），分支不会被一个值替换。`set` 读 `value`（一个字符串；文本形式里是路径后面的整行），按第一条合用的规则：`true`、`false`、`null` 这三个词；JSON（`42`、`-3.5`、`1e3`、`"42"`、`[1, 2]`、`{"a": 1}`）；带括号的 JSON5 对象或列表（`{a: 1}`）；单引号里的文本（`'42'` 是文本 `42`，里面的 `''` 是一个引号）；数的四则运算，用 `+ - * / ^` 和括号（`2*3+1` 是 7——`2026-11-27` 也就是 1988）；YAML（`TRUE` 是 true，`~` 是 null，`0x10` 是 16，`time: dusk` 是一个映射，以 `#` 开头的值是 null）；都不是，就是文本本身，去掉两端的引号、反引号、反斜杠和空格。`undefined` 被拒绝（`var_refused`）。要设一个看起来像数的文本，给它加引号：`'42'` 或 `"42"`。原来是数的叶子收到文本会当作数（不是数时为 `not_a_number`）；声明过的变量按它的类型检查值。 |
| `npc` | admin | `npc` / `npc`, `角色` | `op`（`list`\|`show`\|`delete`）、`name?` | 回答只给调用者。 |
| `chronicle` | admin | `chronicle` / `chronicle`, `编年史`, `年史` | `op`（`list`\|`summary`\|`threads`\|`note`）、`text?` | 回答只给调用者。 |
| `habits` | admin | `habits` / `habits`, `习惯`, `習慣` | `op`（`show`\|`forget`）、`text?`（≤200） | 守秘人对这一桌了解到的习惯。 |
| `rule` | player；`variant`、`system`：admin | `rule` / `rule`, `规则`, `規則` | `variant?`（字符串或 `null`）、`system?`（字符串或 `null`） | 查看或设置规则系统及其房规阶梯；`null` 回到默认。 |
| `bot` | player；`on`：admin | `bot` / `bot` | `on?`（布尔） | 查看或设置守秘人是否回应。 |
| `language` | admin | `language` / `language`, `语言`, `語言` | `locale`（`en`\|`zh`） | 设置房间的语言；以新语言的一个 `narrative` 事件宣布。 |
| `undo` | admin, danger | `undo` / `undo`, `撤销`, `撤銷` | `turns?`（1–64） | 生命周期（[6.7](#67-房间生命周期命令客户端视角)）。 |
| `reset` | admin, danger | `reset` / `reset`, `重置`, `重开`, `重開` | `scope?`（`story`\|`chars`\|`all`）、`confirm?` | 生命周期；先预备，再确认：不带 `confirm` 时为调用者预备这次重置（`data {armed, expiresInMs}`，后者是确认的期限），同一成员在期限内发 `confirm: true` 才执行。 |
| `save` | admin, danger | `save` / `save`, `存档`, `存檔` | `op`（`export`\|`import`）、`file?`（64 位十六进制：上传过的存档） | 生命周期；见 [6.7](#67-房间生命周期命令客户端视角)。拒绝：`save_not_uploaded`、`save_not_stored`（导出没能存下；消息里写出媒体错误码）、`bad_bundle`、`no_media`。文本形式：`save [export]`、`save import <hash>`。 |
| `uploads` | player, observer；`on`：admin | `uploads` / `uploads`, `上传` | `on?`（布尔） | 查看或设置房间的上传开关（`data {on}`，`text` 说明现在是开是关）。这个开关管房间的所有上传：成员分享的文件、带来导入的卡、管理员给音频库加的声音都一样。服务器保存文件时可用（`no_media`）。 |
| `import` | player；`as: "world"`：admin | `import` / `import`, `导入` | `file?`（64 位十六进制内容哈希）、`pack?`（1–64）、`card?`（1–512）、`as`（`world`\|`character`）、`name?`（1–64） | 导入调用者以 `purpose: "import"` 上传的卡片文件（[11.6](#116-导入卡片)），或某个已启用扩展包自带的卡片（`pack` 和 `card`，即卡片在包里的路径；`pack_not_enabled`、`card_not_in_pack`）。没有媒体存储且没装任何扩展包时为 `no_media`。作为角色导入：按房间规则系统掷出一张角色卡，并像 `genchar` 那样偏向服务器的模型从卡片人设里读出的东西（与它共用每小时上限）；没有模型、超出上限或回答不能用时，角色卡就照常掷出，`text` 说明原因——`data.concept` 为 `applied`、`no_model`、`rate_limited`、`model_failed`、`unusable`、`aborted` 或 `none`。角色导入不排在房间的回合后面。 |
| `pack` | player；`enable`、`disable`、`install`：admin | `pack`, `packs` / `pack`, `扩展包`, `擴展包` | `op`（`list`\|`enable`\|`disable`\|`install`）、`id?`（1–64）、`ref?`（1–2000） | `list`：管理员看到所有已安装的扩展包，玩家按名字看到本房间的。`enable`/`disable` 在本房间开关一个已安装的扩展包（`unknown_pack`、`too_many_packs`、`module_id_taken`）；禁用时，正在播放它某个音频提示的层会停止（每层一个 `audio` `stop` 信号）。`install`（文本形式 `install <ref>`）：`ref` 是服务器上的路径、一个 `https://` URL 或 `gh:owner/repo[@tag]`；在服务器上安装扩展包并在这里启用它和它的技能；`data {id, version, replaced, sha256, enabled, skillsEnabled, shadowed, trust}`，`text` 是用文字写出的信任卡；一个 `narrative` 系统事件。它不排在房间的回合后面，下载和安装都完成时才给出它唯一的结果。拒绝：`not_https`、`bad_gh_ref`、`source_not_found`、`archive_too_large`、`fetch_failed`、`too_many_redirects`、`no_pack_asset`、`bad_release`、`bad_archive`、`invalid_pack`、`engine_too_old`、`already_installed`、`index_unreadable`、`install_failed`、`install_unavailable`。 |
| `skill` | admin | `skill`, `skills` / `skill`, `技能` | `op`（`list`\|`enable`\|`disable`）、`id?`（1–64） | 本房间可以启用的守秘人技能：内置的，以及已启用扩展包的（`skill_not_available`、`too_many_skills`）。 |
| `report` | player, observer；`reveal`：admin | `report` / `report`, `团报`, `跑团记录` | `format?`（`text`\|`html`）、`reveal?`（布尔） | 团报。不带参数：结果的 `text` 是一份简短的成绩单（`data {format: "text", players, turns, lines}`）。`html`：整场会话印成一个自包含的页面；`data {format: "html", edition, media: {hash, mime, size, name}}`——见下文。`reveal`（文本形式 `reveal`、`复盘`）：管理员的版本，还印出对玩家隐藏的内容。不产生事件；不等房间锁。服务器没有文件存储时为 `report_no_files`。 |
| `jrrp` | player | `jrrp`, `luck` / `jrrp` | — | 今日人品。 |
| `draw` | player | `draw` / `draw`, `抽牌` | — | 从洗好的牌堆里抽一张牌。 |
| `help` | player, observer | `help`, `h` / `help`, `帮助` | `id?`（1–128） | 把 `commands` 视图写成文字；带 `id`（id 或文本形式）时只说一个命令。 |
| `audio` | admin | `audio` / `audio`, `音频`, `音訊` | `op`（`list`\|`set`\|`remove`）、`query?`（1–400）、`title?`（1–400）、`layer?`（`bgm`\|`ambience`\|`sfx` 或 `null`）、`tags?`（≤16 个，每个 1–32） | 房间的音频库（[10.4](#104-内置视图) `audio`）：房间管理员以 `purpose: "audio"` 上传的声音（[11.2](#112-申报文件)），以及已启用扩展包的音频提示，名为 `<pack>/<cue>`。`list`：`data {sounds: [{id, title, layer, tags, source}]}`。`set` 修改上传声音的标题、层和标签；`remove` 把上传的声音移出音频库（正在播放它的层停止；它的字节被删除，除非桌面的日志或某个已启用扩展包还在用）。扩展包的音频提示只读（`audio_read_only`）。文本形式：`audio [list]`、`audio set <sound> title=<t> layer=<l> tags=a,b`（带空格的值加引号）、`audio remove <sound>`。服务器保存文件时可用（`no_media`）。 |
| `bgm`, `ambience`, `sfx` | admin | `bgm` / `bgm`, `背景音乐`, `背景音樂`; `ambience`, `amb` / `ambience`, `amb`, `环境音`, `環境音`; `sfx` / `sfx`, `音效` | `op`（`play`\|`stop`\|`pause`\|`resume`\|`volume`）、`query?`（1–400）、`loop?`、`volume?`（0–1 的数）、`fadeMs?`（0–60000） | 每层一个命令。`play` 用 `query` 指定音频库里的一个声音——先按 id，再按精确标题（或上传声音的文件名，或不带扩展包名的音频提示 id），再按 id 或标题的唯一前缀，最后按唯一子串——并播放它（`bgm` 和 `ambience` 循环播放，除非 `loop: false`；音量默认 1）；`stop`、`pause`、`resume`、`volume` 作用于该层正在播放的声音（什么都没在播时为 `audio_not_playing`）。向桌面发一个 `audio` 信号（[9.4](#94-audio)）；`data {layer, action, …}`。拒绝：`audio_not_found`、`audio_ambiguous`（消息里列出最多五个候选）、`audio_bad_volume`、`audio_bad_fade`。文本形式：`bgm [play] <sound> [--loop\|--once] [--volume 0.7\|70%] [--fade 2000]`、`bgm stop\|pause\|resume [--fade N]`、`bgm volume <0–1\|N%>`；中文词 `播放`、`停止`、`暂停`、`继续`、`音量` 也可以。 |
| `model` | 不带 `provider`/`lane` 的 `list`：player, observer；其余全部：admin | `model`, `models` / `model`, `模型` | `op`（`show`\|`list`\|`set`\|`key`\|`reset`）、`lane?`（`keeper`\|`npc`\|`scribe`\|`director`\|`memory`；默认 `keeper`）、`provider?`（1–64）、`model?`（1–200）、`key?`（1–1000）、`baseUrl?`（1–2000）、`wire?`（`openai-compatible`\|`anthropic`\|`openai-responses`）、`effort?`（`low`\|`medium`\|`high`\|`xhigh`\|`max`）、`contextWindow?`、`maxOutputTokens?`、`timeoutMs?`（正整数）、`promptCacheKey?`（布尔） | 每个通道用的模型，**对整个服务器生效**（每个房间都跟着变）。`show`：`data` 是 [`admin/model`](#104-内置视图) 的值。不带 `provider` 或 `lane` 的 `list`：这个服务器知道的服务商，任何人都可以看（`data {providers}`）；带了它们，或由管理员发出时：向该服务商询问它的模型——`data {providers, provider, models, total, truncated, skipped}`，最多 500 个 id，每个最多 200 个码点，不符合的 id 被跳过并计数（`model_list_timeout`、`model_list_too_large`、`model_list_failed`（消息里写出服务商的失败类别）、`model_not_configured`、`unknown_provider`）。`set`：该通道改为与 `provider`（一个预设，或任何带 `baseUrl` 的名字）通信；没给密钥时，用为该服务商保存的密钥，或服务器自己的（`unknown_provider`、`model_required`、`model_wire_mismatch`、`bad_provider`、`bad_model_id`、`bad_base_url`、`bad_key`、`too_many_credentials`）；`data {lane, keySaved}`。`key`：该通道当前所用服务商的密钥，为该服务商保存。`reset`：该通道（或全部通道）回到服务器的设置；已保存的密钥保留；`data {reset, keeper}`。密钥返回时是遮罩过的（`sk-a...wxyz`）。下一个回合用新模型；进行中的回合用它开始时的模型跑完。不排在房间的回合后面。没有事件。文本形式：`model [show]`、`model list [provider] [lane=…]`、`model set <provider> [model] [key=…] [base_url=…] [wire=…] [effort=…] [context=N] [max_output=N] [timeout=N] [cache=on\|off] [lane=…]`、`model key <key> [lane=…]`、`model reset [lane]`；词 `show`/`查看`、`list`/`列表`、`set`/`use`/`切换`、`key`/`密钥`、`reset`/`重置`。 |
| `imagegen` | admin | `imagegen` / `imagegen`, `图片生成`, `圖片生成` | `op`（`show`\|`set`\|`off`）、`provider?`（1–64：`openai`、`xai`，或带 `baseUrl` 的名字）、`model?`（1–200）、`size?`（`WIDTHxHEIGHT` 或 `auto`）、`key?`、`baseUrl?` | 图片生成，对整个服务器生效。不带 `baseUrl` 的 `set` 需要一个地址已知（`openai`）或已保存的服务商（`image_base_url_required`、`bad_image_size`）；`off` 停止出图，直到管理员再次设置服务商。`data {imagegen}`，同 `admin/model` 里的。没有事件。文本形式：`imagegen [show]`、`imagegen set <provider> [model] [size] [key=…] [base_url=…]`、`imagegen off`。 |
| `key` | admin | `key`, `keys` / `key`, `钥匙`, `鑰匙` | `op`（`list`\|`mint`\|`rename`\|`role`\|`revoke`）、`id?`（钥匙 id，`k:` 加 12 位十六进制数字）、`name?`（1–64）、`role?`（`player`\|`admin`\|`observer`） | 只涉及本房间的访问钥匙。`list`：`data {keys}`，同 [`admin/keys`](#104-内置视图)。`mint {name, role?}`（默认 `player`）：`data {id, name, role, key}`——新钥匙只出现在这个回答里，永远不会出现在别处。`rename {id, name}`。`role {id, role}`：持有者现有的连接结束，以新身份重连。`revoke {id}`：钥匙失效，持有者现有的连接结束；用它重新拨号的客户端得到 `bad_key`。房间的最后一把管理员钥匙不能吊销或降级（`last_admin`）；只要还有另一把管理员钥匙，管理员可以吊销自己正在使用的钥匙，回答之后即被断开。不属于本房间的 id 为 `unknown_key_id`。没有事件。文本形式：`key [list]`、`key mint [player\|admin\|observer] <name>`、`key rename <id> <name>`、`key role <id> <role>`、`key revoke <id>`；`新建`、`改名`、`角色`、`吊销` 也可以。 |
| `panels` | player, observer；`enable`、`disable`：admin | `panels`, `panel` / `panels`, `面板`, `模组面板` | `op`（`list`\|`enable`\|`disable`）、`id?`（`<pack>/<panel>`，1–129） | 房间已启用扩展包的面板（[10.6](#106-面板)）。每个默认都开着；管理员的开关是一项房间设置，重置后仍保留。没有哪个已启用扩展包有这个 id 时为 `panel_not_available`。 |

**团报页面。** 带 `format: "html"` 的 `report` 回答的是对文件的引用，而不是文件本身：`data.media` 是 `{hash, mime: "text/html", size, name}`，客户端用 `hash` 通过字节通道获取（[11.3](#113-get)），以 `name` 保存或直接打开。页面是一个自包含的 HTML 文件——没有脚本，不从任何地方加载任何东西——用调用者的语言写。它是房间的*不列出的*文件：没有 `media` 事件宣布它，它也不出现在任何列表里；只有调用者知道它的哈希。玩家版只由事件日志生成，房间里任何持有该哈希的成员都可以获取。复盘版为管理员保存：其他任何人用它的哈希只会得到 `media_not_found`。新页面会替换房间里同一版本的上一个页面，旧页面的哈希随之失效——页面一给出就获取，不要留着哈希以后再用。

**规则包命令**取决于房间的规则系统。内置系统里只有 `coc7` 有：

| id | 文本形式 | 参数 |
|---|---|---|
| `rules.sanity_check` | `sc`, `sanity` | `success?`、`failure?`（损失记法，1–100）、`tag?`（≤64） |
| `rules.skill_growth` | `en`, `growth` | `skill` |
| `rules.random_madness` | `ti`, `li` | `table?`（1–64） |

### 6.9 发送机密

`model` 和 `imagegen` 接受 API 密钥，`key mint` 的回答里有一把访问钥匙。客户端应当用 **`command.run`** 发送机密，从它自己的一个输入框里发（输入时遮罩），绝不要作为写发言的地方里打出的一行：命令词打错，这一行就成了发言，而发言会原样在桌上说出（[6.3](#63-文本形式)）。

不管哪种方式，服务器都只把机密留给调用者。这些命令不发布事件，所以密钥不会到达桌面，不会进入日志（`log.page`），也不会进入守秘人读到的命令记录；拒绝只带错误码，从不带参数；回答和 `admin/model` 只显示遮罩过的密钥：前四个和后四个字符（`sk-a...wxyz`），16 个字符及以下的密钥只显示星号。`key mint` 生成的访问钥匙只出现在那一个回答里，别处都没有——既在 `data.key` 里，也在 `text` 里，这样只能显示文本的客户端也能把钥匙交给人。会保存或记录结果文本的客户端必须把这个回答当作机密：只显示一次，哪里都不留。从聊天里设置的密钥存在服务器的数据库里，只有服务器的所有者能读。

## 7. 事件日志

### 7.1 外层结构

```json
{"type":"event","seq":5,"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","ts":1764240000123,"kind":"narrative","turn":2,"data":{"speaker":"kp","text":"The lantern catches, and the quay comes out of the dark.","format":"markdown"}}
```

| 字段 | 含义 |
|---|---|
| `seq` | 事件在房间日志里的编号，≥ 1 的整数。按发送顺序递增；在房间里永不复用。 |
| `id` | 事件的 id（字符串）。`narrative` 事件沿用它所替换的草稿的 id（[9.1](#91-draft)）；带 `replace: true` 的 `blocks` 事件沿用被它替换的那个事件的 id，所以日志里的 id 不唯一。 |
| `ts` | 自 Unix 纪元起的毫秒数，服务器时间。 |
| `kind` | `narrative`、`dice`、`blocks`、`media`、`rewind` 或 `reset`（[8](#8-事件类型)）。 |
| `turn` | 事件所属的守秘人回合，属于某个回合时才有。 |
| `data` | 该类型的载荷。 |

**有 `turn`** 的是回合里的事件：玩家的那一行、其中的内联掷骰、守秘人的回复，以及为该回合产生的 NPC 台词和演出。**没有 `turn`** 的是不属于回合的事件：命令产生的事件、共享的文件（`media`）、`rewind` 和 `reset`。

### 7.2 日志里有什么，按什么顺序

- 每个成员收到每个事件，按 `seq` 顺序，在它追加时收到。
- 事件按发送时的样子存储，用当时房间的语言。回放的事件就是记录下来的那个：改房间语言不会改写过去。
- `seq` 有空洞。撤销会删除事件，它们的编号不再发出；重置清空日志，但 `head` 留在原处。永远不要从 `seq` 推算数量。
- 回合是交错的。一行发言在被接受时记入日志并在那时编号；它的回复在守秘人回合结束时记入日志。一个回合运行期间被接受的发言立刻拿到后续的回合号，所以日志可能是这样的：第 1 回合的发言、第 2 回合的发言、第 1 回合的回复、第 2 回合的回复。
- 一个回合的有些事件在它的 `turn idle` 信号之后才到：导演的演出（带该回合编号的 `blocks` 事件）和它的 `audio` 信号来自回合结束后运行的一趟处理，这趟处理不占用房间，可能在之后的发言已经记入日志后才到。

### 7.3 `epoch` 与 `head`

`welcome.epoch` 是房间的代次。它从 1 开始，每次撤销、重置和房间导入都加一。同一个 `epoch` 内，日志只在末尾增长，所以在同一 `epoch` 里按 `seq` 续传的客户端什么都不会漏。`epoch` 变了，客户端手里的日志副本就作废。

`welcome.head` 和每个 `seq` 都来自每个房间一个只增不减的计数器。

### 7.4 续传与回放上限

`welcome` 之后的回放由 `hello.resume` 和协议的 `RESUME_LIMIT` = **200** 算出：

- **带 `resume` 且 `resume.epoch == welcome.epoch`：** `seq > max(resume.after, head − 200)` 的事件。
- **其他情况**（没有 `resume`，或 `epoch` 不同）：`seq > head − 200` 的事件。`welcome` 的 `epoch` 告诉客户端它手里的一切都作废了。

所以在同一个 `epoch` 里离开超过 200 个事件的客户端只收到最新的一段，中间有一个**空缺**：`resume.after < seq < head − 199` 的每个 `seq` 都可能有它没有的事件。用 `log.page` 补上。

### 7.5 分页：`log.page`

`{"method":"log.page","params":{"before":<seq>,"limit":<1..100>}}` 回答 `{events: [...]}`：`seq < before` 的最新 `limit` 个事件，**最早的在前**，都是完整的事件帧（和实时事件形状相同）。`limit` 默认为 `PAGE_LIMIT` = **100**，最多也是这个数；要更多会被拒绝（`invalid_params`），不会截到 100。返回的事件少于 `limit` 个，说明日志里没有更早的了。分页拿到的事件是历史：其中的 `rewind` 或 `reset` 服务器已经执行过，对客户端没有任何影响。

分页被拒绝就是普通的拒绝。参考客户端的 `loadOlder()` 返回它加进来的事件数，所以没有更早的事件和服务器拒绝了这一页都是 0；要靠快照区分。被拒绝时 `gap` 和 `complete` 保持原样，`lastError` 设为 `{code, message, fatal: false}`，会话里所有不致命的拒绝都放在这里。没有更早的事件时 `complete` 变为真（补缺口时则是 `gap` 被清掉）。

### 7.6 在本地保存日志

参考客户端（`client.ts`）这样做，保存日志的客户端也应当这样做：

1. **收到 `welcome` 时：** 如果手里的日志是在另一个 `epoch` 下建的，或其最新 `seq` 大于 `welcome.head`，丢弃它。如果手里没有日志，那么 `first` 为 0（房间没有事件）或 `first > head − 200`（最早的事件在回放的那一段之内）时，日志是完整的。如果手里有日志且 `head − lastSeq > 200`，记下一个空缺 `(lastSeq, head − 199)`。
2. **收到每个事件时：** 按 `seq` 插入，已有的 `seq` 忽略。按下文处理 `rewind` 和 `reset`。记住见过的最大 `seq`，**包括你不认识的类型的事件**（它们照样占着日志里的一个位置）：这个数就是下次的 `resume.after`。
3. **收到 `rewind {from, kept, epoch}` 时：** 丢掉 `seq ≥ from` 的每个事件，`seq` 在 `kept` 里的除外；如果 `epoch` 比你的大就采用它。然后保留这个 `rewind` 事件本身（它在日志里）。
4. **收到 `reset {scope, epoch}` 时：** 丢掉手里的一切和所有草稿；采用 `epoch`。这个 `reset` 事件是新日志的第一条。
5. **重连时：** 发 `resume {epoch, after: lastSeq}`。

### 7.7 为什么撤销会从中间删

撤销第 N 回合时，保留 N 之前各回合的每个事件，不管它落地多晚；删除第 N 回合及之后的每个事件，以及这些事件中第一个之后记入的每个无回合事件。因为回合是交错的，删掉的不一定是一个后缀：第 1、2 回合的发言都在任何回复之前被接受时，日志是 `1 (line, turn 1)`、`2 (line, turn 2)`、`3 (reply, turn 1)`、`4 (reply, turn 2)`，撤销第 2 回合后剩下 1 和 3。`rewind` 事件说的正是这个：`{"from":2,"kept":[3],"epoch":2}`。通常情况下 `kept` 为空。

## 8. 事件类型

客户端渲染它认识的类型，跳过其他的（[12.1](#121-向前兼容)）。

### 8.1 `narrative`

```json
{"speaker":"player","name":"Ada","member":"m:15b5f3445045","text":"I light the lantern.","format":"plain"}
```

| 字段 | 含义 |
|---|---|
| `speaker` | `player`（成员的发言）、`kp`（守秘人）、`npc`（说话的非玩家角色）、`system`（引擎的通告，如新角色、改了的设置）。 |
| `name` | 谁在说：`player` 是角色（或成员）名，`npc` 是 NPC 的名字。`kp` 没有；`system` 通常没有。 |
| `member` | `player` 专用：发言成员的 id。 |
| `text` | 这一行。 |
| `format` | `markdown`（守秘人的叙述）或 `plain`（原样显示）。 |

### 8.2 `dice`

桌面看到的一次掷骰或检定。它从不带只给守秘人的信息。下面是同一桌的三个例子：一次检定、一次对抗、一次理智检定。

```json
{"actor":"Alice","kind":"check","expr":"1d100","rolls":[19],"total":19,"label":"Spot Hidden","detail":{"skill":"Spot Hidden","modifier":0,"modifiers":[],"params":[]},"target":25,"effectiveTarget":25,"outcome":{"id":"regular","label":"Success","success":true,"critical":false,"fumble":false,"tier":2,"margin":6}}
{"actor":"Alice","kind":"opposed","subsystem":"opposed_check","subsystemLabel":"Opposed check","expr":"1d100","rolls":[28,53],"total":28,"label":"Fighting (Brawl)","text":"Fighting (Brawl) 28 (Failure) vs Dodge 53 (Failure): Dodge wins (higher value)","detail":{"winner":"b","decidedBy":"value","settle":"outcome","a":{"skill":"Fighting (Brawl)","value":20,"total":28,"outcome":{"id":"fail","label":"Failure","success":false,"critical":false,"fumble":false,"tier":1,"margin":-8}},"b":{"skill":"Dodge","value":25,"total":53,"outcome":{"id":"fail","label":"Failure","success":false,"critical":false,"fumble":false,"tier":1,"margin":-28}}},"outcome":{"id":"fail","label":"Failure","success":false,"critical":false,"fumble":false,"tier":1,"margin":-8}}
{"actor":"Alice","kind":"subsystem","subsystem":"sanity_check","subsystemLabel":"Sanity","expr":"1d100","rolls":[55],"total":55,"target":75,"outcome":{"id":"regular","label":"Success","success":true,"critical":false,"fumble":false,"tier":2,"margin":20},"label":"Sanity","text":"Sanity 55 vs 75 (Success): loses 1 (1 = 1), Sanity 75 → 74","detail":{"stat":"SAN","loss":1,"lossNotation":"1","lossRoll":"1 = 1","before":75,"after":74,"max":99}}
```

| 字段 | 含义 |
|---|---|
| `actor` | 谁掷的：角色名或成员名。 |
| `kind` | `roll`（普通掷骰）、`check`（评级检定）、`subsystem`（规则子系统，如理智检定）、`opposed`（对抗）、`init`（先攻）。 |
| `expr` | 掷的记法，规范形式。 |
| `rolls` | 每颗骰子的结果。 |
| `total` | 结果。 |
| `target`、`effectiveTarget` | 检定专用：掷骰对照的值，以及计入难度和调整后的值。 |
| `subsystem`、`subsystemLabel` | `subsystem` 专用：它的稳定 id，以及它在房间语言里的名字。 |
| `label` | 为什么而掷，用房间的语言：规则系统叫的技能或属性名、先攻这个词、子系统给这次掷骰起的名字（理智检定对照的属性、成长检定针对的技能、抽取用的表；对抗里第一方的技能）。单纯掷骰时没有。 |
| `text` | 给人看的一行，把这次掷骰完整说清楚，用房间的语言；只有结果不止总数、目标和结果等级的那几种才有：对抗（双方的总数和结果等级，以及谁赢或平局）、有后果的子系统掷骰（改了什么、从多少到多少；抽到的表项）、普通掷骰。 |
| `outcome` | 评级掷骰专用：见下文。 |
| `detail` | 规则系统声明的附加信息（一个对象）。愿意的话原样显示；永远不要据此分支。普通掷骰还带 `detail.text`，和 `text` 是同一行，留给 `text` 出现之前写的客户端。 |

**显示一次掷骰**不需要懂规则系统：有 `text` 就显示它；没有就用 `label`、`total`、`target`（或 `effectiveTarget`）和 `outcome.label` 拼出来，比如 `Spot Hidden 19 vs 25: Success`。永远不要读 `detail` 来弄清掷的是什么、谁赢了。

**结果约定**与规则系统无关，所以一个客户端能渲染所有系统：

| 字段 | 含义 |
|---|---|
| `id` | 系统自己的等级词（`regular`、`hard`、`extreme`……）。只用于展示：永远不要据此分支。 |
| `label` | 等级，已经是房间语言。显示这个。 |
| `success`、`critical`、`fumble` | 布尔。按这些上色。 |
| `tier` | 一个数；越大越好。愿意的话按它调深浅。 |
| `margin` | 可选：比目标高（正）或低（负）多少。 |

### 8.3 `blocks`

放进故事里的声明式内容：模组的卡片，导演的演出。

```json
{"blocks":[{"kind":"title_card","title":"Act II","subtitle":"The Drowned Quay"},{"kind":"letter","from":"M.","body":"Come alone."}],"replace":true}
```

| 字段 | 含义 |
|---|---|
| `blocks` | 最多 256 个块，按顺序渲染。 |
| `replace` | 为 `true` 时，这个事件原地更新之前那个事件 `id` 相同的 `blocks` 事件（在之前那个的位置渲染它，或替换掉之前那个；不要两个都显示）。 |

| 块 `kind` | 字段 | 渲染为 |
|---|---|---|
| `meter` | `label`、`value`、`min`、`max` | 一个量表 |
| `stat` | `label`、`value`（数、字符串或布尔） | 一个带标签的值 |
| `badge` | `label`、`tone?`（`info`\|`warn`\|`danger`） | 一个标签 |
| `text` | `text`、`style?`（`quote`\|`warning`） | 一个段落 |
| `divider` | — | 一条分隔线 |
| `choices` | `prompt?`、`options`（≤64 个 `{id, label, command, args?}`） | 一组按钮；按下一个就是以按下它的成员身份调用 `command.run {id: command, args}` |
| `image` | `hash`、`mime?`、`size?`、`caption?`、`alt?` | 一张图，用 `hash` 通过字节通道获取 |
| `letter` | `body`、`from?`、`to?`、`date?` | 一封信或一张便条 |
| `clipping` | `headline`、`body`、`source?`、`date?` | 一张剪报 |
| `map_pin` | `hash`、`mime?`、`size?`、`label`、`x`、`y`、`note?` | 图片 `hash` 上 (`x`, `y`) 处的一个图钉 |
| `title_card` | `title`、`subtitle?`、`act?` | 一张章节卡 |

**不确定就不画。** 未知 `kind` 的块被跳过，事件的其余部分照常显示。已知类型的块缺字段、类型不对，或带着客户端不认识的枚举值（某个 `tone`、某个 `style`），整个事件就算格式有误：丢掉它，不要画错。

### 8.4 `media`

与桌面共享的一个文件。

```json
{"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","mime":"image/png","size":48213,"name":"map.png","from":"m:15b5f3445045"}
```

`hash` 是字节内容的小写十六进制 SHA-256，通过字节通道获取；`from` 是共享它的成员的 id，或 `server`。

### 8.5 `rewind`

```json
{"from":3,"kept":[],"epoch":2}
```

一次撤销：日志失去了编号为 `from` 及以上的每个事件，`seq` 在 `kept` 里的**除外**，房间进入代次 `epoch`。按 [7.6](#76-在本地保存日志) 处理。

### 8.6 `reset`

```json
{"scope":"all","epoch":3}
```

战役被清除了（`story`：故事；`chars`：故事和角色；`all`：一切），或者房间被一次导入替换了（总是 `all`）。清空滚动记录和所有草稿；采用 `epoch`。视图随后带着新值到来。`all` 的重置还会清掉房间正在播放的东西：停止每个音频层（没有 `audio` 信号告知）。较轻的重置不停音乐。

## 9. 信号

`{"type":"signal","kind":…,"data":…}`。信号发给每个成员，从不存储或回放。来自过去代次的工作（被撤销取消的回合）的信号不发送，`turn idle` 除外。

### 9.1 `draft`

守秘人回复的流式文本。

```json
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","text":"The lantern catches, "}}
```

```json
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","discard":true}}
```

- `{id, text}` 往流式气泡 `id` 里**追加**一段；某个 id 的第一段打开气泡，显示在最新事件之后。每段大约 48 个字符，或遇到换行就发出。
- `{id, discard: true}` 移除气泡：这一轮模型调用原来是要调用工具，或服务商重试了。重试会用新的 id 重新流式发送。
- `id` 相同的 `narrative` 事件**替换**气泡。以事件为准；草稿显示的可以比事件少，绝不会比事件多（可能属于隐藏块的文本会被扣下，也可能被丢弃）。
- 收到 `turn idle` 时，丢掉所有还开着的气泡：失败的回合或被撤销取消的回合，不一定会丢弃自己的草稿。
- 某个 id 的 `narrative` 事件你已经有了，再来的该 id 的草稿就是过期的：忽略。

### 9.2 `turn`

```json
{"type":"signal","kind":"turn","data":{"status":"busy","actor":"Ada"}}
```

```json
{"type":"signal","kind":"turn","data":{"status":"idle"}}
```

`busy` 表示守秘人正在处理一个回合；`actor` 是它所回答的那一行的发言者名字。`idle` 表示它结束了（回复了、失败了或被取消了）。把 `busy` 当作状态，而不是事件。回合进行中连上的成员会在回放之后立刻收到 `busy`。协议还定义了两个可选的 `busy` 字段：`activity`（`reading`\|`dice`\|`cast`\|`bookkeeping`，只用于展示：未知值忽略）和 `round`（整数）；3.0 服务器不发它们。

### 9.3 `notice`

发给桌面的一行带外消息，用房间的语言。

```json
{"type":"signal","kind":"notice","data":{"level":"warn","code":"provider_transient","text":"The AI provider is still temporarily unavailable after retrying. Please try again shortly."}}
```

| 字段 | 含义 |
|---|---|
| `level` | `info` 或 `warn`。 |
| `code` | 可选，稳定。目前会发的：`turn_failed`、`reply_blocked`、`provider_auth`、`provider_quota`、`provider_transient`、`provider_content`、`unavailable`。 |
| `text` | 显示它。 |
| `spinner` | 可选布尔（有一个耗时操作在进行）。3.0 服务器不发。 |

### 9.4 `audio`

一次播放**转换**；字节用 `hash` 通过字节通道获取（[11.3](#113-get)）。每一层**此刻**在播放什么，看 `audio` 视图（[10.4](#104-内置视图)）。

```json
{"type":"signal","kind":"audio","data":{"id":"01J…","action":"play","layer":"bgm","sound":"harbor/rain","hash":"3f9a…","mime":"audio/ogg","size":48213,"title":"Rain on the quay","loop":true,"volume":0.8,"fadeMs":1500}}
```

| 字段 | 含义 |
|---|---|
| `id` | 这个信号自己的 id。 |
| `action` | `play`、`stop`、`pause`、`resume`、`volume`。 |
| `layer` | `bgm`、`ambience` 或 `sfx`。`bgm` 和 `ambience` 各放一个声音，默认循环；`sfx` 是一次性的：每次 `play` 响一次，和其他的同时响。 |
| `sound` | 声音在音频库里的 id（`<pack>/<cue>`，或上传声音的哈希）：`play` 时，以及 `bgm` 或 `ambience` 层的转换时，它作用的那个声音。 |
| `hash`、`mime`、`size` | 仅 `play`：要获取的声音，以及它的字节数。 |
| `title` | 仅 `play`，可选：用于显示。 |
| `loop` | 仅 `play`。 |
| `volume` | `play` 和 `volume`：0 到 1。 |
| `fadeMs` | 可选：在这么多毫秒内淡入淡出（最多 60,000）。 |

**视图是状态，信号是转换。** 客户端：

1. 每次连接（和重连）时，订阅 `audio`，按 `playing` 开始播放：每一层的声音用它的 `volume`，按 `loop` 决定是否循环，`paused` 时暂停；
2. 之后跟着信号走：`play` 替换该层正在放的（`sfx`：响一次），`stop` 结束它，`pause` / `resume` 暂停和继续它，`volume` 改变它——给了 `fadeMs` 就在这段时间内渐变。`sfx` 从不算状态，这四个动作作用于当时还在响的音效（`stop` 把它们全部结束），服务器什么都不记；
3. 两者可能不一致时，以视图为准：重连之后（信号不回放），以及 `all` 的 `reset` 之后（它停止每一层，[8.6](#86-reset)）。

信号来自两个地方，走同一条路径，每个信号都同步推进房间的状态：管理员的 `bgm`、`ambience` 和 `sfx` 命令（以及 `audio remove` 或 `pack disable` 停掉正在放的声音），还有回合结束后导演的那趟处理（扩展包的音频提示，[7.2](#72-日志里有什么按什么顺序)）。撤销不改变正在播放的东西，也不发 `audio` 信号。

## 10. 视图

### 10.1 视图是什么

视图是为一个查看者计算的具名结构化值：这个成员、他的身份、他的语言和他扮演的角色。里面的名字和标签用**查看者的**语言；id 从不翻译。客户端订阅它想要的视图；服务器立刻发出视图的当前值，之后每当这个值对这个查看者有变化就再发。每次更新都带完整的值。

```json
{"type":"view","name":"room","rev":1,"at":2,"data":{"locale":"en","localeLabel":"English","system":{"id":"coc7","label":"CoC"},"variant":null,"keeperMuted":false,"uploads":true}}
```

| 字段 | 含义 |
|---|---|
| `name` | 视图的名字。 |
| `rev` | 按连接、按视图名计数，只增不减：一个 rev 从不对应两个不同的值。同一连接上取消订阅后它继续累计，换一条新连接则重新开始。保留当前连接上 rev 最大的那个值。 |
| `at` | 这个值所反映的日志 `head`。 |
| `data` | 值。 |

服务器在每个守秘人回合、每个命令、每个生命周期命令、回合结束后的那趟处理之后，以及每当有成员加入或离开时（在线状态是 `party` 的一部分），重新计算已订阅的视图，只发送变了的值。单单一行发言不会刷新视图。

### 10.2 订阅

- **`view.list`** 回答这条连接可以订阅的视图，每个带它的 JSON Schema（模组视图还带 `title`）。
- **`view.subscribe {names}`** 先回答 `{problems: [{name, code}]}`，再把每个新订阅的视图的当前值作为 `view` 帧发出。已经订阅的名字不会再发一次。问题代码：`unknown_view`（没有这个视图，或这条连接不能看）、`too_many_views`（一条连接上超过 64 个订阅）、`too_large`、`view_failed`。
- **`view.unsubscribe {names}`** 回答 `{removed: [...]}`：原本已订阅的那些名字。
- **`view.get {name}`** 回答 `{name, rev, at, data}`：此刻重新计算的视图，不管这条连接有没有订阅。只有当值与该名字下上一次发出的值不同时，rev 才会前进，所以没变的值带着旧的 rev 回来。

订阅属于**连接**，随连接消失。重连之后要重新订阅（参考客户端维护一个想要的集合，每次收到 `welcome` 都重新订阅）。

一次调用最多指定 `MAX_VIEW_NAMES` = 64 个视图；一条连接最多 64 个订阅；视图名最多 200 个码点；超过 512 KiB（按紧凑 JSON 计）的值不发送（`too_large`；上一次发出的值保持有效）。

### 10.3 谁看到什么

每个内置视图都按查看者、由服务器针对每个查看者的投影算出：玩家看到玩家能看的，管理员还能看到对玩家隐藏的（视图里有这类条目时标 `hidden: true`），旁观者看到桌面看到的。同一成员的几条连接，身份、语言和角色都相同时，共用一次计算。成员的角色或身份变了，下一次刷新就按新的查看者计算。

名为 `admin/…` 的视图只给管理员。其他任何人都收不到，连空的也收不到：`view.list` 不列出它们，`view.subscribe` 对它们回答 `unknown_view`，`view.get` 拒绝它们。

### 10.4 内置视图

JSON Schema 在协议包里（`BUILT_IN_VIEW_SCHEMAS`），也在 `view.list` 里。

**`me`**：查看者和他扮演的角色。

| 字段 | 类型 | 含义 |
|---|---|---|
| `member` | `{id, name, role, roleLabel}` | `roleLabel` 是查看者语言里的身份名。 |
| `character` | object 或 `null` | 旁观的人（没有角色）为 `null`。 |
| `character.id`, `.name`, `.pack` | string | `pack` 是角色的规则系统 id。 |
| `character.status` | string[] | 状态。 |
| `character.resources` | `[{id, label, value, max}]` | HP、理智之类的量表。 |
| `character.attributes`, `.skills` | `[{key, label, value, derived?}]` | `value` 是数或字符串。只有角色卡是查看者自己的时才填。`derived: true` 标出规则系统由别的值算出来、角色卡上不存的值（排在存着的值后面）。不要提供修改推算出的属性：设置它会被拒绝（`sheet_write`）。设置推算出的技能会让这个技能有自己的值，此后列出时就不再带这个标记。 |

**`party`**：谁在桌上，各自扮演什么，以及战斗的顺序。

| 字段 | 类型 | 含义 |
|---|---|---|
| `members` | `[{id, name, role, online, character}]` | 先是在线成员，再是不在线但已入座的成员。不在线的 `role` 为 `null`；`character` 是角色 id 或 `null`。 |
| `characters` | `[{id, name, pack, status, resources, player}]` | 每个已入座的角色，以及房间保存的、不在角色池里供选用的其他角色（同伴）。`player` 是 `{id, name}` 或 `null`。 |
| `initiative` | `{round, acting, order: [{name, value}]}` 或 `null` | 没有战斗时为 `null`。`acting` 是名字或 `null`。 |

**`scene`**：桌面正在看的东西，以及时间。

| 字段 | 类型 | 含义 |
|---|---|---|
| `name`, `focus` | string | 未设置时为空字符串。 |
| `established` | `[{text, at}]` | 场景里已确立的事实；`at` 是时间文本或 `null`。 |
| `time` | string 或 `null` | 时钟的文本。 |
| `clockModule` | string 或 `null` | 掌管时钟的模组；由守秘人掌管时为 `null`。 |
| `round` | integer 或 `null` | 有战斗时是战斗轮次，否则是模组时钟的轮次，再否则为 `null`。 |

**`variables`**：这个查看者能看的房间变量。

| 字段 | 类型 | 含义 |
|---|---|---|
| `module` | `[{id, kind, label, value, valueLabel?, min?, max?, options?, hidden?}]` | 声明的变量。`kind` 是 `number`、`bool`、`text` 或 `enum`；`value` 是数、布尔或字符串。 |
| `tree` | `[{path, value, description?, hidden?}]` | 导入的变量树的叶子；`value` 是标量或标量列表。 |

玩家只看到玩家可见的变量和已展示的叶子；管理员看到全部，玩家看不到的标 `hidden: true`。

**`characters`**：可以扮演什么。

| 字段 | 类型 | 含义 |
|---|---|---|
| `claimable` | `[{id, name, blurb, source: {kind, id}, player}]` | 供选用的角色；`source.kind` 是 `pack` 或 `module`；`player` 是扮演它的人的 `{id, name}`，或 `null`。 |
| `systems` | `[{id, label, active}]` | 能创建新角色的规则系统；`active` 标出房间用的那个。 |
| `mine` | string 或 `null` | 查看者扮演的角色的 id。 |

**`commands`**：`{commands: [entry]}`，这个查看者的命令表（[6.5](#65-发现命令commands-视图)）。

**`room`**：房间的设置。

| 字段 | 类型 | 含义 |
|---|---|---|
| `locale`, `localeLabel` | string | 房间的语言，以及它在查看者语言里的名字。 |
| `system` | `{id, label}` 或 `null` | 当前的规则系统。 |
| `variant` | string 或 `null` | 它里面的房规阶梯；默认为 `null`。 |
| `keeperMuted` | boolean | 为 `true` 时守秘人不回应。 |
| `uploads` | boolean | 能否向房间上传文件——对所有人、所有用途（分享、导入、音频）都一样。服务器不保存文件时为 `false`。 |

**`usage`**：房间上一个守秘人回合的 token 数字，以及守秘人所用模型的上下文窗口。守秘人的上下文有多满：`last.inputTokens / contextWindow`。

| 字段 | 类型 | 含义 |
|---|---|---|
| `last` | object 或 `null` | 第一个回合之前（以及故事重置之后）为 `null`。 |
| `last.turn` | integer | 回合。 |
| `last.inputTokens`, `.outputTokens`, `.cachedInputTokens`, `.cacheWriteTokens`, `.reasoningTokens` | integer | 服务商报告的数字。`inputTokens`、`cachedInputTokens` 和 `cacheWriteTokens` 是这个回合守秘人最后一次模型调用的（那次的提示词就是当时的全部上下文）；`outputTokens` 和 `reasoningTokens` 是这个回合各次调用累加的。 |
| `last.estimated` | boolean | 提示词的大小由引擎估算：服务商没有报告。 |
| `contextWindow` | integer | 可选。以 token 计：守秘人下一个回合所用模型的上下文窗口。管理员 `model set` 之后跟着变。 |
| `contextWindowKnown` | `false` | 服务器不知道这个模型的窗口、`contextWindow` 是它的默认值（32,000）时才有；管理员用 `model set … context=N` 给出真实的值。 |

**`packs`**：内容扩展包，按名字。

| 字段 | 类型 | 含义 |
|---|---|---|
| `packs` | `[{id, version, name, enabled, cards: [{file, name, kind}]}]` | 管理员看到每个已安装的扩展包，各自带着本房间是否启用；其他人看到本房间启用的扩展包。`kind` 是 `world` 或 `character`。 |

**`panels`**：这个查看者的面板列表（[10.6](#106-面板)）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `panels` | `[entry]` | 房间已启用扩展包里开着、且列给这个查看者的面板，先按扩展包启用的顺序，再按每个扩展包声明的顺序。 |
| `entry.id` | string | `<pack>/<panel>`。 |
| `entry.title` | string | 用查看者的语言。 |
| `entry.slot` | string | `sidebar`、`tray` 或 `modal`。文本客户端可以把三种都并进侧栏。 |
| `entry.kind` | string | `template` 或 `page`。 |
| `entry.views` | `[{as, view}]` | 面板读取的视图，每个挂在它的路径所用的句柄下。订阅每一个 `view`。 |
| `entry.source` | `{kind, id}` | `kind` 是 `pack`（3.0 里唯一的来源；`room` 留给房间自己发布的面板）。 |
| `entry.blocks` | `[template block]` | 模板的块。 |
| `entry.page` | `{hash, size, mime}` | 页面的 HTML（`mime` 为 `text/html`），用哈希通过字节通道获取（[11.3](#113-get)）。 |
| `entry.fallback` | `[template block]` 或 `null` | 给运行不了页面的客户端的模板；为 `null` 时：显示一行“需要富客户端”。 |

**`audio`**：房间的音频库，以及每个循环层正在放什么（[9.4](#94-audio)）。

| 字段 | 类型 | 含义 |
|---|---|---|
| `library` | `[sound]` | 房间管理员以 `purpose: "audio"` 上传的声音（最早的在前），然后是房间已启用扩展包的音频提示。 |
| `sound.hash`, `.mime`, `.size` | string, string, integer | 通过字节通道获取它所需的东西（[11.3](#113-get)）：每个查看者都有，用于预取。非管理员每个文件只拿到一次，别的什么都没有。 |
| `sound.id` | string | 仅管理员。音频库 id：扩展包的音频提示是 `<pack>/<cue>`，上传的声音是哈希。`bgm`/`ambience`/`sfx` 的 `query` 接受的就是它。 |
| `sound.title` | string | 仅管理员。 |
| `sound.layer` | string 或 `null` | 仅管理员。`bgm`、`ambience` 或 `sfx`：它打算用在哪一层（上传的声音在管理员设置之前为 `null`）。 |
| `sound.tags` | string[] | 仅管理员。 |
| `sound.source` | `{kind, id}` | 仅管理员。`kind` 为 `upload`（`id` 为 `null`）或 `pack`（`id` 为扩展包）。 |
| `playing` | `{bgm?, ambience?}` | 每个循环层正在放什么；没在放的层不出现。`sfx` 从不在这里。 |
| `playing.<layer>` | `{id, title, hash, mime, size, loop, volume, paused}` | 声音（它的音频库 id、标题和获取所需的东西），是否循环，音量（0 到 1），是否暂停。所有查看者都有。 |

玩家只看到获取所需的东西，因为声音的名字也是内容：扩展包音频提示的标题和管理员上传的声音，可能在桌面听到之前就把故事说出去。正在播放的东西对所有人都写出名字。

**`admin/model`**（仅管理员）：每个模型通道和图片生成当前用的是什么。对整个服务器生效：任何一个房间的管理员运行 `model` 或 `imagegen`，所有房间的管理员看到的都会变。

| 字段 | 类型 | 含义 |
|---|---|---|
| `lanes` | `[lane]` | `keeper`、`npc`、`scribe`、`director`、`memory`（编年史折叠），按这个顺序。 |
| `lane.source` | string | `override`（管理员设置的）、`environment`（服务器自己的设置）、`default`（什么都没设置：守秘人没有模型；其他通道用守秘人的）。 |
| `lane.sameAsKeeper` | boolean | 该通道用的是守秘人的客户端。 |
| `lane.provider`, `.model`, `.baseUrl`, `.wire`, `.effort` | string 或 `null` | `provider` 是预设 id 或管理员给某个端点起的名字；服务器设置里只按地址指定的端点为 `null`。`wire` 是 `openai-compatible`、`anthropic` 或 `openai-responses`。 |
| `lane.contextWindow` | integer 或 `null` | 以 token 计；未知时为 `null`。 |
| `lane.key` | `{set, masked}` | 是否设置了密钥，以及它遮罩后的样子（没有时为 `null`）。从不给出密钥本身。 |
| `providers` | `[{id, preset, wire, baseUrl, credential}]` | 先是这个服务器知道的预设，再是管理员用自己起的名字保存的端点；`credential`：为它保存了密钥（或服务器设置里有一个）。 |
| `imagegen` | `{source, enabled, provider, model, size, baseUrl, key}` | 图片生成；`source` 同通道的（`enabled: false` 的 `override` 就是 `imagegen off`）。 |
| `imageProviders` | `[{id, credential}]` | `openai`、`xai`，然后是保存的名字。 |

**`admin/keys`**（仅管理员）：本房间的访问钥匙。从不包括别的房间的。

| 字段 | 类型 | 含义 |
|---|---|---|
| `keys` | `[{id, name, role, masked, created?, online}]` | `id` 是 `key` 命令接受的，从不是钥匙本身。`masked` 是钥匙的首尾几个字符。在开始记录创建时间之前签发的钥匙没有 `created`（毫秒）。`online`：此刻有人用它连着。钥匙变化时、成员连接或离开时刷新。 |

**`admin/content`**（仅管理员）：本房间能用什么、开了什么。

| 字段 | 类型 | 含义 |
|---|---|---|
| `skills` | `[{id, title, enabled, source}]` | 本房间可以启用的守秘人技能（内置的，以及已启用扩展包的）。 |
| `ruleSystems` | `[{id, title, enabled, source}]` | 服务器的规则系统；`enabled` 标出房间用的那个。 |
| `packs` | `[{id, title, version, enabled}]` | 已安装的扩展包；`enabled`：本房间启用了它。 |
| `source` | `{kind, id}` | `kind` 为 `builtin`（`id` 为 `null`）或 `pack`（`id` 为扩展包）。 |

### 10.5 模组视图

模组可以发布名为 `<module>/<name>` 的视图，每个带着模组声明的 JSON Schema 和标题（由 `view.list` 列出）。模组为每个查看者计算值，服务器不加过滤地转发，只发给那个查看者；超过 512 KiB 的值被丢弃。它们的形状由模组决定；不认识某个模组视图的客户端，通用地渲染它，或者干脆不渲染。以 `admin/` 开头的名字是保留的，模组永远不会提供。

### 10.6 面板

面板是故事旁边常驻的界面，由扩展包提供（[LWF panels](lwf/formats/panels.md)）。它的数据**只来自视图**：没有面板帧。客户端：

1. 订阅 `panels`，以及每个条目在 `views` 里指定的每个视图；
2. 对 `template`，调用 `instantiate({views, blocks}, values)`——`values` 是按名字排列的各视图数据——并绘制得到的块（与 `blocks` 事件相同的 `Block` 词汇，[8.3](#83-blocks)）；对 `page`，能的话在沙箱 frame 里运行 HTML，不能就实例化 `fallback`，再不行就显示一行“需要富客户端”；
3. 把 `choices` 选项以及页面做的任何事，以查看面板的成员身份作为 `command.run {id: command, args}`（[6.2](#62-两个入口)）发出。

模板块是一个 `Block`，它的字段可以是**绑定** `{"$view": "<path>"}`，任何块上还可以有 `visible_when`（一个条件），另外还有结构 `{"repeat": {"each": "<path>", "as": "<handle>", "prefix"?: "…", "block": <block>}}`。路径是 `<handle>.<segment>…`：句柄是条目 `views[].as` 之一（在 repeat 里也可以是它的 `as`）；一个 segment 指记录的一个属性、列表里按下标的一个元素，或列表里按 `id`/`key`/`path` 的一个元素。标了 `hidden` 的元素从不读取。解析不出的绑定会丢掉它所在的块（必填字段）或字段（可选字段）；判断不了的条件会隐藏它所在的块。语法、上限和完整规则见 LWF 面板文档 §4–§6；协议包里的 `instantiate`、`panelBlocks` 和 `panelViewNames` 实现了它们，包里的 `panels.vectors.json` 是每个实现都必须吻合的对照表。

```json
{"type":"view","name":"panels","rev":1,"at":12,"data":{"panels":[{"id":"harbor/tide","title":"The tide","slot":"sidebar","kind":"template","views":[{"as":"tide","view":"harbor/tide"}],"source":{"kind":"pack","id":"harbor"},"blocks":[{"kind":"meter","label":"Tide","value":{"$view":"tide.level"},"min":0,"max":10},{"kind":"text","text":"Flood warning!","style":"warning","visible_when":"tide.level >= 8"}]}]}}
```

给成员列哪些面板由服务器决定：扩展包限定给管理员的面板，或读取某个 `admin/*` 视图的面板，从不出现在玩家的 `panels` 里。页面的 HTML 和面板的图片是房间的不列出的媒体：房间成员可以获取（仅限管理员的页面只有管理员能获取），哪里都不列出，其他任何房间都不知道它们。

## 11. 字节通道

### 11.1 流

文件在控制流旁边自己的流上传输。每次操作是同一连接上的一个新双向流：客户端写**一行头**（紧凑 JSON 加 `\n`），服务器回一行头，GET 的话再跟上字节；然后服务器结束这个流。

- 每条连接同时最多打开 `MAX_BYTE_STREAMS` = **4** 个字节流（控制流不算）；第五个以 `too_many_streams` 拒绝。
- 头这一行最多 `MAX_BYTE_HEADER_BYTES` = **2048** 字节，含换行（`header_too_long`）。
- 一个流 `BYTE_STALL_MS` = **30 秒**内什么都没收到就会被关闭（`stalled`）。
- 连接必须已经收到 `welcome`（否则 `not_open`，会话结束后也是）。
- 被拒绝的流收到一行错误后关闭。连接及其控制流永远不受影响。

内容按**哈希**寻址：字节内容的小写十六进制 SHA-256，正好 64 个字符。

### 11.2 申报文件

上传从控制流上的 `call media.offer` 开始：

| 参数 | 类型 | 含义 |
|---|---|---|
| `name` | string | 文件名，最多 255 个码点（存储时会清理）。 |
| `mime` | string | 文件类型（最多 128 个字符）。 |
| `size` | integer | 字节数，大于 0。 |
| `sha256` | string | 字节内容的小写十六进制 SHA-256。 |
| `purpose` | `share`（默认）、`import`、`audio` 或 `save` | `share`：文件成为房间媒体，字节到齐后桌面看到一个 `media` 事件。`import`：给 `import` 命令用的卡片文件（[11.6](#116-导入卡片)），存在只有管理员能获取的地方，不通知任何人。`audio`（仅管理员，仅声音）：给房间音频库的声音，每个成员都能获取，没有事件宣布；它以去掉扩展名的文件名为标题加入 `audio` 视图的音频库（[10.4](#104-内置视图)）。`save`（仅管理员）：给 `save import` 用的房间存档（[6.7](#67-房间生命周期命令客户端视角)），存在只有管理员能获取的地方，不通知任何人。 |

成功时回答以下之一：

- `{"upload_id":"…"}`：用 PUT 发送字节（[11.4](#114-put)）。这个 id 只能用一次，限这个成员，15 分钟内有效。
- `{"existing":{hash, mime, size, name, from}}`：房间已经有这些字节了；什么都不用发。对 `share`，文件会再次向桌面宣布（一个新的 `media` 事件，`from` 是申报的成员）。对 `import`，文件已经可以给 `import` 命令用了。对 `audio`，声音已在音频库里（本来就在，或者房间原本就把这些字节作为每个成员都能获取的文件保存着）。对 `save`，这个文件（房间最新一次导出，或另一位管理员上传的存档）已经可以给 `save import` 用了。`existing` 回答从不给出申报者自己获取不到的文件。

接受的类型：`image/png`、`image/jpeg`、`image/webp`、`image/gif`、`image/svg+xml`（一个受限的子集）、`audio/mpeg`、`audio/ogg`、`audio/wav`、`audio/flac`、`audio/mp4`、`audio/aac`。`purpose: "import"` 只接受 `image/png`（内嵌数据的卡片）和 `application/json`；`purpose: "audio"` 只接受 `audio/…` 类型；`purpose: "save"` 只接受 `application/json`（字节开头必须像一个 JSON 对象）。

默认上限：单张图片最多 8 MiB，每个房间的图片共 512 MiB；单个声音最多 128 MiB，每个房间的声音共 2048 MiB（这两项由运营者设置）；单个存档最多 256 MiB，每个房间的存档共 512 MiB（最新一次导出加一次上传）；每个成员在每个房间每分钟 10 次申报（被拒绝的申报也算一次）；一个房间的音频库最多 100 个上传的声音。卡片文件算在图片的额度里；存档不管是上传的还是导出的，都算在自己的额度里。超过上限就拒绝（`media_too_large`、`media_quota_exceeded`），从不截断。

拒绝：`invalid_params`（某个字段形状不对）、`media_unavailable`（服务器不保存文件）、`observer_upload`、`forbidden`（非管理员申报 `audio` 或 `save`）、`audio_library_full`、`media_disabled`（房间的上传开关关着）、`media_rate_limited`、`media_bad_mime`、`media_bad_offer`、`media_too_large`、`media_bad_hash`、`media_quota_exceeded`。

### 11.3 GET

```
client: {"op":"get","hash":"<64 hex>"}\n
server: {"op":"get","ok":true,"hash":"…","size":<n>,"mime":"…","name":"…"}\n  then exactly <n> bytes
```

成员能获取房间在其身份可见的范围内保存的东西：房间媒体（共享的文件、演出图片）、音频库的声音和房间已启用扩展包的文件，所有人都能获取（只有仅限管理员的面板用到的，限管理员）；导入文件、存档文件（房间的导出和上传的存档）和团报的复盘版只限管理员——看的是发出请求的这条连接在请求那一刻的身份。别的房间里的哈希、这个身份不能看的哈希、谁都没有的哈希，回答都一样：`media_not_found`。

### 11.4 PUT

```
client: {"op":"put","upload_id":"<id>"}\n  then exactly the offered size in bytes, then it finishes its side of the stream
server: {"op":"put","ok":true,"hash":"…","size":<n>,"mime":"…","name":"…"}\n
```

客户端发完正文后**必须结束自己的发送侧**：服务器靠读到流的结尾来确认正文结束，一直开着的流会被当作 `stalled` 关闭。存储任何东西之前，字节会先经过检查（大小精确、SHA-256、声明类型的文件签名、SVG 子集）。对 `share`，`media` 事件先发给桌面，然后才是 PUT 的回答行。

PUT 的拒绝：`media_unknown_upload`（这个成员没有该 id 的待传申报：从没申报过、过期、已经用过，或房间被清空了）、`media_size_mismatch`（字节比申报的多或少）、`media_hash_mismatch`、`media_bad_signature`、`media_bad_svg`、`media_quota_exceeded`、`media_disabled`、`media_bad_upload`、`media_storage_failed`、`audio_library_full`（期间另一次上传把音频库填满了；字节不保留）。任何失败的 PUT 都会用掉这次申报：重新申报。

### 11.5 错误

```
server: {"ok":false,"code":"<stable code>","message":"<in the member's language>"}\n
```

字节通道自己的错误码：`bad_request`（头不是这个通道认识的请求）、`header_too_long`、`too_many_streams`、`stalled`、`not_open`、`byte_failed`（服务器出错；什么都没保留）；以及上面那些媒体错误码。

### 11.6 导入卡片

卡片（PNG 或 JSON 格式的 SillyTavern 角色卡，或 JSON 格式的原生卡片）分两步导入：用 `media.offer {purpose: "import"}` 上传（回答是 `upload_id` 时再做一次 PUT），然后运行 `command.run import {file: <hash>, as: "character"|"world"}`。只有上传文件的那个成员能导入它（否则 `not_uploaded`）。作为 `character`，任何玩家都可以把它变成自己的角色；作为 `world`（仅管理员），它成为房间的世界，桌面听到一行写出它名字的 `narrative`。

## 12. 客户端守则

### 12.1 向前兼容

同一主版本内的小版本只做增量。客户端：

- **忽略**未知 `type` 的帧、未知 `kind` 的事件（但要计入它的 `seq`，[7.6](#76-在本地保存日志)）、未知 `kind` 的信号，以及未知 `kind` 的块（显示事件的其余部分）；
- 在任何地方都**忽略未知字段**；
- 对决定怎么渲染的字段，**不确定就不画**：已知字段带着这个版本不认识的值（某个 `speaker`、`format`、dice `kind`、`role`、reset `scope`、audio `action` 或 `layer`、notice `level`、块的 `tone` 或 `style`），或已知字段类型不对，这一帧就算格式有误，格式有误的帧被丢弃，不画错。唯一的例外是 `turn.activity`，它只用于展示：未知值直接略去；
- 给接受的东西设**上限**，超过上限的帧整个丢弃，而不是截断。参考解码器（`decode.ts`）用的是：短字符串（id、错误码、名字、视图名、语言、哈希、骰子的 `label`）256 个字符，文本（叙述、草稿片段、通知、结果的文本、块的正文、骰子的 `text`）200,000 个字符，骰子表达式 1024 个字符，每次掷骰 10,000 颗骰子，每个事件 256 个块，每个 `choices` 块 64 个选项，每个 `log.page` 回答 1000 个事件，rewind 的 `kept` 4096 项；
- 原样透传不透明的值：模组视图的 `view.data`、`result.data`、骰子的 `detail`。

内置视图的值会按它们的 schema 检查，但允许多出字段：更新的服务器可能给视图加字段。

### 12.2 语言

| 内容 | 语言 |
|---|---|
| 事件和信号（发给桌面的一切） | 房间的（`welcome.room.locale`；改过之后看 `room` 视图） |
| `result` 的文本和错误消息、`error` 帧、字节通道的错误 | 成员的（`hello.locale`） |
| 视图 | 查看者的（`hello.locale`） |

### 12.3 服务器发来的文本

每个字符串都来自人、守秘人、模组或卡片。把它当文本渲染。写到终端之前去掉终端控制字符：`loreweaver-protocol/v3` 为此导出了 `stripControlChars`。`format: "markdown"` 是服务器唯一标为 Markdown 的文本。

### 12.4 上限

| 上限 | 值 | 出处 |
|---|---|---|
| `input.text` | 8000 个码点 | `MAX_INPUT_CHARS` |
| `hello.name` | 64 个码点 | 服务器 |
| 控制流里的一行 | 8 MiB（`MAX_LINE_BYTES`） | `frames.ts` |
| `rid` | 1–64 个字符 | `frames.ts` |
| `command.run` `id` | 200 个码点 | 服务器 |
| 文本命令的参数字符串 | 4000 个码点 | 服务器 |
| 每行的内联掷骰 | 8 | 服务器 |
| 字符串参数（默认） | 4000 个码点 | 参数 schema |
| 列表参数（默认） | 64 项 | 参数 schema |
| `welcome` 之后的回放 | 200 个事件 | `RESUME_LIMIT` |
| `log.page` `limit` | 1–100 | `PAGE_LIMIT` |
| 每次 `view.subscribe` / `view.unsubscribe` 的名字数 | 64 | `MAX_VIEW_NAMES` |
| 每条连接的订阅数 | 64 | 服务器 |
| 视图名 | 200 个码点 | 服务器 |
| 视图值 | 512 KiB | 服务器 |
| 请求（`input`、`command.run`） | 每个成员突发 5 个，之后每 2 秒一个 | 服务器默认值 |
| 每条连接的字节流 | 4 | `MAX_BYTE_STREAMS` |
| 字节流头行 | 2048 字节 | `MAX_BYTE_HEADER_BYTES` |
| 字节流停滞 | 30 秒 | `BYTE_STALL_MS` |
| `upload_id` | 64 个字符 | `MAX_UPLOAD_ID_CHARS` |
| 申报的文件名 | 255 个码点 | `MAX_OFFER_NAME_CHARS` |
| 一个存档文件（导出或上传） | 256 MiB；每个房间的存档共 512 MiB | 服务器默认值 |
| 申报 | 每个成员在每个房间每分钟 10 次 | 服务器默认值 |
| 重置确认窗口 | 60 秒 | 服务器 |
| `model list` 回答里的模型 id | 500 个，每个 ≤ 200 个码点 | 服务器 |
| `model list` 等待服务商 | 15 秒 | 服务器 |

### 12.5 结果错误码

`result` 可能带的协议级错误码（命令拒绝见 [6.4](#64-拒绝)，上传拒绝见 [11.2](#112-申报文件)）：

| 错误码 | 来自 |
|---|---|
| `input_too_long` | 超过 8000 个码点的 `input` |
| `invalid_params` | `params`（或其中某个字段）形状不对的 `call` |
| `unknown_method` | 调用了服务器没有的方法的 `call` |
| `rate_limited` | `input`、`command.run` |
| `observer_speech` | 旁观者的一行发言 |
| `unknown_view`、`view_failed`、`too_large`、`not_open` | `view.get` |
| `command_failed` | 服务器运行命令时出错；什么都没改 |

## 13. 会话示例

### 13.1 一场跑团

下面每一行都是一帧，和它在连接上传输时完全一样（空白除外）。房间 `main` 说英语，用 `coc7` 规则系统，已经有两个事件：Bao 说了一句话，守秘人回答了。

**1. Ada 发 hello。** 第一次来：没有 `resume`。

```json
{"type":"hello","protocol":"3.0","key":"rT9vQ2xLm8Kc3PzW0aYbN5sEdF7gHjU1","name":"Ada","locale":"en","client":{"name":"my-client","version":"0.1.0"},"caps":[]}
```

**2. `welcome`，然后是两个事件的回放**（`head` 是 2，在回放上限之内，所以这就是整份日志）。

```json
{"type":"welcome","protocol":"3.0","server":{"name":"loreweaver","version":"3.0.0-alpha.0"},"room":{"id":"main","locale":"en"},"you":{"id":"m:15b5f3445045","name":"Ada","role":"player"},"features":[],"epoch":1,"head":2,"first":1}
{"type":"event","seq":1,"id":"2c1f8e7a-6b5d-4c3e-9f2a-1b0c9d8e7f6a","ts":1764240000001,"kind":"narrative","turn":1,"data":{"speaker":"player","name":"Bao","member":"m:b40a5aaa35ea","text":"I wait by the quay.","format":"plain"}}
{"type":"event","seq":2,"id":"7d6e5f4a-3b2c-4d1e-8f9a-0b1c2d3e4f5a","ts":1764240002410,"kind":"narrative","turn":1,"data":{"speaker":"kp","text":"The fog thickens.","format":"markdown"}}
```

**3. Ada 订阅两个视图。** 先到的是回答，然后每个视图一个 `view` 帧。Ada 还没有角色，所以 `me.character` 是 `null`。

```json
{"type":"call","rid":"r1","method":"view.subscribe","params":{"names":["me","room"]}}
{"type":"result","rid":"r1","ok":true,"data":{"problems":[]}}
{"type":"view","name":"me","rev":1,"at":2,"data":{"member":{"id":"m:15b5f3445045","name":"Ada","role":"player","roleLabel":"Player"},"character":null}}
{"type":"view","name":"room","rev":1,"at":2,"data":{"locale":"en","localeLabel":"English","system":{"id":"coc7","label":"CoC"},"variant":null,"keeperMuted":false,"uploads":true}}
```

**4. 一行带内联掷骰的发言。** 这一行立刻被接受：它的 `narrative` 事件（第 2 回合）和内联掷骰的 `dice` 事件发布出来，然后 Ada 的结果到达。接着是守秘人的回合：`busy`，两段草稿，替换它们的 `narrative` 事件（id 相同），`idle`。

```json
{"type":"input","rid":"r2","text":"I light the lantern. [[1d6]]"}
{"type":"event","seq":3,"id":"5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b","ts":1764240010000,"kind":"narrative","turn":2,"data":{"speaker":"player","name":"Ada","member":"m:15b5f3445045","text":"I light the lantern. [[1d6]]","format":"plain"}}
{"type":"event","seq":4,"id":"0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d","ts":1764240010001,"kind":"dice","turn":2,"data":{"actor":"Ada","kind":"roll","expr":"1d6","rolls":[6],"total":6,"text":"1d6 (6) = 6","detail":{"text":"1d6 (6) = 6","inline":true}}}
{"type":"result","rid":"r2","ok":true}
{"type":"signal","kind":"turn","data":{"status":"busy","actor":"Ada"}}
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","text":"The lantern catches, "}}
{"type":"signal","kind":"draft","data":{"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","text":"and the quay comes out of the dark."}}
{"type":"event","seq":5,"id":"9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b","ts":1764240014820,"kind":"narrative","turn":2,"data":{"speaker":"kp","text":"The lantern catches, and the quay comes out of the dark.","format":"markdown"}}
{"type":"signal","kind":"turn","data":{"status":"idle"}}
```

**5. 一个命令，两个入口。** 先打字，再用结构化调用：同一个命令，同样形状的结果。每次都在日志里放一个无回合的 `dice` 事件，并把总数回答给 Ada。不开启守秘人回合。

```json
{"type":"input","rid":"r3","text":".r 2d6"}
{"type":"event","seq":6,"id":"3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f","ts":1764240020000,"kind":"dice","data":{"actor":"Ada","kind":"roll","expr":"2d6","rolls":[5,5],"total":10,"text":"2d6 (5, 5) = 10","detail":{"text":"2d6 (5, 5) = 10"}}}
{"type":"result","rid":"r3","ok":true,"data":{"totals":[10]}}
{"type":"call","rid":"r4","method":"command.run","params":{"id":"roll","args":{"expr":"2d6"}}}
{"type":"event","seq":7,"id":"8f7e6d5c-4b3a-4f2e-9d1c-0b9a8f7e6d5c","ts":1764240025000,"kind":"dice","data":{"actor":"Ada","kind":"roll","expr":"2d6","rolls":[3,4],"total":7,"text":"2d6 (3, 4) = 7","detail":{"text":"2d6 (3, 4) = 7"}}}
{"type":"result","rid":"r4","ok":true,"data":{"totals":[7]}}
```

**6. Ada 试图撤销。** `undo` 是管理员命令：拒绝只给 Ada。

```json
{"type":"input","rid":"r5","text":".undo"}
{"type":"result","rid":"r5","ok":false,"error":{"code":"forbidden","message":"That is for the room admin."}}
```

**7. 管理员撤销上一个回合。** 在管理员的连接上：

```json
{"type":"call","rid":"a1","method":"command.run","params":{"id":"undo","args":{}}}
```

每个成员，包括 Ada，都收到 `rewind`。它删除 `seq` 3 起的一切：第 2 回合（发言、它的掷骰和回复），以及第 2 回合开始之后的那两次掷骰。房间现在处于 `epoch` 2。

```json
{"type":"event","seq":8,"id":"6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d","ts":1764240030000,"kind":"rewind","data":{"from":3,"kept":[],"epoch":2}}
```

管理员自己收到的回答：

```json
{"type":"result","rid":"a1","ok":true,"text":"Rewound 1 turn(s); the room is back at the end of turn 1.","data":{"turn":1,"epoch":2,"removedTurns":[2]}}
```

Ada 的日志现在有 `seq` 1、2 和 8。如果她带着 `"resume":{"epoch":1,"after":8}` 重连，`welcome` 会说 `"epoch":2`：她丢弃自己的日志，重新接收回放。

### 13.2 字节通道

Ada 共享一张 48,213 字节的 PNG。在控制流上：

```json
{"type":"call","rid":"r6","method":"media.offer","params":{"name":"map.png","mime":"image/png","size":48213,"sha256":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"}}
{"type":"result","rid":"r6","ok":true,"data":{"upload_id":"c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a"}}
```

在一个新流上，先是 PUT 的头，然后是 48,213 个字节，然后 Ada 结束她这一侧：

```json
{"op":"put","upload_id":"c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a"}
```

桌面（包括 Ada）在控制流上看到文件到达：

```json
{"type":"event","seq":9,"id":"e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b","ts":1764240040000,"kind":"media","data":{"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","mime":"image/png","size":48213,"name":"map.png","from":"m:15b5f3445045"}}
```

PUT 流给出回答，然后关闭：

```json
{"op":"put","ok":true,"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","size":48213,"mime":"image/png","name":"map.png"}
```

Bao 在他自己的一个流上获取它；回答行之后正好跟着 48,213 个字节：

```json
{"op":"get","hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"}
{"op":"get","ok":true,"hash":"3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d","size":48213,"mime":"image/png","name":"map.png"}
```

房间没有的哈希（或 Bao 不能看的哈希）：

```json
{"ok":false,"code":"media_not_found","message":"No such file."}
```

## 14. 3.0 还没有的

以下内容在设计里有定义，或在代码里有保留，但 3.0 没有实现：

- **`features` 和 `caps` 的取值。** 两个列表都在；服务器发 `features: []`，忽略 `caps`。
- **运行页面。** `panels` 视图会列出页面，字节通道也提供它们的 HTML；但还没有参考客户端能运行页面（终端客户端显示 fallback）。页面桥接由桌面客户端来定义。房间在运行时发布的面板（`source.kind: "room"`）是保留的：没有服务器会产生它们。
- **`turn.activity`、`turn.round` 和 `notice.spinner`** 在帧里有定义，但不发送。
