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

Note `'code': None` — on the EMBEDDINGS endpoint. Chat completions is different, and
the difference cost a round of research to find: there the same condition arrives with
`'code': 'context_length_exceeded'` and `'param': 'messages'`. OpenAI's own error-codes
guide enumerates neither, so the evidence for the chat lane is captured error bodies
rather than a doc page — Azure's SDK issue tracker has one verbatim
(`Azure/azure-sdk-for-python#40986`: "(context_length_exceeded) This model's maximum
context length is 128000 tokens. However, you requested 1124171 tokens (124171 in the
messages, 1000000 in the completion)"), corroborated across Microsoft Q&A and the
OpenAI developer forum, and matching the code `infra/llm_chatgpt.py` has classified
this condition under since that path was built.

So this lane is matched TWO ways, and either is enough: the stable code, and the
message clause "maximum context length is N tokens" that every variant shares (the
embeddings body, Azure's "However, your messages resulted in Y tokens", and the chat
body all carry it, and all diverge after it — which is where the pattern stops).
<https://developers.openai.com/cookbook/examples/embedding_long_inputs>
<https://github.com/Azure/azure-sdk-for-python/issues/40986>

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
- **Truncation that is NOT a context overflow.** Two vendors end a response early in
  ways that look similar and are not:
  - OpenAI chat completions returns `finish_reason: "length"`, documented as "the
    maximum number of tokens specified in the request was reached". That is the
    REQUESTED cap, and the documentation does not say it covers the window.
  - Gemini returns `finishReason: MAX_TOKENS`, documented as "token generation reached
    the configured maximum output tokens" — again the configured cap.
  - The OpenAI Responses API returns `status: "incomplete"` with
    `incomplete_details.reason: "max_output_tokens"`, and its guide says this happens
    "when the generated tokens reach the context window limit OR the
    `max_output_tokens` value you've set" — the two causes share one reason code, so
    the code alone cannot tell them apart.
  None of the three is classified. `is_context_overflow_stop` covers only the case a
  vendor states unambiguously.
  <https://developers.openai.com/api/docs/guides/reasoning>

## The 400 gate

Both documented lanes are HTTP 400. Anything else — 429, 5xx, a timeout, a transport
error — is refused before the text is even looked at. A rate limit is `infra.llm_retry`'s
job, and a fold would not help it; a 500 says nothing about size at all.
"""

from __future__ import annotations

import re
from typing import Any

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

# A stable code field is a stronger signal than any sentence, so it is not gated on the
# status: the ChatGPT subscription path wraps its provider payload in an exception that
# carries no HTTP status at all, and that path is the one that has recognised this
# condition the longest (`infra/llm_chatgpt.py`'s content signals).
_OVERFLOW_CODES = frozenset({"context_length_exceeded"})

# The one stop reason a vendor states unambiguously means "generation ran into the
# context window" rather than "it reached the cap you asked for". Claude 4.5 and later
# return it INSTEAD of failing the call, so a turn that only watches for errors ships the
# player a narration that stops mid-sentence and records it as a successful turn.
# <https://platform.claude.com/docs/en/build-with-claude/context-windows>
CONTEXT_WINDOW_STOP_REASON = "model_context_window_exceeded"


def _carries_overflow_code(value: Any, depth: int = 0) -> bool:
    """True if a `code`/`type`/`reason` field anywhere in `value` names this condition.

    Recursive because the providers nest it differently: the OpenAI SDK hangs `code` off
    the exception and repeats it in `body["error"]["code"]`, while the ChatGPT path keeps
    the whole provider event in `payload`.
    """
    if depth > 6:
        return False
    if isinstance(value, str):
        return value.strip().casefold().replace("-", "_") in _OVERFLOW_CODES
    if isinstance(value, dict):
        return any(
            (key in {"code", "type", "reason"} and _carries_overflow_code(item, depth + 1))
            or (isinstance(item, (dict, list)) and _carries_overflow_code(item, depth + 1))
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_carries_overflow_code(item, depth + 1) for item in value)
    return False


def is_context_overflow(error: BaseException) -> bool:
    """True when the provider refused this call because the prompt exceeds its window.

    False for everything else, including everything undocumented. The caller's fallback
    is the behaviour that shipped before this module existed, so a miss costs nothing
    that was not already being paid.
    """
    if _carries_overflow_code(getattr(error, "code", None)):
        return True
    for attribute in ("body", "payload"):
        if _carries_overflow_code(getattr(error, attribute, None)):
            return True
    if status_of(error) not in OVERFLOW_STATUSES:
        return False
    text = str(error)
    return any(pattern.search(text) for pattern in _OVERFLOW_PATTERNS)


def is_context_overflow_stop(result: Any) -> bool:
    """True when a SUCCESSFUL response says generation ran into the context window.

    The failure this catches is quieter than an error: the call returns 200, the reply
    stops mid-sentence, and nothing downstream knows — the turn is persisted, the counter
    advances, and the next turn narrates onward from a severed line. Only the stop reason
    Anthropic documents for exactly this is matched; the vendors that fold "you hit the
    window" and "you hit the cap you set" into one code are not (module docstring).
    """
    raw = getattr(result, "raw", None)
    if raw is None:
        return False
    reason = raw.get("stop_reason") if isinstance(raw, dict) else getattr(raw, "stop_reason", None)
    return str(reason or "") == CONTEXT_WINDOW_STOP_REASON
