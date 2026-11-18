"""GET /api/sensors/latest（全センサーの最新の測定値を 1 件ずつ）のテスト。

全体監視の画面が使う。センサーごとに最新の 1 件だけ返すこと、受信の無いセンサーは含めないこと、
SaaS では自分のワークスペースのセンサーだけを返すことを確かめる。
"""
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest_asyncio
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import Sensor, User, Workspace
from app.db.session import engine
from app.ingest_buffer import PendingReading, buffer, flush_once
from app.main import app


async def _make_sensor(session: AsyncSession, workspace_id: UUID | None, name: str) -> UUID:
    sensor = Sensor(workspace_id=workspace_id, name=name, ingest_key=f"key-{uuid4()}", unit="C")
    session.add(sensor)
    await session.commit()
    return sensor.id


async def _make_workspace(session: AsyncSession) -> UUID:
    user = User(email=f"{uuid4()}@example.com", password_hash="x")
    session.add(user)
    await session.flush()
    workspace = Workspace(name="テスト用", owner_id=user.id)
    workspace_id = workspace.id  # コミット後は属性が期限切れになるため、先に取っておく
    session.add(workspace)
    await session.commit()
    return workspace_id


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSession(engine, expire_on_commit=False) as s:
        yield s


async def test_latest_returns_newest_reading_per_sensor(
    client: httpx.AsyncClient, session: AsyncSession
) -> None:
    first = await _make_sensor(session, None, "温度")
    second = await _make_sensor(session, None, "湿度")
    await _make_sensor(session, None, "まだ受信なし")
    now = datetime.now(UTC)
    earlier = now - timedelta(minutes=10)
    await buffer.add(PendingReading(sensor_id=first, value=20.0, recorded_at=earlier))
    await buffer.add(PendingReading(sensor_id=first, value=22.4, recorded_at=now))
    minute_ago = now - timedelta(minutes=1)
    await buffer.add(PendingReading(sensor_id=second, value=48.0, recorded_at=minute_ago))
    await flush_once()

    resp = await client.get("/api/sensors/latest")

    assert resp.status_code == 200
    body = resp.json()
    by_sensor = {item["sensorId"]: item for item in body["readings"]}
    # 受信の無いセンサーは含めない（2 件だけ）
    assert body["total"] == 2
    assert by_sensor[str(first)]["value"] == 22.4
    assert by_sensor[str(second)]["value"] == 48.0
    assert "recordedAt" in by_sensor[str(first)]


async def test_latest_before_returns_newest_reading_at_or_before_the_time(
    client: httpx.AsyncClient, session: AsyncSession
) -> None:
    """before を付けると、その時刻以前の最新（1 時間前の値）。それ以前が無いセンサーは含めない。"""
    sensor_id = await _make_sensor(session, None, "温度")
    only_new = await _make_sensor(session, None, "さっき始めた")
    now = datetime.now(UTC)
    for minutes_ago, value in [(70, 20.0), (50, 21.0)]:
        recorded_at = now - timedelta(minutes=minutes_ago)
        await buffer.add(PendingReading(sensor_id=sensor_id, value=value, recorded_at=recorded_at))
    await buffer.add(PendingReading(sensor_id=sensor_id, value=22.4, recorded_at=now))
    await buffer.add(PendingReading(sensor_id=only_new, value=5.0, recorded_at=now))
    await flush_once()

    hour_ago = (now - timedelta(hours=1)).isoformat()
    resp = await client.get("/api/sensors/latest", params={"before": hour_ago})

    assert resp.status_code == 200
    by_sensor = {item["sensorId"]: item for item in resp.json()["readings"]}
    assert by_sensor[str(sensor_id)]["value"] == 20.0
    assert str(only_new) not in by_sensor


async def test_latest_before_includes_a_reading_at_exactly_the_same_time(
    client: httpx.AsyncClient, session: AsyncSession
) -> None:
    """before とちょうど同じ時刻の測定値は含める（<=）。1 マイクロ秒後のものは含めない。"""
    sensor_id = await _make_sensor(session, None, "温度")
    boundary = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=1)
    await buffer.add(PendingReading(sensor_id=sensor_id, value=20.0, recorded_at=boundary))
    just_after = boundary + timedelta(microseconds=1)
    await buffer.add(PendingReading(sensor_id=sensor_id, value=99.0, recorded_at=just_after))
    await flush_once()

    resp = await client.get("/api/sensors/latest", params={"before": boundary.isoformat()})

    assert resp.status_code == 200
    readings = resp.json()["readings"]
    assert [item["value"] for item in readings] == [20.0]


async def test_latest_before_without_timezone_is_rejected(client: httpx.AsyncClient) -> None:
    """before は時刻帯つきだけ受ける（時刻帯が無いと、どの時刻か決まらないので 422）。"""
    resp = await client.get("/api/sensors/latest", params={"before": "2026-11-18T00:42:00"})

    assert resp.status_code == 422


async def test_latest_is_limited_to_own_workspace(
    client: httpx.AsyncClient, session: AsyncSession
) -> None:
    mine = await _make_workspace(session)
    other = await _make_workspace(session)
    my_sensor = await _make_sensor(session, mine, "自分の")
    other_sensor = await _make_sensor(session, other, "ほかの")
    now = datetime.now(UTC)
    await buffer.add(PendingReading(sensor_id=my_sensor, value=1.0, recorded_at=now))
    await buffer.add(PendingReading(sensor_id=other_sensor, value=2.0, recorded_at=now))
    await flush_once()

    app.dependency_overrides[get_current_workspace_id] = lambda: mine
    try:
        resp = await client.get("/api/sensors/latest")
    finally:
        app.dependency_overrides.pop(get_current_workspace_id, None)

    assert resp.status_code == 200
    assert [item["sensorId"] for item in resp.json()["readings"]] == [str(my_sensor)]
