"""Small, room-scoped Discord voice player."""

from __future__ import annotations

import asyncio
import importlib.util
import shutil
import tempfile
from pathlib import Path
from typing import Any


class DiscordVoiceManager:
    """Map one logical room to one Discord voice connection and audio source."""

    def __init__(self, sdk: Any, *, executable: str = "ffmpeg") -> None:
        self.sdk = sdk
        self.executable = executable
        self.clients: dict[str, Any] = {}
        self._temp_files: dict[str, Path] = {}
        self._guild_rooms: dict[str, str] = {}
        self._last_events: dict[str, Any] = {}
        self._lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        executable_ok = shutil.which(self.executable) is not None
        voice_dependencies = all(importlib.util.find_spec(name) is not None for name in ("nacl", "davey"))
        return self.sdk is not None and voice_dependencies and executable_ok

    async def join(self, session_key: str, interaction: Any) -> str:
        if not self.available:
            return "unavailable"
        channel = getattr(getattr(getattr(interaction, "user", None), "voice", None), "channel", None)
        if channel is None:
            return "no_channel"
        guild_id = str(
            getattr(interaction, "guild_id", None)
            or getattr(getattr(channel, "guild", None), "id", "")
        )
        async with self._lock:
            if guild_id and self._guild_rooms.get(guild_id) not in {None, session_key}:
                return "busy"

            current = self.clients.get(session_key)
            if current is not None and getattr(current, "channel", None) == channel:
                return "joined"
            if current is not None:
                await current.disconnect()
            self.clients.pop(session_key, None)
            self._guild_rooms = {
                key: room for key, room in self._guild_rooms.items() if room != session_key
            }
            self._cleanup(session_key)
            client = await channel.connect()
            self.clients[session_key] = client
            if guild_id:
                self._guild_rooms[guild_id] = session_key
            return "joined"

    async def leave(self, session_key: str) -> str:
        async with self._lock:
            client = self.clients.pop(session_key, None)
            try:
                if client is not None:
                    await client.disconnect()
            finally:
                self._guild_rooms = {
                    guild_id: room
                    for guild_id, room in self._guild_rooms.items()
                    if room != session_key
                }
                self._last_events.pop(session_key, None)
                self._cleanup(session_key)
            return "left"

    async def handle_event(self, session_key: str, event: Any, media_store: Any) -> None:
        if event.kind != "audio" or event.data.get("type") != "audio_control":
            return
        if self._last_events.get(session_key) is event:
            return
        self._last_events[session_key] = event
        async with self._lock:
            client = self.clients.get(session_key)
            if client is None:
                return

            action = str(event.data.get("action") or "")
            if action == "pause":
                client.pause()
            elif action == "resume":
                client.resume()
            elif action == "stop":
                client.stop()
            elif action == "volume":
                source = getattr(client, "source", None)
                if source is not None and hasattr(source, "volume"):
                    source.volume = float(event.data.get("volume", 1.0))
            elif action == "play" and media_store is not None and event.data.get("hash"):
                record, data = await media_store.read_bytes(session_key, str(event.data["hash"]))
                self._play(
                    session_key,
                    client,
                    record.name,
                    data,
                    float(event.data.get("volume", 1.0)),
                )

    def _play(self, session_key: str, client: Any, name: str, data: bytes, volume: float) -> None:
        client.stop()
        self._cleanup(session_key)
        suffix = Path(name).suffix or ".audio"
        with tempfile.NamedTemporaryFile(prefix="loreweaver-discord-", suffix=suffix, delete=False) as handle:
            handle.write(data)
            path = Path(handle.name)
        self._temp_files[session_key] = path
        try:
            source = self.sdk.FFmpegPCMAudio(str(path), executable=self.executable)
            source = self.sdk.PCMVolumeTransformer(source, volume=max(0.0, min(1.0, volume)))

            def done(_error: Exception | None) -> None:
                path.unlink(missing_ok=True)
                if self._temp_files.get(session_key) == path:
                    self._temp_files.pop(session_key, None)

            client.play(source, after=done)
        except Exception:
            self._cleanup(session_key)
            raise

    def _cleanup(self, session_key: str) -> None:
        path = self._temp_files.pop(session_key, None)
        if path is not None:
            path.unlink(missing_ok=True)

    async def close(self) -> None:
        await asyncio.gather(
            *(self.leave(session_key) for session_key in list(self.clients)),
            return_exceptions=True,
        )
