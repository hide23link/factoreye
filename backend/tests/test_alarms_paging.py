"""アラーム一覧のページング（limit / offset）と total のテスト。"""
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Alarm, AlarmStatus, MinMax
from app.db.session import engine

BASE_TIME = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


async def _create_sensor(client: httpx.AsyncClient, key: str) -> UUID:
    resp = await client.post(
        "/api/sensors",
        json={"name": f"sensor-{key}", "ingestKey": key, "unit": "C"},
    )
    assert resp.status_code == 201
    return UUID(resp.json()["id"])


async def _add_alarms(
    sensor_id: UUID,
    count: int,
    *,
    status: AlarmStatus = AlarmStatus.ACTIVE,
    same_time: bool = False,
    start: int = 0,
) -> list[UUID]:
    """triggered_at が古い順に並ぶように作る（same_time のときは全部同じ時刻）。"""
    ids: list[UUID] = []
    async with AsyncSession(engine) as session:
        for i in range(count):
            offset = 0 if same_time else start + i
            alarm = Alarm(
                sensor_id=sensor_id,
                triggered_at=BASE_TIME + timedelta(minutes=offset),
                value=50.0,
                status=status,
                threshold_breached=MinMax.MAX,
            )
            session.add(alarm)
            ids.append(alarm.id)
        await session.commit()
    return ids


async def test_without_limit_returns_all_and_total_matches(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "paging-all")
    await _add_alarms(sensor_id, 5)

    resp = await client.get("/api/alarms")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["alarms"]) == 5
    assert body["total"] == 5


async def test_limit_returns_newest_first_and_total_is_full_count(
    client: httpx.AsyncClient,
) -> None:
    sensor_id = await _create_sensor(client, "paging-limit")
    ids = await _add_alarms(sensor_id, 5)

    resp = await client.get("/api/alarms", params={"limit": 2})
    body = resp.json()
    assert [a["id"] for a in body["alarms"]] == [str(ids[4]), str(ids[3])]
    assert body["total"] == 5


async def test_offset_pages_do_not_overlap_and_cover_everything(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "paging-offset")
    await _add_alarms(sensor_id, 5)

    seen: list[str] = []
    for offset in (0, 2, 4):
        resp = await client.get("/api/alarms", params={"limit": 2, "offset": offset})
        seen += [a["id"] for a in resp.json()["alarms"]]
    assert len(seen) == 5
    assert len(set(seen)) == 5


async def test_same_timestamp_pages_are_stable_by_id(client: httpx.AsyncClient) -> None:
    """同じ時刻のアラームが並び替わって、ページの境界で重複・抜けが出ないこと（id で並べる）。"""
    sensor_id = await _create_sensor(client, "paging-tie")
    await _add_alarms(sensor_id, 4, same_time=True)

    seen: list[str] = []
    for offset in (0, 2):
        resp = await client.get("/api/alarms", params={"limit": 2, "offset": offset})
        seen += [a["id"] for a in resp.json()["alarms"]]
    assert len(set(seen)) == 4


async def test_status_filter_applies_before_paging(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "paging-status")
    await _add_alarms(sensor_id, 3, status=AlarmStatus.ACTIVE)
    await _add_alarms(sensor_id, 4, status=AlarmStatus.ACKNOWLEDGED, start=10)

    resp = await client.get("/api/alarms", params={"status": "acknowledged", "limit": 2})
    body = resp.json()
    assert len(body["alarms"]) == 2
    assert all(a["status"] == "acknowledged" for a in body["alarms"])
    assert body["total"] == 4


async def test_out_of_range_limit_is_rejected(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/alarms", params={"limit": 0})).status_code == 422
    assert (await client.get("/api/alarms", params={"limit": 501})).status_code == 422
    assert (await client.get("/api/alarms", params={"offset": -1})).status_code == 422
