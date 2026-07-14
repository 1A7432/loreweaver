# Discord 与 QQ 机器人（实验性）

Discord 与 QQ 官方机器人和终端客户端共用房间、确定性骰子、命令、媒体库与 Keeper
核心。平台层只翻译原生事件和控件；按钮与应用命令最终仍进入现有 `CommandRouter`。

在运营者提供测试 Bot 并完成下方真平台清单前，两端都保持 **Experimental**。Telegram
与飞书仍是基础文本适配器。

## 启动

Discord 需要 voice extra；QQ 直接使用核心依赖中的 `aiohttp`/`httpx`。

```bash
uv sync --extra discord
uv run python -m app --doctor
uv run python -m app --serve --platforms discord,qq
```

TUI 与两个 Bot 共用 `TRPG_DATA_DIR`、密钥库和逻辑房间。

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
`/help`、`/room`、`/model`、`/audio`。
共享面板在每个频道只保留一条可编辑消息；个人角色与 Keeper 结果使用私密 Interaction
响应。图片和音频作为 Discord 附件发送；`/audio join|leave|play|pause|resume|stop|volume`
按逻辑房间控制一个播放器。

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
Markdown 模板发送，本身不会启用动态按钮。这些配置只决定载荷，测试 Bot 还必须获得对应
平台能力。未配置或富文本载荷被拒绝时自动降级为纯文本和编号命令。图片/音频在获权后走
QQ 两步富媒体上传；单个附件限制为 20 MiB，因为适配器不实现 QQ 大文件分块协议。QQ 不模拟
Discord 语音频道。

QQ 群回复窗口受平台限制。Loreweaver 使用按逻辑房间隔离的有界 FIFO outbox，在下一次
合法入站回复时刷新；叙事保持顺序，面板状态可合并，API 失败的消息不会被误标为已送达。

## Keeper 绑定

在已认证的终端 Keeper 会话中生成一次性 `chat_bind` token，再在 Bot 私聊/C2C 发送
`/bind <token>`。token 被消费并把该平台用户绑定到 token 的房间；`/unbind` 撤销绑定。
只有用户绑定房间与群当前逻辑房间一致时，群命令才提权；仅仅私聊 Bot 不会获得 Keeper。
Discord 的这两个命令需在 Bot 私聊中输入，不会注册到服务器命令树。

一个自托管进程就是一个运维信任域：所有已认证 Keeper 都可以修改部署级模型和图像提供商配置。互不信任的 Keeper 应分别运行实例。

不要在公开频道粘贴 provider key、邀请 key、Keeper 秘密或备份文件。

## 真平台发布清单

- 在 DM/C2C 绑定并撤销 Keeper；确认未绑定用户和另一房间都被拒绝。
- 把 Discord、QQ、TUI 连接到同一房间；核对行动、真实骰子、叙事与个人状态。
- 覆盖斜杠命令/组件、QQ 富文本与纯文本降级、长叙事和附件。
- 重启 Bot；核对 Discord 面板、QQ 队列顺序与房间隔离恢复。
- 断网后确认 QQ heartbeat/resume/reconnect，且不重复消息。
- Discord 语音完整执行加入/离开/播放/暂停/恢复/停止/音量，并测试缺 ffmpeg 降级。
- 检查日志与公开房间：健康日志不含 provider key、邀请 token、Keeper lore 或剧情正文。
