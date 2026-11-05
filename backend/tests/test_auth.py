"""認証API テスト（AUTH_MODE=multi_tenant）。"""
from collections.abc import AsyncGenerator, Generator
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
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
    assert resp.status_code in (401, 403)  # HTTPBearer は token なしで 401 or 403


async def test_me_invalid_token(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.get("/api/me", headers={"Authorization": "Bearer invalid.token.here"})
    assert resp.status_code == 401


# ── メールの大文字小文字・タイミング ───────────────────────────


async def test_register_email_is_normalized(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.post("/api/auth/register", json={
        "email": "  Case.User@Example.COM ",
        "password": "password123",
        "workspaceName": "W",
    })
    assert resp.status_code == 201
    me = await auth_client.get(
        "/api/me", headers={"Authorization": f"Bearer {resp.json()['accessToken']}"}
    )
    assert me.json()["email"] == "case.user@example.com"


async def test_register_email_case_variant_is_duplicate(auth_client: httpx.AsyncClient) -> None:
    payload = {"email": "foo@example.com", "password": "password123", "workspaceName": "W"}
    assert (await auth_client.post("/api/auth/register", json=payload)).status_code == 201
    resp = await auth_client.post(
        "/api/auth/register", json={**payload, "email": "Foo@Example.com"}
    )
    assert resp.status_code == 409


async def test_login_is_case_insensitive(auth_client: httpx.AsyncClient) -> None:
    payload = {"email": "login.case@example.com", "password": "password123", "workspaceName": "W"}
    await auth_client.post("/api/auth/register", json=payload)
    resp = await auth_client.post("/api/auth/login", json={
        "email": " Login.Case@EXAMPLE.com", "password": "password123",
    })
    assert resp.status_code == 200


async def test_login_matches_existing_mixed_case_account(
    auth_client: httpx.AsyncClient,
) -> None:
    # 正規化の導入前に作られた、大文字を含む既存アカウントでもログインできる
    from sqlmodel.ext.asyncio.session import AsyncSession

    from app import auth as auth_utils
    from app.db.models import User, Workspace
    from app.db.session import engine

    async with AsyncSession(engine) as session:
        user = User(
            email="Legacy@Example.com",
            password_hash=auth_utils.hash_password("password123"),
        )
        session.add(user)
        await session.flush()
        session.add(Workspace(name="W", owner_id=user.id))
        await session.commit()

    resp = await auth_client.post("/api/auth/login", json={
        "email": "legacy@example.com", "password": "password123",
    })
    assert resp.status_code == 200
    dup = await auth_client.post("/api/auth/register", json={
        "email": "LEGACY@example.com", "password": "password123", "workspaceName": "W2",
    })
    assert dup.status_code == 409


async def test_login_unknown_email_still_verifies_password_hash(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 未登録のときも bcrypt の照合を走らせ、応答時間で登録の有無を推測させない
    from app import auth as auth_utils

    calls: list[str] = []
    original = auth_utils.verify_password

    def spy(plain: str, hashed: str) -> bool:
        calls.append(hashed)
        return original(plain, hashed)

    monkeypatch.setattr(auth_utils, "verify_password", spy)
    resp = await auth_client.post("/api/auth/login", json={
        "email": "nobody@example.com", "password": "password123",
    })
    assert resp.status_code == 401
    assert len(calls) == 1


async def test_register_concurrent_unique_violation_returns_409(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 事前確認をすり抜けた同時登録が、一意制約違反（IntegrityError）になる状況を再現する
    from sqlalchemy.exc import IntegrityError
    from sqlmodel.ext.asyncio.session import AsyncSession

    async def boom(self: AsyncSession, *args: object, **kwargs: object) -> None:
        raise IntegrityError("INSERT INTO users", {}, Exception("duplicate key"))

    monkeypatch.setattr(AsyncSession, "flush", boom)
    resp = await auth_client.post("/api/auth/register", json={
        "email": "race@example.com", "password": "password123", "workspaceName": "W",
    })
    assert resp.status_code == 409
    assert resp.json()["detail"] == "email already registered"


async def test_register_case_variant_blocked_by_db_when_precheck_bypassed(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 事前確認をすり抜けた同時登録を再現する。lower(email) の一意インデックスが DB 側で拒否し、
    # 既存の IntegrityError の処理で 409 になる（大文字を含む既存アカウントとの重複も同様）
    from sqlmodel.ext.asyncio.session import AsyncSession

    from app import auth as auth_utils
    from app.db.models import User, Workspace
    from app.db.session import engine

    async with AsyncSession(engine) as session:
        user = User(
            email="Race@Example.com", password_hash=auth_utils.hash_password("password123")
        )
        session.add(user)
        await session.flush()
        session.add(Workspace(name="W", owner_id=user.id))
        await session.commit()

    original_exec = AsyncSession.exec

    class _Empty:
        def first(self) -> None:
            return None

    async def skip_precheck(self: AsyncSession, statement: Any, *a: Any, **kw: Any) -> Any:
        if "lower(" in str(statement):
            return _Empty()
        return await original_exec(self, statement, *a, **kw)

    monkeypatch.setattr(AsyncSession, "exec", skip_precheck)
    resp = await auth_client.post("/api/auth/register", json={
        "email": "race@example.com", "password": "password123", "workspaceName": "W2",
    })
    assert resp.status_code == 409
    assert resp.json()["detail"] == "email already registered"
