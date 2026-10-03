"""管理者API・管理者アカウント（テキストファイル）のテスト（AUTH_MODE=multi_tenant）。"""

from collections.abc import AsyncGenerator, Generator
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import admin_accounts
from app.api import admin as admin_module
from app.api import auth as auth_module
from app.config import AuthMode, settings
from app.db.models import Reading, Sensor, User, Workspace
from app.db.session import engine
from app.rate_limit import limiter

ADMIN_ID = "admin"
ADMIN_PASSWORD = "adminpass123"


@pytest.fixture(autouse=True)
def _admin_env(tmp_path: Path) -> Generator[None, None, None]:
    """各テストで AUTH_MODE=multi_tenant、専用の管理者ファイル、レート制限オフ。"""
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
    test_app.include_router(auth_module.router)
    test_app.include_router(admin_module.router)
    async with httpx.AsyncClient(
        transport=ASGITransport(app=test_app), base_url="http://test"
    ) as c:
        yield c


async def _admin_login(api: httpx.AsyncClient, password: str = ADMIN_PASSWORD) -> dict[str, str]:
    resp = await api.post("/api/admin/login", json={"adminId": ADMIN_ID, "password": password})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['accessToken']}"}


async def _register(api: httpx.AsyncClient, email: str, workspace: str = "WS") -> dict[str, str]:
    resp = await api.post(
        "/api/auth/register",
        json={"email": email, "password": "password123", "workspaceName": workspace},
    )
    assert resp.status_code == 201, resp.text
    tokens: dict[str, str] = resp.json()
    return tokens


async def _user_id(email: str) -> str:
    async with AsyncSession(engine) as session:
        user = (await session.exec(select(User).where(User.email == email))).one()
        return str(user.id)


async def _add_sensor_with_readings(email: str, n_readings: int) -> str:
    """ユーザーのワークスペースにセンサーを1つ作り、測定値を n 件入れる。センサーIDを返す。"""
    async with AsyncSession(engine) as session:
        user = (await session.exec(select(User).where(User.email == email))).one()
        ws = (await session.exec(select(Workspace).where(Workspace.owner_id == user.id))).one()
        sensor = Sensor(
            workspace_id=ws.id,
            name=f"s-{uuid4().hex[:8]}",
            ingest_key=uuid4().hex,
            unit="count",
        )
        session.add(sensor)
        await session.flush()
        sensor_id = sensor.id  # commit で expire される前に取得
        now = datetime.now(UTC)
        for i in range(n_readings):
            session.add(Reading(sensor_id=sensor_id, value=float(i), recorded_at=now))
        await session.commit()
    return str(sensor_id)


# ── 管理者ファイル ───────────────────────────────────────────


def test_set_admin_writes_hash_not_plaintext() -> None:
    path = Path(settings.admin_credentials_file)
    content = path.read_text(encoding="utf-8")
    assert f"{ADMIN_ID}:$2" in content  # bcryptハッシュ
    assert ADMIN_PASSWORD not in content


def test_set_admin_replaces_without_duplicating_header() -> None:
    admin_accounts.set_admin(ADMIN_ID, "another-pass-456")
    admin_accounts.set_admin("second", "second-pass-789")
    content = Path(settings.admin_credentials_file).read_text(encoding="utf-8")
    assert content.count("# FactorEye 管理者アカウント") == 1
    assert content.count(f"{ADMIN_ID}:") == 1
    assert admin_accounts.verify_admin(ADMIN_ID, "another-pass-456")
    assert not admin_accounts.verify_admin(ADMIN_ID, ADMIN_PASSWORD)
    assert admin_accounts.list_admin_ids() == ["admin", "second"]


def test_remove_admin() -> None:
    assert admin_accounts.remove_admin(ADMIN_ID) is True
    assert admin_accounts.remove_admin(ADMIN_ID) is False
    assert not admin_accounts.admin_exists(ADMIN_ID)


def test_invalid_admin_id_is_rejected() -> None:
    with pytest.raises(ValueError):
        admin_accounts.set_admin("bad:id", "password123")


# ── ログイン ─────────────────────────────────────────────────


async def test_login_success(api: httpx.AsyncClient) -> None:
    resp = await api.post(
        "/api/admin/login", json={"adminId": ADMIN_ID, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200
    assert resp.json()["tokenType"] == "bearer"


async def test_login_wrong_password_and_unknown_id_look_the_same(api: httpx.AsyncClient) -> None:
    wrong_pw = await api.post(
        "/api/admin/login", json={"adminId": ADMIN_ID, "password": "nope-nope"}
    )
    unknown = await api.post("/api/admin/login", json={"adminId": "ghost", "password": "nope-nope"})
    assert wrong_pw.status_code == 401
    assert unknown.status_code == 401
    assert wrong_pw.json() == unknown.json()


async def test_normal_user_cannot_log_in_to_admin(api: httpx.AsyncClient) -> None:
    # 一般ユーザーのメール・パスワードでは管理者ログインできない（DB ユーザーは管理者ではない）
    await _register(api, "normal@example.com")
    resp = await api.post(
        "/api/admin/login",
        json={"adminId": "normal@example.com", "password": "password123"},
    )
    assert resp.status_code == 401


# ── 認可 ─────────────────────────────────────────────────────


async def test_admin_endpoints_require_admin_token(api: httpx.AsyncClient) -> None:
    assert (await api.get("/api/admin/users")).status_code == 401


async def test_user_token_cannot_access_admin_api(api: httpx.AsyncClient) -> None:
    tokens = await _register(api, "member@example.com")
    resp = await api.get(
        "/api/admin/users", headers={"Authorization": f"Bearer {tokens['accessToken']}"}
    )
    assert resp.status_code == 401


async def test_removed_admin_is_rejected_immediately(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    admin_accounts.remove_admin(ADMIN_ID)
    resp = await api.get("/api/admin/overview", headers=headers)
    assert resp.status_code == 403


async def test_login_is_rate_limited_when_enabled(api: httpx.AsyncClient) -> None:
    limiter.enabled = True
    try:
        codes = []
        for _ in range(6):
            r = await api.post(
                "/api/admin/login", json={"adminId": ADMIN_ID, "password": "wrong-pass"}
            )
            codes.append(r.status_code)
        assert 429 in codes
    finally:
        limiter.enabled = False
        limiter.reset()


# ── 一覧・詳細・概要 ─────────────────────────────────────────


async def test_list_users_shows_sensor_and_reading_counts(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    await _register(api, "tanaka@example.com", "田中工場")
    await _add_sensor_with_readings("tanaka@example.com", n_readings=3)

    resp = await api.get("/api/admin/users", headers=headers)
    assert resp.status_code == 200
    row = next(u for u in resp.json() if u["email"] == "tanaka@example.com")
    assert row["workspaceName"] == "田中工場"
    assert row["plan"] == "free"
    assert row["sensorCount"] == 1
    assert row["readingCount"] == 3
    assert row["lastReadingAt"] is not None


async def test_user_detail_lists_sensors(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    await _register(api, "detail@example.com")
    sensor_id = await _add_sensor_with_readings("detail@example.com", n_readings=2)
    user_id = await _user_id("detail@example.com")

    resp = await api.get(f"/api/admin/users/{user_id}", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["sensors"]) == 1
    assert body["sensors"][0]["id"] == sensor_id
    assert body["sensors"][0]["readingCount"] == 2


async def test_overview_counts(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    await _register(api, "ov@example.com")
    await _add_sensor_with_readings("ov@example.com", n_readings=4)

    resp = await api.get("/api/admin/overview", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["userCount"] == 1
    assert body["sensorCount"] == 1
    assert body["readingCount"] == 4
    assert body["databaseSizeBytes"] > 0


async def test_unknown_user_returns_404(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    resp = await api.get(f"/api/admin/users/{uuid4()}", headers=headers)
    assert resp.status_code == 404


# ── 修正 ─────────────────────────────────────────────────────


async def test_patch_plan_and_email(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    await _register(api, "edit@example.com")
    user_id = await _user_id("edit@example.com")

    resp = await api.patch(
        f"/api/admin/users/{user_id}",
        headers=headers,
        json={"plan": "pro", "email": "edited@example.com"},
    )
    assert resp.status_code == 200
    assert resp.json()["plan"] == "pro"
    assert resp.json()["email"] == "edited@example.com"


async def test_patch_email_conflict_returns_409(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    await _register(api, "a@example.com")
    await _register(api, "b@example.com")
    user_id = await _user_id("a@example.com")
    resp = await api.patch(
        f"/api/admin/users/{user_id}", headers=headers, json={"email": "b@example.com"}
    )
    assert resp.status_code == 409


async def test_password_reset_revokes_refresh_tokens(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    tokens = await _register(api, "reset@example.com")
    user_id = await _user_id("reset@example.com")

    resp = await api.patch(
        f"/api/admin/users/{user_id}", headers=headers, json={"password": "brandnew-pass1"}
    )
    assert resp.status_code == 200
    # 既存のリフレッシュトークンは失効している
    refreshed = await api.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert refreshed.status_code == 401
    # 新しいパスワードでログインできる
    login = await api.post(
        "/api/auth/login", json={"email": "reset@example.com", "password": "brandnew-pass1"}
    )
    assert login.status_code == 200


# ── 削除 ─────────────────────────────────────────────────────


async def test_delete_user_removes_workspace_sensors_and_readings(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    await _register(api, "gone@example.com")
    await _add_sensor_with_readings("gone@example.com", n_readings=5)
    user_id = await _user_id("gone@example.com")

    resp = await api.delete(f"/api/admin/users/{user_id}", headers=headers)
    assert resp.status_code == 204

    listing = await api.get("/api/admin/users", headers=headers)
    assert all(u["email"] != "gone@example.com" for u in listing.json())

    async with AsyncSession(engine) as session:
        assert (
            await session.exec(select(User).where(User.email == "gone@example.com"))
        ).first() is None
        assert (await session.exec(select(Sensor))).all() == []
        assert (await session.exec(select(Reading))).all() == []


async def test_delete_unknown_user_returns_404(api: httpx.AsyncClient) -> None:
    headers = await _admin_login(api)
    resp = await api.delete(f"/api/admin/users/{uuid4()}", headers=headers)
    assert resp.status_code == 404
