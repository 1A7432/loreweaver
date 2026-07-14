"""A temporary, upload-only filesystem view for one chat turn."""

from __future__ import annotations

import tempfile
from pathlib import Path

from gateway.chat import ChatAttachment


class AttachmentFs:
    def __init__(self, attachments: list[ChatAttachment]) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="loreweaver-chat-")
        self._root = Path(self._temp.name)
        self._paths: dict[str, Path] = {}
        self._names: list[str] = []
        for index, attachment in enumerate(attachments):
            if attachment.data is None:
                continue
            name = Path(attachment.name).name or f"attachment-{index}"
            path = self._root / f"{index}-{name}"
            path.write_bytes(attachment.data)
            self._paths.setdefault(name, path)
            self._names.append(name)
            if attachment.id:
                self._paths[attachment.id] = path

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._names)

    def get_file(self, path: str) -> str:
        candidate = self._paths.get(path) or self._paths.get(Path(path).name)
        return str(candidate or self._root / "missing")

    @property
    def shared_path(self) -> Path:
        raise NotImplementedError("chat attachments are upload-only")  # i18n-exempt: internal contract

    def forward_file(self, host_path: str | Path) -> str:
        del host_path
        raise NotImplementedError("chat attachments are upload-only")  # i18n-exempt: internal contract

    def close(self) -> None:
        self._temp.cleanup()
