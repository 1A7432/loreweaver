"""OpenAI-compatible image generation providers.

The production path intentionally uses only the OpenAI-compatible
``/images/generations`` HTTP shape. Native SDKs and provider-specific branches
would make runtime switching harder to reason about and harder to test offline.
"""

from __future__ import annotations

import base64
import binascii
from typing import Protocol

import httpx

from infra.config import ImageGenSettings, Settings

OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1"
IMAGEGEN_OVERRIDE_FIELDS: tuple[str, ...] = ("provider", "base_url", "api_key", "model", "size")

_PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8ffff3f0005fe02fea7a0a5810000000049454e44ae426082"
)


class ImageGenError(RuntimeError):
    """Stable image-generation error code plus optional detail."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


class ImageGen(Protocol):
    async def generate(self, prompt: str, *, size: str = "1024x1024") -> tuple[bytes, str]:
        """Generate one image. Returns ``(bytes, mime)``."""


class OpenAICompatImageGen:
    """HTTP client for OpenAI-compatible image generation endpoints."""

    def __init__(
        self,
        settings: ImageGenSettings,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._settings = settings
        self._client = client
        self._timeout = timeout

    async def generate(self, prompt: str, *, size: str = "1024x1024") -> tuple[bytes, str]:
        prompt = str(prompt or "").strip()
        if not prompt:
            raise ImageGenError("imagegen_bad_prompt")
        if not self._settings.model or not self._settings.provider:
            raise ImageGenError("imagegen_not_configured")
        if not self._settings.api_key:
            raise ImageGenError("imagegen_missing_key")

        close_client = False
        client = self._client
        if client is None:
            client = httpx.AsyncClient(timeout=self._timeout)
            close_client = True
        try:
            response = await client.post(
                f"{_base_url(self._settings).rstrip('/')}/images/generations",
                headers={"Authorization": f"Bearer {self._settings.api_key}"},
                json={
                    "model": self._settings.model,
                    "prompt": prompt,
                    "size": size or self._settings.size or "1024x1024",
                    "response_format": "b64_json",
                },
            )
        except httpx.TimeoutException as exc:
            raise ImageGenError("imagegen_timeout") from exc
        except httpx.HTTPError as exc:
            raise ImageGenError("imagegen_http_error") from exc
        finally:
            if close_client:
                await client.aclose()

        if response.status_code < 200 or response.status_code >= 300:
            raise ImageGenError("imagegen_http_error", str(response.status_code))

        try:
            payload = response.json()
            b64 = payload["data"][0]["b64_json"]
            data = base64.b64decode(str(b64), validate=True)
        except (KeyError, IndexError, TypeError, ValueError, binascii.Error) as exc:
            raise ImageGenError("imagegen_bad_response") from exc
        if not data:
            raise ImageGenError("imagegen_bad_response")
        return data, "image/png"


class FakeImageGen:
    """Deterministic offline image generator for tests."""

    def __init__(self, data: bytes = _PNG_1X1, mime: str = "image/png") -> None:
        self.data = data
        self.mime = mime
        self.calls: list[dict[str, str]] = []

    async def generate(self, prompt: str, *, size: str = "1024x1024") -> tuple[bytes, str]:
        self.calls.append({"prompt": str(prompt), "size": str(size)})
        return self.data, self.mime


def build_imagegen(settings: Settings) -> ImageGen | None:
    """Build the configured image generator, or ``None`` when incomplete."""
    cfg = settings.imagegen
    if not cfg.provider or not cfg.model or not cfg.api_key:
        return None
    return OpenAICompatImageGen(cfg)


def apply_imagegen_overrides(base: Settings, overrides: dict) -> Settings:
    filtered = {
        key: value
        for key, value in (overrides or {}).items()
        if key in IMAGEGEN_OVERRIDE_FIELDS and value not in (None, "")
    }
    if not filtered:
        return base.model_copy(deep=True)
    return base.model_copy(update={"imagegen": base.imagegen.model_copy(update=filtered)})


def describe_imagegen_settings(settings: ImageGenSettings, *, configured: bool = False) -> dict[str, object]:
    return {
        "provider": settings.provider,
        "base_url": _base_url(settings) if settings.provider else settings.base_url,
        "model": settings.model,
        "size": settings.size,
        "api_key_masked": mask_secret_tail(settings.api_key),
        "has_key": bool(settings.api_key),
        "configured": configured,
    }


def mask_secret_tail(value: str) -> str:
    if not value:
        return ""
    tail = value[-4:]
    return f"{'*' * max(4, len(value) - 4)}{tail}"


def _base_url(settings: ImageGenSettings) -> str:
    if settings.base_url:
        return settings.base_url
    if (settings.provider or "").casefold() == "openai":
        return OPENAI_IMAGE_BASE_URL
    return settings.base_url
