"""取り込みのレート制限の期限付き解除（管理画面からの ON/OFF）のテスト。"""

from collections.abc import AsyncGenerator, Callable, Generator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, Request
from fastapi import status as http_status
from httpx import ASGITransport
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app import admin_accounts, ingest_limit_toggle
from app import auth as auth_utils
from app.api import admin as admin_module
from app.api import ingest
from app.config import AuthMode, settings
from app.rate_limit import limiter

ADMIN_ID = "admin"
ADMIN_PASSWORD = "adminpass123"
TEST_LIMIT = "1/minute"


@pytest.fixture(autouse=True)
def _toggle_env(tmp_path: Path) -> Generator[None, None, None]:
    """各テストで解除状態を初期化し、管理者ファイルを専用のものにする。"""
    original_mode = settings.auth_mode
    original_file = settings.admin_credentials_file
    original_limit = settings.ingest_rate_limit
    original_enabled = limiter.enabled
    settings.auth_mode = AuthMode.MULTI_TENANT
    settings.admin_credentials_file = str(tmp_path / "admins.txt")
    settings.ingest_rate_limit = TEST_LIMIT
    admin_accounts.set_admin(ADMIN_ID, ADMIN_PASSWORD)
    ingest_limit_toggle.reset_for_tests()
    limiter.reset()
    limiter.enabled = True
    yield
    ingest_limit_toggle.reset_for_tests()
    limiter.reset()
    limiter.enabled = original_enabled
    settings.auth_mode = original_mode
    settings.admin_credentials_file = original_file
    settings.ingest_rate_limit = original_limit


def _admin_headers() -> dict[str, str]:
    token = auth_utils.create_admin_access_token(ADMIN_ID)
    return {"Authorization": f"Bearer {token}"}


# ── 状態（メモリ上の解除の期限） ─────────────────────────────


def test_enable_sets_a_deadline_and_is_bypassed_until_it_passes() -> None:
    now = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
    ingest_limit_toggle.enable(ADMIN_ID, 60, now=now)

    assert ingest_limit_toggle.is_bypassed(now + timedelta(minutes=59))
    assert not ingest_limit_toggle.is_bypassed(now + timedelta(minutes=60))


def test_expired_state_reports_no_bypass() -> None:
    now = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
    ingest_limit_toggle.enable(ADMIN_ID, 10, now=now)

    state = ingest_limit_toggle.current(now + timedelta(minutes=11))

    assert state.until is None
    assert state.set_by is None


def test_disable_clears_the_bypass() -> None:
    ingest_limit_toggle.enable(ADMIN_ID, 60)
    ingest_limit_toggle.disable()

    assert not ingest_limit_toggle.is_bypassed()


# ── 取り込み API の制限（解除中は通す、解除後は元に戻る） ─────


async def _limited_endpoint(request: Request) -> dict[str, str]:
    return {"ok": "yes"}


@pytest.fixture(scope="module")
def limited_route() -> Callable[..., Any]:
    # 制限は 1 回だけ付ける（テストごとに付けると、slowapi の登録が重なって数え方が崩れる）
    original = settings.ingest_rate_limit
    settings.ingest_rate_limit = TEST_LIMIT
    wrapped = ingest._ingest_rate_limit(_limited_endpoint)
    settings.ingest_rate_limit = original
    return wrapped


@pytest_asyncio.fixture
async def ingest_app(limited_route: Callable[..., Any]) -> AsyncGenerator[httpx.AsyncClient, None]:
    """制限付きの取り込み風エンドポイントだけを持つ小さなアプリ。"""
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]
    app.post("/limited")(limited_route)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def test_limit_applies_when_not_bypassed(ingest_app: httpx.AsyncClient) -> None:
    assert (await ingest_app.post("/limited")).status_code == http_status.HTTP_200_OK
    assert (await ingest_app.post("/limited")).status_code == http_status.HTTP_429_TOO_MANY_REQUESTS


async def test_bypass_lets_requests_through_and_reverting_restores_the_limit(
    ingest_app: httpx.AsyncClient,
) -> None:
    ingest_limit_toggle.enable(ADMIN_ID, 60)
    for _ in range(3):
        assert (await ingest_app.post("/limited")).status_code == http_status.HTTP_200_OK

    ingest_limit_toggle.disable()
    limiter.reset()
    assert (await ingest_app.post("/limited")).status_code == http_status.HTTP_200_OK
    assert (await ingest_app.post("/limited")).status_code == http_status.HTTP_429_TOO_MANY_REQUESTS


async def _plain_handler(request: Request) -> dict[str, str]:
    return {"ok": "yes"}


def test_env_off_returns_the_handler_unwrapped() -> None:
    # 環境変数が off のときは、管理画面の状態に関係なく、ラップせずに元の関数を返す
    settings.ingest_rate_limit = "off"
    assert ingest._ingest_rate_limit(_plain_handler) is _plain_handler


# ── 管理者 API ───────────────────────────────────────────────


@pytest_asyncio.fixture
async def admin_api() -> AsyncGenerator[httpx.AsyncClient, None]:
    app = FastAPI()
    app.include_router(admin_module.router)
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def test_ingest_limit_endpoints_require_admin_token(admin_api: httpx.AsyncClient) -> None:
    assert (await admin_api.get("/api/admin/ingest-limit")).status_code == 401
    assert (
        await admin_api.put("/api/admin/ingest-limit", json={"enabled": True})
    ).status_code == 401


async def test_get_shows_the_default_when_not_bypassed(admin_api: httpx.AsyncClient) -> None:
    response = await admin_api.get("/api/admin/ingest-limit", headers=_admin_headers())

    assert response.status_code == 200
    body = response.json()
    assert body["defaultLimit"] == TEST_LIMIT
    assert body["envOff"] is False
    assert body["bypassed"] is False
    assert body["bypassUntil"] is None


async def test_put_enable_then_disable(admin_api: httpx.AsyncClient) -> None:
    enabled = await admin_api.put(
        "/api/admin/ingest-limit",
        json={"enabled": True, "minutes": 30},
        headers=_admin_headers(),
    )
    assert enabled.status_code == 200
    body = enabled.json()
    assert body["bypassed"] is True
    assert body["setBy"] == ADMIN_ID
    assert body["bypassUntil"] is not None

    disabled = await admin_api.put(
        "/api/admin/ingest-limit", json={"enabled": False}, headers=_admin_headers()
    )
    assert disabled.status_code == 200
    assert disabled.json()["bypassed"] is False


async def test_put_defaults_to_60_minutes(admin_api: httpx.AsyncClient) -> None:
    response = await admin_api.put(
        "/api/admin/ingest-limit", json={"enabled": True}, headers=_admin_headers()
    )

    until = datetime.fromisoformat(response.json()["bypassUntil"])
    remaining = until - datetime.now(UTC)
    assert timedelta(minutes=59) < remaining <= timedelta(minutes=60)


@pytest.mark.parametrize("minutes", [0, -1, ingest_limit_toggle.MAX_BYPASS_MINUTES + 1])
async def test_put_rejects_out_of_range_minutes(admin_api: httpx.AsyncClient, minutes: int) -> None:
    response = await admin_api.put(
        "/api/admin/ingest-limit",
        json={"enabled": True, "minutes": minutes},
        headers=_admin_headers(),
    )

    assert response.status_code == 422
    assert ingest_limit_toggle.is_bypassed() is False
