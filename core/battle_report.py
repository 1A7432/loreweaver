"""Battle report generation for TRPG sessions.

Ported from ``nekro_trpg_dice_plugin``'s ``core/battle_report.py``:
``SessionRecord`` bookkeeping, the ``session_record.*`` / ``session_name.*`` /
``session_history.*`` store-key layout, and the score/rating formulas are all
unchanged. Only two things differ from the source: the injected store is
``infra.store.Store`` (drop-in — same async ``get``/``set``/``delete``
signature) and every human-readable line of the rendered reports goes
through ``infra.i18n`` instead of being a hardcoded Chinese literal.
"""

from __future__ import annotations

import json
import time
from datetime import datetime

from core.dice_engine import coc_rank_label
from infra.i18n import I18n, get_i18n
from infra.store import Store

NPC_USER_ID = "__npc__"
_KEY_EVENT_DEDUPE_SECONDS = 5 * 60
_REPORT_RECAP_LIMIT = 10
_REPORT_RECAP_TEXT_LIMIT = 200


def _is_successful_level(success_level: str) -> bool:
    """Legacy fallback for records that predate structured check outcomes.

    New records carry a canonical boolean and rank. Old stored records only
    have a localized label, so compare those labels case-insensitively across
    every shipped locale.
    """
    i18n = get_i18n()
    normalized = str(success_level).casefold()
    return any(
        i18n.with_locale(locale).t("battle.skill_check.success_keyword").casefold() in normalized
        for locale in i18n.available_locales()
    )


def _check_succeeded(check: dict) -> bool:
    success = check.get("success")
    if isinstance(success, bool):
        return success
    return _is_successful_level(str(check.get("success_level", "")))


def _check_level_label(check: dict, i18n: I18n) -> str:
    rank = check.get("rank")
    if isinstance(rank, int):
        return coc_rank_label(rank, i18n)
    return str(check.get("success_level", ""))


def _select_recap_events(events: list[dict], limit: int = _REPORT_RECAP_LIMIT) -> list[dict]:
    if len(events) <= limit:
        return list(events)
    return [events[index * (len(events) - 1) // (limit - 1)] for index in range(limit)]


def _render_recap_text(description: object, limit: int = _REPORT_RECAP_TEXT_LIMIT) -> str:
    text = " ".join(str(description).split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


def _default_session_name(moment: datetime, i18n: I18n) -> str:
    """Render the auto-generated session name used when none is supplied."""
    return i18n.t("battle.session.default_name", timestamp=moment.strftime("%Y%m%d-%H%M"))


class SessionRecord:
    """A single TRPG session's recorded events and per-player stats."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.start_time = time.time()
        self.end_time: float | None = None

        self.dice_rolls: list[dict] = []
        self.skill_checks: list[dict] = []
        self.combat_rounds: list[dict] = []
        self.key_events: list[dict] = []
        self.npc_interactions: list[dict] = []
        self.player_actions: dict[str, list[dict]] = {}  # {user_id: [action, ...]}

        # {user_id: {char_name, total_rolls, success_count, critical_success, ...}}
        self.player_stats: dict[str, dict] = {}

    def add_dice_roll(
        self,
        user_id: str,
        char_name: str,
        expression: str,
        result: int,
        is_critical: bool = False,
        critical_type: str = "",
    ) -> None:
        """Record a dice roll and update the roller's aggregate stats.

        ``critical_type`` is ``"success"`` / ``"failure"`` / ``""``; critical
        successes and failures are tracked as SEPARATE counters on
        ``player_stats``.
        """
        self.dice_rolls.append(
            {
                "user_id": user_id,
                "char_name": char_name,
                "expression": expression,
                "result": result,
                "is_critical": is_critical,
                "critical_type": critical_type,
                "timestamp": time.time(),
            }
        )

        if user_id == NPC_USER_ID:
            return

        if user_id not in self.player_stats:
            self.player_stats[user_id] = {
                "char_name": char_name,
                "total_rolls": 0,
                "critical_success": 0,
                "critical_failure": 0,
            }

        stats = self.player_stats[user_id]
        stats["char_name"] = stats.get("char_name", char_name)
        stats["total_rolls"] = stats.get("total_rolls", 0) + 1
        stats["critical_success"] = stats.get("critical_success", 0)
        stats["critical_failure"] = stats.get("critical_failure", 0)
        if critical_type == "success" or (is_critical and not critical_type):
            stats["critical_success"] += 1
        elif critical_type == "failure":
            stats["critical_failure"] += 1

    def add_skill_check(
        self,
        user_id: str,
        char_name: str,
        skill: str,
        target: int,
        roll: int,
        success_level: str | None = None,
        *,
        success: bool | None = None,
        rank: int | None = None,
        is_critical: bool | None = None,
        bonus: int | None = None,
        penalty: int | None = None,
        raw_roll: int | None = None,
        base_roll: int | None = None,
        extra_tens: list[int] | None = None,
        final_tens: int | None = None,
        difficulty: int | None = None,
        rule: int | None = None,
        modifier: int | None = None,
        advantage_rolls: list[int] | None = None,
        disadvantage_rolls: list[int] | None = None,
        loss_expr: str | None = None,
        loss: int | None = None,
        san_before: int | None = None,
        san_after: int | None = None,
        luck_adjusted: bool | None = None,
        luck_spent: int | None = None,
        adjusted_roll: int | None = None,
        luck_before: int | None = None,
        luck_after: int | None = None,
    ) -> None:
        """Record a structured skill check and update the roller's aggregates.

        ``success_level`` remains accepted only for legacy callers. New callers
        store the canonical ``success``/``rank`` fields and localize the rank at
        report-render time.
        """
        check = {
            "user_id": user_id,
            "char_name": char_name,
            "skill": skill,
            "target": target,
            "roll": roll,
            "timestamp": time.time(),
        }
        if success is not None:
            check["success"] = success
        if rank is not None:
            check["rank"] = rank
        if success is None and rank is None and success_level is not None:
            check["success_level"] = success_level
        optional_fields = {
            "is_critical": is_critical,
            "bonus": bonus,
            "penalty": penalty,
            "raw_roll": raw_roll,
            "base_roll": base_roll,
            "extra_tens": list(extra_tens) if extra_tens is not None else None,
            "final_tens": final_tens,
            "difficulty": difficulty,
            "rule": rule,
            "modifier": modifier,
            "advantage_rolls": list(advantage_rolls) if advantage_rolls is not None else None,
            "disadvantage_rolls": list(disadvantage_rolls) if disadvantage_rolls is not None else None,
            "loss_expr": loss_expr,
            "loss": loss,
            "san_before": san_before,
            "san_after": san_after,
            "luck_adjusted": luck_adjusted,
            "luck_spent": luck_spent,
            "adjusted_roll": adjusted_roll,
            "luck_before": luck_before,
            "luck_after": luck_after,
        }
        check.update({key: value for key, value in optional_fields.items() if value is not None})
        self.skill_checks.append(check)

        if user_id == NPC_USER_ID:
            return

        if user_id not in self.player_stats:
            self.player_stats[user_id] = {
                "char_name": char_name,
                "total_checks": 0,
                "successful_checks": 0,
            }

        stats = self.player_stats[user_id]
        stats["char_name"] = stats.get("char_name", char_name)
        stats["total_checks"] = stats.get("total_checks", 0) + 1
        stats["successful_checks"] = stats.get("successful_checks", 0)
        if success if success is not None else _is_successful_level(success_level or ""):
            stats["successful_checks"] = stats.get("successful_checks", 0) + 1
        if is_critical:
            field = "critical_failure" if rank == -2 else "critical_success"
            stats[field] = stats.get(field, 0) + 1

    def add_key_event(self, description: str, event_type: str = "general") -> bool:
        """Record a key event unless identical text was added in the last five minutes."""
        now = time.time()
        for event in reversed(self.key_events):
            if now - float(event.get("timestamp", 0) or 0) > _KEY_EVENT_DEDUPE_SECONDS:
                break
            if event.get("description") == description:
                return False
        self.key_events.append({"description": description, "event_type": event_type, "timestamp": now})
        return True

    def add_player_action(self, user_id: str, char_name: str, action: str) -> None:
        """Record a free-text player action."""
        if user_id not in self.player_actions:
            self.player_actions[user_id] = []

        self.player_actions[user_id].append({"char_name": char_name, "action": action, "timestamp": time.time()})

        if user_id not in self.player_stats:
            self.player_stats[user_id] = {"char_name": char_name}

        self.player_stats[user_id]["action_count"] = len(self.player_actions[user_id])

    def add_combat_round(self, round_number: int, notes: str = "") -> bool:
        """Record one transition into a combat round, ignoring duplicates."""
        if self.combat_rounds and self.combat_rounds[-1].get("round") == round_number:
            return False
        self.combat_rounds.append(
            {
                "round": max(1, int(round_number)),
                "notes": notes,
                "timestamp": time.time(),
            }
        )
        return True

    def set_combat_state(self, round_number: int, current: str, turn: int) -> None:
        """Persist the committed initiative pointer on the current combat round."""
        normalized_round = max(1, int(round_number))
        if not self.combat_rounds or self.combat_rounds[-1].get("round") != normalized_round:
            self.add_combat_round(normalized_round)
        self.combat_rounds[-1]["current"] = current
        self.combat_rounds[-1]["turn"] = max(0, int(turn))

    def end_session(self) -> None:
        """Mark the session as ended (stamps ``end_time``)."""
        self.end_time = time.time()

    def rebuild_player_stats(self) -> None:
        """Rebuild derived player aggregates from canonical recorded events."""
        stats_by_user: dict[str, dict] = {}

        def player(user_id: str, char_name: str) -> dict | None:
            if not user_id or user_id == NPC_USER_ID:
                return None
            stats = stats_by_user.setdefault(user_id, {"char_name": char_name})
            if not stats.get("char_name"):
                stats["char_name"] = char_name
            return stats

        for roll in self.dice_rolls:
            stats = player(str(roll.get("user_id", "")), str(roll.get("char_name", "")))
            if stats is None:
                continue
            stats["total_rolls"] = stats.get("total_rolls", 0) + 1
            stats.setdefault("critical_success", 0)
            stats.setdefault("critical_failure", 0)
            if roll.get("is_critical"):
                field = "critical_failure" if roll.get("critical_type") == "failure" else "critical_success"
                stats[field] += 1

        for check in self.skill_checks:
            stats = player(str(check.get("user_id", "")), str(check.get("char_name", "")))
            if stats is None:
                continue
            stats["total_checks"] = stats.get("total_checks", 0) + 1
            stats["successful_checks"] = stats.get("successful_checks", 0) + int(_check_succeeded(check))
            if check.get("is_critical"):
                field = "critical_failure" if check.get("rank") == -2 else "critical_success"
                stats[field] = stats.get(field, 0) + 1

        for user_id, actions in self.player_actions.items():
            if not actions:
                continue
            latest = actions[-1]
            stats = player(str(user_id), str(latest.get("char_name", "")))
            if stats is not None:
                stats["action_count"] = len(actions)

        self.player_stats = stats_by_user

    def get_duration_minutes(self) -> int:
        """Return the session's duration in minutes (ongoing sessions use "now")."""
        end = self.end_time or time.time()
        return int((end - self.start_time) / 60)

    def to_dict(self) -> dict:
        """Serialize to a plain dict (JSON-safe)."""
        return {
            "session_id": self.session_id,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "dice_rolls": self.dice_rolls,
            "skill_checks": self.skill_checks,
            "combat_rounds": self.combat_rounds,
            "key_events": self.key_events,
            "npc_interactions": self.npc_interactions,
            "player_actions": self.player_actions,
            "player_stats": self.player_stats,
        }

    @classmethod
    def from_dict(cls, data: dict) -> SessionRecord:
        """Deserialize from the shape produced by `to_dict`."""
        record = cls(data["session_id"])
        record.start_time = data["start_time"]
        record.end_time = data.get("end_time")
        record.dice_rolls = data.get("dice_rolls", [])
        record.skill_checks = data.get("skill_checks", [])
        record.combat_rounds = data.get("combat_rounds", [])
        record.key_events = data.get("key_events", [])
        record.npc_interactions = data.get("npc_interactions", [])
        record.player_actions = data.get("player_actions", {})
        record.player_stats = data.get("player_stats", {})
        if record.dice_rolls or record.skill_checks or record.player_actions:
            record.rebuild_player_stats()
        else:
            record.player_stats.pop(NPC_USER_ID, None)
        return record


class BattleReportGenerator:
    """Builds battle-report renderings (text / Markdown / prompt summary) from a `SessionRecord`."""

    def __init__(self, store: Store) -> None:
        self.store = store

    async def get_latest_history(self, chat_key: str) -> SessionRecord | None:
        """Return the most recently archived session for `chat_key`, if any."""
        try:
            latest_key = f"session_history.{chat_key}.latest"
            data = await self.store.get(store_key=latest_key)
            if data:
                return SessionRecord.from_dict(json.loads(data))
        except Exception:
            pass

        return None

    async def start_session(
        self,
        chat_key: str,
        session_name: str | None = None,
        auto_start: bool = False,
        i18n: I18n | None = None,
        force_new: bool = False,
    ) -> str:
        """Start recording a session, preserving an active record by default.

        `auto_start` distinguishes manual vs. automatic session starts (kept
        for parity with the source; not otherwise used here). ``force_new``
        archives an active record before creating a fresh one.
        """
        i18n = i18n or get_i18n()
        current = await self.get_current_session(chat_key)
        if current is not None and not force_new:
            return current.session_id
        if current is not None:
            await self.end_session(chat_key)

        session_id = f"session_{time.time_ns()}"

        if not session_name:
            session_name = _default_session_name(datetime.now(), i18n)

        record = SessionRecord(session_id)

        store_key = f"session_record.{chat_key}.current"
        await self.store.set(store_key=store_key, value=json.dumps(record.to_dict(), ensure_ascii=False))

        name_key = f"session_name.{chat_key}.current"
        await self.store.set(store_key=name_key, value=session_name)

        return session_id

    async def get_current_session(self, chat_key: str) -> SessionRecord | None:
        """Return the in-progress session for `chat_key`, if one exists."""
        store_key = f"session_record.{chat_key}.current"

        try:
            data = await self.store.get(store_key=store_key)
            if data:
                return SessionRecord.from_dict(json.loads(data))
        except Exception:
            pass

        return None

    async def save_session(self, chat_key: str, record: SessionRecord) -> None:
        """Persist `record` as the in-progress session for `chat_key`."""
        store_key = f"session_record.{chat_key}.current"
        await self.store.set(store_key=store_key, value=json.dumps(record.to_dict(), ensure_ascii=False))

    async def end_session(self, chat_key: str) -> SessionRecord | None:
        """End the in-progress session for `chat_key`, archiving it to history."""
        record = await self.get_current_session(chat_key)
        if record:
            record.end_session()

            name_key = f"session_name.{chat_key}.current"
            session_name = await self.store.get(store_key=name_key)

            history_key = f"session_history.{chat_key}.{record.session_id}"
            latest_key = f"session_history.{chat_key}.latest"
            latest_name_key = f"session_name.{chat_key}.latest"
            record_json = json.dumps(record.to_dict(), ensure_ascii=False)

            await self.store.set(store_key=history_key, value=record_json)
            await self.store.set(store_key=latest_key, value=record_json)

            if session_name:
                await self.store.set(store_key=latest_name_key, value=session_name)

            current_key = f"session_record.{chat_key}.current"
            await self.store.delete(store_key=current_key)
            await self.store.delete(store_key=name_key)

            return record

        return None

    def calculate_player_score(
        self, user_id: str, record: SessionRecord, i18n: I18n | None = None
    ) -> tuple[int, str]:
        """Compute a player's `(score, localized rating)` for `record`."""
        i18n = i18n or get_i18n()
        if user_id not in record.player_stats:
            return 0, i18n.t("battle.score.not_participated")

        breakdown = self.calculate_player_score_breakdown(user_id, record)
        score = breakdown["total"]

        if score >= 90:
            rating = i18n.t("battle.rating.legendary")
        elif score >= 80:
            rating = i18n.t("battle.rating.excellent")
        elif score >= 70:
            rating = i18n.t("battle.rating.good")
        elif score >= 60:
            rating = i18n.t("battle.rating.qualified")
        else:
            rating = i18n.t("battle.rating.needs_effort")

        return score, rating

    def calculate_player_score_breakdown(self, user_id: str, record: SessionRecord) -> dict[str, int]:
        """Return the deterministic components used by ``calculate_player_score``."""
        stats = record.player_stats.get(user_id, {})
        base = 60

        # Participation covers every committed dice action: raw rolls and checks.
        total_rolls = stats.get("total_rolls", 0)
        total_checks = stats.get("total_checks", 0)
        participation_count = total_rolls + total_checks
        participation = min(participation_count * 2, 15) if participation_count > 0 else 0

        # skill-check success rate
        successful_checks = stats.get("successful_checks", 0)
        success = int((successful_checks / total_checks) * 15) if total_checks > 0 else 0

        # roleplay, via action count
        action_count = stats.get("action_count", 0)
        actions = min(action_count, 10)

        # bonus for critical successes
        critical_success = stats.get("critical_success", 0)
        critical = critical_success * 2
        total = max(0, min(100, base + participation + success + actions + critical))
        return {
            "base": base,
            "participation": participation,
            "success": success,
            "actions": actions,
            "critical": critical,
            "total": total,
        }

    def generate_report_text(self, record: SessionRecord, session_name: str, i18n: I18n | None = None) -> str:
        """Render the plain-text battle report."""
        i18n = i18n or get_i18n()
        lines: list[str] = []

        lines.append("=" * 50)
        lines.append(i18n.t("battle.report.title"))
        lines.append("=" * 50)
        lines.append("")
        lines.append(i18n.t("battle.report.session_name_line", name=session_name))
        lines.append(
            i18n.t(
                "battle.report.start_time_line",
                time=datetime.fromtimestamp(record.start_time).strftime("%Y-%m-%d %H:%M:%S"),
            )
        )
        if record.end_time:
            lines.append(
                i18n.t(
                    "battle.report.end_time_line",
                    time=datetime.fromtimestamp(record.end_time).strftime("%Y-%m-%d %H:%M:%S"),
                )
            )
        lines.append(i18n.t("battle.report.duration_line", minutes=record.get_duration_minutes()))
        lines.append("")

        lines.append("=" * 50)
        lines.append(i18n.t("battle.report.player_scores_heading"))
        lines.append("=" * 50)
        lines.append("")

        for user_id, stats in record.player_stats.items():
            char_name = stats.get("char_name", i18n.t("battle.player.unknown_character"))
            score, rating = self.calculate_player_score(user_id, record, i18n=i18n)
            breakdown = self.calculate_player_score_breakdown(user_id, record)

            lines.append(i18n.t("battle.report.player_header", name=char_name))
            lines.append(i18n.t("battle.report.total_score_line", score=score, rating=rating))
            lines.append(i18n.t("battle.report.score_breakdown_line", **breakdown))
            lines.append(i18n.t("battle.report.total_rolls_line", count=stats.get("total_rolls", 0)))
            lines.append(
                i18n.t(
                    "battle.report.skill_checks_line",
                    successful=stats.get("successful_checks", 0),
                    total=stats.get("total_checks", 0),
                )
            )
            lines.append(i18n.t("battle.report.action_count_line", count=stats.get("action_count", 0)))
            lines.append(i18n.t("battle.report.critical_success_line", count=stats.get("critical_success", 0)))
            lines.append(i18n.t("battle.report.critical_failure_line", count=stats.get("critical_failure", 0)))
            lines.append("")

        lines.append("=" * 50)
        lines.append(i18n.t("battle.report.stats_heading"))
        lines.append("=" * 50)
        lines.append("")
        lines.append(
            i18n.t(
                "battle.report.stat_line",
                label=i18n.t("battle.report.label.total_dice_rolls"),
                count=len(record.dice_rolls),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.stat_line",
                label=i18n.t("battle.report.label.total_skill_checks"),
                count=len(record.skill_checks),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.stat_line",
                label=i18n.t("battle.report.label.combat_rounds"),
                count=len(record.combat_rounds),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.stat_line",
                label=i18n.t("battle.report.label.key_events_count"),
                count=len(record.key_events),
            )
        )
        lines.append("")

        if record.key_events:
            lines.append("=" * 50)
            lines.append(i18n.t("battle.report.key_events_heading"))
            lines.append("=" * 50)
            lines.append("")

            for i, event in enumerate(_select_recap_events(record.key_events), 1):
                timestamp = datetime.fromtimestamp(event["timestamp"]).strftime("%H:%M:%S")
                lines.append(
                    i18n.t(
                        "battle.report.key_event_item",
                        index=i,
                        time=timestamp,
                        description=_render_recap_text(event["description"]),
                    )
                )
            lines.append("")

        # highlights (critical successes/failures)
        critical_moments = [roll for roll in record.dice_rolls if roll.get("is_critical")]

        if critical_moments:
            lines.append("=" * 50)
            lines.append(i18n.t("battle.report.highlights_heading"))
            lines.append("=" * 50)
            lines.append("")

            for moment in critical_moments[-5:]:  # last 5 only
                lines.append(
                    i18n.t(
                        "battle.report.critical_moment_line",
                        name=moment["char_name"],
                        expression=moment["expression"],
                        result=moment["result"],
                    )
                )
            lines.append("")

        lines.append("=" * 50)
        lines.append(i18n.t("battle.report.footer"))
        lines.append("=" * 50)

        return "\n".join(lines)

    def generate_markdown_report(
        self, record: SessionRecord, session_name: str, i18n: I18n | None = None, detailed: bool = False
    ) -> str:
        """Render the Markdown battle report.

        With ``detailed=True`` the summary output is followed by a full
        chronological transcript (player actions, dice rolls, skill checks WITH
        their success levels, NPC interactions, combat rounds, key events) --
        the players' full keepsake / review log. ``detailed=False`` (the
        default) is byte-for-byte the historical summary-only rendering, so
        existing callers/tests are unaffected.
        """
        i18n = i18n or get_i18n()
        lines: list[str] = []

        lines.append(f"# {i18n.t('battle.report.title')}")
        lines.append("")
        lines.append(i18n.t("battle.report.md.session_info_heading"))
        lines.append("")
        lines.append(i18n.t("battle.report.md.session_name_line", name=session_name))
        lines.append(
            i18n.t(
                "battle.report.md.start_time_line",
                time=datetime.fromtimestamp(record.start_time).strftime("%Y-%m-%d %H:%M:%S"),
            )
        )
        if record.end_time:
            lines.append(
                i18n.t(
                    "battle.report.md.end_time_line",
                    time=datetime.fromtimestamp(record.end_time).strftime("%Y-%m-%d %H:%M:%S"),
                )
            )
        lines.append(i18n.t("battle.report.md.duration_line", minutes=record.get_duration_minutes()))
        lines.append("")

        lines.append(f"## {i18n.t('battle.report.player_scores_heading')}")
        lines.append("")

        for user_id, stats in record.player_stats.items():
            char_name = stats.get("char_name", i18n.t("battle.player.unknown_character"))
            score, rating = self.calculate_player_score(user_id, record, i18n=i18n)
            breakdown = self.calculate_player_score_breakdown(user_id, record)

            lines.append(f"### {i18n.t('battle.report.player_header', name=char_name)}")
            lines.append("")
            lines.append(i18n.t("battle.report.md.total_score_line", score=score, rating=rating))
            lines.append(i18n.t("battle.report.md.score_breakdown_line", **breakdown))
            lines.append("")
            lines.append(i18n.t("battle.report.md.stats_table_header"))
            lines.append("|--------|------|")
            lines.append(i18n.t("battle.report.md.total_rolls_row", count=stats.get("total_rolls", 0)))
            lines.append(
                i18n.t(
                    "battle.report.md.skill_checks_row",
                    successful=stats.get("successful_checks", 0),
                    total=stats.get("total_checks", 0),
                )
            )
            lines.append(i18n.t("battle.report.md.action_count_row", count=stats.get("action_count", 0)))
            lines.append(i18n.t("battle.report.md.critical_success_row", count=stats.get("critical_success", 0)))
            lines.append(i18n.t("battle.report.md.critical_failure_row", count=stats.get("critical_failure", 0)))
            lines.append("")

        lines.append(f"## {i18n.t('battle.report.stats_heading')}")
        lines.append("")
        lines.append(i18n.t("battle.report.md.game_stats_table_header"))
        lines.append("|------|------|")
        lines.append(
            i18n.t(
                "battle.report.md.stat_row",
                label=i18n.t("battle.report.label.total_dice_rolls"),
                count=len(record.dice_rolls),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.md.stat_row",
                label=i18n.t("battle.report.label.total_skill_checks"),
                count=len(record.skill_checks),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.md.stat_row",
                label=i18n.t("battle.report.label.combat_rounds"),
                count=len(record.combat_rounds),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.md.stat_row",
                label=i18n.t("battle.report.label.key_events_count"),
                count=len(record.key_events),
            )
        )
        lines.append("")

        if record.key_events:
            lines.append(f"## {i18n.t('battle.report.key_events_heading')}")
            lines.append("")

            for i, event in enumerate(_select_recap_events(record.key_events), 1):
                timestamp = datetime.fromtimestamp(event["timestamp"]).strftime("%H:%M:%S")
                lines.append(
                    i18n.t(
                        "battle.report.md.key_event_item",
                        index=i,
                        time=timestamp,
                        description=_render_recap_text(event["description"]),
                    )
                )
            lines.append("")

        critical_moments = [roll for roll in record.dice_rolls if roll.get("is_critical")]

        if critical_moments:
            lines.append(f"## {i18n.t('battle.report.highlights_heading')}")
            lines.append("")

            for moment in critical_moments[-5:]:
                timestamp = datetime.fromtimestamp(moment["timestamp"]).strftime("%H:%M:%S")
                lines.append(
                    i18n.t(
                        "battle.report.md.critical_moment_line",
                        time=timestamp,
                        name=moment["char_name"],
                        expression=moment["expression"],
                        result=moment["result"],
                    )
                )
            lines.append("")

        if detailed:
            lines.append(f"## {i18n.t('battle.report.md.detailed.heading')}")
            lines.append("")
            transcript = self._detailed_transcript_lines(record, i18n)
            lines.extend(transcript or [i18n.t("battle.report.md.detailed.empty")])
            lines.append("")

        lines.append("---")
        lines.append("")
        lines.append(f"*{i18n.t('battle.report.footer')}*")
        lines.append("")

        return "\n".join(lines)

    def _detailed_transcript_lines(self, record: SessionRecord, i18n: I18n) -> list[str]:
        """Build the chronological event transcript for `generate_markdown_report(detailed=True)`.

        Every recorded event (player action, dice roll, skill check WITH its success level, key event,
        NPC interaction, combat round) becomes one localized line tagged with its `HH:MM:SS` timestamp,
        then all are merged into a single timeline. Events with no timestamp (e.g. hand-appended combat
        rounds / NPC interactions) sort first and render with a placeholder time; the sort is stable, so
        same-timestamp events keep their insertion order.
        """
        unknown = i18n.t("battle.player.unknown_character")

        def _fmt_time(timestamp: float) -> str:
            if not timestamp:
                return i18n.t("battle.report.md.detailed.no_time")
            return datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")

        entries: list[tuple[float, str]] = []

        for actions in record.player_actions.values():
            for action in actions:
                timestamp = action.get("timestamp", 0)
                entries.append(
                    (
                        timestamp,
                        i18n.t(
                            "battle.report.md.detailed.player_action",
                            time=_fmt_time(timestamp),
                            name=action.get("char_name", unknown),
                            action=action.get("action", ""),
                        ),
                    )
                )

        for roll in record.dice_rolls:
            timestamp = roll.get("timestamp", 0)
            if roll.get("is_critical"):
                marker = i18n.t(
                    "battle.report.md.detailed.crit_failure_marker"
                    if roll.get("critical_type") == "failure"
                    else "battle.report.md.detailed.crit_success_marker"
                )
            else:
                marker = ""
            entries.append(
                (
                    timestamp,
                    i18n.t(
                        "battle.report.md.detailed.dice_roll",
                        time=_fmt_time(timestamp),
                        name=roll.get("char_name", unknown),
                        expression=roll.get("expression", ""),
                        result=roll.get("result", ""),
                        marker=marker,
                    ),
                )
            )

        for check in record.skill_checks:
            timestamp = check.get("timestamp", 0)
            entries.append(
                (
                    timestamp,
                    i18n.t(
                        "battle.report.md.detailed.skill_check",
                        time=_fmt_time(timestamp),
                        name=check.get("char_name", unknown),
                        skill=check.get("skill", ""),
                        target=check.get("target", ""),
                        roll=check.get("roll", ""),
                        success_level=_check_level_label(check, i18n),
                    ),
                )
            )

        for event in record.key_events:
            timestamp = event.get("timestamp", 0)
            entries.append(
                (
                    timestamp,
                    i18n.t(
                        "battle.report.md.detailed.key_event",
                        time=_fmt_time(timestamp),
                        description=event.get("description", ""),
                    ),
                )
            )

        for interaction in record.npc_interactions:
            timestamp = interaction.get("timestamp", 0)
            entries.append(
                (
                    timestamp,
                    i18n.t(
                        "battle.report.md.detailed.npc_interaction",
                        time=_fmt_time(timestamp),
                        npc=interaction.get("npc", interaction.get("name", "?")),
                        note=interaction.get("note", interaction.get("description", interaction.get("action", ""))),
                    ),
                )
            )

        for index, combat_round in enumerate(record.combat_rounds, 1):
            timestamp = combat_round.get("timestamp", 0)
            entries.append(
                (
                    timestamp,
                    i18n.t(
                        "battle.report.md.detailed.combat_round",
                        time=_fmt_time(timestamp),
                        round=combat_round.get("round", index),
                        notes=combat_round.get("notes", combat_round.get("description", "")),
                    ),
                )
            )

        entries.sort(key=lambda item: item[0])
        return [line for _timestamp, line in entries]

    def generate_summary_for_prompt(self, record: SessionRecord, session_name: str, i18n: I18n | None = None) -> str:
        """Render a compact recap of `record`, meant for injection into an LLM prompt."""
        i18n = i18n or get_i18n()
        lines: list[str] = []

        lines.append(i18n.t("battle.summary.title"))
        lines.append("")
        lines.append(i18n.t("battle.summary.session_name_line", name=session_name))
        lines.append(
            i18n.t("battle.summary.date_line", date=datetime.fromtimestamp(record.start_time).strftime("%Y-%m-%d"))
        )

        if record.end_time:
            lines.append(i18n.t("battle.summary.duration_line", minutes=record.get_duration_minutes()))
        lines.append("")

        if record.player_stats:
            lines.append(i18n.t("battle.summary.players_heading"))
            for user_id, stats in record.player_stats.items():
                char_name = stats.get("char_name", i18n.t("battle.player.unknown_character"))
                score, rating = self.calculate_player_score(user_id, record, i18n=i18n)
                lines.append(i18n.t("battle.summary.player_line", name=char_name, score=score, rating=rating))
            lines.append("")

        if record.key_events:
            lines.append(i18n.t("battle.summary.events_heading"))
            for event in record.key_events[-5:]:  # last 5 only
                lines.append(i18n.t("battle.summary.event_item", description=event["description"]))
            lines.append("")

        lines.append(i18n.t("battle.summary.progress_heading"))
        lines.append(
            i18n.t(
                "battle.summary.progress_line",
                dice_rolls=len(record.dice_rolls),
                skill_checks=len(record.skill_checks),
            )
        )

        if record.combat_rounds:
            lines.append(i18n.t("battle.summary.combat_rounds_line", count=len(record.combat_rounds)))

        lines.append("")
        lines.append(i18n.t("battle.summary.footer"))

        return "\n".join(lines)


class BattleReportManager:
    """Async convenience wrapper around `BattleReportGenerator`, keyed by `chat_key`."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self.generator = BattleReportGenerator(store)

    async def ensure_session_started(self, chat_key: str, i18n: I18n | None = None) -> bool:
        """Start a session for `chat_key` if none is in progress; returns True if one was started."""
        current_session = await self.generator.get_current_session(chat_key)
        if not current_session:
            await self.generator.start_session(chat_key, auto_start=True, i18n=i18n)
            return True
        return False

    async def start_session(
        self,
        chat_key: str,
        session_name: str | None = None,
        i18n: I18n | None = None,
        force_new: bool = False,
    ) -> str:
        """Start recording a session for `chat_key`."""
        return await self.generator.start_session(chat_key, session_name, i18n=i18n, force_new=force_new)

    async def _session_for_write(self, chat_key: str) -> SessionRecord:
        record = await self.generator.get_current_session(chat_key)
        if record is None:
            await self.generator.start_session(chat_key, auto_start=True)
            record = await self.generator.get_current_session(chat_key)
        if record is None:  # defensive: a successful start must persist a record
            raise RuntimeError("session_record_not_available")
        return record

    async def add_dice_roll(
        self,
        chat_key: str,
        user_id: str,
        char_name: str,
        expression: str,
        result: int,
        is_critical: bool = False,
        critical_type: str = "",
    ) -> None:
        """Record a dice roll, lazily starting the session when needed."""
        record = await self._session_for_write(chat_key)
        record.add_dice_roll(user_id, char_name, expression, result, is_critical, critical_type)
        await self.generator.save_session(chat_key, record)

    async def add_skill_check(
        self,
        chat_key: str,
        user_id: str,
        char_name: str,
        skill: str,
        target: int,
        roll: int,
        success_level: str | None = None,
        **details: object,
    ) -> None:
        """Record a structured skill check, lazily starting the session."""
        record = await self._session_for_write(chat_key)
        record.add_skill_check(user_id, char_name, skill, target, roll, success_level, **details)
        await self.generator.save_session(chat_key, record)

    async def add_key_event(self, chat_key: str, description: str, event_type: str = "general") -> bool:
        """Record a key event, returning whether deduplication accepted it."""
        record = await self._session_for_write(chat_key)
        recorded = record.add_key_event(description, event_type)
        if recorded:
            await self.generator.save_session(chat_key, record)
        return recorded

    async def add_player_action(self, chat_key: str, user_id: str, char_name: str, action: str) -> None:
        """Record a player action, lazily starting the session when needed."""
        record = await self._session_for_write(chat_key)
        record.add_player_action(user_id, char_name, action)
        await self.generator.save_session(chat_key, record)

    async def add_combat_round(self, chat_key: str, round_number: int, notes: str = "") -> None:
        """Record a combat-round transition, lazily starting the session."""
        record = await self._session_for_write(chat_key)
        if record.add_combat_round(round_number, notes):
            await self.generator.save_session(chat_key, record)

    async def set_combat_state(self, chat_key: str, round_number: int, current: str, turn: int) -> None:
        """Record the round and initiative pointer from one committed tracker state."""
        record = await self._session_for_write(chat_key)
        record.set_combat_state(round_number, current, turn)
        await self.generator.save_session(chat_key, record)

    async def generate_battle_report(
        self, chat_key: str, i18n: I18n | None = None
    ) -> tuple[str, str, str] | tuple[None, None, None]:
        """End the in-progress session and render its report.

        Returns `(text_report, markdown_report, session_name)`; all three are
        `None` if no session was in progress. A custom session name set via
        `start_session` is preserved in the return value even though
        `end_session` clears `session_name.{chat_key}.current` as part of
        archiving the session.
        """
        i18n = i18n or get_i18n()
        name_key = f"session_name.{chat_key}.current"
        session_name = await self.store.get(store_key=name_key)
        record = await self.generator.end_session(chat_key)
        if not record:
            return None, None, None
        if not session_name:
            session_name = _default_session_name(datetime.fromtimestamp(record.start_time), i18n)
        text_report = self.generator.generate_report_text(record, session_name, i18n=i18n)
        markdown_report = self.generator.generate_markdown_report(record, session_name, i18n=i18n)
        return text_report, markdown_report, session_name

    async def get_last_session_summary(self, chat_key: str, i18n: I18n | None = None) -> str | None:
        """Return a compact recap of the most recently archived session, for prompt injection."""
        i18n = i18n or get_i18n()
        latest_record = await self.generator.get_latest_history(chat_key)
        if not latest_record:
            return None
        name_key = f"session_name.{chat_key}.latest"
        session_name = await self.store.get(store_key=name_key)
        if not session_name:
            session_name = _default_session_name(datetime.fromtimestamp(latest_record.start_time), i18n)
        return self.generator.generate_summary_for_prompt(latest_record, session_name, i18n=i18n)
