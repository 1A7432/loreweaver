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

from infra.i18n import I18n, get_i18n
from infra.store import Store


def _is_successful_level(success_level: str) -> bool:
    """Best-effort success detection for a caller-supplied skill-check level label.

    ``success_level`` is a free-text label produced upstream (e.g. by the
    dice engine's localized level-name renderer), so its language isn't
    fixed. This checks the localized "success" keyword for every shipped
    locale — for zh-rendered labels it matches the legacy hardcoded
    ``"成功" in success_level`` check byte-for-byte.
    """
    i18n = get_i18n()
    return any(
        i18n.with_locale(locale).t("battle.skill_check.success_keyword") in success_level
        for locale in i18n.available_locales()
    )


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

        if user_id not in self.player_stats:
            self.player_stats[user_id] = {
                "char_name": char_name,
                "total_rolls": 0,
                "critical_success": 0,
                "critical_failure": 0,
            }

        self.player_stats[user_id]["total_rolls"] += 1
        if critical_type == "success" or (is_critical and not critical_type):
            self.player_stats[user_id]["critical_success"] += 1
        elif critical_type == "failure":
            self.player_stats[user_id]["critical_failure"] += 1

    def add_skill_check(
        self, user_id: str, char_name: str, skill: str, target: int, roll: int, success_level: str
    ) -> None:
        """Record a skill check and update the roller's aggregate stats."""
        self.skill_checks.append(
            {
                "user_id": user_id,
                "char_name": char_name,
                "skill": skill,
                "target": target,
                "roll": roll,
                "success_level": success_level,
                "timestamp": time.time(),
            }
        )

        if user_id not in self.player_stats:
            self.player_stats[user_id] = {
                "char_name": char_name,
                "total_checks": 0,
                "successful_checks": 0,
            }

        stats = self.player_stats[user_id]
        stats["total_checks"] = stats.get("total_checks", 0) + 1
        if _is_successful_level(success_level):
            stats["successful_checks"] = stats.get("successful_checks", 0) + 1

    def add_key_event(self, description: str, event_type: str = "general") -> None:
        """Record a key (plot-relevant) event."""
        self.key_events.append({"description": description, "event_type": event_type, "timestamp": time.time()})

    def add_player_action(self, user_id: str, char_name: str, action: str) -> None:
        """Record a free-text player action."""
        if user_id not in self.player_actions:
            self.player_actions[user_id] = []

        self.player_actions[user_id].append({"char_name": char_name, "action": action, "timestamp": time.time()})

        if user_id not in self.player_stats:
            self.player_stats[user_id] = {"char_name": char_name}

        self.player_stats[user_id]["action_count"] = len(self.player_actions[user_id])

    def end_session(self) -> None:
        """Mark the session as ended (stamps ``end_time``)."""
        self.end_time = time.time()

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
    ) -> str:
        """Start recording a session for `chat_key`, returning the new `session_id`.

        `auto_start` distinguishes manual vs. automatic session starts (kept
        for parity with the source; not otherwise used here).
        """
        i18n = i18n or get_i18n()
        session_id = f"session_{int(time.time())}"

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

        stats = record.player_stats[user_id]
        score = 60  # base score

        # participation, via roll count
        total_rolls = stats.get("total_rolls", 0)
        if total_rolls > 0:
            score += min(total_rolls * 2, 15)  # capped at 15

        # skill-check success rate
        total_checks = stats.get("total_checks", 0)
        successful_checks = stats.get("successful_checks", 0)
        if total_checks > 0:
            success_rate = successful_checks / total_checks
            score += int(success_rate * 15)  # capped at 15

        # roleplay, via action count
        action_count = stats.get("action_count", 0)
        score += min(action_count * 1, 10)  # capped at 10

        # bonus for critical successes
        critical_success = stats.get("critical_success", 0)
        score += critical_success * 2

        score = max(0, min(100, score))

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

            lines.append(i18n.t("battle.report.player_header", name=char_name))
            lines.append(i18n.t("battle.report.total_score_line", score=score, rating=rating))
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

            for i, event in enumerate(record.key_events[-10:], 1):  # last 10 only
                timestamp = datetime.fromtimestamp(event["timestamp"]).strftime("%H:%M:%S")
                lines.append(
                    i18n.t("battle.report.key_event_item", index=i, time=timestamp, description=event["description"])
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

    def generate_markdown_report(self, record: SessionRecord, session_name: str, i18n: I18n | None = None) -> str:
        """Render the Markdown battle report."""
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

            lines.append(f"### {i18n.t('battle.report.player_header', name=char_name)}")
            lines.append("")
            lines.append(i18n.t("battle.report.md.total_score_line", score=score, rating=rating))
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

            for i, event in enumerate(record.key_events[-10:], 1):
                timestamp = datetime.fromtimestamp(event["timestamp"]).strftime("%H:%M:%S")
                lines.append(
                    i18n.t(
                        "battle.report.md.key_event_item", index=i, time=timestamp, description=event["description"]
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

        lines.append("---")
        lines.append("")
        lines.append(f"*{i18n.t('battle.report.footer')}*")
        lines.append("")

        return "\n".join(lines)

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

    async def start_session(self, chat_key: str, session_name: str | None = None, i18n: I18n | None = None) -> str:
        """Start recording a session for `chat_key`."""
        return await self.generator.start_session(chat_key, session_name, i18n=i18n)

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
        """Record a dice roll against the in-progress session, if any."""
        record = await self.generator.get_current_session(chat_key)
        if record:
            record.add_dice_roll(user_id, char_name, expression, result, is_critical, critical_type)
            await self.generator.save_session(chat_key, record)

    async def add_skill_check(
        self, chat_key: str, user_id: str, char_name: str, skill: str, target: int, roll: int, success_level: str
    ) -> None:
        """Record a skill check against the in-progress session, if any."""
        record = await self.generator.get_current_session(chat_key)
        if record:
            record.add_skill_check(user_id, char_name, skill, target, roll, success_level)
            await self.generator.save_session(chat_key, record)

    async def add_key_event(self, chat_key: str, description: str, event_type: str = "general") -> None:
        """Record a key event against the in-progress session, if any."""
        record = await self.generator.get_current_session(chat_key)
        if record:
            record.add_key_event(description, event_type)
            await self.generator.save_session(chat_key, record)

    async def add_player_action(self, chat_key: str, user_id: str, char_name: str, action: str) -> None:
        """Record a player action against the in-progress session, if any."""
        record = await self.generator.get_current_session(chat_key)
        if record:
            record.add_player_action(user_id, char_name, action)
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
