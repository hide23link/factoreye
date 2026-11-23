"""ログイン状態の API のテスト（AUTH_MODE=multi_tenant）: 更新・ログアウト・自分の情報。

登録とログインはパスキーで行う。その試験は test_passkeys.py。
ここでは、DB に直接作った利用者のトークン（tests/helpers.py）で、その後の API を試す。
"""
from collections.abc import AsyncGenerator, Generator

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from helpers import create_user
from httpx import ASGITransport

from app.config import AuthMode, settings


# このモジュール全体で AUTH_MODE=multi_tenant に切り替え
# monkeypatch は function-scope のため module-scope フィクスチャでは使えない → 直接書き換えて戻す
@pytest.fixture(scope="module", autouse=True)
def _set_multi_tenant() -> Generator[None, None, None]:
    original = settings.auth_mode
    settings.auth_mode = AuthMode.MULTI_TENANT
    yield
    settings.auth_mode = original


@pytest_asyncio.fixture
async def auth_client() -> AsyncGenerator[httpx.AsyncClient, None]:
    # main.py の app は AUTH_MODE=disabled でモジュールキャッシュ済みのため、
    # auth ルーター専用のスタンドアロン app を使う
    from app.api import auth as auth_module

    test_app = FastAPI()
    test_app.include_router(auth_module.router)

    async with httpx.AsyncClient(
        transport=ASGITransport(app=test_app),
        base_url="http://test",
    ) as c:
        yield c


# ── refresh ────────────────────────────────────────────────────

async def test_refresh_success(auth_client: httpx.AsyncClient) -> None:
    refresh_token = (await create_user("refresh@example.com"))["refreshToken"]

    resp = await auth_client.post("/api/auth/refresh", json={"refreshToken": refresh_token})
    assert resp.status_code == 200
    new_body = resp.json()
    assert "accessToken" in new_body
    assert new_body["refreshToken"] != refresh_token  # ローテーションで別トークンが返る


async def test_refresh_reuse_revoked_fails(auth_client: httpx.AsyncClient) -> None:
    old_token = (await create_user("reuse@example.com"))["refreshToken"]

    # 1回目は成功
    await auth_client.post("/api/auth/refresh", json={"refreshToken": old_token})
    # 失効済みトークンで再リフレッシュ → 401
    resp = await auth_client.post("/api/auth/refresh", json={"refreshToken": old_token})
    assert resp.status_code == 401


async def test_refresh_invalid_token(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.post("/api/auth/refresh", json={"refreshToken": "not-a-real-token"})
    assert resp.status_code == 401


# ── logout ─────────────────────────────────────────────────────

async def test_logout_success(auth_client: httpx.AsyncClient) -> None:
    refresh_token = (await create_user("logout@example.com"))["refreshToken"]

    resp = await auth_client.post("/api/auth/logout", json={"refreshToken": refresh_token})
    assert resp.status_code == 204

    # ログアウト後はリフレッシュ不可
    resp2 = await auth_client.post("/api/auth/refresh", json={"refreshToken": refresh_token})
    assert resp2.status_code == 401


# ── /me ────────────────────────────────────────────────────────

async def test_me_success(auth_client: httpx.AsyncClient) -> None:
    access_token = (await create_user("me@example.com", "MyFactory"))["accessToken"]

    resp = await auth_client.get(
        "/api/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["email"] == "me@example.com"
    assert body["workspaceName"] == "MyFactory"
    assert body["plan"] == "free"


async def test_me_no_token(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.get("/api/me")
    assert resp.status_code in (401, 403)  # HTTPBearer は token なしで 401 or 403


async def test_me_invalid_token(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.get("/api/me", headers={"Authorization": "Bearer invalid.token.here"})
    assert resp.status_code == 401
