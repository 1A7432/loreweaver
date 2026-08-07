"""Suite-wide defaults.

The post-turn Scribe (`agent.scribe`) is ON in production but OFF for the test
suite: its fire-and-forget extra LLM call would make every FakeLLM call-count
assertion nondeterministic (and racy — the task lands whenever the loop yields).
`tests/agent/test_scribe.py` opts back in explicitly on its own services.

The chronicle fold (`agent.chronicle`, M18) follows the same posture: ON in
production, OFF here, because its fold-generation LLM call fires from inside
`run_kp_turn` whenever the room's usage meter crosses the trigger — fatal to
unrelated call-count assertions the moment a test seeds chronicle records.
`tests/agent/test_chronicle.py` / `tests/gateway/test_chronicle_commands.py`
opt back in explicitly on their own services.
"""

import os

os.environ.setdefault("TRPG_SCRIBE__ENABLED", "0")
os.environ.setdefault("TRPG_CHRONICLE__ENABLED", "0")
