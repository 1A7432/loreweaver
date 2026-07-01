"""Ensure the repo root is importable so `core`, `infra`, `agent`, `gateway`,
`adapters` resolve as top-level packages when running pytest from anywhere."""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
