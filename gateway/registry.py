"""Platform adapter registry.

Trimmed from the Hermes gateway platform registry design (MIT, Copyright 2025
Nous Research) for the platform-independent transport layer.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class PlatformEntry:
    name: str
    label: str
    adapter_factory: Callable[[Any], Any]
    check_fn: Callable[[], bool]
    required_env: list[str] = field(default_factory=list)
    install_hint: str = ""


class PlatformRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, PlatformEntry] = {}

    def register(self, entry: PlatformEntry) -> None:
        self._entries[entry.name] = entry

    def get(self, name: str) -> PlatformEntry | None:
        return self._entries.get(name)

    def create_adapter(self, name: str, config: Any) -> Any | None:
        entry = self.get(name)
        if entry is None:
            return None
        if not entry.check_fn():
            return None
        return entry.adapter_factory(config)

    def is_registered(self, name: str) -> bool:
        return name in self._entries

    def all_entries(self) -> list[PlatformEntry]:
        return list(self._entries.values())


platform_registry = PlatformRegistry()
