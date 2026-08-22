# Implemented: deep shared-protocol frame validation

- **Problem:** `isServerFrame` treated load-bearing arrays as "is an array" and
  nested objects as "is an object". `ui_manifest.panels:[null]`,
  `audio_state.layers:[null]`, and `state.party:[null]` all returned true, so
  Studio then dereferenced `panel.id` / `wire.layer` / `member.name` and threw.
  The package README promised malformed frames drop and never crash a consumer.
  Separately, the runtime and docs already emitted `error.demo_unavailable` and
  `admin_error.last_keeper` while the TypeScript unions omitted both.
- **Verdict:** deepen the single validator table in `loreweaver-protocol` so
  every nested shape a client maps or indexes is an object with its current
  required fields; closed semantic fields (`action` / `layer` / `role` / `kind`
  / …) check the protocol enums; export `ERROR_CODES` / `ADMIN_ERROR_CODES`
  const arrays (unions derive from them) and pin them to the Python frozensets
  and locale keys with an architecture gate. Patch 2.3.2 — wire `major.minor`
  stays 2.3.
- **Reason:** a null in a typed array is not additive future-proofing; it is a
  crash. Unknown extra fields and unknown frame / block kinds stay ignored, so
  a newer minor can still talk to this client. `repeat` is the only recursive
  validator pair; the inner template is checked with `allowRepeat=false` so a
  nested or thousand-deep repeat tree is a flat reject (protocol: does not
  nest) and cannot stack-overflow the drop path.
- **Rule home:** `clients/protocol/src/client.ts` (validator table);
  `clients/protocol/src/types.ts` (`ERROR_CODES` / `ADMIN_ERROR_CODES`);
  `tests/architecture/test_protocol_error_codes.py`.
- **Date:** 2026-08-22.
