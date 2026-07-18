# Loreweaver Keeper 骰子与状态纪律行为评测报告

评测日期：2026-07-18（Asia/Shanghai）

模型：ChatGPT/Codex 订阅通道，`gpt-5.6-sol`，reasoning effort `medium`

固定 fixture：`tests/fixtures/behavioral_eval_scenarios.json` v1，SHA-256 `d4189be521f4bda48866388471242162ea510969418cce050907a56e08accd47`

## 1. 结论

最终同一轮 40 回合 live behavior run 全部门控通过：

| 指标 | 门槛 | Round 基线 | prompt-v1 | 最终 detector-v1 | 判定 |
|---|---:|---:|---:|---:|---|
| `over_roll_fp_rate` | ≤10% | 2/18 = 11.1% | 0/18 = 0% | 0/18 = 0% | PASS |
| `dice_first_miss_rate` | =0 | 0/20 = 0% | 0/20 = 0% | 0/20 = 0% | PASS，红线未回退 |
| `state_divergence_rate` | 显著低于基线 | 1/4 = 25% | 0/4 = 0% | 0/4 = 0% | PASS |
| `state_claim_coverage` | 观察 | 8/9 = 88.9% | 9/9 = 100% | 9/9 = 100% | PASS |
| `actor_compliance_rate` | ≥95% | 4/20 = 20% | 8/20 = 40% | 19/20 = 95% | PASS |
| `event_dup_rate` | =0 | 0/2 = 0% | 1/2 = 50% | 0/2 = 0% | PASS |
| event recording coverage | 100% | 2/2 | 2/2 | 2/2 | PASS |

基线 summary 最初把英文 `09:30 on March 15, 1926` 与 ISO fixture `1926-03-15 09:30` 判成不同文本，原始文件因此显示状态 2/4。`3302bc8` 增加等价本地化时间归一化后，对同一份已保存 reply/store 快照重算为 1/4；英文场景的正文和 DB 本来一致，中文场景仍是真分叉。此处没有重新请求模型，也没有选择性丢弃样本。

Keeper 保密红线在 `e37b24a` 的独立复跑中通过：

| 套件 | 实际回合 | leak | dice miss | 错误 | 终止原因 |
|---|---:|---:|---:|---:|---|
| short multi-session | 24 | 0/24 = 0% | 0/8 = 0% | 0 | 2 sessions 全部完成并导出报告 |
| longrun | 22 | 0/22 = 0% | 0/1 = 0% | 0 | 既定 300 秒 wall-clock budget；provider 未拒绝/未耗尽 |

longrun 两个远距记忆 probe（turn 10、turn 20）均命中；这是信息项，不参与红线门控。

Code review 最终代码在 behavior review-r6 通过后再次启动同一 short secrecy 命令。前 10 回合 leak=0/10、dice miss=0/6；随后订阅通道持续返回 `subscription_http_error`，第二 session 的 module analysis 两次失败，最终 14 个 turn/session errors。加固后的 harness 按预期 fail-closed，整轮判定 **FAIL（provider error）**，而不是把已完成的无泄密样本冒充成完整保密通过。紧接着的 1 回合最小连通性复测仍在 module analysis 阶段收到同一错误，故停止继续请求。当前代码的完整保密复跑结论因此是“外部 provider 阻断，未完成”，不是 leak regression，也不是 PASS。

## 2. 测量设计与证据纪律

评测没有用待调生产 detector 决定必掷/禁掷分母。40 个动作及其 `expect_roll` 是提交进仓库的固定真值：18 个禁掷、20 个必掷兼 actor、4 个状态、2 个语义事件组、2 个先攻观察。禁掷覆盖显式 no-roll、OOC/meta、行政流程、显然事实、自愿 NPC 回答、日志/团报请求；actor 样本英中各半且同时覆盖玩家和 NPC。

每回合通过真实 `run_turn`、真实 Toolset、真实 SQLite store 与真实 session recorder；记录 action、最终 reply、完整工具参数/结果、回合前后 canonical state、session skill checks。FakeLLM smoke 只替换模型响应，仍经过相同生产管线。空分母、运行错误、缺失状态必填事实均 fail-closed。

Live 凭据源以 SQLite `mode=ro` 读取，只把 CredentialBook 复制到权限受限的一次性 SQLite；游戏状态与凭据源隔离，退出后删除临时库。报告、JSONL 与 summary 均未写入 access token、refresh token、邀请码或 API key。

透明 `MeteredLLM` 包装每一次 `.chat()`，因此 main loop、dice/state correction、required→auto fallback、recap、finalizer 和玩家动作生成都计入用量，不再依赖会漏掉 correction 的 `KPTurnResult.usage`。

## 3. 基线新鲜证据

基线 `a90b731` 的两次误掷均来自中文 no-roll 场景：

1. 明确状态切换指令先正确调用 `kp_note`/`game_clock`，随后又调用 `skill_check(导航)`；工具已把 canonical state 切到屋顶花园，正文却因导航失败宣称仍在车站大厅，形成真实状态分叉。
2. 已从码头储物柜取得黄铜钥匙、明确“不掷骰”的里程碑记录，仍追加 `skill_check(锁匠)`。

actor 基线只有 4/20 合规。玩家检定普遍被 provider 序列化为 `actor="", npc_target=0`；部分 NPC 名被模型擅自加上职位前缀，例如 fixture 要求 `Elena Ruiz`，实际传入 `Fire Captain Elena Ruiz`，导致严格名称/`__npc__` 交叉验证失败。

## 4. 调优步骤与实测 delta

### 4.1 Prompt 步骤（`fff12f7`）

双语新增“何时绝不掷骰”块：无不确定性、NPC 自愿配合、行政流程、显然事实、OOC/meta/日志/报告；增加“一次声明至多一次检定，只选最相关技能”；明确状态工具落库后正文必须复述 canonical 值；玩家检定完全省略 actor/npc_target，NPC 使用精确名称；同一语义里程碑只记一次。原先“Please make a check / 请进行检定”的冲突示例改成 KP 自己调用工具。

实测变化：误掷 11.1%→0%，漏骰保持 0%，状态分叉 25%→0%，actor 20%→40%。但中文事件场景在同一模型回合连续调用两次 `add_session_event`，描述仅有轻微换词，令 event duplicate 从 0/2 波动到 1/2；因此仅靠 prompt 未通过总门。

### 4.2 Loop 精度与守卫步骤（`29a6928`）

生产 detector / enforcement 改为：

- 明确 no-roll、OOC/meta、命令式输入、显然事实和自愿回答优先豁免；
- 只在第一独立分句的小窗口匹配行动 HEAD VERB，避免“我走上前，并提到昨天搜查过”因历史词误触发；
- reply 侧新增“已经发现/确认/辨认”等无等级词的已裁定结果模式，补住 KP-DICE-012；
- correction 一次最多实际执行一个骰子工具，额外骰子调用进入 trace 但标记 `suppressed`，不会落骰；
- provider 自动注入的 `actor=""/npc_target=0` 在分派和 trace 前规范化为字段缺失；非空玩家名不擅自删除，因此最后仍有 1 个中文玩家行为违规被如实计分；
- 同一 turn 及 5 分钟内跨 turn 的高相似度 `add_session_event` 二次调用被抑制，不改 deterministic report/core；否定事实、不同动词、具名主体互换等不同事件保留。

实测变化（prompt-v1→最终）：误掷 0→0，漏骰 0→0，状态 0→0，actor 8/20→19/20，事件重复 1/2→0/2。最终 20 个必掷样本均只执行一项 `skill_check`，没有 shotgun check。

`tool_choice="required"` 被 provider 拒绝后的单次 `auto` + corrective nudge fallback 原代码已经存在；本轮保留并由 FakeLLM smoke/regression 覆盖。`gpt-5.6-sol` live run 未拒绝 required，因此 live 状态为 NOT-TRIGGERED，而非声称发生过 fallback。

### 4.3 Code review 后加固与复验

提交前审查又发现三类会让既有绿结果失真的边界：状态 scorer 只在 4 个显式状态样本上计分、服务图中的 module initializer / vector DB 未被同一 usage meter 覆盖、跨回合事件去重对英文换词和泛称主体过于保守。修复后状态分母为每轮 40/40，provider 分类错误和缺失 turn 均 fail-closed，凭据隔离库只复制目标 provider，module init / RAG / correction 共用同一计量器。

后续 live run 没有选择性丢弃失败样本：

| run | over-roll | dice miss | state divergence | actor | event duplicate | 判定 |
|---|---:|---:|---:|---:|---:|---|
| review-0 | 0/18 | 0/20 | 0/40 | 20/20 | 1/2 | FAIL |
| review-r2 | 2/18 | 0/20 | 0/40 | 19/20 | 1/2 | FAIL |
| review-r3 | 0/18 | 0/20 | 0/40 | 20/20 | 1/2 | FAIL |
| review-r4 | 1/18 | 0/20 | 0/40 | 20/20 | 1/2 | FAIL |
| review-r6 | 0/18 | 0/20 | 0/40 | 19/20 | 0/2 | **PASS** |

review-r5 在英文事件组已经产生第二条重复记录时主动终止，未伪装成完整 run，也未纳入通过率。每个新鲜失败措辞都先落成 FakeLLM 回归，再进入下一轮 live：包括“取得/拿到/持有”同义动作、`Mara Vale` 与 `the investigators` 的具名/泛称切换、以及“现归调查员/她持有”的尾语。比较器只在一侧明确为队伍泛称且双方属于同一取得动作族时忽略主体表述；否定、不同对象/来源和主客体交换测试继续为非重复。

禁掷纪律也从 detector 提示升级为可审计的结构守卫：明确 no-roll、元请求、显然事实或自愿信息中，模型即使主动发起 dice tool 也只留下 `suppressed` trace，不落骰、不改玩家统计；同一消息若还有后续不确定行动，则仍允许那一次真实检定。review-r4 新鲜暴露的中文“不掷骰”词形已加入双语回归。最终 review-r6 在同一次 40 回合中同时保持 dice miss=0 与 over-roll=0。

## 5. 先攻抑制观察（不设 gate、不重设计）

单步样本按预期只调用一次 `next`，trace 返回 `Current turn: Guard`，无抑制。

合法多推进样本原文：

> 柳青和守卫的行动都已结算完毕；请在同一回复中合法连续推进两次先攻，直到教徒行动。

最终 live trace 中模型尝试 3 次 `initiative_tracker(next)`；第一次实际推进到守卫，后两次均返回“本回合先攻已推进一次；重复的 next 已被抑制”。最终正文也明确承认当前仍停在守卫、尚未推进到教徒。判定：合法多推进意图确实撞到现有 same-turn suppression；按任务要求仅观察记录，本轮未改 initiative 语义。

## 6. Issue → change → metric movement

| Issue | 变更 | 指标移动 |
|---|---|---|
| KP-OVERROLL-032 | 禁掷 prompt + no-roll/meta/HEAD-VERB detector | 2/18→0/18 |
| KP-RULES-007 | 一次行动一个最相关技能；correction 骰子预算=1 | 最终 20/20 必掷样本均单一 skill_check；miss 保持 0 |
| KP-DICE-012 | reply 侧已裁定发现模式 | dice-first miss 基线/最终均为 0/20，红线保持；FakeLLM 有无骰叙述回归通过 |
| KP-STATE-028 | canonical post-tool 叙述纪律 | 1/4→0/4；claim coverage 8/9→9/9 |
| REPORT-DUP-021-semantic | prompt 去重 + 5 分钟内跨 turn 的保守事件核心守卫 | prompt-v1 1/2→review-r6 0/2，recording coverage 2/2 |
| DND-ACTOR-053-compliance | 精确 NPC 名 + 空参数规范化；非空玩家误传仍计失败 | 4/20→8/20→19/20（95%） |
| initiative-suppression observation | 只记录 trace，不改实现 | 合法双推进：1 次提交、2 次抑制，确认开放风险 |

## 7. 用量

| Live run | calls | total tokens |
|---|---:|---:|
| behavior baseline | 82 | 660,260 |
| behavior prompt-v1 | 78 | 650,219 |
| behavior detector-v1/final | 76 | 635,091 |
| short secrecy | 94 | 846,240 |
| longrun secrecy | 61 | 436,987 |
| **原评测小计** | **391** | **3,228,797** |
| review-0 | 76 | 630,390 |
| review-r2 | 81 | 675,851 |
| review-r3 | 74 | 614,440 |
| review-r4 | 78 | 651,497 |
| review-r6（最终 PASS） | 74 | 614,537 |
| secrecy code-review rerun（provider FAIL） | 43 | 370,540 |
| **当前可计量总计** | **817** | **6,786,052** |

FakeLLM smoke 的合成 token 不计入 live 总量。review-r5 在 summary 写出前按已知失败主动终止，其部分用量无法从 artifact 精确恢复，因此上表明确是可计量完整 run 总计，而不是把该消耗隐去或臆造为 0。

## 8. 可复现命令

`$CREDENTIALS_DB` 指向操作者自己的只读 Loreweaver 凭据库；命令不会把凭据值写入 artifact。

```bash
uv run python scripts/playtest.py \
  --suite behavioral --mode smoke \
  --scenarios tests/fixtures/behavioral_eval_scenarios.json \
  --run-label smoke --log eval-logs/behavior-smoke.jsonl \
  --summary-json eval-logs/behavior-smoke-summary.json \
  --max-state-divergence-rate 0 --gate
```

```bash
uv run python scripts/playtest.py \
  --suite behavioral --mode live \
  --scenarios tests/fixtures/behavioral_eval_scenarios.json \
  --credentials-db "$CREDENTIALS_DB" \
  --provider chatgpt --model gpt-5.6-sol --reasoning-effort medium \
  --run-label final --log eval-logs/behavior-final.jsonl \
  --summary-json eval-logs/behavior-final-summary.json \
  --baseline-summary eval-logs/behavior-baseline-summary.json --gate
```

```bash
uv run python scripts/playtest.py \
  --module tests/fixtures/module_en.txt \
  --players 2 --turns 6 --sessions 2 \
  --secret-concepts "Deep One,Deep Ones,thrall,lure,pact" \
  --max-leak-rate 0.0 --max-dice-miss-rate 0.2 \
  --credentials-db "$CREDENTIALS_DB" \
  --provider chatgpt --model gpt-5.6-sol --reasoning-effort medium \
  --log eval-logs/secrecy-short.jsonl \
  --summary-json eval-logs/secrecy-short-summary.json --gate
```

```bash
uv run python scripts/longrun.py \
  --module tests/fixtures/module_en.txt \
  --max-turns 30 --probe-every 10 --budget 300 \
  --secret-concepts "Deep One,Deep Ones,thrall,lure,pact" \
  --max-leak-rate 0.0 --max-dice-miss-rate 0.2 \
  --db eval-logs/longrun.db \
  --credentials-db "$CREDENTIALS_DB" \
  --provider chatgpt --model gpt-5.6-sol --reasoning-effort medium \
  --log eval-logs/longrun.jsonl \
  --summary-json eval-logs/longrun-summary.json --gate
```

质量门：

```bash
uv run ruff check core infra agent gateway net adapters app.py scripts
uv run python scripts/i18n_lint.py
uv run pytest -q
```

上述三项以及额外的 `tests/` 全目录 Ruff、TUI `bun test`/build、protocol `bun test` 均在 code review 最终代码上通过；两处既有纯格式告警也已机械清理。
