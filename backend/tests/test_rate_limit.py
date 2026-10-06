"""認証 API のレート制限と、制限の鍵（接続元 IP）の決め方。"""
from collections.abc import AsyncGenerator, Generator

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, Request
from starlette.datastructures import Headers

from app.config import AuthMode, settings
from app.rate_limit import client_ip, limiter


def _request(headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "headers": Headers(headers).raw,
        "client": ("172.18.0.3", 12345),
    }
    return Request(scope)


def test_client_ip_prefers_cloudflare_header() -> None:
    # 本番では backend から見た接続元は Caddy のコンテナ IP。実際の接続元は CF-Connecting-IP
    assert client_ip(_request({"cf-connecting-ip": "203.0.113.7"})) == "203.0.113.7"


def test_client_ip_falls_back_to_remote_address() -> None:
    assert client_ip(_request({})) == "172.18.0.3"


@pytest.fixture(scope="module", autouse=True)
def _set_multi_tenant() -> Generator[None, None, None]:
    original = settings.auth_mode
    settings.auth_mode = AuthMode.MULTI_TENANT
    yield
    settings.auth_mode = original


@pytest_asyncio.fixture
async def auth_client() -> AsyncGenerator[httpx.AsyncClient, None]:
    # main.py の app は AUTH_MODE=disabled でモジュールキャッシュ済みのため、
    # auth ルーター専用のスタンドアロン app を使う（test_auth.py と同じ方法）
    from app.api import auth as auth_module

    test_app = FastAPI()
    test_app.include_router(auth_module.router)
    transport = httpx.ASGITransport(app=test_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def _limited() -> AsyncGenerator[None, None]:
    limiter.enabled = True
    limiter.reset()
    yield
    limiter.enabled = False
    limiter.reset()


@pytest.mark.asyncio
async def test_login_is_rate_limited_per_client(
    auth_client: httpx.AsyncClient, _limited: None
) -> None:
    body = {"email": "nobody@example.com", "password": "wrong-password"}
    headers = {"cf-connecting-ip": "203.0.113.50"}

    for _ in range(20):
        r = await auth_client.post("/api/auth/login", json=body, headers=headers)
        assert r.status_code == 401

    r = await auth_client.post("/api/auth/login", json=body, headers=headers)
    assert r.status_code == 429

    # 別の利用者（別の接続元）は、影響を受けない
    other = await auth_client.post(
        "/api/auth/login", json=body, headers={"cf-connecting-ip": "203.0.113.51"}
    )
    assert other.status_code == 401
