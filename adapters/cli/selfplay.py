"""Programmatic CLI self-play driver."""

from __future__ import annotations

import io

from adapters.cli.adapter import CliAdapter
from agent.kp_tools import build_kp_toolset
from agent.services import Services
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.ops import UnlimitedRateLimiter
from gateway.runner import GatewayRunner


async def run_script(lines: list[str], services: Services, *, seed: int = 0) -> list[str]:
    seed_dice(seed)
    adapter = CliAdapter(stdout=io.StringIO())
    runner = GatewayRunner(
        services,
        adapters=[adapter],
        command_router=CommandRouter(services),
        toolset=build_kp_toolset(services),
    )
    # Same stance as `--script` / `--exec` (app.py `_run_cli`): a scripted batch from
    # the operator is not a flood; the rate limiter's job is the network.
    runner.rate_limiter = UnlimitedRateLimiter()
    await runner.start()
    try:
        for index, line in enumerate(lines, 1):
            if not line.strip():
                continue
            await adapter.handle_inbound(adapter.inbound(line, message_id=f"cli-{index}"))
    finally:
        await runner.stop()
    return list(adapter.sent)
