"""90日データ削除バッチ + Free Tier センサー上限のテスト。"""
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Reading, Sensor, User, Workspace
from app.db.session import engine
from app.purge import purge_old_readings


async def _create_sensor(session: AsyncSession, workspace_id=None) -> Sensor:
    sensor = Sensor(
        workspace_id=workspace_id,
        name=f"sensor-{uuid4().hex[:8]}",
        ingest_key=uuid4().hex,
        unit="count",
    )
    session.add(sensor)
    await session.flush()
    return sensor


async def _create_reading(session: AsyncSession, sensor_id, recorded_at: datetime) -> Reading:
    r = Reading(sensor_id=sensor_id, value=1.0, recorded_at=recorded_at)
    session.add(r)
    return r


# ── 90日削除バッチ ────────────────────────────────────────────

async def test_purge_deletes_old_multi_tenant_readings() -> None:
    """multi-tenant の 90日超えデータを削除する。"""
    async with AsyncSession(engine) as session:
        ws = Workspace(name="purge-ws", owner_id=uuid4())
        session.add(ws)
        await session.flush()

        sensor = await _create_sensor(session, workspace_id=ws.id)
        old = datetime.now(UTC) - timedelta(days=91)
        recent = datetime.now(UTC) - timedelta(days=10)

        await _create_reading(session, sensor.id, old)
        await _create_reading(session, sensor.id, recent)
        await session.commit()

    deleted = await purge_old_readings()
    assert deleted == 1

    async with AsyncSession(engine) as session:
        result = await session.exec(select(Reading).where(Reading.sensor_id == sensor.id))
        remaining = result.all()
    assert len(remaining) == 1
    assert remaining[0].recorded_at.replace(tzinfo=UTC) > datetime.now(UTC) - timedelta(days=30)


async def test_purge_skips_self_hosted_readings() -> None:
    """self-hosted（workspace_id=None）のデータは削除しない。"""
    async with AsyncSession(engine) as session:
        sensor = await _create_sensor(session, workspace_id=None)
        old = datetime.now(UTC) - timedelta(days=100)
        await _create_reading(session, sensor.id, old)
        await session.commit()

    deleted = await purge_old_readings()
    assert deleted == 0

    async with AsyncSession(engine) as session:
        result = await session.exec(select(Reading).where(Reading.sensor_id == sensor.id))
        assert len(result.all()) == 1


async def test_purge_returns_zero_when_nothing_to_delete() -> None:
    """削除対象がなければ 0 を返す。"""
    deleted = await purge_old_readings()
    assert deleted == 0


# ── Free Tier センサー上限（HTTP API） ────────────────────────

async def test_sensor_limit_enforced(client) -> None:  # type: ignore[no-untyped-def]
    """multi-tenant で 10個超えは 402 を返す。"""
    from app.config import AuthMode, settings
    from app.api import auth as auth_module
    import httpx
    from fastapi import FastAPI
    from httpx import ASGITransport

    original_mode = settings.auth_mode
    settings.auth_mode = AuthMode.MULTI_TENANT
    try:
        # 登録してトークン取得
        test_app = FastAPI()
        test_app.include_router(auth_module.router)
        from app.api import sensors as sensors_module
        test_app.include_router(sensors_module.router)

        async with httpx.AsyncClient(
            transport=ASGITransport(app=test_app), base_url="http://test"
        ) as c:
            reg = await c.post("/api/auth/register", json={
                "email": f"limit-{uuid4().hex[:6]}@example.com",
                "password": "password123",
                "workspaceName": "LimitWS",
            })
            assert reg.status_code == 201
            token = reg.json()["accessToken"]
            headers = {"Authorization": f"Bearer {token}"}

            # 10個まで作成
            for i in range(10):
                resp = await c.post("/api/sensors", json={
                    "name": f"sensor-limit-{i}",
                    "ingestKey": f"key-limit-{i}",
                    "unit": "count",
                }, headers=headers)
                assert resp.status_code == 201, f"sensor {i}: {resp.json()}"

            # 11個目は 402
            resp = await c.post("/api/sensors", json={
                "name": "sensor-over-limit",
                "ingestKey": "key-over-limit",
                "unit": "count",
            }, headers=headers)
            assert resp.status_code == 402
    finally:
        settings.auth_mode = original_mode
