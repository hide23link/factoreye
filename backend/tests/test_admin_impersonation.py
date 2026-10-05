"""管理者が利用者として閲覧するためのトークン（POST /api/admin/users/{id}/impersonate）のテスト。"""

from collections.abc import AsyncGenerator, Generator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import jwt
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import admin_accounts
from app import auth as auth_module
from app.api import admin as admin_module
from app.api import auth as auth_routes
from app.api import sensors as sensors_module
from app.config import AuthMode, settings
from app.db.models import User
from app.db.session import engine
from app.rate_limit import limiter

ADMIN_ID = "admin"
ADMIN_PASSWORD = "adminpass123"


@pytest.fixture(autouse=True)
def _admin_env(tmp_path: Path) -> Generator[None, None, None]:
    original_mode = settings.auth_mode
    original_file = settings.admin_credentials_file
    original_enabled = limiter.enabled
    settings.auth_mode = AuthMode.MULTI_TENANT
    settings.admin_credentials_file = str(tmp_path / "admins.txt")
    limiter.enabled = False
    admin_accounts.set_admin(ADMIN_ID, ADMIN_PASSWORD)
    yield
    settings.auth_mode = original_mode
    settings.admin_credentials_file = original_file
    limiter.enabled = original_enabled


@pytest_asyncio.fixture
async def api() -> AsyncGenerator[httpx.AsyncClient, None]:
    test_app = FastAPI()
    test_app.state.limiter = limiter
    test_app.include_router(auth_routes.router)
    test_app.include_router(admin_module.router)
    test_app.include_router(sensors_module.router)
    async with httpx.AsyncClient(
        transport=ASGITransport(app=test_app), base_url="http://test"
    ) as c:
        yield c


def _admin_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {auth_module.create_admin_access_token(ADMIN_ID)}"}


async def _register(api: httpx.AsyncClient, email: str) -> dict[str, str]:
    resp = await api.post(
        "/api/auth/register",
        json={"email": email, "password": "password123", "workspaceName": "WS"},
    )
    assert resp.status_code == 201, resp.text
    tokens: dict[str, str] = resp.json()
    return tokens


async def _user_id(email: str) -> str:
    async with AsyncSession(engine) as session:
        user = (await session.exec(select(User).where(User.email == email))).one()
        return str(user.id)


async def test_unknown_user_returns_404(api: httpx.AsyncClient) -> None:
    resp = await api.post(
        "/api/admin/users/00000000-0000-0000-0000-000000000000/impersonate",
        headers=_admin_headers(),
    )
    assert resp.status_code == 404


async def test_requires_admin_token(api: httpx.AsyncClient) -> None:
    await _register(api, "imp-auth@example.com")
    user_id = await _user_id("imp-auth@example.com")

    resp = await api.post(f"/api/admin/users/{user_id}/impersonate")

    assert resp.status_code == 401


async def test_impersonation_token_sees_and_changes_the_users_own_data(
    api: httpx.AsyncClient,
) -> None:
    user_tokens = await _register(api, "imp-data@example.com")
    user_id = await _user_id("imp-data@example.com")

    resp = await api.post(
        f"/api/admin/users/{user_id}/impersonate", headers=_admin_headers()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    viewer = {"Authorization": f"Bearer {body['accessToken']}"}
    assert body["email"] == "imp-data@example.com"
    assert body["workspaceName"] == "WS"

    # 利用者と同じワークスペースのデータが見え、同じ画面の操作（作成）もできる
    created = await api.post(
        "/api/sensors",
        headers=viewer,
        json={"name": "imp-sensor", "ingestKey": "imp-sensor-key", "unit": "℃"},
    )
    assert created.status_code == 201, created.text

    owner_view = await api.get(
        "/api/sensors", headers={"Authorization": f"Bearer {user_tokens['accessToken']}"}
    )
    assert [s["name"] for s in owner_view.json()] == ["imp-sensor"]


async def test_impersonation_token_is_short_lived_and_has_no_refresh(
    api: httpx.AsyncClient,
) -> None:
    await _register(api, "imp-expiry@example.com")
    user_id = await _user_id("imp-expiry@example.com")

    resp = await api.post(
        f"/api/admin/users/{user_id}/impersonate", headers=_admin_headers()
    )
    body = resp.json()

    # リフレッシュトークンは返さない（期限切れ後に延長できない）
    assert "refreshToken" not in body
    payload = jwt.decode(body["accessToken"], settings.jwt_secret, algorithms=["HS256"])
    assert payload["imp"] == ADMIN_ID
    remaining = datetime.fromtimestamp(payload["exp"], tz=UTC) - datetime.now(UTC)
    assert timedelta(minutes=settings.impersonation_expire_minutes - 1) < remaining
    assert remaining <= timedelta(minutes=settings.impersonation_expire_minutes)


async def test_impersonation_token_cannot_use_admin_api(api: httpx.AsyncClient) -> None:
    await _register(api, "imp-admin@example.com")
    user_id = await _user_id("imp-admin@example.com")
    resp = await api.post(
        f"/api/admin/users/{user_id}/impersonate", headers=_admin_headers()
    )
    viewer = {"Authorization": f"Bearer {resp.json()['accessToken']}"}

    overview = await api.get("/api/admin/overview", headers=viewer)

    assert overview.status_code == 401
