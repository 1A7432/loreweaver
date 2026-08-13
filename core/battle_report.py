"""The session report ("团报") — the players' keepsake of a session.

The report has ONE narrative source: the room's real conversation, the
append-only `chat_history` tree that `agent.history.load_chain` reads. Nothing
here re-records the story a second time.

What this module still keeps is the layer the transcript genuinely cannot
carry: **dice**. A roll's expression, its total, a check's target, the graded
success label and the critical/fumble flags are engine values (iron rule #1) —
the narration around them is prose, and prose is not a record of what the dice
did. So a `SessionRecord` is exactly two ledgers, `dice_rolls` and
`skill_checks`, plus the per-player aggregates derived from them.

Everything else that used to live here was a hand-maintained index of a
transcript that was already complete — player actions truncated at write time,
key events that only existed when the model remembered to log one, combat
rounds duplicating `initiative_meta`, NPC interactions with no writer at all —
and it is gone.

Rendering splits by audience:

- `generate_report_text` — the compact scoreboard. It is what the
  `generate_session_report` tool hands back to the model and what a console
  prints, so it must stay small; it never carries the transcript.
- `generate_markdown_report` — the players' file. Pass `transcript=` (the wire
  shape `load_chain` returns) and the whole exchange is rendered below the
  scoreboard, capped by `TRANSCRIPT_MAX_CHARS` with the truncation stated in
  the report itself.

Secrecy (iron rule #3): the report is player-facing. `chat_history` holds only
what the room saw — the player's own message and the final, post-censor reply
that was broadcast — and hidden (`.rh`) rolls are filtered by `_visible_rolls`
before any rendering or aggregate.
"""

from __future__ import annotations

import json
import time
from datetime import datetime

from infra.i18n import I18n, get_i18n
from infra.llm import HISTORY_TURN_KEY
from infra.room_facets import STORAGE_ROOM_STATE, RoomStateFacet
from infra.store import Store

NPC_USER_ID = "__npc__"

# How much rendered transcript one report may carry. A turn costs roughly 1.5-2.5k
# characters (a keeper reply runs ~1.5k, a player's a few hundred, and `net.session`
# caps player input at 4k), so 200k is on the order of a hundred turns — a whole
# real campaign fits, and a room that somehow does not is still bounded to a file a
# client can render. Past the cap the report keeps the MOST RECENT messages (a
# session's ending is what a keepsake is for) and says how many it left out. Nothing
# is lost from disk: the history tree is append-only and still holds every message.
TRANSCRIPT_MAX_CHARS = 200_000


def _check_succeeded(check: dict) -> bool:
    return bool(check.get("success"))


def _check_level_label(check: dict, i18n: I18n) -> str:
    """The display label recorded with the check (already localized at record
    time — a historical record keeps the language it was played in)."""
    label = check.get("label")
    if label:
        return str(label)
    return str(check.get("rank_id", ""))


def _clock_time(timestamp: float, i18n: I18n) -> str:
    """``HH:MM:SS`` for a recorded moment, or the placeholder for an unstamped one."""
    if not timestamp:
        return i18n.t("battle.report.md.dice_log.no_time")
    return datetime.fromtimestamp(timestamp).strftime("%H:%M:%S")


def _default_session_name(moment: datetime, i18n: I18n) -> str:
    """Render the auto-generated session name used when none is supplied."""
    return i18n.t("battle.session.default_name", timestamp=moment.strftime("%Y%m%d-%H%M"))


def _visible_rolls(rolls: list[dict]) -> list[dict]:
    """Drop hidden (`.rh`) rolls so no report ever replays a secret result."""
    return [roll for roll in rolls if not roll.get("hidden")]


class SessionRecord:
    """One session's dice ledgers and the per-player aggregates over them."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.start_time = time.time()
        self.end_time: float | None = None

        self.dice_rolls: list[dict] = []
        self.skill_checks: list[dict] = []

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
        hidden: bool = False,
    ) -> None:
        """Record a dice roll and update the roller's aggregate stats.

        ``critical_type`` is ``"success"`` / ``"failure"`` / ``""``; critical
        successes and failures are tracked as SEPARATE counters on
        ``player_stats``.

        ``hidden`` marks a keeper/private roll (e.g. `.rh`): it is retained on
        the record for the keeper's own bookkeeping, but MUST never surface in
        any player-facing report -- it is excluded from every rendered
        statistic, aggregate and highlight (see ``_visible_rolls`` and
        ``rebuild_player_stats``), so the roller's secret result cannot be
        replayed via `.report`.
        """
        entry = {
            "user_id": user_id,
            "char_name": char_name,
            "expression": expression,
            "result": result,
            "is_critical": is_critical,
            "critical_type": critical_type,
            "timestamp": time.time(),
        }
        if hidden:
            entry["hidden"] = True
        self.dice_rolls.append(entry)

        # A hidden roll never contributes to any player-facing aggregate.
        if user_id == NPC_USER_ID or hidden:
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
        **details: object,
    ) -> None:
        """Record a structured skill check and update the roller's aggregates.

        ``details`` is the canonical `core.battle_recording.check_fields` shape
        — semantic flags (``success``/``critical``/``fumble``), the pack rank
        id/tier, the rendered ``label``, plus any system-declared roll
        modifiers — stored as-is (``None`` values dropped). Aggregates branch
        only on the semantic flags.
        """
        check: dict = {
            "user_id": user_id,
            "char_name": char_name,
            "skill": skill,
            "target": target,
            "roll": roll,
            "timestamp": time.time(),
        }
        check.update({key: value for key, value in details.items() if value is not None})
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
        stats["successful_checks"] = stats.get("successful_checks", 0) + int(_check_succeeded(check))
        if check.get("critical"):
            stats["critical_success"] = stats.get("critical_success", 0) + 1
        elif check.get("fumble"):
            stats["critical_failure"] = stats.get("critical_failure", 0) + 1

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
            if roll.get("hidden"):
                continue
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
            if check.get("critical"):
                stats["critical_success"] = stats.get("critical_success", 0) + 1
            elif check.get("fumble"):
                stats["critical_failure"] = stats.get("critical_failure", 0) + 1

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
        record.player_stats = data.get("player_stats", {})
        if record.dice_rolls or record.skill_checks:
            record.rebuild_player_stats()
        else:
            record.player_stats.pop(NPC_USER_ID, None)
        return record


class BattleReportGenerator:
    """Builds the session report's renderings (text / Markdown) from a `SessionRecord`."""

    def __init__(self, store: Store) -> None:
        self.store = store

    async def get_latest_history(self, chat_key: str) -> SessionRecord | None:
        """Return the most recently archived session for `chat_key`, if any."""
        try:
            latest_key = "session_history.latest"
            data = await self.store.state_get(chat_key, latest_key)
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

        store_key = "session_record.current"
        await self.store.state_set(chat_key, store_key, json.dumps(record.to_dict(), ensure_ascii=False))

        name_key = "session_name.current"
        await self.store.state_set(chat_key, name_key, session_name)

        return session_id

    async def get_current_session(self, chat_key: str) -> SessionRecord | None:
        """Return the in-progress session for `chat_key`, if one exists."""
        store_key = "session_record.current"

        try:
            data = await self.store.state_get(chat_key, store_key)
            if data:
                return SessionRecord.from_dict(json.loads(data))
        except Exception:
            pass

        return None

    async def save_session(self, chat_key: str, record: SessionRecord) -> None:
        """Persist `record` as the in-progress session for `chat_key`."""
        store_key = "session_record.current"
        await self.store.state_set(chat_key, store_key, json.dumps(record.to_dict(), ensure_ascii=False))

    async def end_session(self, chat_key: str) -> SessionRecord | None:
        """End the in-progress session for `chat_key`, archiving it to history."""
        record = await self.get_current_session(chat_key)
        if record:
            record.end_session()

            name_key = "session_name.current"
            session_name = await self.store.state_get(chat_key, name_key)

            history_key = f"session_history.{record.session_id}"
            latest_key = "session_history.latest"
            latest_name_key = "session_name.latest"
            record_json = json.dumps(record.to_dict(), ensure_ascii=False)

            await self.store.state_set(chat_key, history_key, record_json)
            await self.store.state_set(chat_key, latest_key, record_json)

            if session_name:
                await self.store.state_set(chat_key, latest_name_key, session_name)

            current_key = "session_record.current"
            await self.store.state_delete(chat_key, current_key)
            await self.store.state_delete(chat_key, name_key)

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
        """Return the deterministic components used by ``calculate_player_score``.

        Every component is computed from the dice ledgers — the only thing this
        module records. Roleplay is deliberately unscored: the transcript is
        the record of it, and `chat_history` carries no speaker identity to
        attribute a line to a player with.
        """
        stats = record.player_stats.get(user_id, {})
        base = 60

        # Participation covers every committed dice action: raw rolls and checks.
        total_rolls = stats.get("total_rolls", 0)
        total_checks = stats.get("total_checks", 0)
        participation_count = total_rolls + total_checks
        participation = min(participation_count * 2, 20) if participation_count > 0 else 0

        # skill-check success rate
        successful_checks = stats.get("successful_checks", 0)
        success = int((successful_checks / total_checks) * 20) if total_checks > 0 else 0

        # bonus for critical successes
        critical_success = stats.get("critical_success", 0)
        critical = critical_success * 2
        total = max(0, min(100, base + participation + success + critical))
        return {
            "base": base,
            "participation": participation,
            "success": success,
            "critical": critical,
            "total": total,
        }

    def generate_report_text(self, record: SessionRecord, session_name: str, i18n: I18n | None = None) -> str:
        """Render the plain-text scoreboard (no transcript — see the module docstring)."""
        i18n = i18n or get_i18n()
        lines: list[str] = []
        visible_rolls = _visible_rolls(record.dice_rolls)

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
                count=len(visible_rolls),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.stat_line",
                label=i18n.t("battle.report.label.total_skill_checks"),
                count=len(record.skill_checks),
            )
        )
        lines.append("")

        # highlights (critical successes/failures)
        critical_moments = [roll for roll in visible_rolls if roll.get("is_critical")]

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
        self,
        record: SessionRecord,
        session_name: str,
        i18n: I18n | None = None,
        transcript: list[dict] | None = None,
    ) -> str:
        """Render the Markdown session report.

        With ``transcript`` supplied — the wire-shape message list
        `agent.history.load_chain` returns — the room's whole conversation is
        rendered below the scoreboard, capped at ``TRANSCRIPT_MAX_CHARS``.
        ``None`` (the default) renders the scoreboard alone; an empty list
        still renders the section, saying the room has no exchange yet.
        """
        i18n = i18n or get_i18n()
        lines: list[str] = []
        visible_rolls = _visible_rolls(record.dice_rolls)

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
                count=len(visible_rolls),
            )
        )
        lines.append(
            i18n.t(
                "battle.report.md.stat_row",
                label=i18n.t("battle.report.label.total_skill_checks"),
                count=len(record.skill_checks),
            )
        )
        lines.append("")

        critical_moments = [roll for roll in visible_rolls if roll.get("is_critical")]

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

        if transcript is not None:
            dice_log = self._dice_log_lines(record, i18n)
            if dice_log:
                lines.append(f"## {i18n.t('battle.report.md.dice_log.heading')}")
                lines.append("")
                lines.extend(dice_log)
                lines.append("")
            lines.append(f"## {i18n.t('battle.report.md.transcript.heading')}")
            lines.append("")
            lines.extend(self._transcript_lines(transcript, i18n))
            lines.append("")

        lines.append("---")
        lines.append("")
        lines.append(f"*{i18n.t('battle.report.footer')}*")
        lines.append("")

        return "\n".join(lines)

    def _dice_log_lines(self, record: SessionRecord, i18n: I18n) -> list[str]:
        """Every visible roll and graded check, chronologically — the values the
        transcript cannot carry.

        The prose above a roll says "the lock gives"; it does not say `1d100` = 07
        against a target of 45 for a hard success. That is why these two ledgers
        survived the rebuild, and this is where they are read. They are a SEPARATE
        section rather than interleaved into the conversation because a history
        record carries a turn index but no timestamp, so there is no honest way to
        order a roll against a message.
        """
        unknown = i18n.t("battle.player.unknown_character")
        entries: list[tuple[float, str]] = []

        for roll in _visible_rolls(record.dice_rolls):
            timestamp = float(roll.get("timestamp", 0) or 0)
            if roll.get("is_critical"):
                marker = i18n.t(
                    "battle.report.md.dice_log.crit_failure_marker"
                    if roll.get("critical_type") == "failure"
                    else "battle.report.md.dice_log.crit_success_marker"
                )
            else:
                marker = ""
            entries.append(
                (
                    timestamp,
                    i18n.t(
                        "battle.report.md.dice_log.roll",
                        time=_clock_time(timestamp, i18n),
                        name=roll.get("char_name", unknown),
                        expression=roll.get("expression", ""),
                        result=roll.get("result", ""),
                        marker=marker,
                    ),
                )
            )

        for check in record.skill_checks:
            timestamp = float(check.get("timestamp", 0) or 0)
            entries.append(
                (
                    timestamp,
                    i18n.t(
                        "battle.report.md.dice_log.check",
                        time=_clock_time(timestamp, i18n),
                        name=check.get("char_name", unknown),
                        skill=check.get("skill", ""),
                        target=check.get("target", ""),
                        roll=check.get("roll", ""),
                        success_level=_check_level_label(check, i18n),
                    ),
                )
            )

        entries.sort(key=lambda item: item[0])
        return [line for _timestamp, line in entries]

    def _transcript_lines(self, transcript: list[dict], i18n: I18n) -> list[str]:
        """Render the room's conversation, newest-biased under ``TRANSCRIPT_MAX_CHARS``.

        One block per message, labelled by role (`user` = the player's own words,
        `assistant` = the Keeper's reply) and stamped with the turn it belongs to,
        so a reader can line the story up with `.undo` and the chronicle. When the
        budget cuts, the KEPT part is the tail and the report says so — a silent
        truncation would make a keepsake lie about where the session ended.
        """
        rendered: list[str] = []
        used = 0
        omitted = 0
        for message in reversed(transcript):
            text = str(message.get("content", "")).strip()
            if not text:
                continue
            if omitted:  # the budget is spent; from here on we only count what we lost
                omitted += 1
                continue
            speaker = i18n.t(
                "battle.report.md.transcript.keeper"
                if message.get("role") == "assistant"
                else "battle.report.md.transcript.player"
            )
            block = i18n.t(
                "battle.report.md.transcript.message",
                turn=int(message.get(HISTORY_TURN_KEY, 0) or 0),
                speaker=speaker,
                text=text,
            )
            # `rendered` guards the floor: the newest message is always shown, even
            # if it alone is over budget, so the report can never come back empty.
            if used + len(block) > TRANSCRIPT_MAX_CHARS and rendered:
                omitted += 1
                continue
            used += len(block)
            rendered.append(block)
        rendered.reverse()
        if not rendered:
            return [i18n.t("battle.report.md.transcript.empty")]
        if omitted:
            rendered.insert(
                0,
                i18n.t(
                    "battle.report.md.transcript.truncated",
                    omitted=omitted,
                    kept=len(rendered),
                ),
            )
        return rendered


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
        hidden: bool = False,
    ) -> None:
        """Record a dice roll, lazily starting the session when needed.

        ``hidden`` marks a private/keeper roll that must be kept out of every
        player-facing report (see ``SessionRecord.add_dice_roll``).
        """
        record = await self._session_for_write(chat_key)
        record.add_dice_roll(user_id, char_name, expression, result, is_critical, critical_type, hidden)
        await self.generator.save_session(chat_key, record)

    async def add_skill_check(
        self,
        chat_key: str,
        user_id: str,
        char_name: str,
        skill: str,
        target: int,
        roll: int,
        **details: object,
    ) -> None:
        """Record a structured skill check, lazily starting the session."""
        record = await self._session_for_write(chat_key)
        record.add_skill_check(user_id, char_name, skill, target, roll, **details)
        await self.generator.save_session(chat_key, record)

    async def generate_battle_report(
        self, chat_key: str, i18n: I18n | None = None, transcript: list[dict] | None = None
    ) -> tuple[str, str, str] | tuple[None, None, None]:
        """End the in-progress session and render its report.

        Returns `(text_report, markdown_report, session_name)`; all three are
        `None` if no session was in progress. `transcript` (the room's
        conversation, as `agent.history.load_chain` returns it) rides into the
        Markdown keepsake only — the text report stays a compact scoreboard. A
        custom session name set via `start_session` is preserved in the return
        value even though `end_session` clears `session_name.{chat_key}.current`
        as part of archiving the session.
        """
        i18n = i18n or get_i18n()
        name_key = "session_name.current"
        session_name = await self.store.state_get(chat_key, name_key)
        record = await self.generator.end_session(chat_key)
        if not record:
            return None, None, None
        if not session_name:
            session_name = _default_session_name(datetime.fromtimestamp(record.start_time), i18n)
        text_report = self.generator.generate_report_text(record, session_name, i18n=i18n)
        markdown_report = self.generator.generate_markdown_report(
            record, session_name, i18n=i18n, transcript=transcript
        )
        return text_report, markdown_report, session_name


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="battle_reports",
        owner="core.battle_report",
        reset_scope="story",
        # Rendered records plus the per-session pointers that index them; every key in the
        # family is written under one of these prefixes, never bare.
        state_prefixes=frozenset(
            {"battle_report.", "session_history.", "session_name.", "session_record."}
        ),
        storages=frozenset({STORAGE_ROOM_STATE}),
    ),
)
