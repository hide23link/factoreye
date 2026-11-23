"""管理者のパスワードの 72 バイト上限のテスト（bcrypt は 72 バイトを超える入力を拒否する）。

利用者はパスワードを使わない（パスキー）ので、対象は管理者ログインだけ。
72 バイトを超える入力・孤立サロゲートは、他の失敗と同じ 401（または入力検証の 422）で、
500 にならず、パスワードの値を応答に含めない。
"""
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport

from app import admin_accounts
from app.api import admin as admin_module
from app.config import AuthMode, settings
from app.rate_limit import limiter
from app.validation import handle_input_error

ADMIN_ID = "admin"
ADMIN_PASSWORD = "adminpass123"

# 73 バイト（ASCII と日本語）
NG_ASCII = "a" * 73
NG_JA = "あ" * 25


@pytest.fixture(autouse=True)
def _env(tmp_path: Path) -> Generator[None, None, None]:
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
    test_app.add_exception_handler(RequestValidationError, handle_input_error)  # type: ignore[arg-type]
    test_app.include_router(admin_module.router)
    async with httpx.AsyncClient(
        transport=ASGITransport(app=test_app), base_url="http://test"
    ) as c:
        yield c


@pytest.mark.parametrize("password", [NG_ASCII, NG_JA])
async def test_admin_login_over_72_bytes_is_401(api: httpx.AsyncClient, password: str) -> None:
    known = await api.post("/api/admin/login", json={"adminId": ADMIN_ID, "password": password})
    unknown = await api.post("/api/admin/login", json={"adminId": "ghost", "password": password})
    assert known.status_code == unknown.status_code == 401
    assert known.json() == unknown.json()


def test_main_app_registers_the_validation_handler() -> None:
    from app.main import app

    assert app.exception_handlers[RequestValidationError] is handle_input_error


def test_verify_admin_with_lone_surrogate_is_false() -> None:
    """管理者ログインの照合（既知の ID・未知の ID）は、例外にせず False を返す。"""
    assert admin_accounts.verify_admin(ADMIN_ID, "\ud800x") is False
    assert admin_accounts.verify_admin("ghost", "\ud800x") is False


async def test_admin_login_with_lone_surrogate_is_not_500(api: httpx.AsyncClient) -> None:
    # 管理者ログインの入力は長さの制約があり、孤立サロゲートは入力の検証で 422 になる
    # （パスワードは応答に含まれない）。500 にならないことを確かめる
    resp = await api.post(
        "/api/admin/login",
        content='{"adminId": "admin", "password": "\\ud800x"}',
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422
    assert "input" not in resp.text
