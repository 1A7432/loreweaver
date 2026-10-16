"""A seeded room for the HTML session-report tests (and the reviewable sample pages).

Every keeper-grade category the reveal edition prints carries its own sentinel string, so
a test can assert the player edition holds none of them and the reveal edition all of
them. The content is invented; nothing here is a real module.
"""

from __future__ import annotations

from typing import Any

from agent.history import DEFAULT_HISTORY_KEY, append_turn
from core.chronicle import CAMPAIGN_SUMMARY_DOC_TYPE, CHRONICLE_DOC_TYPE
from core.modvars import build_spec, define_modvar, set_modvar

# The four reveal categories: (a) hidden rolls, (b) chronicle margins, (c) module/NPC
# secrets, (d) keeper-only variables. Several sentinels per category where the category
# has several sources.
SENTINELS: dict[str, str] = {
    "hidden_roll": "1d100+RH7Q",
    "margin": "MARGIN-SENTINEL-4K",
    "summary_margin": "SUMMARY-MARGIN-SENTINEL-2P",
    "truth": "TRUTH-SENTINEL-9X",
    "threat": "THREAT-SENTINEL-3M",
    "clue": "CLUE-SENTINEL-5W",
    "pool_npc": "POOLNPC-SENTINEL-8V",
    "npc_secret": "NPCSECRET-SENTINEL-6R",
    "npc_knowledge": "NPCKNOWS-SENTINEL-1T",
    "keeper_var": "KEEPERVAR-SENTINEL-0Z",
    "hidden_leaf": "LEAF-SENTINEL-2H",
}
# Only the module-pool sentinels: a world-card room has no pool to carry them.
POOL_SENTINELS = ("truth", "threat", "clue", "pool_npc")

INJECTION = '<script>alert("x")</script><img src=x onerror=alert(1)>'


async def seed_report_room(
    services: Any, chat_key: str, *, with_pool: bool = True, injection: bool = False
) -> None:
    """Seed one played session plus keeper material in every reveal category."""
    battles = services.battles
    await battles.start_session(chat_key, "The Lamplighter's Debt")
    await battles.add_dice_roll(chat_key, "u-nora", "Nora Vale", "1d20", 17)
    await battles.add_dice_roll(
        chat_key, "u-nora", "Nora Vale", "1d100", 1, is_critical=True, critical_type="success"
    )
    await battles.add_skill_check(
        chat_key, "u-nora", "Nora Vale", "Spot Hidden", 45, 12,
        success=True, critical=False, fumble=False, tier=2, rank_id="hard", label="Hard success",
    )
    await battles.add_skill_check(
        chat_key, "u-ash", "Ash Morrow", "Persuade", 40, 63,
        success=False, critical=False, fumble=False, tier=0, rank_id="fail", label="Failure",
    )
    await battles.add_skill_check(
        chat_key, "u-ash", "Ash Morrow", "Climb", 30, 100,
        success=False, critical=False, fumble=True, tier=-1, rank_id="fumble", label="Fumble",
    )
    await battles.add_dice_roll(chat_key, "u-keeper", "Keeper", SENTINELS["hidden_roll"], 3, hidden=True)

    player_line = "Nora: I hold the lamp up to the ledger and read the last entry."
    if injection:
        player_line += " " + INJECTION
    keeper_reply = (
        "The ink is still **wet**. Someone wrote here *tonight*.\n\n"
        "Three names, each struck through:\n"
        "- Ezra Pell\n- Marguerite Sole\n- a third, scratched out\n\n"
        "Behind you the stair *creaks*."
    )
    if injection:
        keeper_reply += "\n\n[a link](javascript:alert(1)) <b>raw</b> " + INJECTION
    await append_turn(services, chat_key, DEFAULT_HISTORY_KEY, user_message=player_line, reply=keeper_reply, turn=1)
    await append_turn(
        services,
        chat_key,
        DEFAULT_HISTORY_KEY,
        user_message="Ash: I go down the stair, slowly.",
        reply="The lamplighter is waiting at the bottom, coat buttoned wrong.\nHe does not look up.",
        turn=2,
    )

    documents = services.documents
    await documents.put(
        chat_key,
        CHRONICLE_DOC_TYPE,
        "c1",
        {"text": "The table found the ledger.", "turn": 1, "keeper": SENTINELS["margin"]},
    )
    await documents.put_singleton(
        chat_key,
        CAMPAIGN_SUMMARY_DOC_TYPE,
        {"text": "Two investigators chase a debt.", "through_turn": 1, "fold_count": 1, "keeper": SENTINELS["summary_margin"]},
    )
    if with_pool:
        await documents.put_singleton(
            chat_key,
            "module_pool",
            {
                "keeper": {
                    "truths": [{"name": "The debt", "description": SENTINELS["truth"], "revealed_by": "the ledger"}],
                    "threats": [
                        {
                            "name": "The lamplighter",
                            "type": "NPC",
                            "description": SENTINELS["threat"],
                            "stats": {"HP": 11},
                            "location": "the stair",
                        }
                    ],
                    "clues": [
                        {"name": "The ledger", "description": "A list of names."},
                        {"name": "The wrong button", "description": SENTINELS["clue"], "leads_to": "the truth"},
                    ],
                    "npcs": [{"name": "Ezra Pell", "secret": SENTINELS["pool_npc"]}],
                },
                "player": {"clues": [{"name": "The ledger", "description": "A list of names."}]},
            },
        )
    npc_name = "Wick" + (" " + INJECTION if injection else "")
    await documents.put(
        chat_key,
        "npc",
        "wick",
        {
            "id": "wick",
            "name": npc_name,
            "public_description": "A tired lamplighter.",
            "secret_agenda": SENTINELS["npc_secret"],
            "knowledge": [SENTINELS["npc_knowledge"]],
        },
    )
    await define_modvar(
        documents, chat_key, build_spec("dread", "text", visibility="keeper", default="", labels={"en": "Dread"})
    )
    await set_modvar(documents, chat_key, "dread", SENTINELS["keeper_var"])
    await define_modvar(documents, chat_key, build_spec("lamps_lit", "number", default=2, labels={"en": "Lamps lit"}))
    await documents.put_singleton(
        chat_key,
        "mvu_tree",
        {
            "tree": {"world": {"weather": "fog"}, "secret": {"debt_owner": SENTINELS["hidden_leaf"]}},
            "exposed": ["world"],
        },
    )
