# Loreweaver

**开源的 AI 守秘人:你和朋友出人,它来带团。**

*[English](README.en.md) · 中文*

想跑团的人不少,愿意当 KP 的永远缺。Loreweaver 补的就是这个位置:它读模组、记世界、扮演每一个 NPC、守住每一条线索,你只管坐下来说"我要做什么"。

它跟"和 AI 聊天"的根本区别是:**骰子是真的**。检定、伤害、理智,全由代码掷骰、按规则结算,AI 只负责把结果讲成故事——它编得出气氛,编不了点数。

支持《克苏鲁的呼唤》7 版和 D&D 5e(SRD),中英双语,服务器跑在你自己的电脑上。

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black)

> **实话实说**:项目还很年轻,基本是一个人带着 AI 写出来的。骰子和规则这部分最扎实,有整套离线测试盯着;终端客户端用起来也顺手了。联网多人和 AI 带团的稳定度还在磨——哪些能用、哪些还差点,[路线图](docs/roadmap.zh.md)里写得清楚。

## 它凭什么不一样

现有的工具就两类:骰子机器人(SealDice、Avrae)——骰子很硬,但没人带团;角色扮演聊天(SillyTavern/酒馆)——聊得热闹,但没有规则、没有世界,你永远不会失败。Loreweaver 把两边都缺的那块补上了:

| | 真骰子/规则 | AI 守秘人 | 持久世界+故事 | AI 队友 |
|---|:---:|:---:|:---:|:---:|
| 骰子机器人 | ✅ | ❌ | ❌ | ❌ |
| 人物卡聊天 | ❌ | ~ | ❌ | ~ |
| **Loreweaver** | ✅ | ✅ | ✅ | ✅ |

丑话说在前:AI 带团带得好不好,很看你接的是哪家模型。好模型会老老实实掷骰、贴着模组走;差模型爱嘴上说说、自由发挥。怎么选,见[快速上手](#快速上手)。

## 怎么玩

一条命令进游戏大厅,不用碰配置文件:

![Loreweaver TUI —— 真·终端截图:守秘人叙事、一次掷骰检定、右侧队伍花名册](assets/tui-zh.png)

- **建卡有四条路**:掷骰生成、手动逐项填(超预算界面直接拦)、写段人设让 AI 起草、或者把酒馆(SillyTavern)的卡直接丢进来。不管哪条路,最后都要过规则这一关——数值不合规,AI 说破天也没用。
- **键盘鼠标都能用**。KP 思考时有转圈提示,不用对着静止的屏幕干猜;顶栏摆着场景、游戏内时间、真实时间和 token 开销;掉线会自动重连,回来接着玩。
- 发邀请码、换模型、导模组是守秘人的事,用守秘人钥匙连进来才看得到这些页面。

## 开一局,叫朋友来玩

服务器你自己开,把 ticket 和邀请码发出去,朋友装个客户端就能进来。不用买域名、不用配证书、不用开端口。

**① 你(守秘人):起服务器**
```bash
python -m app --serve   # 打印一个 p2p ticket 和一把守秘人钥匙(也存成 iroh-ticket.txt / keeper-key.txt)
```
然后运行 `loreweaver`,在连接屏贴上 ticket 和钥匙。

**② 建房,给每人发一个邀请码**
主菜单进「房间与邀请」,填房间名和朋友昵称,发码。房名随便起,发码就算建房;想要个副 KP,就发一把守秘人角色的钥匙。

**③ 朋友:装客户端,连进来**
```bash
curl -fsSL https://1a7432.site/trpg/install.sh | bash   # Windows: irm https://1a7432.site/trpg/install.ps1 | iex
loreweaver     # 贴上你发的 ticket + 邀请码,起个昵称
```
没有注册这回事,邀请码就是入场券。

> ticket 存在服务器本地,重启也不会变——发一次,一直能用。客户端掉线会自己重连。图片、语音这些以后也走这条 p2p 通道(见[路线图](docs/roadmap.zh.md));协议细节在 [docs/protocol.zh.md](docs/protocol.zh.md)。

## 亮点

- **AI 是真的在带团,不是在陪聊**。掷骰、翻角色卡、记笔记、推时钟,都是它实际操作引擎完成的动作,一共 60 多个守秘人工具。接哪家模型都行,推荐 `deepseek-v4-pro` 开思考。
- **NPC 不开天眼**。每个 NPC、每个 AI 队友,只知道自己该知道的事,剧情的底牌根本不在它们手里——想剧透都没得透。缺人的时候,AI 队友真能顶上一个位置:用自己的卡,掷自己的骰。
- **想要什么,说一句就有**。新规则系统、新玩法、新模组,在管理页里描述一下,KP 当场写好、校验、装上就能用。写出来的全是通用格式(酒馆卡、世界书、SKILL.md、YAML 规则包),你收藏的老资源也能直接搬进来。细节见 [docs/plugins.md](docs/plugins.md)。
- **感情戏也有账本**。开了浪漫技能之后,好感和情欲是实打实的数值:涨了就是涨了,由代码记账,不看 AI 心情。
- **两套指令习惯都认**。中文 SealDice 那套(`.ra 侦查`、`.st 力量50`)和英文 Avrae 那套(`/roll 4d6kh3`、`adv/dis`),背后是同一个骰子引擎。
- **内容过滤默认关闭**。私人团想怎么跑怎么跑;真要开,也只过滤 KP 的输出,不碰玩家输入(见 [docs/deploy.zh.md](docs/deploy.zh.md#content-moderation))。

## 快速上手
```bash
uv sync                                  # 建环境、装依赖

# 先离线尝个鲜——不用 API key,内置演示 KP + 真骰子:
uv run python -m app --cli               # 试试  r 3d6+2 · /roll 4d6kh3 · .ra 侦查 · .setcoc 2

# 接真模型:复制 .env.example 为 .env,填上你的 key,再跑一次:
uv run python -m app --cli
# (没有 uv?python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev,anthropic,gemini]")
```
`.env` 这样写(以 DeepSeek 为例,别家同理,OpenAI 兼容或原生都行):
```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=max
```
> **模型别太省。** KP 全靠调用工具干活:强模型(deepseek-v4-pro 开思考、GPT-4 级、Claude)会真掷骰、贴着模组走;太便宜的模型常常嘴上说"你成功了"却根本没掷,还爱把团带偏。游戏里 `.model set <provider> [model]` 随时热切,不用重启。

**终端界面(真正的体验):**
```bash
uv run python -m app --serve   # 起 p2p 服务端,打印 ticket 和守秘人钥匙
# 另开一个终端:
cd clients/tui && bun install && bun run dev
```
把 ticket 和钥匙贴进连接屏就行。更省事的办法:直接点连接屏上的「本地开服」,这些它全帮你干了。

**玩家一行安装(不用克隆仓库):**
```bash
curl -fsSL https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh | bash   # Windows: irm https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.ps1 | iex
loreweaver          # 启动后贴上守秘人发你的 ticket + 邀请码
loreweaver update   # 客户端自更新
```
> 🇨🇳 GitHub 慢或连不上?换国内镜像:
>
> ```bash
> curl -fsSL https://1a7432.site/trpg/install.sh | bash   # Windows: irm https://1a7432.site/trpg/install.ps1 | iex
> ```

### 跑一台常驻服务器(可选)
多数团在笔记本上 p2p 就开了。想要 7×24 常驻,找台机器:
```bash
uv sync && uv run python -m app --serve   # 用 systemd 守着——见 docs/deploy.zh.md
```
首次运行会生成 `.env`,并自动发一把守秘人钥匙(打印出来,也存在 `keeper-key.txt`)。用它连进去,之后发码、建房都在客户端里做。数据(SQLite + 钥匙)就存在程序旁边。完整说明见 **[docs/deploy.zh.md](docs/deploy.zh.md)**。

## 游玩入口
| 入口 | 状态 |
|---|---|
| **终端 · OpenTUI** | ✅ **主力**——上面那个游戏大厅;本地或联网 p2p(Iroh) |
| CLI(无头) | ✅ 开发 / 快速试玩 / 离线 demo |

系统:D&D 5e SRD 和 CoC 7 版以数据驱动的 rulepack(`rulepacks/*.yaml`)随附——加新系统不用改代码。(Discord/Telegram/QQ/飞书这些聊天平台适配器还在仓库里,但没人维护、没在真平台上测过,见[路线图](docs/roadmap.zh.md)。)

## 架构
```
core/  确定性引擎        infra/  store · config · i18n · llm · embeddings · vector · providers
agent/ AI-KP 大脑 + 工具  gateway/ 平台无关层:commands · ops · hub · runner · director
net/   Iroh p2p + 会话核心  adapters/ cli(聊天适配器在树内、无人维护)   clients/ protocol · tui
```
引擎用稳定的 `chat_key` 隔离全部状态;RoomHub 再叠一层跨端实时广播。分层契约、铁律(确定性 vs 生成、掷骰优先、信息隔离),以及怎么加 rulepack / 适配器 / provider / 工具 / 客户端,都在 **[CLAUDE.md](CLAUDE.md)**。客户端线格式见 **[docs/protocol.zh.md](docs/protocol.zh.md)**。

## 测试
```bash
uv run pytest -q                            # 离线:FakeLLM + seed 骰子,不联网、不用 key
uv run ruff check core infra agent gateway net adapters app.py scripts
uv run python scripts/i18n_lint.py          # 不许有硬编码的文案
cd clients/tui && bun install && bun test   # 客户端(protocol · tui)
```
测试全程离线、结果可复现。自 play 测试用脚本化的 KP 把整条链路跑一遍(传模组 → 分析 → 开团 → 玩家行动 → 真骰检定 → 战报);"秘密进不了玩家池""NPC 只由自己的档案组装"这些底线,各有专门的红线测试守着。

离线测试证明的是流程正确;真模型守不守规矩,另有一道每夜跑的真模型检查(`.github/workflows/redline-eval.yml`):用便宜的真模型给每一回合打分,剧透率或"光说不掷"率超过阈值就报警。它只按计划跑、不卡 PR;没配 `EVAL_LLM_API_KEY` 时自动跳过。CI(push/PR)跑 Python 3.11/3.12 和各客户端包,全程离线。

## 参与贡献
欢迎 PR 和 issue。提交前把这些跑绿:`uv run ruff check …`、`uv run python scripts/i18n_lint.py`、`uv run pytest -q`(以及相关的 `bun test`)。守住 [CLAUDE.md](CLAUDE.md) 里的铁律——尤其是文案必须走 i18n、信息隔离不能破。规则内容只收开放许可的(SRD / 米斯卡塔尼克);模组请运行时自备。最缺人手的地方列在[路线图](docs/roadmap.zh.md)里。

## 安全
别提交任何密钥——`.env`、发出的钥匙、SSH host key、数据库都已 gitignore(只提交 `*.example.*`)。

没有账号系统:邀请码就是通行证,它把玩家绑到某个房间、带玩家或守秘人角色。要面向可信小圈子以外开放,请自己在前面加鉴权和 TLS,别直接裸奔公网——任何自托管服务都该有的卫生习惯。

发现漏洞?请在 GitHub 开私有安全通告,别开公开 issue。

## 许可与致谢
MIT——见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。含 **D&D 5e SRD 5.1**(CC-BY-4.0)材料;克苏鲁内容仅限开放 / 米斯卡塔尼克仓库许可范围。gateway/适配器层派生自 **hermes-agent**(MIT,© 2025 Nous Research);骰子引擎是 **avrae/d20**(MIT);中文命令方言、CoC 成功函数与技能别名表参照 **SealDice**(MIT)重写;终端客户端用 **OpenTUI**。本仓库不随附任何受版权保护的冒险/模组文本。

## 路线图
完整计划见 **[docs/roadmap.zh.md](docs/roadmap.zh.md)**。更远的方向:会生长的世界引擎(生成式世界、活的因果时间线、设定一致性)、迟到玩家的剧情追进度、D&D Beyond 角色卡导入,以及把聊天适配器放到真平台上端到端测一遍。
