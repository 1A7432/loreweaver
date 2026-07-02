"""Interactive test-play: run the 漱雪·上供 module with the 沈墨 AI companion, refereed by
a real Keeper (whatever TRPG_LLM__* in .env points at — DeepSeek by default). YOU are the
investigator; type actions in natural language or use commands. Progress persists in
data/play.db, so re-running this script continues the same campaign.

  .venv/bin/python scripts/play.py

In-session: natural-language actions (e.g. 我推开老严家的门，打量屋里) run the Keeper;
commands work too — `.ra 侦查` skill check, `.sc 1/1d6` sanity, `r 3d6+2` a raw roll,
`.st` your sheet, `.report` a session recap, `.help` the full list. Type /quit to leave.

Requires the private play material (gitignored): modules/shuxue.md, cards/companion_shenmo.json.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except Exception:
    pass

from agent.context import AgentCtx, LocalFs  # noqa: E402
from agent.kp_tools import build_kp_toolset  # noqa: E402
from agent.services import build_services  # noqa: E402
from core.charcard import parse_card_file  # noqa: E402
from gateway.commands import CommandRouter  # noqa: E402
from gateway.hub import RoomHub  # noqa: E402
from gateway.turn import run_turn  # noqa: E402
from infra.config import get_settings  # noqa: E402
from infra.embeddings import LocalEmbeddings  # noqa: E402

CHAT_KEY = "play:campaign"
MODULE = ROOT / "modules" / "shuxue.md"
CARD = ROOT / "cards" / "companion_shenmo.json"


async def _setup(services, ts, ctx):
    if await services.store.get(store_key=f"play.setup.{CHAT_KEY}"):
        return
    print("首次启动：正在装载模组「漱雪·上供」与队友沈墨（Keeper 分析模组中，约 10–30 秒）……")
    if not MODULE.exists():
        print(f"  ！找不到 {MODULE}（私有素材，未随仓库分发）。请把模组 md 放到该路径。")
        return
    await services.store.set(store_key=f"module_fulltext.{CHAT_KEY}", value=MODULE.read_text(encoding="utf-8"))
    await services.module_init.initialize(CHAT_KEY)
    if CARD.exists():
        try:
            card = parse_card_file(CARD)
            await ts.dispatch("import_character", ctx, {"file_path": str(CARD), "system": "coc7", "as_": "companion"})
            print(f"  队友已加入：{card.name}")
        except Exception as exc:
            print(f"  （队友导入跳过：{exc}）")
    await ts.dispatch("create_character", ctx, {"name": "调查员", "system": "coc7"})
    await services.store.set(store_key=f"play.setup.{CHAT_KEY}", value="1")
    print("装载完成。\n")


async def _say(router, services, ts, hub, ctx, text: str) -> str:
    # Commands (.ra / .sc / r / .st / .report / …) resolve through the router and return their
    # reply directly; everything else is a natural-language turn refereed by the Keeper.
    if router.resolve(text, ctx.locale) is not None:
        return await router.dispatch(ctx, text) or ""
    res = await run_turn(hub, services, ctx, text, command_router=router, toolset=ts, actor_name="调查员")
    return (getattr(res, "reply", "") or "") if res else ""


async def main():
    settings = get_settings()
    if not settings.llm.api_key:
        print("提示：.env 未配 API key —— 将使用离线演示 Keeper（非真 LLM）。配好 TRPG_LLM__* 后重跑即可用真 DeepSeek。\n")
    services = build_services(settings, embeddings=LocalEmbeddings(64), db_path=str(ROOT / "data" / "play.db"))
    ts = build_kp_toolset(services)
    router = CommandRouter(services)
    hub = RoomHub()
    ctx = AgentCtx(chat_key=CHAT_KEY, user_id="play:you", platform="cli", locale="zh", fs=LocalFs(str(ROOT)))

    await _setup(services, ts, ctx)
    print("=" * 60)
    print("  漱雪·上供 —— 你是调查员，沈墨是你的 AI 队友，Keeper 由 DeepSeek 扮演")
    print("  直接打字行动，或用命令：.ra 侦查 / .sc 1/1d6 / r 3d6+2 / .st / .report / .help")
    print("  /quit 退出（进度自动存 data/play.db，下次重跑本脚本继续）")
    print("=" * 60 + "\n")

    opening = await _say(router, services, ts, hub, ctx, "开场：请描述此刻的场景，把我带入模组的开头。")
    if opening.strip():
        print(f"KP：{opening}\n")

    while True:
        try:
            text = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            continue
        if text in ("/quit", "/exit", "退出", "quit", "exit"):
            break
        try:
            reply = await _say(router, services, ts, hub, ctx, text)
            print(f"KP：{reply}\n" if reply.strip() else "（无回应）\n")
        except Exception as exc:
            print(f"（出错：{type(exc).__name__}: {exc}）\n")

    print("\n再见。进度已存 data/play.db —— 重跑 scripts/play.py 即可继续这场战役。")


if __name__ == "__main__":
    asyncio.run(main())
