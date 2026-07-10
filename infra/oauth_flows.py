"""Subscription OAuth flows for ChatGPT and SuperGrok (device-code, pure httpx).

Mirrors public parameters from:
- ChatGPT / Codex CLI + LiteLLM ``chatgpt`` provider (auth.openai.com device auth)
- xAI SuperGrok / Hermes Agent (auth.x.ai device code)

Tokens must never appear in logs or user-facing strings — use :func:`mask_token`.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx

# -- ChatGPT / Codex (public client id shipped with Codex CLI / LiteLLM) --------
CHATGPT_AUTH_BASE = "https://auth.openai.com"
CHATGPT_DEVICE_CODE_URL = f"{CHATGPT_AUTH_BASE}/api/accounts/deviceauth/usercode"
CHATGPT_DEVICE_TOKEN_URL = f"{CHATGPT_AUTH_BASE}/api/accounts/deviceauth/token"
CHATGPT_OAUTH_TOKEN_URL = f"{CHATGPT_AUTH_BASE}/oauth/token"
CHATGPT_DEVICE_VERIFY_URL = f"{CHATGPT_AUTH_BASE}/codex/device"
CHATGPT_API_BASE = "https://chatgpt.com/backend-api/codex"
CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CHATGPT_RESPONSES_URL = f"{CHATGPT_API_BASE}/responses"

# -- SuperGrok / xAI (public client id used by Hermes Agent / Grok CLI) --------
XAI_OAUTH_ISSUER = "https://auth.x.ai"
XAI_OAUTH_DISCOVERY_URL = f"{XAI_OAUTH_ISSUER}/.well-known/openid-configuration"
XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
# Space-joined OAuth scope tokens (not user-facing UI text).
XAI_OAUTH_SCOPE = " ".join(
    ("openid", "profile", "email", "offline_access", "grok-cli:access", "api:access")
)
XAI_OAUTH_DEVICE_CODE_URL = f"{XAI_OAUTH_ISSUER}/oauth2/device/code"
XAI_OAUTH_TOKEN_URL = f"{XAI_OAUTH_ISSUER}/oauth2/token"
XAI_API_BASE = "https://api.x.ai/v1"
XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image"

TOKEN_EXPIRY_SKEW_SECONDS = 60
DEFAULT_POLL_INTERVAL = 5.0
LOGIN_TIMEOUT_SECONDS = 10 * 60

# Provider names that use subscription OAuth (no static API key).
SUBSCRIPTION_PROVIDER_NAMES: tuple[str, ...] = ("chatgpt", "gpt-subscription", "supergrok")
SUBSCRIPTION_PROVIDERS: frozenset[str] = frozenset(SUBSCRIPTION_PROVIDER_NAMES)
# Canonical name per alias group (credentials stored under the canonical key).
SUBSCRIPTION_CANONICAL: dict[str, str] = {
    "chatgpt": "chatgpt",
    "gpt-subscription": "chatgpt",
    "supergrok": "supergrok",
}
SUBSCRIPTION_DEFAULT_MODELS: dict[str, str] = {
    "chatgpt": "gpt-5.4",
    "gpt-subscription": "gpt-5.4",
    "supergrok": "grok-4.3",
}


class OAuthError(RuntimeError):
    """OAuth failure with a stable i18n-friendly code (never embeds raw tokens)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass
class SubscriptionToken:
    access_token: str
    refresh_token: str
    expires_at: float  # epoch seconds
    account_id: str = ""  # ChatGPT needs this; SuperGrok leaves empty

    def is_expired(self, *, skew: float = TOKEN_EXPIRY_SKEW_SECONDS) -> bool:
        return time.time() >= float(self.expires_at) - skew


@dataclass
class DeviceLogin:
    """State for an in-progress device-code login (safe to show to users)."""

    verification_url: str
    user_code: str
    poll_interval: float = DEFAULT_POLL_INTERVAL
    expires_at: float = 0.0  # epoch when the device code itself expires
    # Opaque provider state — never display.
    state: dict[str, Any] = field(default_factory=dict, repr=False)


class OAuthFlow(Protocol):
    async def start(self) -> DeviceLogin: ...
    async def poll(self, login: DeviceLogin) -> SubscriptionToken | None: ...
    async def refresh(self, token: SubscriptionToken) -> SubscriptionToken: ...


def mask_token(value: str) -> str:
    """Mask a bearer/JWT for display: never echo the full secret."""
    if not value:
        return ""
    if value.startswith("eyJ") and len(value) > 12:
        return f"eyJ…{value[-4:]}"
    if value.startswith("sk-") and len(value) > 8:
        return f"sk-…{value[-4:]}"
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}…{value[-4:]}"


def canonical_subscription_provider(name: str) -> str:
    return SUBSCRIPTION_CANONICAL.get((name or "").casefold(), (name or "").casefold())


def is_subscription_provider(name: str) -> bool:
    return (name or "").casefold() in SUBSCRIPTION_PROVIDERS


def flow_for(provider: str) -> OAuthFlow:
    """Return the OAuth flow implementation for a subscription provider name."""
    key = canonical_subscription_provider(provider)
    if key == "chatgpt":
        return ChatGPTOAuth()
    if key == "supergrok":
        return GrokOAuth()
    raise OAuthError("subscription_unknown_provider", key)


def decode_jwt_claims(token: str) -> dict[str, Any]:
    """Decode JWT payload without verifying the signature (claims extraction only)."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return {}


def extract_chatgpt_account_id(*tokens: str) -> str:
    """Pull ``chatgpt_account_id`` from id/access JWT claims (LiteLLM/Codex fallbacks)."""
    for token in tokens:
        if not token:
            continue
        claims = decode_jwt_claims(token)
        if isinstance(claims.get("chatgpt_account_id"), str) and claims["chatgpt_account_id"]:
            return str(claims["chatgpt_account_id"])
        auth = claims.get("https://api.openai.com/auth")
        if isinstance(auth, dict):
            account_id = auth.get("chatgpt_account_id")
            if isinstance(account_id, str) and account_id:
                return account_id
        orgs = claims.get("organizations")
        if isinstance(orgs, list) and orgs:
            first = orgs[0]
            if isinstance(first, dict) and first.get("id"):
                return str(first["id"])
    return ""


def expires_at_from_token(access_token: str, *, expires_in: Any = None, default_ttl: float = 3600.0) -> float:
    """Prefer JWT ``exp``; fall back to ``expires_in`` seconds from now."""
    claims = decode_jwt_claims(access_token)
    exp = claims.get("exp")
    if isinstance(exp, (int, float)) and exp > 0:
        return float(exp)
    if expires_in is not None:
        try:
            return time.time() + float(expires_in)
        except (TypeError, ValueError):
            pass
    return time.time() + default_ttl


class TokenManager:
    """In-memory subscription token with proactive refresh + optional persist hook."""

    def __init__(
        self,
        token: SubscriptionToken,
        flow: OAuthFlow,
        *,
        on_update: Callable[[SubscriptionToken], Awaitable[None]] | None = None,
    ) -> None:
        self._token = token
        self._flow = flow
        self._on_update = on_update
        self._lock = asyncio.Lock()
        self._active = True

    @property
    def token(self) -> SubscriptionToken:
        return self._token

    @property
    def active(self) -> bool:
        """Whether this manager may still issue or refresh bearer tokens."""
        return self._active

    def invalidate(self) -> None:
        """Permanently revoke this manager, including refreshes already in flight."""
        self._active = False

    def _ensure_active(self) -> None:
        if not self._active:
            raise OAuthError("subscription_login_required")

    async def access_token(self) -> str:
        async with self._lock:
            self._ensure_active()
            if self._token.is_expired():
                await self._refresh_locked()
            self._ensure_active()
            return self._token.access_token

    async def force_refresh(self) -> str:
        async with self._lock:
            self._ensure_active()
            await self._refresh_locked()
            self._ensure_active()
            return self._token.access_token

    async def _refresh_locked(self) -> None:
        self._ensure_active()
        try:
            updated = await self._flow.refresh(self._token)
        except OAuthError:
            raise
        except Exception as exc:
            raise OAuthError("subscription_refresh_failed") from exc
        # ``CredentialBook.forget`` may run while the network refresh is in
        # flight. Never resurrect or persist the newly returned token then.
        self._ensure_active()
        self._token = updated
        if self._on_update is not None:
            await self._on_update(self._token)
        self._ensure_active()


# ---------------------------------------------------------------------------
# ChatGPT device-code OAuth (LiteLLM / Codex CLI)
# ---------------------------------------------------------------------------


class ChatGPTOAuth:
    """Device-code login against auth.openai.com (ChatGPT subscription)."""

    def __init__(self, *, client: httpx.AsyncClient | None = None, timeout: float = 30.0) -> None:
        self._client = client
        self._timeout = timeout
        self._owns_client = client is None

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
            self._owns_client = True
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def start(self) -> DeviceLogin:
        client = await self._http()
        try:
            resp = await client.post(CHATGPT_DEVICE_CODE_URL, json={"client_id": CHATGPT_CLIENT_ID})
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            raise OAuthError("subscription_device_code_failed") from exc

        device_auth_id = data.get("device_auth_id")
        user_code = data.get("user_code") or data.get("usercode")
        if not device_auth_id or not user_code:
            raise OAuthError("subscription_device_code_failed")
        interval = float(data.get("interval") or DEFAULT_POLL_INTERVAL)
        expires_in = float(data.get("expires_in") or LOGIN_TIMEOUT_SECONDS)
        return DeviceLogin(
            verification_url=CHATGPT_DEVICE_VERIFY_URL,
            user_code=str(user_code),
            poll_interval=max(3.0, interval),
            expires_at=time.time() + expires_in,
            state={"device_auth_id": str(device_auth_id), "user_code": str(user_code)},
        )

    async def poll(self, login: DeviceLogin) -> SubscriptionToken | None:
        if login.expires_at and time.time() > login.expires_at:
            raise OAuthError("subscription_login_timeout")
        client = await self._http()
        device_auth_id = login.state.get("device_auth_id")
        user_code = login.state.get("user_code") or login.user_code
        try:
            resp = await client.post(
                CHATGPT_DEVICE_TOKEN_URL,
                json={"device_auth_id": device_auth_id, "user_code": user_code},
            )
        except httpx.HTTPError as exc:
            raise OAuthError("subscription_poll_failed") from exc

        if resp.status_code in (403, 404):
            return None  # still pending
        if resp.status_code != 200:
            raise OAuthError("subscription_poll_failed")

        data = resp.json()
        auth_code = data.get("authorization_code")
        code_verifier = data.get("code_verifier")
        if not auth_code or not code_verifier:
            return None

        return await self._exchange_code(str(auth_code), str(code_verifier))

    async def _exchange_code(self, authorization_code: str, code_verifier: str) -> SubscriptionToken:
        client = await self._http()
        redirect_uri = f"{CHATGPT_AUTH_BASE}/deviceauth/callback"
        try:
            resp = await client.post(
                CHATGPT_OAUTH_TOKEN_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "grant_type": "authorization_code",
                    "code": authorization_code,
                    "redirect_uri": redirect_uri,
                    "client_id": CHATGPT_CLIENT_ID,
                    "code_verifier": code_verifier,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            raise OAuthError("subscription_token_exchange_failed") from exc

        access = str(data.get("access_token") or "")
        refresh = str(data.get("refresh_token") or "")
        id_token = str(data.get("id_token") or "")
        if not access or not refresh:
            raise OAuthError("subscription_token_exchange_failed")
        return SubscriptionToken(
            access_token=access,
            refresh_token=refresh,
            expires_at=expires_at_from_token(access, expires_in=data.get("expires_in")),
            account_id=extract_chatgpt_account_id(id_token, access),
        )

    async def refresh(self, token: SubscriptionToken) -> SubscriptionToken:
        client = await self._http()
        try:
            resp = await client.post(
                CHATGPT_OAUTH_TOKEN_URL,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                data={
                    "client_id": CHATGPT_CLIENT_ID,
                    "grant_type": "refresh_token",
                    "refresh_token": token.refresh_token,
                    "scope": "openid profile email",
                },
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            raise OAuthError("subscription_refresh_failed") from exc

        access = str(data.get("access_token") or "")
        if not access:
            raise OAuthError("subscription_refresh_failed")
        refresh = str(data.get("refresh_token") or token.refresh_token)
        id_token = str(data.get("id_token") or "")
        account_id = extract_chatgpt_account_id(id_token, access) or token.account_id
        return SubscriptionToken(
            access_token=access,
            refresh_token=refresh,
            expires_at=expires_at_from_token(access, expires_in=data.get("expires_in")),
            account_id=account_id,
        )


# ---------------------------------------------------------------------------
# SuperGrok / xAI device-code OAuth (Hermes Agent)
# ---------------------------------------------------------------------------


class GrokOAuth:
    """Device-code login against auth.x.ai (SuperGrok / X Premium+)."""

    def __init__(self, *, client: httpx.AsyncClient | None = None, timeout: float = 30.0) -> None:
        self._client = client
        self._timeout = timeout
        self._owns_client = client is None
        self._token_endpoint = XAI_OAUTH_TOKEN_URL

    async def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
            self._owns_client = True
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _discover_token_endpoint(self) -> str:
        client = await self._http()
        try:
            resp = await client.get(XAI_OAUTH_DISCOVERY_URL, headers={"Accept": "application/json"})
            if resp.status_code == 200:
                data = resp.json()
                endpoint = str(data.get("token_endpoint") or "").strip()
                hostname = (urlparse(endpoint).hostname or "").casefold()
                if endpoint.startswith("https://") and (
                    hostname == "x.ai" or hostname.endswith(".x.ai")
                ):
                    self._token_endpoint = endpoint
        except httpx.HTTPError:
            pass
        return self._token_endpoint

    async def start(self) -> DeviceLogin:
        client = await self._http()
        await self._discover_token_endpoint()
        try:
            resp = await client.post(
                XAI_OAUTH_DEVICE_CODE_URL,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                data={"client_id": XAI_OAUTH_CLIENT_ID, "scope": XAI_OAUTH_SCOPE},
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            raise OAuthError("subscription_device_code_failed") from exc

        device_code = data.get("device_code")
        user_code = data.get("user_code")
        verification = data.get("verification_uri_complete") or data.get("verification_uri")
        if not device_code or not user_code or not verification:
            raise OAuthError("subscription_device_code_failed")
        interval = float(data.get("interval") or DEFAULT_POLL_INTERVAL)
        expires_in = float(data.get("expires_in") or LOGIN_TIMEOUT_SECONDS)
        return DeviceLogin(
            verification_url=str(verification),
            user_code=str(user_code),
            poll_interval=max(1.0, interval),
            expires_at=time.time() + expires_in,
            state={
                "device_code": str(device_code),
                "token_endpoint": self._token_endpoint,
            },
        )

    async def poll(self, login: DeviceLogin) -> SubscriptionToken | None:
        if login.expires_at and time.time() > login.expires_at:
            raise OAuthError("subscription_login_timeout")
        client = await self._http()
        token_endpoint = str(login.state.get("token_endpoint") or self._token_endpoint)
        device_code = login.state.get("device_code")
        try:
            resp = await client.post(
                token_endpoint,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "client_id": XAI_OAUTH_CLIENT_ID,
                    "device_code": device_code,
                },
            )
        except httpx.HTTPError as exc:
            raise OAuthError("subscription_poll_failed") from exc

        if resp.status_code == 200:
            data = resp.json()
            access = str(data.get("access_token") or "")
            refresh = str(data.get("refresh_token") or "")
            if not access or not refresh:
                raise OAuthError("subscription_token_exchange_failed")
            return SubscriptionToken(
                access_token=access,
                refresh_token=refresh,
                expires_at=expires_at_from_token(access, expires_in=data.get("expires_in")),
                account_id="",
            )

        try:
            err = resp.json()
        except Exception:
            raise OAuthError("subscription_poll_failed") from None
        error_code = str(err.get("error") or "")
        if error_code == "slow_down":
            # RFC 8628 §3.5: increase the interval by five seconds for this and
            # every subsequent request after the authorization server asks us
            # to slow down.
            login.poll_interval = max(1.0, float(login.poll_interval or 0.0)) + 5.0
            return None
        if error_code == "authorization_pending":
            return None
        raise OAuthError("subscription_poll_failed")

    async def refresh(self, token: SubscriptionToken) -> SubscriptionToken:
        client = await self._http()
        endpoint = await self._discover_token_endpoint()
        try:
            resp = await client.post(
                endpoint,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                data={
                    "grant_type": "refresh_token",
                    "client_id": XAI_OAUTH_CLIENT_ID,
                    "refresh_token": token.refresh_token,
                },
            )
            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPError as exc:
            raise OAuthError("subscription_refresh_failed") from exc

        access = str(data.get("access_token") or "")
        if not access:
            raise OAuthError("subscription_refresh_failed")
        refresh = str(data.get("refresh_token") or token.refresh_token)
        return SubscriptionToken(
            access_token=access,
            refresh_token=refresh,
            expires_at=expires_at_from_token(access, expires_in=data.get("expires_in")),
            account_id="",
        )
