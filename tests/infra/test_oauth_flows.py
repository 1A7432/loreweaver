"""Offline tests for subscription OAuth flows (mock httpx, never hit the network)."""

from __future__ import annotations

import base64
import json
import time
from urllib.parse import parse_qs

import httpx
import pytest

from infra.oauth_flows import (
    CHATGPT_CLIENT_ID,
    XAI_OAUTH_CLIENT_ID,
    ChatGPTOAuth,
    DeviceLogin,
    GrokOAuth,
    OAuthError,
    SubscriptionToken,
    TokenManager,
    extract_chatgpt_account_id,
    mask_token,
)


def _jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"{header}.{body}.sig"


def test_mask_token_never_echoes_full_secret():
    jwt = _jwt({"sub": "x"}) + "extra"
    assert jwt not in mask_token(jwt)
    assert "eyJ" in mask_token(jwt) or "…" in mask_token(jwt)
    assert mask_token("sk-abcdefghijklmnop").startswith("sk-")
    assert "abcdefghijklmnop" not in mask_token("sk-abcdefghijklmnop")


def test_extract_chatgpt_account_id_from_nested_claim():
    token = _jwt({"https://api.openai.com/auth": {"chatgpt_account_id": "acc-123"}})
    assert extract_chatgpt_account_id(token) == "acc-123"


async def test_chatgpt_start_poll_success():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        path = request.url.path
        if path.endswith("/usercode"):
            body = json.loads(request.content)
            assert body["client_id"] == CHATGPT_CLIENT_ID
            return httpx.Response(
                200,
                json={"device_auth_id": "dev-1", "user_code": "ABCD-EFGH", "interval": 1},
            )
        if path.endswith("/token") and "deviceauth" in path:
            return httpx.Response(
                200,
                json={
                    "authorization_code": "auth+code&scope=wrong",
                    "code_challenge": "ch",
                    "code_verifier": "verifier=/+",
                },
            )
        if path.endswith("/oauth/token"):
            assert request.headers["content-type"].startswith("application/x-www-form-urlencoded")
            form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
            assert form["grant_type"] == "authorization_code"
            assert form["code"] == "auth+code&scope=wrong"
            assert form["code_verifier"] == "verifier=/+"
            assert form["client_id"] == CHATGPT_CLIENT_ID
            access = _jwt({"exp": time.time() + 3600, "https://api.openai.com/auth": {"chatgpt_account_id": "acc-9"}})
            return httpx.Response(
                200,
                json={
                    "access_token": access,
                    "refresh_token": "rt-1",
                    "id_token": access,
                },
            )
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    flow = ChatGPTOAuth(client=client)
    try:
        login = await flow.start()
        assert login.user_code == "ABCD-EFGH"
        assert "codex/device" in login.verification_url
        # User-facing fields must not contain tokens
        blob = f"{login.verification_url} {login.user_code}"
        assert "rt-1" not in blob
        assert "auth+code" not in blob

        pending = await flow.poll(login)  # first poll succeeds in this mock
        assert pending is not None
        assert pending.account_id == "acc-9"
        assert pending.refresh_token == "rt-1"
        assert pending.access_token not in blob
    finally:
        await client.aclose()


async def test_chatgpt_poll_pending_then_none():
    def handler(request: httpx.Request) -> httpx.Response:
        if "deviceauth/token" in str(request.url):
            return httpx.Response(403, json={"error": "pending"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    flow = ChatGPTOAuth(client=client)
    try:
        login = DeviceLogin(
            verification_url="https://auth.openai.com/codex/device",
            user_code="X",
            expires_at=time.time() + 60,
            state={"device_auth_id": "d", "user_code": "X"},
        )
        assert await flow.poll(login) is None
    finally:
        await client.aclose()


async def test_chatgpt_refresh_and_failure():
    from urllib.parse import parse_qs

    state = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["n"] += 1
        form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        assert request.headers["content-type"].startswith("application/x-www-form-urlencoded")
        assert form["grant_type"] == "refresh_token"
        assert form["refresh_token"] == "rt-old+ /"
        assert form["client_id"] == CHATGPT_CLIENT_ID
        if state["n"] == 1:
            access = _jwt({"exp": time.time() + 3600})
            return httpx.Response(
                200,
                json={"access_token": access, "refresh_token": "rt-2", "id_token": access},
            )
        return httpx.Response(401, json={"error": "invalid_grant"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    flow = ChatGPTOAuth(client=client)
    try:
        token = SubscriptionToken(
            access_token="old",
            refresh_token="rt-old+ /",
            expires_at=time.time() - 10,
            account_id="acc",
        )
        refreshed = await flow.refresh(token)
        assert refreshed.refresh_token == "rt-2"
        assert refreshed.access_token != "old"

        with pytest.raises(OAuthError) as exc:
            await flow.refresh(token)
        assert exc.value.code == "subscription_refresh_failed"
        # Error string must not include raw tokens
        assert "rt-old+ /" not in str(exc.value)
        assert "rt-2" not in str(exc.value)
    finally:
        await client.aclose()


async def test_grok_start_poll_refresh():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("openid-configuration"):
            return httpx.Response(
                200,
                json={
                    "token_endpoint": "https://auth.x.ai/oauth2/token",
                    "authorization_endpoint": "https://auth.x.ai/oauth2/auth",
                },
            )
        if path.endswith("/device/code"):
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            assert form.get("client_id") == XAI_OAUTH_CLIENT_ID
            return httpx.Response(
                200,
                json={
                    "device_code": "dc-1",
                    "user_code": "WXYZ",
                    "verification_uri": "https://accounts.x.ai/device",
                    "verification_uri_complete": "https://accounts.x.ai/device?code=WXYZ",
                    "expires_in": 600,
                    "interval": 2,
                },
            )
        if path.endswith("/oauth2/token"):
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if form.get("grant_type") == "urn:ietf:params:oauth:grant-type:device_code":
                access = _jwt({"exp": time.time() + 3600})
                return httpx.Response(
                    200,
                    json={"access_token": access, "refresh_token": "grt-1", "expires_in": 3600},
                )
            if form.get("grant_type") == "refresh_token":
                access = _jwt({"exp": time.time() + 7200})
                return httpx.Response(
                    200,
                    json={"access_token": access, "refresh_token": "grt-2", "expires_in": 7200},
                )
            return httpx.Response(400, json={"error": "authorization_pending"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    flow = GrokOAuth(client=client)
    try:
        login = await flow.start()
        assert login.user_code == "WXYZ"
        assert "accounts.x.ai" in login.verification_url or "auth.x.ai" in login.verification_url

        token = await flow.poll(login)
        assert token is not None
        assert token.refresh_token == "grt-1"
        assert token.account_id == ""

        refreshed = await flow.refresh(token)
        assert refreshed.refresh_token == "grt-2"
    finally:
        await client.aclose()


async def test_grok_discovery_rejects_lookalike_token_endpoint():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.path.endswith("openid-configuration"):
            return httpx.Response(
                200,
                json={"token_endpoint": "https://x.ai.attacker.example/oauth2/token"},
            )
        if request.url.path.endswith("/device/code"):
            return httpx.Response(
                200,
                json={
                    "device_code": "dc",
                    "user_code": "CODE",
                    "verification_uri": "https://auth.x.ai/device",
                },
            )
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    flow = GrokOAuth(client=client)
    try:
        login = await flow.start()
    finally:
        await client.aclose()

    assert login.state["token_endpoint"] == "https://auth.x.ai/oauth2/token"
    assert all("attacker.example" not in url for url in seen)


async def test_grok_slow_down_increases_all_subsequent_poll_intervals():
    errors = iter(("slow_down", "authorization_pending", "slow_down"))

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": next(errors)})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    flow = GrokOAuth(client=client)
    login = DeviceLogin(
        verification_url="https://auth.x.ai/device",
        user_code="CODE",
        poll_interval=2.0,
        expires_at=time.time() + 60,
        state={"device_code": "device", "token_endpoint": "https://auth.x.ai/oauth2/token"},
    )
    try:
        assert await flow.poll(login) is None
        assert login.poll_interval == 7.0
        assert await flow.poll(login) is None
        assert login.poll_interval == 7.0
        assert await flow.poll(login) is None
        assert login.poll_interval == 12.0
    finally:
        await client.aclose()


async def test_token_manager_refreshes_when_expired():
    class _Flow:
        def __init__(self) -> None:
            self.refreshed = 0

        async def start(self):
            raise NotImplementedError

        async def poll(self, login):
            raise NotImplementedError

        async def refresh(self, token: SubscriptionToken) -> SubscriptionToken:
            self.refreshed += 1
            return SubscriptionToken(
                access_token="new-access",
                refresh_token=token.refresh_token,
                expires_at=time.time() + 3600,
                account_id=token.account_id,
            )

    flow = _Flow()
    updates: list[str] = []

    async def on_update(token: SubscriptionToken) -> None:
        updates.append(token.access_token)

    mgr = TokenManager(
        SubscriptionToken(access_token="old", refresh_token="rt", expires_at=time.time() - 1),
        flow,  # type: ignore[arg-type]
        on_update=on_update,
    )
    assert await mgr.access_token() == "new-access"
    assert flow.refreshed == 1
    assert updates == ["new-access"]
