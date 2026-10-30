"""取り込みの照合のキャッシュ（app/ingest_cache.py）のテスト。"""

import httpx
import pytest
import sqlalchemy as sa
from sqlmodel.ext.asyncio.session import AsyncSession

from app import device_keys, ingest_cache
from app.config import settings
from app.db.session import engine

HEADERS = {"X-API-Key": settings.ingest_api_key}
DISABLE = "UPDATE sensors SET enabled = false WHERE ingest_key = '{key}'"


async def _sensor(client: httpx.AsyncClient, key: str) -> str:
    body = {"name": f"c-{key}", "ingestKey": key, "unit": "V"}
    resp = await client.post("/api/sensors", json=body)
    assert resp.status_code == 201
    return str(resp.json()["id"])


async def _send(client: httpx.AsyncClient, key: str) -> int:
    resp = await client.post(
        "/api/ingest/readings", headers=HEADERS, json={"ingestKey": key, "value": 1}
    )
    return resp.status_code


async def test_change_made_outside_the_api_is_seen_after_the_cache_expires(
    client: httpx.AsyncClient,
) -> None:
    """DB を直接変えた場合（別プロセス・CLI）は、覚えている間は古い結果、期限後に反映される。"""
    await _sensor(client, "cache-a")
    assert await _send(client, "cache-a") == 202            # 覚える
    async with engine.begin() as conn:
        await conn.execute(sa.text(DISABLE.format(key="cache-a")))
    assert await _send(client, "cache-a") == 202            # 覚えている間は、まだ通る
    ingest_cache.clear()                                    # 期限が切れた状態
    assert await _send(client, "cache-a") == 403


async def test_change_through_the_api_is_seen_immediately(client: httpx.AsyncClient) -> None:
    sensor_id = await _sensor(client, "cache-b")
    assert await _send(client, "cache-b") == 202
    resp = await client.put(f"/api/sensors/{sensor_id}", json={"enabled": False})
    assert resp.status_code == 200
    assert await _send(client, "cache-b") == 403            # 同じプロセスの変更は、すぐ反映
    resp = await client.delete(f"/api/sensors/{sensor_id}")
    assert resp.status_code == 204
    assert await _send(client, "cache-b") == 404


async def test_cache_can_be_turned_off(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_cache_seconds", 0)
    await _sensor(client, "cache-c")
    assert await _send(client, "cache-c") == 202
    async with engine.begin() as conn:
        await conn.execute(sa.text(DISABLE.format(key="cache-c")))
    assert await _send(client, "cache-c") == 403            # 覚えないので、すぐ反映


async def test_unknown_sensor_is_not_remembered(client: httpx.AsyncClient) -> None:
    """未登録の結果は覚えない。作った直後に、古い「無い」が返らない。"""
    assert await _send(client, "cache-d") == 404
    await _sensor(client, "cache-d")
    assert await _send(client, "cache-d") == 202


async def test_revoked_device_key_stops_working_in_this_process(
    client: httpx.AsyncClient,
) -> None:
    await _sensor(client, "cache-e")
    async with AsyncSession(engine) as session:
        key = await device_keys.create_device(session, "cache-dev")
        device = await device_keys.get_device_by_name(session, "cache-dev")
        assert device is not None
        await device_keys.attach_sensors(session, device, ["cache-e"])
        body = {"ingestKey": "cache-e", "value": 1}
        ok = await client.post("/api/ingest/readings", headers={"X-Device-Key": key}, json=body)
        assert ok.status_code == 202                         # 覚える
        await device_keys.revoke_device(session, device)     # 同じプロセスの失効は、すぐ反映
    bad = await client.post("/api/ingest/readings", headers={"X-Device-Key": key}, json=body)
    assert bad.status_code == 401


async def test_wrong_device_key_is_not_remembered(client: httpx.AsyncClient) -> None:
    await _sensor(client, "cache-f")
    body = {"ingestKey": "cache-f", "value": 1}
    first = await client.post("/api/ingest/readings", headers={"X-Device-Key": "nope"}, json=body)
    assert first.status_code == 401
    async with AsyncSession(engine) as session:
        key = await device_keys.create_device(session, "cache-dev-2")
        device = await device_keys.get_device_by_name(session, "cache-dev-2")
        assert device is not None
        await device_keys.attach_sensors(session, device, ["cache-f"])
    ok = await client.post("/api/ingest/readings", headers={"X-Device-Key": key}, json=body)
    assert ok.status_code == 202


def test_cache_is_bounded() -> None:
    from uuid import uuid4

    ingest_cache.clear()
    for i in range(ingest_cache.MAX_ENTRIES + 5):
        ingest_cache.put_sensor(f"k{i}", ingest_cache.SensorInfo(uuid4(), True, None))
    assert len(ingest_cache._sensors) <= ingest_cache.MAX_ENTRIES
