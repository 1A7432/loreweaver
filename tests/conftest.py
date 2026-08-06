"""Suite-wide defaults.

The post-turn Scribe (`agent.scribe`) is ON in production but OFF for the test
suite: its fire-and-forget extra LLM call would make every FakeLLM call-count
assertion nondeterministic (and racy — the task lands whenever the loop yields).
`tests/agent/test_scribe.py` opts back in explicitly on its own services."""

import os

os.environ.setdefault("TRPG_SCRIBE__ENABLED", "0")
