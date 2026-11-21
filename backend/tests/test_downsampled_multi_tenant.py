"""間引き取得（まとめ POST・単体 GET）の、SaaS（AUTH_MODE=multi_tenant）での認可の確認。

見ること: トークンなし・不正は 401、他人のセンサーと存在しないセンサーは区別できず 404
（まとめ POST は件ごとに 404 / 400）、自分のセンサーは 200。status と detail の文言は、
応答を直接 JSON にする変更の前と同じ。OSS 版（disabled）の動きは test_readings_downsampled*.py。
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from httpx import Response
from sqlmodel.ext.asyncio.session import AsyncSession

from app.auth import create_access_token
from app.config import AuthMode, settings
from app.db.models import Reading, Sensor, User, Workspace
from app.db.session import engine

BATCH_URL = "/api/sensors/readings/downsampled"


@pytest.fixture(autouse=True)
def _multi_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)


async def _tenant(now: datetime) -> tuple[UUID, dict[str, str]]:
    """ワークスペースと測定値のあるセンサーを 1 つ作り、(センサー, ログイン用の見出し) を返す。"""
    async with AsyncSession(engine) as session:
        user = User(email=f"{uuid4()}@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        workspace = Workspace(name="テスト用", owner_id=user.id)
        session.add(workspace)
        await session.flush()
        sensor = Sensor(workspace_id=workspace.id, name="s", ingest_key=uuid4().hex, unit="℃")
        session.add(sensor)
        await session.flush()
        for minutes in range(1, 4):
            recorded_at = now - timedelta(minutes=minutes)
            session.add(Reading(sensor_id=sensor.id, value=minutes * 1.5, recorded_at=recorded_at))
        # commit のあとは属性が期限切れになるので、先に値を取り出す
        sensor_id = sensor.id
        token = create_access_token(user.id, workspace.id)
        await session.commit()
        return sensor_id, {"Authorization": f"Bearer {token}"}


def _item(sensor_id: UUID, now: datetime) -> dict[str, object]:
    return {
        "sensorId": str(sensor_id),
        "from": (now - timedelta(hours=1)).isoformat(),
        "to": now.isoformat(),
        "buckets": 4,
    }


async def test_batch_returns_only_own_sensors(client: httpx.AsyncClient) -> None:
    now = datetime.now(UTC)
    mine, mine_auth = await _tenant(now)
    theirs, _ = await _tenant(now)
    missing = uuid4()
    items = [_item(mine, now), _item(theirs, now), _item(missing, now)]

    resp = await client.post(BATCH_URL, json={"items": items}, headers=mine_auth)

    assert resp.status_code == 200
    own, other, none = resp.json()["results"]
    assert (own["status"], own["detail"], own["data"] is not None) == (200, None, True)
    assert own["data"]["buckets"], "自分のセンサーの値が返る"
    # 他人のセンサーと存在しないセンサーは、区別できない同じ応答
    assert (other["status"], other["detail"], other["data"]) == (404, "sensor not found", None)
    assert (none["status"], none["detail"], none["data"]) == (404, "sensor not found", None)


async def test_batch_without_or_with_bad_token_is_401(client: httpx.AsyncClient) -> None:
    now = datetime.now(UTC)
    mine, _ = await _tenant(now)
    body = {"items": [_item(mine, now)]}

    no_token = await client.post(BATCH_URL, json=body)
    bad_token = await client.post(BATCH_URL, json=body, headers={"Authorization": "Bearer x"})

    assert (no_token.status_code, no_token.json()["detail"]) == (401, "authentication required")
    assert (bad_token.status_code, bad_token.json()["detail"]) == (
        401,
        "invalid or expired token",
    )


async def test_single_get_is_scoped_to_the_workspace(client: httpx.AsyncClient) -> None:
    now = datetime.now(UTC)
    mine, mine_auth = await _tenant(now)
    theirs, _ = await _tenant(now)
    params = {k: str(v) for k, v in _item(mine, now).items() if k != "sensorId"}

    async def get(sensor_id: UUID, headers: dict[str, str] | None = None) -> Response:
        url = f"/api/sensors/{sensor_id}/readings/downsampled"
        return await client.get(url, params=params, headers=headers)

    own = await get(mine, mine_auth)
    other = await get(theirs, mine_auth)
    missing = await get(uuid4(), mine_auth)
    anonymous = await get(mine)

    assert own.status_code == 200
    assert own.headers["content-type"] == "application/json"
    assert own.json()["buckets"]
    assert (other.status_code, other.json()["detail"]) == (404, "sensor not found")
    assert (missing.status_code, missing.json()["detail"]) == (404, "sensor not found")
    assert (anonymous.status_code, anonymous.json()["detail"]) == (401, "authentication required")
