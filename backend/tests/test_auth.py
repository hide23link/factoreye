"""認証API テスト（AUTH_MODE=multi_tenant）。"""
from collections.abc import Generator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport

from app.config import AuthMode, settings


# このモジュール全体で AUTH_MODE=multi_tenant に切り替え、auth ルーターが登録されたアプリを使う
# monkeypatch は function-scope のため module-scope フィクスチャでは使えない → 直接書き換えて戻す
@pytest.fixture(scope="module", autouse=True)
def _set_multi_tenant() -> Generator[None, None, None]:
    original = settings.auth_mode
    settings.auth_mode = AuthMode.MULTI_TENANT
    yield
    settings.auth_mode = original


@pytest_asyncio.fixture
async def auth_client() -> httpx.AsyncClient:
    # auth ルーターは AUTH_MODE=multi_tenant 時のみ main.py でマウントされるため、
    # 設定変更後に app を再インポートして動的にルーターを追加したアプリを使う
    from app.api import auth as auth_router
    from app.main import app

    # 未追加なら追加（モジュールスコープで1回だけ）
    routes = [r.path for r in app.routes]  # type: ignore[attr-defined]
    if "/api/auth/register" not in routes:
        app.include_router(auth_router.router)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── register ──────────────────────────────────────────────────

async def test_register_success(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.post("/api/auth/register", json={
        "email": "tanaka@example.com",
        "password": "password123",
        "workspaceName": "田中工場",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert "accessToken" in body
    assert "refreshToken" in body
    assert body["tokenType"] == "bearer"


async def test_register_duplicate_email(auth_client: httpx.AsyncClient) -> None:
    payload = {"email": "dup@example.com", "password": "password123", "workspaceName": "W"}
    await auth_client.post("/api/auth/register", json=payload)
    resp = await auth_client.post("/api/auth/register", json=payload)
    assert resp.status_code == 409


async def test_register_password_too_short(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.post("/api/auth/register", json={
        "email": "short@example.com",
        "password": "abc",
        "workspaceName": "W",
    })
    assert resp.status_code == 422


# ── login ──────────────────────────────────────────────────────

async def test_login_success(auth_client: httpx.AsyncClient) -> None:
    await auth_client.post("/api/auth/register", json={
        "email": "login@example.com",
        "password": "password123",
        "workspaceName": "LoginWS",
    })
    resp = await auth_client.post("/api/auth/login", json={
        "email": "login@example.com",
        "password": "password123",
    })
    assert resp.status_code == 200
    assert "accessToken" in resp.json()


async def test_login_wrong_password(auth_client: httpx.AsyncClient) -> None:
    await auth_client.post("/api/auth/register", json={
        "email": "badpw@example.com",
        "password": "password123",
        "workspaceName": "W",
    })
    resp = await auth_client.post("/api/auth/login", json={
        "email": "badpw@example.com",
        "password": "wrongpass",
    })
    assert resp.status_code == 401


async def test_login_unknown_email(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.post("/api/auth/login", json={
        "email": "ghost@example.com",
        "password": "password123",
    })
    assert resp.status_code == 401


# ── refresh ────────────────────────────────────────────────────

async def test_refresh_success(auth_client: httpx.AsyncClient) -> None:
    reg = await auth_client.post("/api/auth/register", json={
        "email": "refresh@example.com",
        "password": "password123",
        "workspaceName": "W",
    })
    refresh_token = reg.json()["refreshToken"]

    resp = await auth_client.post("/api/auth/refresh", json={"refreshToken": refresh_token})
    assert resp.status_code == 200
    new_body = resp.json()
    assert "accessToken" in new_body
    assert new_body["refreshToken"] != refresh_token  # ローテーションで別トークンが返る


async def test_refresh_reuse_revoked_fails(auth_client: httpx.AsyncClient) -> None:
    reg = await auth_client.post("/api/auth/register", json={
        "email": "reuse@example.com",
        "password": "password123",
        "workspaceName": "W",
    })
    old_token = reg.json()["refreshToken"]

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
    reg = await auth_client.post("/api/auth/register", json={
        "email": "logout@example.com",
        "password": "password123",
        "workspaceName": "W",
    })
    refresh_token = reg.json()["refreshToken"]

    resp = await auth_client.post("/api/auth/logout", json={"refreshToken": refresh_token})
    assert resp.status_code == 204

    # ログアウト後はリフレッシュ不可
    resp2 = await auth_client.post("/api/auth/refresh", json={"refreshToken": refresh_token})
    assert resp2.status_code == 401


# ── /me ────────────────────────────────────────────────────────

async def test_me_success(auth_client: httpx.AsyncClient) -> None:
    reg = await auth_client.post("/api/auth/register", json={
        "email": "me@example.com",
        "password": "password123",
        "workspaceName": "MyFactory",
    })
    access_token = reg.json()["accessToken"]

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
    assert resp.status_code == 403  # HTTPBearer は token なしで 403 を返す


async def test_me_invalid_token(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.get("/api/me", headers={"Authorization": "Bearer invalid.token.here"})
    assert resp.status_code == 401
