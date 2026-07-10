"""Image generation over the shared OpenAI-compatible HTTP endpoint.

Providers use ``/images/generations`` without native SDKs. Small wire-level
differences, such as xAI's aspect-ratio/resolution fields, are translated here
so runtime switching remains deterministic and testable offline.
"""

from __future__ import annotations

import base64
import binascii
import math
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Protocol

import httpx

from infra.config import ImageGenSettings, Settings
from infra.oauth_flows import XAI_API_BASE, XAI_DEFAULT_IMAGE_MODEL

if TYPE_CHECKING:
    from infra.runtime_config import CredentialBook

OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1"
IMAGEGEN_OVERRIDE_FIELDS: tuple[str, ...] = ("provider", "base_url", "api_key", "model", "size")

# Provider presets: base_url + default model. ``supergrok`` reuses the SuperGrok
# subscription token from the LLM credential book (not a separate image key).
IMAGEGEN_PRESETS: dict[str, dict[str, str]] = {
    "openai": {"base_url": OPENAI_IMAGE_BASE_URL, "model": "gpt-image-1"},
    "supergrok": {"base_url": XAI_API_BASE, "model": XAI_DEFAULT_IMAGE_MODEL},
}

TokenProvider = Callable[[], Awaitable[str]]

_PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8ffff3f0005fe02fea7a0a5810000000049454e44ae426082"
)

_XAI_ASPECT_RATIOS: tuple[tuple[str, float], ...] = (
    ("1:1", 1.0),
    ("16:9", 16 / 9),
    ("9:16", 9 / 16),
    ("4:3", 4 / 3),
    ("3:4", 3 / 4),
    ("3:2", 3 / 2),
    ("2:3", 2 / 3),
    ("2:1", 2.0),
    ("1:2", 0.5),
    ("19.5:9", 19.5 / 9),
    ("9:19.5", 9 / 19.5),
    ("20:9", 20 / 9),
    ("9:20", 9 / 20),
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
        token_provider: TokenProvider | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._settings = settings
        self._client = client
        self._token_provider = token_provider
        self._timeout = timeout

    async def generate(self, prompt: str, *, size: str = "1024x1024") -> tuple[bytes, str]:
        prompt = str(prompt or "").strip()
        if not prompt:
            raise ImageGenError("imagegen_bad_prompt")
        if not self._settings.model or not self._settings.provider:
            raise ImageGenError("imagegen_not_configured")
        if self._token_provider is not None:
            api_key = await self._token_provider()
        else:
            api_key = self._settings.api_key
        if not api_key:
            raise ImageGenError("imagegen_missing_key")

        close_client = False
        client = self._client
        if client is None:
            client = httpx.AsyncClient(timeout=self._timeout)
            close_client = True
        requested_size = size or self._settings.size or "1024x1024"
        request_body = {
            "model": self._settings.model,
            "prompt": prompt,
            "response_format": "b64_json",
        }
        if (self._settings.provider or "").casefold() == "supergrok":
            # xAI's Imagine API uses aspect_ratio + 1k/2k resolution rather
            # than OpenAI's pixel-based `size` field.
            request_body.update(_xai_dimensions(requested_size))
        else:
            request_body["size"] = requested_size

        try:
            response = await client.post(
                f"{_base_url(self._settings).rstrip('/')}/images/generations",
                headers={"Authorization": f"Bearer {api_key}"},
                json=request_body,
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
            entry = payload["data"][0]
            b64 = entry["b64_json"]
            data = base64.b64decode(str(b64), validate=True)
        except (KeyError, IndexError, TypeError, ValueError, binascii.Error) as exc:
            raise ImageGenError("imagegen_bad_response") from exc
        if not data:
            raise ImageGenError("imagegen_bad_response")
        declared_mime = entry.get("mime_type") if isinstance(entry, dict) else None
        return data, _detect_image_mime(data, declared_mime)


class FakeImageGen:
    """Deterministic offline image generator for tests."""

    def __init__(self, data: bytes = _PNG_1X1, mime: str = "image/png") -> None:
        self.data = data
        self.mime = mime
        self.calls: list[dict[str, str]] = []

    async def generate(self, prompt: str, *, size: str = "1024x1024") -> tuple[bytes, str]:
        self.calls.append({"prompt": str(prompt), "size": str(size)})
        return self.data, self.mime


def build_imagegen(
    settings: Settings,
    *,
    llm_credentials: CredentialBook | None = None,
) -> ImageGen | None:
    """Build the configured image generator, or ``None`` when incomplete.

    For ``supergrok``, credentials come from the LLM SuperGrok subscription
    (same token as chat) — no separate imagegen key is required.
    """
    cfg = _apply_imagegen_preset(settings.imagegen)
    provider = (cfg.provider or "").casefold()

    if provider == "supergrok":
        return _build_supergrok_imagegen(cfg, llm_credentials=llm_credentials)

    if not cfg.provider or not cfg.model or not cfg.api_key:
        return None
    return OpenAICompatImageGen(cfg)


def _build_supergrok_imagegen(
    cfg: ImageGenSettings,
    *,
    llm_credentials: CredentialBook | None,
) -> ImageGen | None:
    if llm_credentials is None:
        return None
    manager = llm_credentials.subscription_manager_sync("supergrok")
    if manager is None:
        return None
    filled = cfg.model_copy(
        update={
            "provider": "supergrok",
            # Subscription tokens must never be sent to a remembered proxy.
            "base_url": XAI_API_BASE,
            "model": cfg.model or XAI_DEFAULT_IMAGE_MODEL,
            "api_key": "",  # token_provider supplies the bearer
        }
    )
    return OpenAICompatImageGen(filled, token_provider=manager.access_token)


def _apply_imagegen_preset(cfg: ImageGenSettings) -> ImageGenSettings:
    provider = (cfg.provider or "").casefold()
    preset = IMAGEGEN_PRESETS.get(provider)
    if not preset:
        return cfg
    updates: dict[str, str] = {}
    if not cfg.base_url:
        updates["base_url"] = preset["base_url"]
    if not cfg.model:
        updates["model"] = preset["model"]
    return cfg.model_copy(update=updates) if updates else cfg


def apply_imagegen_overrides(base: Settings, overrides: dict) -> Settings:
    filtered = {
        key: value
        for key, value in (overrides or {}).items()
        if key in IMAGEGEN_OVERRIDE_FIELDS and value is not None
    }
    if not filtered:
        return base.model_copy(deep=True)
    return base.model_copy(update={"imagegen": base.imagegen.model_copy(update=filtered)})


def describe_imagegen_settings(settings: ImageGenSettings, *, configured: bool = False) -> dict[str, object]:
    filled = _apply_imagegen_preset(settings)
    has_key = bool(filled.api_key) or (filled.provider or "").casefold() == "supergrok" and configured
    return {
        "provider": filled.provider,
        "base_url": _base_url(filled) if filled.provider else filled.base_url,
        "model": filled.model,
        "size": filled.size,
        "api_key_masked": mask_secret_tail(filled.api_key),
        "has_key": has_key,
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
    provider = (settings.provider or "").casefold()
    preset = IMAGEGEN_PRESETS.get(provider)
    if preset:
        return preset["base_url"]
    if provider == "openai":
        return OPENAI_IMAGE_BASE_URL
    return settings.base_url


def _detect_image_mime(data: bytes, declared: object = None) -> str:
    """Return the actual image MIME from magic bytes, then a safe declaration."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if isinstance(declared, str) and declared.casefold() in {
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
    }:
        return declared.casefold()
    # Preserve compatibility with providers that omit MIME metadata.
    return "image/png"


def _xai_dimensions(size: str) -> dict[str, str]:
    """Translate a pixel size to xAI Imagine's nearest supported dimensions."""
    try:
        width_raw, height_raw = str(size).casefold().split("x", 1)
        width, height = int(width_raw), int(height_raw)
        if width <= 0 or height <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return {"aspect_ratio": "1:1", "resolution": "1k"}

    ratio = width / height
    # Log distance treats portrait and landscape deviations symmetrically.
    aspect_ratio = min(
        _XAI_ASPECT_RATIOS,
        key=lambda item: abs(math.log(ratio / item[1])),
    )[0]
    return {
        "aspect_ratio": aspect_ratio,
        "resolution": "2k" if max(width, height) > 1024 else "1k",
    }
