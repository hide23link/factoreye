"""管理画面の「書き戻し」API（/api/admin/failback）のテスト。復旧ツールは偽の相手（MockTransport）。"""

import json
from collections.abc import AsyncGenerator, Generator
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr

from app import admin_accounts, failback_client
from app.api import admin as admin_module
from app.api import admin_failback
from app.config import AuthMode, settings
from app.main import app as main_app
from app.rate_limit import limiter

ADMIN_ID = "admin"
ADMIN_PASSWORD = "adminpass123"
NAME = "handoff-factoreye-20261028-103000.sql.gz"
RECOVERY_PASSWORD = "recovery-secret-value"


@pytest.fixture(autouse=True)
def _env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    original = (settings.auth_mode, settings.admin_credentials_file)
    settings.auth_mode = AuthMode.MULTI_TENANT
    settings.admin_credentials_file = str(tmp_path / "admins.txt")
    admin_accounts.set_admin(ADMIN_ID, ADMIN_PASSWORD)
    monkeypatch.setattr(settings, "failback_recovery_url", "http://recovery:8090")
    monkeypatch.setattr(settings, "failback_recovery_username", "admin")
    monkeypatch.setattr(settings, "failback_recovery_password", SecretStr(RECOVERY_PASSWORD))
    yield
    failback_client._transport = None
    settings.auth_mode, settings.admin_credentials_file = original


@pytest_asyncio.fixture
async def api() -> AsyncGenerator[httpx.AsyncClient, None]:
    test_app = FastAPI()
    test_app.state.limiter = limiter
    test_app.include_router(admin_module.router)
    test_app.include_router(admin_failback.router)
    async with httpx.AsyncClient(
        transport=ASGITransport(app=test_app), base_url="http://test"
    ) as c:
        yield c


async def _headers(api: httpx.AsyncClient) -> dict[str, str]:
    resp = await api.post(
        "/api/admin/login", json={"adminId": ADMIN_ID, "password": ADMIN_PASSWORD}
    )
    return {"Authorization": f"Bearer {resp.json()['accessToken']}"}


def _fake_recovery(
    handler: Any,
) -> list[httpx.Request]:
    """復旧ツールの偽の相手を差し込む。呼ばれたリクエストを記録して返す。"""
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)  # type: ignore[no-any-return]

    failback_client._transport = httpx.MockTransport(wrapped)
    return seen


PLAN = {
    "applied": False,
    "snapshot": None,
    "tables": [
        {"table": "readings", "source": 4, "inserted": 3, "existing": 1, "note": None, "closed": 0},
        {"table": "alarms", "source": 3, "inserted": 2, "existing": 1,
         "note": "発生中のアラーム 1 件を解除済みにして戻します", "closed": 1},
    ],
}


async def test_requires_admin_token(api: httpx.AsyncClient) -> None:
    seen = _fake_recovery(lambda r: httpx.Response(200, json={}))
    assert (await api.get("/api/admin/failback/handoffs")).status_code == 401
    assert (await api.post("/api/admin/failback/preview", json={"name": NAME})).status_code == 401
    body = {"name": NAME, "expectedInserted": 5}
    assert (await api.post("/api/admin/failback/apply", json=body)).status_code == 401
    assert seen == []


async def test_list_handoffs_passes_through_with_basic_auth(api: httpx.AsyncClient) -> None:
    seen = _fake_recovery(lambda r: httpx.Response(200, json={
        "source": "s3://factoreye-backup/handoff-inc",
        "items": [{
            "name": NAME, "size": 12000, "modified": "2026-10-28T10:30:00+00:00",
            "kind": "reduced", "watermark": "2026-10-05 00:30:00+00", "alembic": "abc",
            "instance": "i-0abc", "region": "ap-northeast-3", "created_at": "2026-10-28T10:30:00Z",
        }],
    }))
    r = await api.get("/api/admin/failback/handoffs", headers=await _headers(api))

    assert r.status_code == 200
    item = r.json()["items"][0]
    assert item["name"] == NAME and item["kind"] == "reduced" and item["createdAt"]
    assert seen[0].url.path == "/api/handoffs"
    # 復旧ツールへは Basic 認証で呼ぶ（値は応答には出ない）
    assert seen[0].headers["authorization"].startswith("Basic ")
    assert RECOVERY_PASSWORD not in r.text


async def test_preview_sends_no_apply_and_sums_inserted(api: httpx.AsyncClient) -> None:
    seen = _fake_recovery(lambda r: httpx.Response(200, json=PLAN))
    r = await api.post(
        "/api/admin/failback/preview", json={"name": NAME}, headers=await _headers(api)
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied"] is False and body["totalInserted"] == 5 and body["snapshot"] is None
    assert body["tables"][1]["closed"] == 1
    sent = json.loads(seen[0].content)
    assert seen[0].url.path == f"/api/handoffs/{NAME}/failback"
    assert sent == {"apply": False}


async def test_apply_sends_expected_count_and_returns_snapshot(api: httpx.AsyncClient) -> None:
    seen = _fake_recovery(lambda r: httpx.Response(
        200, json={**PLAN, "applied": True, "snapshot": "before-merge-20261028-110000.sql.gz"}
    ))
    r = await api.post(
        "/api/admin/failback/apply",
        json={"name": NAME, "expectedInserted": 5},
        headers=await _headers(api),
    )

    assert r.status_code == 200, r.text
    assert r.json()["applied"] is True
    assert r.json()["snapshot"].startswith("before-merge-")
    assert json.loads(seen[0].content) == {"apply": True, "expected_inserted": 5}


async def test_apply_requires_the_expected_count(api: httpx.AsyncClient) -> None:
    seen = _fake_recovery(lambda r: httpx.Response(200, json=PLAN))
    r = await api.post(
        "/api/admin/failback/apply", json={"name": NAME}, headers=await _headers(api)
    )
    assert r.status_code == 422
    assert seen == []


@pytest.mark.parametrize(
    "bad", ["../etc/passwd", "factoreye-20261028-103000.sql.gz", f"{NAME}/../x", "handoff-x"]
)
async def test_rejects_malformed_names_without_calling_recovery(
    api: httpx.AsyncClient, bad: str
) -> None:
    seen = _fake_recovery(lambda r: httpx.Response(200, json=PLAN))
    h = await _headers(api)
    assert (await api.post("/api/admin/failback/preview", json={"name": bad}, headers=h)
            ).status_code == 422
    assert seen == []


async def test_count_mismatch_is_reported_as_conflict(api: httpx.AsyncClient) -> None:
    _fake_recovery(lambda r: httpx.Response(
        409, json={"detail": "試行の後に今の DB が変わりました（確認した 5 行 → 今は 7 行）。"}
    ))
    r = await api.post(
        "/api/admin/failback/apply",
        json={"name": NAME, "expectedInserted": 5},
        headers=await _headers(api),
    )
    assert r.status_code == 409 and "今の DB が変わりました" in r.json()["detail"]


async def test_schema_mismatch_keeps_both_versions(api: httpx.AsyncClient) -> None:
    detail = {"code": "schema_mismatch", "message": "スキーマの版が違います",
              "handoff_alembic": "aaa", "current_alembic": "bbb"}
    _fake_recovery(lambda r: httpx.Response(409, json={"detail": detail}))
    r = await api.post(
        "/api/admin/failback/preview", json={"name": NAME}, headers=await _headers(api)
    )
    assert r.status_code == 409 and r.json()["detail"] == detail


async def test_recovery_unreachable_gives_a_clear_error(api: httpx.AsyncClient) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("name resolution failed: recovery")

    _fake_recovery(refuse)
    r = await api.get("/api/admin/failback/handoffs", headers=await _headers(api))
    assert r.status_code == 503 and "復旧ツールに接続できません" in r.json()["detail"]


async def test_recovery_timeout_gives_a_clear_error(api: httpx.AsyncClient) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    _fake_recovery(slow)
    r = await api.post(
        "/api/admin/failback/preview", json={"name": NAME}, headers=await _headers(api)
    )
    assert r.status_code == 504 and "時間切れ" in r.json()["detail"]


async def test_wrong_recovery_credentials_do_not_leak(api: httpx.AsyncClient) -> None:
    _fake_recovery(lambda r: httpx.Response(401, json={"detail": "認証に失敗しました"}))
    r = await api.get("/api/admin/failback/handoffs", headers=await _headers(api))
    assert r.status_code == 502 and "認証に失敗" in r.json()["detail"]
    assert RECOVERY_PASSWORD not in r.text


async def test_recovery_server_error_is_shown_as_bad_gateway(api: httpx.AsyncClient) -> None:
    _fake_recovery(lambda r: httpx.Response(503, json={"detail": "DB に接続できません: x"}))
    r = await api.get("/api/admin/failback/handoffs", headers=await _headers(api))
    assert r.status_code == 502 and "DB に接続できません" in r.json()["detail"]


async def test_missing_settings_say_so_without_calling(
    api: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _fake_recovery(lambda r: httpx.Response(200, json={}))
    monkeypatch.setattr(settings, "failback_recovery_password", SecretStr(""))
    r = await api.get("/api/admin/failback/handoffs", headers=await _headers(api))
    assert r.status_code == 503 and "FAILBACK_RECOVERY_PASSWORD" in r.json()["detail"]
    assert seen == []


async def test_password_is_not_in_settings_repr() -> None:
    assert RECOVERY_PASSWORD not in repr(settings)


async def test_not_mounted_in_the_self_hosted_app(client: httpx.AsyncClient) -> None:
    # main.py は AUTH_MODE が multi_tenant のときだけ /api/admin をマウントする。
    # main_app は読み込み時の設定（既定は self-hosted）で組み立て済みなので、マウントされていない
    paths = {getattr(r, "path", "") for r in main_app.routes}
    assert not any(p.startswith("/api/admin/failback") for p in paths)
    assert (await client.get("/api/admin/failback/handoffs")).status_code == 404
