*[English](authoring.md) · 中文*

# 做一个 Loreweaver 扩展包

*从一个空目录，做到一个在房间里启用、真能起作用的扩展包；再把扩展包能带的每一种内容走一遍。*

**扩展包**（pack）是内容进入 Loreweaver 服务器的方式：一个 `.lwpack` 文件（一个 ZIP 压缩包，根目录有一份 `pack.yaml` 清单），里面可以有模组（代码）、卡和卡里的设定、规则包补丁、给守秘人的技能、面板，以及带图片和声音的演出包。服务器会先把整个扩展包校验一遍，然后才写下第一个文件。

这一页讲做事的顺序。格式本身在 [LWF](lwf/SPEC.md) 里规定：[pack.md](lwf/formats/pack.md)（清单、拒收规则、信任卡）、[panels.md](lwf/formats/panels.md)、[cards.md](lwf/formats/cards.md)、[rulepacks.md](lwf/formats/rulepacks.md)，以及 [skills-hooks.md](lwf/formats/skills-hooks.md) §1。这一页和格式文档说法不一致时，以格式文档为准。哪些东西可以扩展、信任模型是什么，见 [plugins.zh.md](plugins.zh.md)。卡有单独一份指南：[cards.zh.md](cards.zh.md)。格式文档都是英文的。

**`loreweaver` 命令。** 下文的 `loreweaver` 指服务器的命令行：编译好的可执行文件，或者在本仓库的检出目录里用 `bun server/src/cli/main.ts`。涉及已安装扩展包的命令都读写服务器的数据目录（`TRPG_DATA_DIR`，默认 `./data`），所以要和服务器用同一个设置来跑。每条命令都输出一个 JSON 对象。

**称呼。** *守秘人*是 AI 主持人。*房间管理员*是持有某个房间管理员钥匙的人。*运营者*是运行服务器进程的人。

---

## 1. 第一个扩展包

一盏大家可以点亮的灯：一个模组，一条命令，两个文件。

```
lantern/
├── pack.yaml
└── src/lantern.ts
```

`pack.yaml`：

```yaml
manifest_version: 3
id: lantern
version: 0.1.0
name: { en: The Lantern, zh: 提灯 }
description: A lantern the table can light.
license: CC-BY-4.0
modules:
  - { id: lantern, entry: src/lantern.ts }
```

`src/lantern.ts`：

```ts
import { defineModule } from "loreweaver/module";

let lit = false;

export default defineModule({
  id: "lantern",
  create() { lit = false; },
  load(snapshot) { lit = (snapshot as { lit: boolean }).lit; },
  save() { return { lit }; },

  on: {
    turnStart(_event, fx) {
      fx.inject(lit ? "The lantern is lit." : "The lantern is dark.");
    },
  },

  commands: {
    light: {
      title: "Light the lantern",
      run(_args, who, fx) {
        lit = true;
        fx.fact({ text: `${who.member?.name ?? "Someone"} lights the lantern.` });
        return { text: "The lantern is lit." };
      },
    },
  },

  views: {
    state: { title: "Lantern", schema: { type: "object" }, for: () => ({ lit }) },
  },
});
```

这个模组每回合告诉守秘人灯亮没亮（`fx.inject`），给玩家一条命令（`lantern/light`），再发布一个视图（`lantern/state`），之后的面板会读它。它的状态靠 `save` 和 `load` 撑过服务器重启。

**构建：**

```sh
loreweaver pack lantern
```

它会在当前目录写出 `lantern-0.1.0.lwpack`（用 `--out <文件>` 指定位置），并打印构建结果：`{"ok":true,"out":…,"sha256":…,"trust":{…}}`。构建器把 `src/lantern.ts` 和它导入的一切打成一个文件 `modules/lantern.js`；`src/` 本身不进压缩包。同一个源目录永远构建出同样的字节。

**安装。** 两条路，检查完全一样。

- *在聊天里*，以房间管理员身份：扩展包装到正在运行的服务器上，并立刻在你的房间里启用。路径是**服务器**磁盘上的路径（`https://` 链接或 `gh:owner/repo[@tag]` 也行）：

  ```
  .pack install /path/to/lantern-0.1.0.lwpack
  ```

  回复就是用文字写出的信任卡（下面是英文界面的原文）：

  ```
  Installed The Lantern (lantern 0.1.0) on this server.
  It is enabled in this room.
  It runs code on this server, with no sandbox: modules lantern.
  ```

  中文界面下是「已在服务器上安装 提灯（lantern 0.1.0）。」「已在本房间启用。」「它会在这台服务器上运行代码，没有沙箱：模组 lantern。」整桌只会听到一行：「已安装并启用扩展包：提灯。」

- *在命令行里*，以运营者身份。不加 `--yes` 时只打印信任卡（JSON），什么都不写：

  ```sh
  loreweaver install lantern-0.1.0.lwpack          # 只看信任卡，不写任何东西
  loreweaver install lantern-0.1.0.lwpack --yes    # 安装
  loreweaver packs                                 # 列出已安装的扩展包
  ```

  从命令行安装不会在任何房间启用，正在运行的服务器要等下次启动才看得到它。之后由房间管理员启用：`.pack enable lantern`（中文写法 `.扩展包 启用 lantern`）。

**用起来。** 任何玩家输入：

```
.lantern/light
```

这位玩家收到命令的回答（*The lantern is lit.*），整桌看到这条事实（*Ada lights the lantern.*），从下一回合起守秘人的提示词里写着灯是亮的。模组命令只有一种文字写法：完整的 id，要带参数时后面跟一个 JSON 对象：`.lantern/light {"hours": 2}`。客户端也会在 `commands` 视图里列出模组命令，所以 `.help` 能看到它。

## 2. 改了之后重新安装

3.0 没有热重载的开发房间，也没有单独的检查命令：改完就重新构建、重新安装。构建器跑的检查和服务器一样，所以能构建出来的扩展包就能装上（除非服务器比扩展包的 `engine` 最低版本还旧）。

同一个版本不能装两次（`already_installed`）。两种办法：

- **升版本号**（`0.1.1`，或者预发布版本 `0.1.0-dev.2`），构建，然后在聊天里再 `.pack install` 一次。新版本在运行中的服务器上替掉旧版本，每个启用了它的房间都会重载自己的工作线程，从此跑新版本。模组从保存的状态开始（`load`）。
- **在命令行里：** `loreweaver uninstall lantern`，再 `loreweaver install … --yes`，然后重启服务器。卸载只能由运营者在命令行里做。

## 3. 测试模组

模组用 SDK 的测试宿主在 `bun test` 下测试：和房间工作线程用的是同一个运行器，不需要服务器。SDK 就是本仓库的 `sdk/` 目录，还没发布到 npm，所以扩展包的源目录要依赖一份检出：

```json
{ "private": true, "devDependencies": { "loreweaver": "file:../loreweaver/sdk" } }
```

（路径换成你那份检出里的 `sdk/`。）然后 `bun install`，在模组旁边写个测试：

```ts
import { expect, test } from "bun:test";
import { createTestHost, who } from "loreweaver/testing";

import lantern from "./lantern.ts";

test("lighting the lantern tells the table", async () => {
  const host = createTestHost(lantern);
  const run = await host.command("light", {}, who("Ada"));
  expect(run.facts.map((fact) => fact.text)).toEqual(["Ada lights the lantern."]);
  expect(await host.view("state", who("Ada"))).toEqual({ lit: true });
});
```

`package.json`、`node_modules/` 和测试文件都可以放在源目录里：构建器只读清单里点了名的文件。测试宿主的说明在 [sdk/README.md](../sdk/README.md#testing-a-module)（英文）。

## 4. 每一种内容

这盏灯长成一个小扩展包，每种内容都有。完成后的目录：

```
lantern/
├── pack.yaml
├── src/lantern.ts
├── cards/old-quarter.lorecard.json    一张世界卡：设定、一条秘密、一个变量
├── rules/lantern-rules.yaml           基于 CoC 7 版的规则包补丁
├── skills/lamplighter/SKILL.md        给守秘人的技能
├── ui/panels.yaml                     一个面板
├── presentation.yaml                  演出包
├── art/lantern.png
└── sound/rain.ogg
```

清单：

```yaml
manifest_version: 3
id: lantern
version: 0.2.0
name: { en: The Lantern, zh: 提灯 }
description: { en: A dark quarter and the lantern that lights it., zh: 一片黑街，和照亮它的一盏灯。 }
authors: [You]
license: CC-BY-4.0
engine: { protocol: "3.0" }
modules:
  - { id: lantern, entry: src/lantern.ts }
contents:
  cards:
    - { path: cards/old-quarter.lorecard.json, kind: world, notes: { en: Import as the world., zh: 作为世界导入。 } }
  rulepacks: [rules/lantern-rules.yaml]
  skills: [skills/lamplighter]
  panels: [ui/panels.yaml]
  presentation: [presentation.yaml]
```

图片和声音不用写进 `assets`：演出包和面板点名的文件都会跟着扩展包走。只有想给文件加标题、许可证或标签，或者要带一个别处都没点名的文件时，才写进 `assets`。

### 4.1 卡和设定

设定靠卡进入房间：酒馆卡（`.png` 或 `.json`），或 Loreweaver 自己的 `*.lorecard.json`。3.0 没有单独的世界书文件；世界书放在卡的 `character_book` 里带进来。每个卡条目要写明这张卡是 `world` 还是 `character`，构建器会拿卡本身去核对（`card_kind_mismatch`）：带任何世界机制的卡——变量声明、模板、秘密条目、带类型的变量——就是世界卡。

`cards/old-quarter.lorecard.json`：

```json
{
  "format": "loreweaver.card",
  "format_version": 1,
  "name": "The Old Quarter",
  "description": "A maze of streets where the gas lamps went out a year ago.",
  "opening": "Fog rolls up from the river. Somewhere ahead, a lantern swings.",
  "worldbook": [
    { "title": "The lamplighters", "keys": ["lamplighter", "lamp"], "content": "The lamplighters' guild still meets on Tallow Street." },
    { "title": "Who put out the lamps", "keys": ["lamps went out"], "secret": true, "content": "The guild master cut the gas to hide what walks at night." }
  ],
  "variables": [
    { "id": "dread", "kind": "number", "labels": { "en": "Dread", "zh": "恐惧" }, "minimum": 0, "maximum": 10, "default": 0 }
  ]
}
```

启用扩展包并不会导入里面的卡，要由房间管理员导入：

```
.import world lantern cards/old-quarter.lorecard.json
```

（中文写法 `.导入 世界 lantern cards/old-quarter.lorecard.json`。）回复会说导入了 2 条设定（1 条秘密）、0 条变量声明、1 段开场。秘密条目归守秘人，玩家永远看不到（玩家的 `.lore list` 只列出一条）。玩家可以把已启用扩展包里的 `character` 卡导入成自己的角色：`.import character <扩展包> <卡的路径>`。两种导入各带来什么，见 [cards.zh.md](cards.zh.md)。

### 4.2 规则包补丁

要加房规的扩展包，给内置规则系统打补丁，而不是整个重写。`rules/lantern-rules.yaml`：

```yaml
extends: coc7
names: [Lantern Rules]
defaults: { Lamplore: 10 }
```

文件名就是规则系统的 id（`lantern-rules`）。`extends:` 把补丁深度合并到底本上（底本是内置的 `coc7`、`dnd5e`、`wod`，或者同一个扩展包里的另一个规则包）：映射逐层合并，列表和标量整体替换，`null` 删除继承来的键。规则系统不按扩展包启用：扩展包装好后，房间用 `.rule system lantern-rules`（`.规则 系统 lantern-rules`）选它。用了 2.x 规则脚本通道（`resolution.script`、`script` 子系统）的规则包会被拒收：3.0 没有这个通道。格式见 [rulepacks.md](lwf/formats/rulepacks.md)，`extends:` 在 §14。

### 4.3 技能

技能是写给守秘人的文字：技能在房间里启用期间守秘人会读到的一段 Markdown，外加一份可选的、它解锁的工具名单。`skills/lamplighter/SKILL.md`：

```markdown
---
name: Lamplighter
name-zh: 点灯人
description: Run the Old Quarter as a place where darkness is a threat.
description-zh: 把旧城区当成一个黑暗本身就是威胁的地方来主持。
allowed-tools: [generate_image]
---
Darkness in the Old Quarter is never safe. When the lantern is out, describe sounds,
not sights, and call for a Listen check before anything is seen.
```

目录名就是技能 id。技能能解锁的是服务器的受限工具：`generate_image`，以及 `adjust_relationship`、`set_relationship`、`get_relationships`；不认识的名字会被忽略。`metadata.content-rating: mature` 声明成人内容。房间管理员用 `.skill enable lamplighter`（`.技能 启用 lamplighter`）启用技能，`.skill list` 列出房间能启用哪些；在聊天里安装扩展包会顺带在那个房间启用它的技能。技能要写怎么*主持*这个扩展包——节奏、该藏什么、什么时候要求检定——而不是故事本身，故事在卡里。技能只是文字：`SKILL.md` 旁边的 `hooks.js` 不会运行（构建时报告为已忽略）。代码放进模组（§4.6）。格式见 [skills-hooks.md](lwf/formats/skills-hooks.md) §1。

### 4.4 面板

面板是故事旁边的界面——仪表、追踪器、地图——放在客户端的侧栏、托盘或弹窗里。它只显示看的人自己的**视图**里有的东西：内置视图（`me`、`party`、`scene`、`variables`、`characters` 等）和模组视图，比如 `lantern/state`。`ui/panels.yaml`：

```yaml
panels:
  - id: oil
    title: { en: The lantern, zh: 提灯 }
    slot: sidebar
    views: { lamp: lantern/state }
    blocks:
      - { kind: meter, label: { en: Oil, zh: 灯油 }, value: { $view: lamp.oil }, min: 0, max: { $view: lamp.max } }
      - { kind: image, src: art/lantern.png, caption: { en: The lantern, zh: 提灯 } }
      - kind: choices
        options:
          - { id: light, label: { en: Light it, zh: 点亮 }, command: lantern/light }
        visible_when: "lamp.oil > 0"
```

- `views` 把一个短名字映射到一个视图名；`{$view: lamp.oil}` 读视图里的一条路径。路径解析不出来，这个区块就不显示（如果是可选字段，只去掉这个字段）。
- `choices` 的选项运行一条命令（`command`，可选 `args`），以点它的那位成员的身份和权限运行。
- `visible_when` 只管显示，不管保密——区块照样发给能看到这个面板的每个人。不该让某人看到的东西，就不能出现在他的视图里：模组的 `for(who, room)` 逐人决定这一点，`audience: admin` 让整个面板只给管理员看。
- `repeat` 给列表里的每个元素画一个区块：`{repeat: {each: me.character.resources, as: r, block: …}}`。
- **页面**是一个自包含的 HTML 文件（`entry: ui/chart.html`），给富客户端用。它必须声明一份模板 `fallback`（或者写 `fallback: null`），别的客户端画这份。目前还没有参考客户端运行页面，终端客户端显示的是 fallback。

已启用扩展包的面板默认全部打开；房间管理员用 `.panels disable lantern/oil`（`.面板 停用 lantern/oil`）关掉某一个，`.panels` 列出全部。给这个面板供数据的模组在 §4.6。格式见 [panels.md](lwf/formats/panels.md)。

### 4.5 演出包：图片和声音

演出包告诉演出导演——用图片和道具来布置场景的那条车道——这个扩展包的牌桌该是什么样子、什么声音。`presentation.yaml`：

```yaml
version: 2
style:
  keywords: { en: "gaslight, fog, ink wash", zh: "煤气灯、雾、水墨" }
subjects:
  - { id: lantern, kind: item, name: { en: The lantern, zh: 提灯 }, ref: art/lantern.png }
audio:
  - { id: rain, layer: ambience, asset: sound/rain.ogg, title: Rain on cobbles }
```

- `subjects` 是导演可以展示的人物、地点和物品（`npc`、`location`、`item`）；`ref` 是扩展包自带的那张图。`generation: pack_only` 完全不许生成图片；`templates` 限定道具种类（`image`、`title_card`、`letter`、`clipping`、`text`）。
- `audio` 里的音效以 `<扩展包>/<音效>` 的名字加入房间的音频库，只读。由房间管理员播放：`.ambience play rain`（还有 `.bgm`、`.sfx`；`.audio list` 列出音频库）。音效的 `title` 只给管理员看。
- `{ … }` 里的值带逗号时要加引号：`{ en: gaslight, fog }` 会被读成两个键，构建会拒收这个演出包（`unknown_key`）。

图片可以是 PNG、JPEG、WebP、GIF 或 SVG（最大 8 MiB）；声音可以是 MP3、Ogg、WAV、FLAC、M4A 或 AAC（最大 128 MiB）。文件内容必须和扩展名对得上。在房间里启用后，演出包的图片和声音成为这个房间的不公开媒体：房间成员能取，别人取不到。演出包的字段见 [pack.md](lwf/formats/pack.md) §4.2。

### 4.6 模组

模组是扩展包的代码：扩展包信不过守秘人自己记住的规则——追踪器、时钟、命令、私密视图。它用 TypeScript 或 JavaScript 写，基于 `loreweaver/module`，运行在房间的工作线程里。这盏灯的模组长大后给上面的面板供数据：

```ts
import { defineModule } from "loreweaver/module";

let oil = 3;

export default defineModule({
  id: "lantern",
  create() { oil = 3; },
  load(snapshot) { oil = (snapshot as { oil: number }).oil; },
  save() { return { oil }; },

  on: {
    turnStart(_event, fx) {
      fx.inject(oil > 0 ? `The lantern burns; ${oil} hours of oil left.` : "The lantern is out.");
    },
  },

  commands: {
    light: {
      title: "Light the lantern",
      description: "Burn an hour of oil.",
      run(_args, who, fx) {
        if (oil === 0) return { text: "No oil left." };
        oil -= 1;
        fx.fact({ text: `${who.member?.name ?? "Someone"} lights the lantern.` });
        return { text: `${oil} hours of oil left.` };
      },
    },
  },

  views: {
    state: {
      title: "Lantern",
      schema: { type: "object", properties: { oil: { type: "integer" } } },
      for: () => ({ oil, max: 3 }),
    },
  },
});
```

模组能做的事，简单说：

- **事件：** `turnStart`（守秘人开始之前；`fx.inject` 往本回合提示词里加内容）、`toolUse`（守秘人要调用工具了；`fx.deny` 拒掉其中一个）、`replyPhase`（回复之后）。
- **命令**，名字是 `<模组>/<命令>`，带一个角色：`player`（默认）、`admin`，或者 `keeper`——玩家永远看不到的守秘人机关，由守秘人的 `run_command` 工具运行，房间管理员也能运行，用来纠正守秘人弄错的地方。
- **视图**，逐人计算：私密信息就是这样只送到一个人手上。
- **效果**是请求，由引擎校验后执行：给整桌或给守秘人的事实、变量写入、掷骰、界面区块。模组从不直接调用引擎。
- **角色和时钟：** `characters(room)` 提供可以入座的角色；`clock(room)` 接管房间的时钟。

模组的 `id` 必须和清单条目的 `id` 一致。构建器把每个入口和它导入的 npm 包打成一个文件；`loreweaver/module` 保留为导入，由服务器用自己的 SDK 来接。完整的约定、效果表和各项上限在 [sdk/README.md](../sdk/README.md)（英文）——写模组之前先读它。

**模组是真代码。** 它在服务器进程里运行，没有沙箱：能用文件系统、网络和它打包进来的任何东西。服务器隔离的是故障——模组抛错或卡住，只让它的房间少一次调用，不会拖垮服务器——不隔离信任。所以信任卡第一句就是*它会在这台服务器上运行代码*（§5）。

## 5. 安装、信任和启用

**信任卡。** 安装之前，服务器根据校验过的扩展包算出一份摘要给安装的人看：名字、id、版本、作者和许可证；是否运行代码，以及每个模组的文件、大小和 sha256；规则系统和各自的底本；技能和各自解锁的工具，是否声明了成人内容；卡、各自的类型和带的世界机制；面板、各自的受众和读的视图；演出包；资源的数量和大小；以及被忽略的东西。它是从内容算出来的，不可能少报扩展包里有什么。在聊天里安装完整的那盏灯（英文界面原文）：

```
Installed The Lantern (lantern 0.2.0) on this server, in place of 0.1.0: rooms that have it enabled now play the new version.
It is enabled in this room.
It runs code on this server, with no sandbox: modules lantern.
rule systems: lantern-rules (extends coc7)
skills: lamplighter (unlocks generate_image)
cards: The Old Quarter (cards/old-quarter.lorecard.json, world)
panels: oil
a presentation kit
2 assets
Its skills are enabled in this room: lamplighter.
Its world card: .import world lantern cards/old-quarter.lorecard.json
```

**谁来安装。** 运营者在命令行里装，或者房间管理员在聊天里装。两边用同一个安装器，检查一样。模组是真代码，所以在聊天里安装扩展包的房间管理员，就是在决定服务器运行什么代码；自托管的牌桌上，管理员通常也就是运营者。不想这样的运营者，只把管理员钥匙给自己信得过、愿意把服务器交给他的人。

**安装不等于启用。** 从命令行安装不改变任何房间；在聊天里安装只在那位管理员的房间里启用。在房间里启用一个扩展包（`.pack enable <id>`，用 `.pack disable <id>` 撤销；每个房间最多 16 个）会：

- 在房间的工作线程里加载它的模组，按扩展包启用的先后顺序（两个已启用的扩展包不能有同 id 的模组：`module_id_taken`）；
- 把它的演出包并入房间的演出包，音效加入房间的音频库；
- 把它的面板加入房间的 `panels` 视图；
- 让它的技能可以用 `.skill enable` 启用（停用扩展包时这些技能一并停用）；
- 让它的卡可以用 `.import` 导入。

规则系统是全服务器共用的：房间用 `.rule system <id>` 选。扩展包里的规则系统或技能，如果 id 已经被占——被内置的，或被更早安装的扩展包——就不会加载，安装时会说明；先来的那个永远不会被替换。

**发布。** Git Release 就是发布渠道：把 `.lwpack` 挂到一个 GitHub Release 上，任何人都能用 `gh:owner/repo`（最新一个 Release）或 `gh:owner/repo@v1.0.0` 安装。任何 `https://` 链接也行。把压缩包的 sha256 一起贴出来：构建是确定的，谁都可以用你的源目录重新构建一遍来比对。

## 6. 上限和拒收

出了问题，构建（和安装）会带着一个固定的代码和相关路径拒收，什么都不写。作者最常碰到的：

| 代码 | 意思 |
|---|---|
| `manifest_version_unsupported` | 清单不是 `manifest_version: 3`（一个 2.x 扩展包）。 |
| `unsupported_kind` | `contents` 里有 `lorebooks`、`presets` 或 `prep`，3.0 没有这些。 |
| `unknown_kind`、`unknown_key` | 格式没定义的键（每一层嵌套对象都是封闭的）。 |
| `missing_file` | 清单点名的文件不存在。 |
| `card_kind_mismatch` | 卡的 `kind` 和卡本身对不上；`detail` 是检测出来的类型。 |
| `presentation_invalid`、`panels_invalid` | 演出包或面板文件有错；`detail` 写明问题和位置。 |
| `kit_asset_missing`、`panel_asset_missing` | 演出包或面板点名的图片、声音不在扩展包里。 |
| `asset_type`、`asset_bad_signature`、`asset_too_large` | 文件扩展名不认识、内容和扩展名不符，或者太大。 |
| `undeclared_script` | 压缩包里有不是已声明模组入口的代码文件（手工打的包才会有，构建器从不打进去）。 |
| `already_installed` | 这个版本已经装了；升版本号。 |
| `engine_too_old` | 服务器比扩展包的 `engine` 最低版本旧。 |

一些上限：每个扩展包最多 16 个模组、16 个面板；每种内容最多 64 条；演出包最多一个；资源最多 512 个；`pack.yaml` 最大 256 KiB，规则包 512 KiB，演出包 128 KiB，页面 2 MiB，卡 32 MiB，打包后的模组 16 MiB；整个压缩包最大 512 MiB。超过上限就拒收，绝不截断。完整的表见 [pack.md](lwf/formats/pack.md) §2–§6 和 [panels.md](lwf/formats/panels.md) §8。

## 7. 从 2.x 过来

2.x 的扩展包装不到 3.0 上。对作者来说变了这些：

- `manifest_version: 3`；删掉 2.x 构建生成的 `files` 和 `trust` 块（信任卡由服务器计算）；每个卡条目都写上 `kind:`。
- **`hooks.js` 没有了。** 回合生命周期代码、卡里的钩子脚本、`defineAction` 动作、`emitUI` / `emitPanel`，全部改写成模组（§4.6）。卡里的钩子脚本在导入时只计数、报告，绝不运行。
- 作为单独内容种类的**世界书**没有了：把条目放进卡里。**提示词预设**、**准备阶段脚本**和准备阶段在 3.0 里都没有对应物。扩展包给卡配的 `overlay:` 文件也没有了：同样的开关由房间管理员用 `.lore` 和 `.var` 来设（[cards.zh.md](cards.zh.md)）。
- **面板**改为面板 3.0：绑定读视图，选项运行命令，页面是一个自包含的 HTML 文件（[panels.md](lwf/formats/panels.md) §9 逐个字段对照了 1.0）。
- 带规则脚本的**规则包**加载不了。
- 没有锻造（从一段描述生成技能、规则包或模组），没有热重载开发房间，也没有单独的检查命令：构建、安装、看效果（§2）。
- 原生卡的 `pregens` 和 AI 同伴都不在 3.0 里：玩家导入一张 `character` 卡，或者用 `genchar` 从描述生成角色；模组的 `characters()` 也可以提供座位。

## 接着看哪份

- [sdk/README.md](../sdk/README.md)——编写和测试模组（英文）。
- [cards.zh.md](cards.zh.md)——卡、世界与人物拆分、设定、变量、模板。
- [plugins.zh.md](plugins.zh.md)——哪些东西可以扩展，以及信任模型。
- [LWF](lwf/SPEC.md)——各项格式；[protocol.zh.md](protocol.zh.md) §6.8——这里提到的每条命令，含中文写法。
