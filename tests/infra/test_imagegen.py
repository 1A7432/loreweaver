import base64

import httpx
import pytest

from infra.config import ImageGenSettings, Settings
from infra.imagegen import ImageGenError, OpenAICompatImageGen, build_imagegen


async def test_openai_compat_imagegen_posts_expected_shape_and_decodes_b64():
    image_bytes = b"png-bytes"
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["json"] = request.read()
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(image_bytes).decode("ascii")}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    gen = OpenAICompatImageGen(
        ImageGenSettings(provider="openai", base_url="https://example.test/v1", api_key="secret", model="img"),
        client=client,
    )
    try:
        data, mime = await gen.generate("a portrait", size="512x512")
    finally:
        await client.aclose()

    assert data == image_bytes
    assert mime == "image/png"
    assert seen["url"] == "https://example.test/v1/images/generations"
    assert seen["auth"] == "Bearer secret"
    assert b'"model":"img"' in seen["json"]
    assert b'"response_format":"b64_json"' in seen["json"]


async def test_openai_compat_imagegen_maps_bad_response_to_error_code():
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"data": [{}]})))
    gen = OpenAICompatImageGen(
        ImageGenSettings(provider="openai", base_url="https://example.test/v1", api_key="secret", model="img"),
        client=client,
    )
    try:
        with pytest.raises(ImageGenError) as exc:
            await gen.generate("bad")
    finally:
        await client.aclose()

    assert exc.value.code == "imagegen_bad_response"


async def test_openai_compat_imagegen_maps_http_failure_to_error_code():
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(500, text="nope")))
    gen = OpenAICompatImageGen(
        ImageGenSettings(provider="openai", base_url="https://example.test/v1", api_key="secret", model="img"),
        client=client,
    )
    try:
        with pytest.raises(ImageGenError) as exc:
            await gen.generate("bad")
    finally:
        await client.aclose()

    assert exc.value.code == "imagegen_http_error"


def test_build_imagegen_returns_none_when_incomplete():
    assert build_imagegen(Settings()) is None
    assert build_imagegen(Settings(imagegen=ImageGenSettings(provider="openai", model="img"))) is None
