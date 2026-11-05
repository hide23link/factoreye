"""パスワードの 72 バイト上限のテスト（bcrypt は 72 バイトを超える入力を拒否する）。

登録・管理者によるパスワード変更は 422、ログイン（利用者・管理者）は他の失敗と同じ 401 になる。
422 の応答にパスワードの値（input）が含まれないことも確かめる。
"""

import json
from collections.abc import AsyncGenerator, Generator
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import admin_accounts
from app.api import admin as admin_module
from app.api import auth as auth_module
from app.config import AuthMode, settings
from app.db.models import User
from app.db.session import engine
from app.rate_limit import limiter
from app.validation import handle_input_error

ADMIN_ID = "admin"
ADMIN_PASSWORD = "adminpass123"

# 72 バイトちょうど / 73 バイト（ASCII と日本語）
OK_ASCII = "a" * 72
NG_ASCII = "a" * 73
OK_JA = "あ" * 24
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
    test_app.include_router(auth_module.router)
    test_app.include_router(admin_module.router)
    async with httpx.AsyncClient(
        transport=ASGITransport(app=test_app), base_url="http://test"
    ) as c:
        yield c


def _email() -> str:
    return f"pw72-{uuid4().hex[:10]}@example.com"


async def _register(api: httpx.AsyncClient, email: str, password: str) -> httpx.Response:
    return await api.post(
        "/api/auth/register",
        json={"email": email, "password": password, "workspaceName": "WS"},
    )


async def _admin_headers(api: httpx.AsyncClient) -> dict[str, str]:
    resp = await api.post(
        "/api/admin/login", json={"adminId": ADMIN_ID, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['accessToken']}"}


async def _user_id(email: str) -> str:
    async with AsyncSession(engine) as session:
        user = (await session.exec(select(User).where(User.email == email))).one()
        return str(user.id)


def _assert_no_password_leak(resp: httpx.Response, password: str) -> None:
    assert password not in resp.text
    assert password not in json.dumps(resp.json(), ensure_ascii=False)
    for err in resp.json()["detail"]:
        assert "input" not in err
        assert "ctx" not in err


@pytest.mark.parametrize("password", [OK_ASCII, OK_JA])
async def test_register_and_login_at_72_bytes(api: httpx.AsyncClient, password: str) -> None:
    email = _email()
    assert (await _register(api, email, password)).status_code == 201
    login = await api.post("/api/auth/login", json={"email": email, "password": password})
    assert login.status_code == 200


@pytest.mark.parametrize("password", [NG_ASCII, NG_JA])
async def test_register_over_72_bytes_is_422_without_echo(
    api: httpx.AsyncClient, password: str
) -> None:
    resp = await _register(api, _email(), password)
    assert resp.status_code == 422
    assert "72" in resp.text  # 利用者向けのメッセージ
    _assert_no_password_leak(resp, password)


async def test_register_too_short_422_does_not_echo_password(api: httpx.AsyncClient) -> None:
    resp = await _register(api, _email(), "abc")
    assert resp.status_code == 422
    _assert_no_password_leak(resp, "abc")


@pytest.mark.parametrize("password", [NG_ASCII, NG_JA])
async def test_user_login_over_72_bytes_is_401_like_wrong_password(
    api: httpx.AsyncClient, password: str
) -> None:
    email = _email()
    assert (await _register(api, email, "password123")).status_code == 201
    long_pw = await api.post("/api/auth/login", json={"email": email, "password": password})
    wrong = await api.post("/api/auth/login", json={"email": email, "password": "wrongpass1"})
    unknown = await api.post(
        "/api/auth/login", json={"email": _email(), "password": password}
    )
    assert long_pw.status_code == wrong.status_code == unknown.status_code == 401
    assert long_pw.json() == wrong.json() == unknown.json()


@pytest.mark.parametrize("password", [NG_ASCII, NG_JA])
async def test_admin_login_over_72_bytes_is_401(api: httpx.AsyncClient, password: str) -> None:
    known = await api.post("/api/admin/login", json={"adminId": ADMIN_ID, "password": password})
    unknown = await api.post("/api/admin/login", json={"adminId": "ghost", "password": password})
    assert known.status_code == unknown.status_code == 401
    assert known.json() == unknown.json()


@pytest.mark.parametrize("password", [OK_ASCII, OK_JA])
async def test_admin_password_change_at_72_bytes(api: httpx.AsyncClient, password: str) -> None:
    email = _email()
    assert (await _register(api, email, "password123")).status_code == 201
    headers = await _admin_headers(api)
    uid = await _user_id(email)
    resp = await api.patch(f"/api/admin/users/{uid}", json={"password": password}, headers=headers)
    assert resp.status_code == 200, resp.text
    login = await api.post("/api/auth/login", json={"email": email, "password": password})
    assert login.status_code == 200


@pytest.mark.parametrize("password", [NG_ASCII, NG_JA])
async def test_admin_password_change_over_72_bytes_is_422_without_echo(
    api: httpx.AsyncClient, password: str
) -> None:
    email = _email()
    assert (await _register(api, email, "password123")).status_code == 201
    headers = await _admin_headers(api)
    uid = await _user_id(email)
    resp = await api.patch(f"/api/admin/users/{uid}", json={"password": password}, headers=headers)
    assert resp.status_code == 422
    assert "72" in resp.text
    _assert_no_password_leak(resp, password)
    # 元のパスワードのまま
    login = await api.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert login.status_code == 200


def test_main_app_registers_the_validation_handler() -> None:
    from app.main import app

    assert app.exception_handlers[RequestValidationError] is handle_input_error




async def test_login_with_lone_surrogate_is_401_like_wrong_password(
    api: httpx.AsyncClient,
) -> None:
    email = _email()
    assert (await _register(api, email, "password123")).status_code == 201
    body = '{"email": "%s", "password": "\\ud800x"}'
    headers = {"Content-Type": "application/json"}
    bad = await api.post("/api/auth/login", content=body % email, headers=headers)
    wrong = await api.post("/api/auth/login", json={"email": email, "password": "wrongpass1"})
    unknown = await api.post("/api/auth/login", content=body % _email(), headers=headers)
    assert bad.status_code == wrong.status_code == unknown.status_code == 401
    assert bad.json() == wrong.json() == unknown.json()


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


async def test_register_with_lone_surrogate_stays_422(api: httpx.AsyncClient) -> None:
    resp = await api.post(
        "/api/auth/register",
        content='{"email": "s@example.com", "password": "\\ud800xxxxxxxx", "workspaceName": "W"}',
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422
