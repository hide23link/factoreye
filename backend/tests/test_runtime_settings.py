"""配布版の「API・取り込み」設定 API（app/api/runtime_settings.py）。"""
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from app import auth as auth_utils
from app import env_file
from app.api import runtime_settings
from app.config import settings

PASSWORD = "correct-horse"
BASE = """INGEST_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaa
INGEST_AUTH=key
ENVIRONMENT=production
JWT_SECRET=jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj
POSTGRES_PASSWORD=dbpass
"""


@pytest.fixture
def restarts() -> list[bool]:
    """再起動の予約の記録（予約されるたびに True が 1 つ増える）。"""
    return []


@pytest.fixture
def env_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, restarts: list[bool]
) -> Iterator[Path]:
    """使い捨ての .env を用意し、起動時の内容と同じ状態にする。再起動は行わず、記録だけする。"""
    path = tmp_path / ".env"
    path.write_text(BASE)
    monkeypatch.setattr(env_file, "ENV_PATH", path)
    monkeypatch.setattr(env_file, "BACKUP_PATH", tmp_path / ".env.bak")
    monkeypatch.setattr(env_file, "LOADED_DIGEST", env_file.digest_of(path))
    monkeypatch.setattr(settings, "admin_password_hash", auth_utils.hash_password(PASSWORD))
    monkeypatch.setattr(runtime_settings, "_failures", runtime_settings._FailureCounter())
    monkeypatch.setattr(runtime_settings, "schedule_restart", lambda: restarts.append(True))
    yield path


async def _token(client: httpx.AsyncClient) -> dict[str, str]:
    response = await client.post("/api/settings/runtime/unlock", json={"password": PASSWORD})
    assert response.status_code == 200
    return {"X-Settings-Token": response.json()["token"]}


async def test_get_never_returns_secret_values(client: httpx.AsyncClient, env_path: Path) -> None:
    body = (await client.get("/api/settings/runtime")).json()
    assert "ingestApiKey" not in body
    assert "aaaaaaaa" not in str(body)
    assert body["passwordConfigured"] is True
    assert body["fileChanged"] is False


async def test_put_requires_token(client: httpx.AsyncClient, env_path: Path) -> None:
    response = await client.put("/api/settings/runtime", json={"values": {"INGEST_AUTH": "off"}})
    assert response.status_code == 401
    assert env_path.read_text() == BASE


async def test_put_rejects_garbage_token(client: httpx.AsyncClient, env_path: Path) -> None:
    response = await client.put(
        "/api/settings/runtime",
        headers={"X-Settings-Token": "abc"},
        json={"values": {"INGEST_AUTH": "off"}},
    )
    assert response.status_code == 401


async def test_unlock_wrong_password_and_lockout(client: httpx.AsyncClient, env_path: Path) -> None:
    for _ in range(runtime_settings.MAX_FAILED_UNLOCKS):
        wrong = await client.post("/api/settings/runtime/unlock", json={"password": "nope"})
        assert wrong.status_code == 401
    locked = await client.post("/api/settings/runtime/unlock", json={"password": PASSWORD})
    assert locked.status_code == 429


async def test_unlock_without_configured_password(
    client: httpx.AsyncClient, env_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "admin_password_hash", "")
    response = await client.post("/api/settings/runtime/unlock", json={"password": PASSWORD})
    assert response.status_code == 403


async def test_save_writes_file_and_restarts(
    client: httpx.AsyncClient, env_path: Path, restarts: list[bool]
) -> None:
    headers = await _token(client)
    response = await client.put(
        "/api/settings/runtime",
        headers=headers,
        json={"values": {"INGEST_AUTH": "off", "INGEST_RATE_LIMIT": "50/minute"}},
    )
    assert response.status_code == 200
    assert response.json() == {"restarting": True}
    text = env_path.read_text()
    assert "INGEST_AUTH=off" in text
    assert "INGEST_RATE_LIMIT=50/minute" in text
    assert "JWT_SECRET=jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj" in text
    assert (env_path.parent / ".env.bak").read_text() == BASE
    assert restarts == [True]


async def test_save_rejects_uneditable_and_invalid(
    client: httpx.AsyncClient, env_path: Path, restarts: list[bool]
) -> None:
    headers = await _token(client)
    for values in ({"JWT_SECRET": "x" * 32}, {"INGEST_AUTH": "of"}, {"INGEST_API_KEY": "short"}):
        response = await client.put(
            "/api/settings/runtime", headers=headers, json={"values": values}
        )
        assert response.status_code == 422
    assert env_path.read_text() == BASE
    assert restarts == []


async def test_save_refuses_file_that_would_not_start(
    client: httpx.AsyncClient, env_path: Path
) -> None:
    """直接編集で壊れている .env の上に重ねても、起動できない内容は書かない。"""
    env_path.write_text(BASE + "INGEST_CACHE_SECONDS=abc\n")
    headers = await _token(client)
    response = await client.put(
        "/api/settings/runtime", headers=headers, json={"values": {"INGEST_AUTH": "off"}}
    )
    assert response.status_code == 422
    assert any("INGEST_CACHE_SECONDS" in line for line in response.json()["detail"])
    assert "INGEST_AUTH=off" not in env_path.read_text()


async def test_change_password_stores_quoted_hash(
    client: httpx.AsyncClient, env_path: Path
) -> None:
    headers = await _token(client)
    response = await client.put(
        "/api/settings/runtime/password", headers=headers, json={"password": "new-password"}
    )
    assert response.status_code == 200
    lines = env_path.read_text().splitlines()
    line = next(line for line in lines if line.startswith("ADMIN_PASSWORD_HASH="))
    assert line.startswith("ADMIN_PASSWORD_HASH='$2b$")
    stored = env_file.values_in(env_path.read_text())["ADMIN_PASSWORD_HASH"]
    assert auth_utils.verify_password("new-password", stored)


async def test_short_password_rejected(client: httpx.AsyncClient, env_path: Path) -> None:
    headers = await _token(client)
    response = await client.put(
        "/api/settings/runtime/password", headers=headers, json={"password": "12345"}
    )
    assert response.status_code == 422


async def test_reflect_requires_changed_file(
    client: httpx.AsyncClient, env_path: Path, restarts: list[bool]
) -> None:
    response = await client.post("/api/settings/runtime/reflect")
    assert response.status_code == 409
    assert restarts == []


async def test_reflect_after_direct_edit_without_password(
    client: httpx.AsyncClient, env_path: Path, restarts: list[bool]
) -> None:
    env_path.write_text(BASE.replace("INGEST_AUTH=key", "INGEST_AUTH=off"))
    assert (await client.get("/api/settings/runtime")).json()["fileChanged"] is True
    response = await client.post("/api/settings/runtime/reflect")
    assert response.status_code == 200
    assert restarts == [True]


async def test_reflect_refuses_broken_file(
    client: httpx.AsyncClient, env_path: Path, restarts: list[bool]
) -> None:
    env_path.write_text(BASE.replace("INGEST_AUTH=key", "INGEST_AUTH=of"))
    response = await client.post("/api/settings/runtime/reflect")
    assert response.status_code == 422
    assert response.json()["detail"][0].startswith("INGEST_AUTH:")
    assert restarts == []
