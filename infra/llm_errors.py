"""Is this provider error a context overflow? (M23 WS2)

The usage meter has been wrong three times — a 16x-wrong window table, a streaming
lane that reported nothing, and estimated/measured readings compared as if they were
the same unit. Each time a long campaign hit a wall the meter could not see. The
provider's own refusal is the one meter that cannot lie, so it becomes the fold's
second trigger: `agent/loop.py` catches it, folds, and retries once.

That only works if "the provider refused because the prompt is too big" is recognised
correctly. A false positive spends a fold generation and a retry on an error a fold
cannot fix; a false negative is today's behaviour, which is merely no worse. **So this
module is deliberately strict: it matches shapes that a vendor's OWN CURRENT
DOCUMENTATION states, and nothing else.** Every entry below cites the page it came
from and the date it was read, and `tests/infra/test_llm_errors.py` builds its case
from the error body that page prints. When a lane is not covered here, that is a
recorded decision, not an oversight — see "Lanes deliberately not covered".

## What the vendors actually document (read 2026-08-14)

**OpenAI-compatible** — the OpenAI Cookbook's "Embedding texts that are longer than
the model's maximum context length" prints the whole raised error:

    Error code: 400 - {'error': {'message': "This model's maximum context length is
    8192 tokens, however you requested 10001 tokens (10001 in your prompt; 0 for the
    completion). Please reduce your prompt; or completion length.", 'type':
    'invalid_request_error', 'param': None, 'code': None}}

Note `'code': None`. There is no stable code to match on this lane — the widely
repeated `context_length_exceeded` is NOT what the platform returns here — so the
message is the only documented signal, and the durable part of it is the "maximum
context length is N tokens" clause. Azure OpenAI's variant ("This model's maximum
context length is X tokens. However, your messages resulted in Y tokens") differs
after that clause, which is why the pattern stops there.
<https://developers.openai.com/cookbook/examples/embedding_long_inputs>

**Anthropic** — the Claude docs' "Context window overflow behavior" states it
outright: "If the input alone already exceeds the model's context window, the API
returns a 400 `invalid_request_error` ("prompt is too long") on every model."
<https://platform.claude.com/docs/en/build-with-claude/context-windows>

## Lanes deliberately not covered

- **Gemini.** The Gemini API error reference documents 400 `invalid_request`,
  `failed_precondition`, `out_of_range`, `parameter_unknown` and the rest — and no
  context-overflow error at all. Guessing a message shape for it would be exactly the
  vendor constant that travels from memory into code and turns out wrong, so a Gemini
  overflow keeps today's behaviour: a localized provider error, no fold.
  <https://ai.google.dev/gemini-api/docs/api-errors>
- **DeepSeek** and the other OpenAI-compatible vendors. DeepSeek's error-code page
  lists seven codes, none of them about context length. They are not matched by
  vendor; they are matched if and only if they emit the OpenAI message above, which
  is the only thing anyone has documented about this case on that wire.
  <https://api-docs.deepseek.com/quick_start/error_codes>
- **Generation-time overflow.** On Claude 4.5 and later, an input that fits but whose
  generation runs into the window does NOT raise: the response comes back 200 with
  `stop_reason: "model_context_window_exceeded"`. That is a truncated reply, not a
  failed call, and it needs its own handling in the success path rather than a
  classifier entry here.

## The 400 gate

Both documented lanes are HTTP 400. Anything else — 429, 5xx, a timeout, a transport
error — is refused before the text is even looked at. A rate limit is `infra.llm_retry`'s
job, and a fold would not help it; a 500 says nothing about size at all.
"""

from __future__ import annotations

import re

from infra.llm_retry import status_of

# The status every documented context-overflow error arrives with. Kept as a set so the
# gate reads as a claim about the documented lanes rather than a magic number.
OVERFLOW_STATUSES: frozenset[int] = frozenset({400})

# OpenAI-compatible: the durable clause of the documented message (see module docstring).
# `\d+` rather than a captured number — this asks "did the model say the prompt was
# bigger than its context", not "how big".
_OPENAI_OVERFLOW = re.compile(r"(?i)maximum context length is\s+\d+\s+tokens")

# Anthropic: the documented message for an input that alone exceeds the window. The
# 400 gate is what keeps this from matching a stray mention of the phrase in some other
# vendor's prose.
_ANTHROPIC_OVERFLOW = re.compile(r"(?i)prompt is too long")

_OVERFLOW_PATTERNS = (_OPENAI_OVERFLOW, _ANTHROPIC_OVERFLOW)


def is_context_overflow(error: BaseException) -> bool:
    """True when the provider refused this call because the prompt exceeds its window.

    False for everything else, including everything undocumented. The caller's fallback
    is the behaviour that shipped before this module existed, so a miss costs nothing
    that was not already being paid.
    """
    if status_of(error) not in OVERFLOW_STATUSES:
        return False
    text = str(error)
    return any(pattern.search(text) for pattern in _OVERFLOW_PATTERNS)
