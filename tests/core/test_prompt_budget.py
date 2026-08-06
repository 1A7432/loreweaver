"""Prompt-size regression guard: the 2026-08-06 slim-down (judgment over rigid rules,
progressive disclosure — standing instructions cut ~70%) must not silently re-bloat.
Ceilings carry ~2x headroom over the post-slim sizes; hitting one means a structural
re-review, not a threshold bump."""

from __future__ import annotations

from core.prompt_sections import inject_interaction_style_prompt, inject_trpg_system_prompt
from infra.i18n import I18n

EN = I18n("en")
ZH = I18n("zh")


class _Ctx:
    chat_key = "budget-room"


async def test_standing_sections_stay_slim():
    for i18n, system_cap, style_cap in ((EN, 3000, 5000), (ZH, 1400, 2200)):
        system = await inject_trpg_system_prompt(_Ctx(), i18n)
        style = await inject_interaction_style_prompt(_Ctx(), i18n)
        assert len(system) < system_cap, f"system section re-bloated: {len(system)}"
        assert len(style) < style_cap, f"style section re-bloated: {len(style)}"


def test_module_blocks_stay_slim():
    for i18n, discipline_cap, fidelity_cap in ((EN, 3500, 1600), (ZH, 1200, 600)):
        assert len(i18n.t("prompt.keeper_discipline")) < discipline_cap
        assert len(i18n.t("prompt.module_fidelity")) < fidelity_cap


def test_no_hand_written_tool_catalog_ever_returns():
    # The function-calling schemas ARE the tool catalog; the prompt never restates
    # per-tool signatures (the pre-slim-down catalog duplicated every schema).
    for i18n in (EN, ZH):
        for key in ("prompt.system.guidelines", "prompt.system.intro"):
            text = i18n.t(key)
            assert "roll_dice(expression)" not in text
            assert "skill_check(skill_name," not in text
