"""POST /api/sensors/readings/downsampled（間引きの、複数センサーまとめ取得）のテスト。

見ること:
- 件ごとの結果が、単体の GET .../readings/downsampled と同じ（速い道・従来の道の両方）。
  avg だけは最後の桁の差を許す
  （足す順で変わりうる）。min・max・count・start・区間数・status は完全一致
- 上限（50 件）・空・他人のセンサー・存在しないセンサー・範囲の誤りの扱い
- 接続の持ち方: プールが 1 本だけでも止まらない（接続を持ったまま別の接続を取らない）
"""

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from app import minute_cache
from app.api.deps import get_current_workspace_id
from app.config import settings
from app.db import session as db_session
from app.db.models import Sensor, User, Workspace
from app.db.session import engine
from app.main import app
from app.minute_cache import floor_minute, run_tick

BATCH_URL = "/api/sensors/readings/downsampled"


@pytest.fixture
def now() -> datetime:
    return floor_minute(datetime.now(UTC))


@pytest.fixture(autouse=True)
def _cache_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    monkeypatch.setattr(minute_cache, "_PAUSE_SECONDS", 0.0)


async def _sensor(workspace_id: UUID | None = None) -> UUID:
    async with AsyncSession(engine) as session:
        sensor = Sensor(
            workspace_id=workspace_id, name=f"b-{uuid4().hex[:6]}", ingest_key=uuid4().hex, unit="℃"
        )
        session.add(sensor)
        sensor_id = sensor.id
        await session.commit()
    return sensor_id


async def _seconds(sensor_id: UUID, start: datetime, end: datetime, step: float, seed: int) -> None:
    """start 以上 end 未満を step 秒ごとに（SQL で一気に入れる）。
    実データに近づけるため、時刻はマイクロ秒つき（step が整数でない）、値は細かい小数にする。"""
    async with AsyncSession(engine) as session:
        await session.execute(
            text(
                """
                INSERT INTO readings (sensor_id, recorded_at, value)
                SELECT :s, t,
                       sin(extract(epoch FROM t) / 997.0 + :seed) * 37.123456789
                         + 20.0 + :seed * 0.37
                FROM generate_series(CAST(:a AS timestamptz),
                                     CAST(:b AS timestamptz) - interval '1 microsecond',
                                     make_interval(secs => :step)) AS t
                """
            ),
            {"s": sensor_id, "a": start, "b": end, "step": step, "seed": seed},
        )
        await session.commit()


def _item(sensor_id: UUID, lo: datetime, hi: datetime, buckets: int = 500) -> dict[str, Any]:
    return {
        "sensorId": str(sensor_id),
        "from": lo.isoformat(),
        "to": hi.isoformat(),
        "buckets": buckets,
    }


async def _single(client: httpx.AsyncClient, item: dict[str, Any]) -> dict[str, Any]:
    resp = await client.get(
        f"/api/sensors/{item['sensorId']}/readings/downsampled",
        params={"from": item["from"], "to": item["to"], "buckets": item["buckets"]},
    )
    assert resp.status_code == 200
    body: dict[str, Any] = resp.json()
    return body


def _assert_same_data(batch: dict[str, Any], single: dict[str, Any]) -> None:
    """まとめ取得の 1 件が、単体 API の結果と同じ。avg だけ最後の桁（相対 1e-12）の差を許す。

    avg は 合計 ÷ 件数。DB が足す順は計画で変わりうるので、最後の桁は保証しない。
    区間数・start・min・max・count・bucketSeconds は完全一致。
    """
    assert batch["bucketSeconds"] == single["bucketSeconds"]
    assert len(batch["buckets"]) == len(single["buckets"])
    for got, want in zip(batch["buckets"], single["buckets"], strict=True):
        assert (got["start"], got["min"], got["max"], got["count"]) == (
            want["start"],
            want["min"],
            want["max"],
            want["count"],
        )
        assert got["avg"] == pytest.approx(want["avg"], rel=1e-12)


async def _data_sensors(now: datetime, count: int = 4) -> list[UUID]:
    ids = [await _sensor() for _ in range(count)]
    for seed, sensor_id in enumerate(ids):
        await _seconds(sensor_id, now - timedelta(days=8), now, step=30.123457, seed=seed)
    await run_tick(now)
    async with AsyncSession(engine) as session:  # 速い道の印と 1 分の集計ができていること
        count_states = text("SELECT count(*) FROM readings_minute_state")
        count_minutes = text("SELECT count(*) FROM readings_minute")
        states = (await session.execute(count_states)).scalar()
        minutes = (await session.execute(count_minutes)).scalar()
    assert states == count
    assert minutes
    return ids


@pytest.mark.parametrize("rollup_days", [7, 0], ids=["fast-path", "legacy-path"])
async def test_each_result_equals_single_api(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, now: datetime, rollup_days: int
) -> None:
    """7 日・500 区間で、センサーごとに単体 API と同じ（avg は桁の差を許す）。"""
    ids = await _data_sensors(now)
    monkeypatch.setattr(settings, "readings_rollup_days", rollup_days)
    items = [_item(i, now - timedelta(days=7), now) for i in ids]
    # 短い範囲（従来の道）と、分の途中の端
    items.append(_item(ids[0], now - timedelta(hours=1), now + timedelta(minutes=3), 60))
    items.append(_item(ids[1], now - timedelta(days=2, minutes=7), now, 97))  # 分の途中の端

    resp = await client.post(BATCH_URL, json={"items": items})

    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == len(items)
    for item, result in zip(items, results, strict=True):
        assert result["sensorId"] == item["sensorId"]
        assert result["status"] == 200
        _assert_same_data(result["data"], await _single(client, item))
        assert result["data"]["buckets"], "空の結果どうしの比較になっていない"


async def test_same_item_twice_gives_same_result(client: httpx.AsyncClient, now: datetime) -> None:
    ids = await _data_sensors(now, 1)
    item = _item(ids[0], now - timedelta(days=7), now)

    resp = await client.post(BATCH_URL, json={"items": [item, item]})

    first, second = resp.json()["results"]
    assert first == second  # 同じ件は 1 回だけ計算して分け合うので、avg も含めて完全に同じ
    _assert_same_data(first["data"], await _single(client, item))


async def test_more_than_50_items_is_rejected(client: httpx.AsyncClient, now: datetime) -> None:
    sensor_id = await _sensor()
    item = _item(sensor_id, now - timedelta(hours=1), now)

    too_many = await client.post(BATCH_URL, json={"items": [item] * 51})
    limit = await client.post(BATCH_URL, json={"items": [item] * 50})
    empty = await client.post(BATCH_URL, json={"items": []})

    assert too_many.status_code == 422
    assert limit.status_code == 200
    assert empty.status_code == 422


async def test_invalid_buckets_is_rejected(client: httpx.AsyncClient, now: datetime) -> None:
    sensor_id = await _sensor()
    for buckets in (0, 1001):
        item = _item(sensor_id, now - timedelta(hours=1), now, buckets)
        assert (await client.post(BATCH_URL, json={"items": [item]})).status_code == 422


async def test_missing_sensor_and_bad_range_fail_only_that_item(
    client: httpx.AsyncClient, now: datetime
) -> None:
    """存在しないセンサー（404）・to が from 以前（400）は、その件だけ失敗。他の件は返す。"""
    ids = await _data_sensors(now, 1)
    good = _item(ids[0], now - timedelta(days=7), now)
    missing = _item(uuid4(), now - timedelta(days=7), now)
    backwards = _item(ids[0], now, now - timedelta(hours=1))

    resp = await client.post(BATCH_URL, json={"items": [missing, good, backwards]})

    assert resp.status_code == 200
    missing_result, good_result, backwards_result = resp.json()["results"]
    assert (missing_result["status"], missing_result["data"]) == (404, None)
    assert good_result["status"] == 200
    _assert_same_data(good_result["data"], await _single(client, good))
    assert (backwards_result["status"], backwards_result["data"]) == (400, None)
    # 単体 API も同じ番号
    single_missing = await client.get(
        f"/api/sensors/{missing['sensorId']}/readings/downsampled",
        params={"from": missing["from"], "to": missing["to"]},
    )
    single_backwards = await client.get(
        f"/api/sensors/{backwards['sensorId']}/readings/downsampled",
        params={"from": backwards["from"], "to": backwards["to"]},
    )
    assert (single_missing.status_code, single_backwards.status_code) == (404, 400)


@pytest.fixture
def as_workspace() -> Iterator[Any]:
    def _set(workspace_id: UUID | None) -> None:
        app.dependency_overrides[get_current_workspace_id] = lambda: workspace_id

    yield _set
    app.dependency_overrides.pop(get_current_workspace_id, None)


async def _workspace() -> UUID:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        user = User(email=f"{uuid4()}@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        workspace = Workspace(name="テスト用", owner_id=user.id)
        session.add(workspace)
        await session.commit()
        return workspace.id


async def test_other_workspace_sensor_is_404_like_missing(
    client: httpx.AsyncClient, as_workspace: Any, now: datetime
) -> None:
    """SaaS: 他人のセンサーは、存在しないセンサーと同じ 404。自分のものは返す。"""
    mine_ws, other_ws = await _workspace(), await _workspace()
    mine, theirs = await _sensor(mine_ws), await _sensor(other_ws)
    for seed, sensor_id in enumerate((mine, theirs)):
        await _seconds(sensor_id, now - timedelta(hours=3), now, step=20.654321, seed=seed)
    as_workspace(mine_ws)
    lo = now - timedelta(hours=2)
    items = [_item(mine, lo, now, 40), _item(theirs, lo, now, 40)]

    resp = await client.post(BATCH_URL, json={"items": items})

    own, foreign = resp.json()["results"]
    assert own["status"] == 200
    _assert_same_data(own["data"], await _single(client, items[0]))
    assert (foreign["status"], foreign["data"]) == (404, None)
    assert foreign["detail"] == "sensor not found"
    single_foreign = await client.get(
        f"/api/sensors/{theirs}/readings/downsampled",
        params={"from": items[1]["from"], "to": items[1]["to"]},
    )
    assert single_foreign.status_code == 404


async def test_batch_finishes_with_a_single_connection_pool(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """プールが 1 本だけでも、12 件のまとめ取得（速い道）が止まらず、同時の 3 リクエストも終わる。

    接続を持ったまま別の接続を取る形（#38）なら、1 本では必ず待ちで止まる（pool_timeout で失敗）。
    """
    ids = await _data_sensors(now, 12)
    expected = [await _single(client, _item(i, now - timedelta(days=7), now)) for i in ids]
    one = create_async_engine(settings.database_url, pool_size=1, max_overflow=0, pool_timeout=5)
    monkeypatch.setattr(db_session, "engine", one)
    monkeypatch.setattr(minute_cache, "engine", one)
    items = [_item(i, now - timedelta(days=7), now) for i in ids]

    try:
        responses = await asyncio.wait_for(
            asyncio.gather(*(client.post(BATCH_URL, json={"items": items}) for _ in range(3))), 60
        )
    finally:
        await one.dispose()

    for resp in responses:
        assert resp.status_code == 200
        for result, single in zip(resp.json()["results"], expected, strict=True):
            _assert_same_data(result["data"], single)


async def test_mixed_fast_and_legacy_sensors_match_single_api(
    client: httpx.AsyncClient, now: datetime
) -> None:
    """印のあるセンサー（速い道）と無いセンサー（従来の道）・測定値の無いセンサーが混ざっても、
    センサーごとに単体 API と同じ。遅れて届いた行（作り直しが要る）もある。"""
    with_state = await _data_sensors(now, 3)
    no_state = await _sensor()
    await _seconds(no_state, now - timedelta(days=8), now, step=30.123457, seed=9)  # 印は作らない
    empty = await _sensor()
    late_minute = now - timedelta(hours=20)
    async with AsyncSession(engine) as session:  # 遅れた行 + 記録（取り込みと同じ書き方）
        from app.ingest_buffer import PendingReading, _insert_readings

        await _insert_readings(
            session,
            [PendingReading(sensor_id=with_state[0], value=777.0, recorded_at=late_minute)],
        )
        await session.commit()
    items = [_item(i, now - timedelta(days=7), now) for i in [*with_state, no_state, empty]]

    resp = await client.post(BATCH_URL, json={"items": items})

    for item, result in zip(items, resp.json()["results"], strict=True):
        assert result["status"] == 200
        _assert_same_data(result["data"], await _single(client, item))
    assert any(b["max"] == 777.0 for b in resp.json()["results"][0]["data"]["buckets"])
    assert resp.json()["results"][-1]["data"]["buckets"] == []


async def test_sql_statements_do_not_grow_with_sensor_count(
    client: httpx.AsyncClient, now: datetime
) -> None:
    """12 センサー（速い道）のまとめ取得で出す SQL の数は、センサーの数に比例しない。"""
    from sqlalchemy import event

    ids = await _data_sensors(now, 12)
    items = [_item(i, now - timedelta(days=7), now) for i in ids]
    statements: list[str] = []

    def count(*args: Any) -> None:
        statements.append(str(args[2]))

    event.listen(engine.sync_engine, "before_cursor_execute", count)
    try:
        resp = await client.post(BATCH_URL, json={"items": items})
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", count)

    assert resp.status_code == 200
    reads = [s for s in statements if "readings" in s]
    assert len(reads) <= 3, reads  # センサー確認 1 + 印の確認 1 + 読み出し 1
