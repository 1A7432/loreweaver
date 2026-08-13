"""The context-overflow classifier, built from what the vendors actually publish.

Every positive case below is constructed from an error body a vendor's OWN CURRENT
documentation prints — the page and the date are in `infra/llm_errors.py`'s docstring,
and the strings here are copied from those pages rather than recalled. The negative
cases are the ones that matter more: a classifier that says yes too easily spends a
fold generation and a retry on an error no fold can fix.

Exceptions are built by shape rather than by importing an SDK's class, exactly as
`infra.llm_retry` matches them at runtime — the classifier must work on the five
different exception types the five provider paths raise for the same HTTP status.
"""

from __future__ import annotations

from infra.llm_errors import is_context_overflow


class _ApiError(Exception):
    """An SDK-shaped error: a status attribute plus the string the SDK renders."""

    def __init__(self, status_code: int, text: str) -> None:
        super().__init__(text)
        self.status_code = status_code


# The body printed by the OpenAI Cookbook, "Embedding texts that are longer than the
# model's maximum context length" (read 2026-08-14), verbatim — including `'code': None`,
# which is why this lane is matched on its message and not on a code.
OPENAI_OVERFLOW_BODY = (
    "Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 "
    "tokens, however you requested 10001 tokens (10001 in your prompt; 0 for the completion). "
    "Please reduce your prompt; or completion length.\", 'type': 'invalid_request_error', "
    "'param': None, 'code': None}}"
)

# Anthropic's documented shape: a 400 `invalid_request_error` whose message is "prompt is
# too long" (Claude docs, "Context window overflow behavior", read 2026-08-14). The body is
# assembled in the error shape the same docs' "Error shapes" section publishes.
ANTHROPIC_OVERFLOW_BODY = (
    "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', "
    "'message': 'prompt is too long: 1049000 tokens > 1000000 maximum'}}"
)


def test_the_openai_documented_body_is_an_overflow():
    assert is_context_overflow(_ApiError(400, OPENAI_OVERFLOW_BODY))


def test_the_anthropic_documented_body_is_an_overflow():
    assert is_context_overflow(_ApiError(400, ANTHROPIC_OVERFLOW_BODY))


def test_the_azure_variant_of_the_openai_message_is_an_overflow():
    """Azure OpenAI phrases the second half differently, which is why the pattern
    stops at the clause both forms share."""
    body = (
        "Error code: 400 - {'error': {'message': \"This model's maximum context length is "
        "8192 tokens. However, your messages resulted in 8409 tokens. Please reduce the "
        "length of the messages.\", 'type': 'invalid_request_error', 'param': 'messages', "
        "'code': 'context_length_exceeded'}}"
    )
    assert is_context_overflow(_ApiError(400, body))


def test_a_content_refusal_is_not_an_overflow():
    """A non-overflow 400 must never trigger a fold — the strictness case in the spec."""
    body = (
        "Error code: 400 - {'error': {'message': 'Invalid prompt: your prompt was flagged "
        "as potentially violating our usage policy.', 'type': 'invalid_request_error', "
        "'param': None, 'code': 'invalid_prompt'}}"
    )
    assert not is_context_overflow(_ApiError(400, body))


def test_a_rate_limit_is_not_an_overflow():
    assert not is_context_overflow(_ApiError(429, "Error code: 429 - rate limit reached"))


def test_a_server_error_is_not_an_overflow():
    assert not is_context_overflow(_ApiError(503, "Error code: 503 - the engine is overloaded"))


def test_the_overflow_message_without_a_400_is_not_an_overflow():
    """The status gate is not decoration: the same sentence inside a 500 says nothing
    about this request's size."""
    assert not is_context_overflow(_ApiError(500, OPENAI_OVERFLOW_BODY))


def test_an_error_with_no_status_at_all_is_not_an_overflow():
    """A bare transport error carries no status; guessing from prose is how a fold gets
    spent on a dropped connection."""
    assert not is_context_overflow(RuntimeError(OPENAI_OVERFLOW_BODY))


def test_a_gemini_style_invalid_argument_is_not_an_overflow():
    """Gemini documents no context-overflow error, so nothing Gemini-shaped is claimed
    (`infra/llm_errors.py`, "Lanes deliberately not covered")."""
    body = (
        "400 INVALID_ARGUMENT. {'error': {'code': 400, 'message': 'Request contains an "
        "invalid argument.', 'status': 'INVALID_ARGUMENT'}}"
    )
    assert not is_context_overflow(_ApiError(400, body))


def test_a_response_shaped_status_is_read_too():
    """Some SDKs hang the status off `response`, not the exception (see
    `infra.llm_retry.status_of`)."""

    class _Response:
        status_code = 400

    class _Wrapped(Exception):
        response = _Response()

    assert is_context_overflow(_Wrapped(OPENAI_OVERFLOW_BODY))
