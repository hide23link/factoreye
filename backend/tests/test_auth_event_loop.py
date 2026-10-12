"""bcrypt の処理（登録・ログイン・管理者ログイン・パスワード変更）がループを止めない検証。

認証の最中に別のコルーチン（センサーの取り込みや /health の代わり）を動かし、
その遅れの最大値が、bcrypt 1 回分（コスト係数 12 で約 200ms 以上）より十分小さいことを確かめる。
"""
import asyncio
import time
from collections.abc import AsyncGenerator, Awaitable, Generator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport

from app import admin_accounts
from app import auth as auth_utils
from app.api import admin as admin_module
from app.api import auth as auth_module
from app.config import AuthMode, settings
from app.rate_limit import limiter

# 1 回の bcrypt は 200ms 前後。止まっていれば遅れはそれに近い値になる。
# 緩めの 100ms 未満を求める（別スレッドなら、通常は数 ms〜十数 ms）
MAX_LAG_SECONDS = 0.1
TICK = 0.01


@pytest.fixture(autouse=True)
def _env(tmp_path: Path) -> Generator[None, None, None]:
    original_mode = settings.auth_mode
    original_file = settings.admin_credentials_file
    settings.auth_mode = AuthMode.MULTI_TENANT
    settings.admin_credentials_file = str(tmp_path / "admins.txt")
    admin_accounts.set_admin("admin", "adminpass123")
    yield
    settings.auth_mode = original_mode
    settings.admin_credentials_file = original_file


@pytest_asyncio.fixture
async def api() -> AsyncGenerator[httpx.AsyncClient, None]:
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(auth_module.router)
    app.include_router(admin_module.router)
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _max_lag_during(work: Awaitable[httpx.Response]) -> tuple[float, httpx.Response]:
    """work の実行中、短い sleep を繰り返し、予定より遅れた時間の最大値（秒）を返す。"""
    lags: list[float] = []
    done = asyncio.Event()

    async def ticker() -> None:
        while not done.is_set():
            start = time.perf_counter()
            await asyncio.sleep(TICK)
            lags.append(time.perf_counter() - start - TICK)

    task = asyncio.create_task(ticker())
    await asyncio.sleep(TICK * 3)  # ticker が動き出してから開始する
    try:
        resp = await work
    finally:
        done.set()
        await task
    return max(lags), resp


async def test_register_does_not_block_event_loop(api: httpx.AsyncClient) -> None:
    lag, resp = await _max_lag_during(
        api.post(
            "/api/auth/register",
            json={"email": "a@example.com", "password": "password123", "workspaceName": "W"},
        )
    )
    assert resp.status_code == 201
    assert lag < MAX_LAG_SECONDS, f"イベントループが {lag * 1000:.0f}ms 止まった"


async def test_login_does_not_block_event_loop(api: httpx.AsyncClient) -> None:
    await api.post(
        "/api/auth/register",
        json={"email": "b@example.com", "password": "password123", "workspaceName": "W"},
    )
    lag, resp = await _max_lag_during(
        api.post("/api/auth/login", json={"email": "b@example.com", "password": "password123"})
    )
    assert resp.status_code == 200
    assert lag < MAX_LAG_SECONDS, f"イベントループが {lag * 1000:.0f}ms 止まった"


async def test_login_unknown_email_dummy_check_does_not_block(api: httpx.AsyncClient) -> None:
    lag, resp = await _max_lag_during(
        api.post("/api/auth/login", json={"email": "none@example.com", "password": "password123"})
    )
    assert resp.status_code == 401
    assert lag < MAX_LAG_SECONDS, f"イベントループが {lag * 1000:.0f}ms 止まった"


async def test_admin_login_does_not_block_event_loop(api: httpx.AsyncClient) -> None:
    lag, resp = await _max_lag_during(
        api.post("/api/admin/login", json={"adminId": "admin", "password": "adminpass123"})
    )
    assert resp.status_code == 200
    assert lag < MAX_LAG_SECONDS, f"イベントループが {lag * 1000:.0f}ms 止まった"


async def test_admin_login_unknown_id_dummy_check_does_not_block(api: httpx.AsyncClient) -> None:
    lag, resp = await _max_lag_during(
        api.post("/api/admin/login", json={"adminId": "nobody", "password": "adminpass123"})
    )
    assert resp.status_code == 401
    assert lag < MAX_LAG_SECONDS, f"イベントループが {lag * 1000:.0f}ms 止まった"


async def test_admin_password_change_does_not_block_event_loop(api: httpx.AsyncClient) -> None:
    reg = await api.post(
        "/api/auth/register",
        json={"email": "c@example.com", "password": "password123", "workspaceName": "W"},
    )
    assert reg.status_code == 201
    login = await api.post(
        "/api/admin/login", json={"adminId": "admin", "password": "adminpass123"}
    )
    headers = {"Authorization": f"Bearer {login.json()['accessToken']}"}
    users = await api.get("/api/admin/users", headers=headers)
    user_id = users.json()[0]["id"]
    lag, resp = await _max_lag_during(
        api.patch(
            f"/api/admin/users/{user_id}", json={"password": "newpassword456"}, headers=headers
        )
    )
    assert resp.status_code == 200, resp.text
    assert lag < MAX_LAG_SECONDS, f"イベントループが {lag * 1000:.0f}ms 止まった"


async def test_dummy_hash_uses_same_cost_as_real_hash() -> None:
    """ダミー照合と本物の照合のコスト係数が同じ（応答時間を揃える前提）。"""
    real = auth_utils.hash_password("password123")
    assert auth_utils.DUMMY_PASSWORD_HASH.split("$")[2] == real.split("$")[2]
