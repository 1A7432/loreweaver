# Implemented: `--script` / `--exec` batches are exempt from the rate limiter

- **Problem:** the documented author smoke path (`--cli --script`) rate-limited
  like a networked player, so the tutorial's own end-to-end wiring script died
  mid-file with "Too many messages too quickly."
- **Verdict:** owner picked option 3 (2026-08-17) — exempt only the batch lanes
  (`--exec` / `--script`, and the programmatic `adapters.cli.selfplay.run_script`);
  interactive CLI stdin and every networked transport keep the real limiter.
- **Reason:** a file the operator handed the process is not a flood; the
  limiter's job is the network.
- **Rule home:** `gateway/ops.py` (`UnlimitedRateLimiter`), `app.py` `_run_cli`;
  `docs/authoring.md` §8 states the behavior.
- **Date:** 2026-08-17.
