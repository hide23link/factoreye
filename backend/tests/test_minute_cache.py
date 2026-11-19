"""直近の測定値の 1 分の集計（app/minute_cache.py）と、それを使う読み出しのテスト。

見るのは「1 分の集計を使った答え（速い道）が、生の行から直接数えた答え（従来の道）と同じこと」。
従来の道は、設定 READINGS_ROLLUP_DAYS を 0 にして呼ぶと使われる（同じ関数・同じ DB で比べられる）。
時刻は、テストを始めた時点の「今」（分に切り捨て）を基準にする（取り込みの「遅れて届いた」の判定が
実際の時計を使うため）。
"""
from datetime import UTC, datetime, timedelta
from typing import NamedTuple
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func, text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import minute_cache
from app.auth import hash_password
from app.config import settings
from app.db.models import Reading, ReadingMinute, ReadingMinuteState, Sensor, User, Workspace
from app.db.session import engine
from app.ingest_buffer import PendingReading, _insert_readings
from app.minute_cache import (
    build_window,
    create_missing_states,
    floor_minute,
    load_state,
    mark_late_rows,
    reset_cache,
    run_tick,
    settle_dirty,
    settled_horizon,
    top_up_current,
)
from app.readings_query import _ceil_minute, downsample, sum_and_count
from app.rollup import rollup_old_readings


class Bucket(NamedTuple):
    """グラフの区間 1 つ（比べやすい形。平均は丸めて比べる）。"""

    start: datetime
    min: float
    avg: float
    max: float
    cnt: int  # tuple.count と名前がぶつからないよう cnt


@pytest.fixture
def now() -> datetime:
    """このテストの「今」（分に切り捨て）。"""
    return floor_minute(datetime.now(UTC))


@pytest.fixture
def minute_cache_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """READINGS_ROLLUP_DAYS = 7（1 分の集計を使う設定）。"""
    monkeypatch.setattr(settings, "readings_rollup_days", 7)


@pytest.fixture(autouse=True)
def _no_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    """1 日分ごとの休みを 0 にする（テストを速くする）。"""
    monkeypatch.setattr(minute_cache, "_PAUSE_SECONDS", 0.0)


async def _create_sensor(workspace_id: UUID | None = None) -> UUID:
    async with AsyncSession(engine) as session:
        sensor = Sensor(
            workspace_id=workspace_id,
            name=f"s-{uuid4().hex[:6]}",
            ingest_key=uuid4().hex,
            unit="個",
        )
        session.add(sensor)
        sensor_id = sensor.id
        await session.commit()
        return sensor_id


async def _add_readings(sensor_id: UUID, values: list[tuple[datetime, float]]) -> None:
    async with AsyncSession(engine) as session:
        session.add_all([Reading(sensor_id=sensor_id, value=v, recorded_at=t) for t, v in values])
        await session.commit()


def _series(start: datetime, end: datetime, step_seconds: int) -> list[tuple[datetime, float]]:
    """start 以上 end 未満を、step_seconds ごとに。値は時刻から決まる（97 通りの繰り返し）。"""
    count = int((end - start).total_seconds() // step_seconds)
    return [
        (start + timedelta(seconds=i * step_seconds), float((i * 7) % 97) - 40.0)
        for i in range(count)
    ]


async def _fast_and_legacy_buckets(
    monkeypatch: pytest.MonkeyPatch, sensor_id: UUID, lo: datetime, hi: datetime, buckets: int
) -> tuple[list[Bucket], list[Bucket]]:
    """同じ範囲を、速い道（設定 7）と従来の道（設定 0）で読み、比べやすい形で返す。"""

    async def read() -> list[Bucket]:
        async with AsyncSession(engine) as session:
            result = await downsample(session, sensor_id, lo, hi, buckets)
        return [Bucket(b.start, b.min, round(b.avg, 9), b.max, b.count) for b in result.buckets]

    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    fast = await read()
    monkeypatch.setattr(settings, "readings_rollup_days", 0)
    legacy = await read()
    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    return fast, legacy


async def _fast_and_legacy_sum(
    monkeypatch: pytest.MonkeyPatch, sensor_id: UUID, lo: datetime, hi: datetime | None
) -> tuple[tuple[float, int], tuple[float, int]]:
    async def read() -> tuple[float, int]:
        async with AsyncSession(engine) as session:
            total, count = await sum_and_count(session, sensor_id, lo, hi)
        return round(total, 6), count

    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    fast = await read()
    monkeypatch.setattr(settings, "readings_rollup_days", 0)
    legacy = await read()
    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    return fast, legacy


async def _minute_rows(sensor_id: UUID) -> int:
    async with AsyncSession(engine) as session:
        return (
            await session.exec(select(func.count(1)).where(ReadingMinute.sensor_id == sensor_id))
        ).one()


async def _dirty_rows(sensor_id: UUID) -> list[datetime]:
    async with AsyncSession(engine) as session:
        rows = (
            await session.execute(
                text(
                    "SELECT bucket_start FROM readings_dirty_minutes "
                    "WHERE sensor_id = :s ORDER BY bucket_start"
                ),
                {"s": sensor_id},
            )
        ).all()
    return [row.bucket_start for row in rows]


async def _write_like_ingest(sensor_id: UUID, values: list[tuple[datetime, float]]) -> None:
    """取り込みと同じ書き方（_insert_readings。遅れて届いた行の記録も、ここで付く）で書く。"""
    async with AsyncSession(engine) as session:
        await _insert_readings(
            session,
            [PendingReading(sensor_id=sensor_id, value=v, recorded_at=t) for t, v in values],
        )
        await session.commit()


# ── 純粋な関数 ────────────────────────────────────────────────


def test_settled_horizon_waits_for_the_buffer_lag() -> None:
    assert settled_horizon(datetime(2026, 11, 19, 12, 0, 5, tzinfo=UTC)) == datetime(
        2026, 11, 19, 11, 59, 0, tzinfo=UTC
    )
    assert settled_horizon(datetime(2026, 11, 19, 12, 0, 15, tzinfo=UTC)) == datetime(
        2026, 11, 19, 12, 0, 0, tzinfo=UTC
    )


def test_ceil_minute() -> None:
    assert _ceil_minute(datetime(2026, 11, 19, 10, 15, 42, tzinfo=UTC)) == datetime(
        2026, 11, 19, 10, 16, 0, tzinfo=UTC
    )
    boundary = datetime(2026, 11, 19, 10, 15, 0, tzinfo=UTC)
    assert _ceil_minute(boundary) == boundary


# ── 作る ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_first_tick_builds_state_and_minute_rows(now: datetime) -> None:
    sensor_id = await _create_sensor()
    start = now - timedelta(days=3, seconds=-17)
    await _add_readings(sensor_id, _series(start, now, 5))

    result = await run_tick(now)

    assert result.new_states == 1
    async with AsyncSession(engine) as session:
        state = await load_state(session, sensor_id)
    assert state is not None
    assert state.finalized_until == floor_minute(start)
    assert state.built_until == settled_horizon(now)
    # 3 日分の閉じた分（4,320 分ほど）が、1 行ずつ
    assert abs(await _minute_rows(sensor_id) - 3 * 1440) <= 2


@pytest.mark.asyncio
async def test_tick_is_idempotent(now: datetime) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=5), now, 10))
    await run_tick(now)
    first = await _minute_rows(sensor_id)

    again = await run_tick(now)

    assert again.new_states == 0
    assert await _minute_rows(sensor_id) == first


@pytest.mark.asyncio
async def test_saas_sensors_get_no_state(now: datetime) -> None:
    async with AsyncSession(engine) as session:
        user = User(email=f"m-{uuid4().hex[:6]}@example.com", password_hash=hash_password("pw"))
        session.add(user)
        await session.flush()
        workspace = Workspace(name="w", owner_id=user.id)
        session.add(workspace)
        workspace_id = workspace.id
        await session.commit()
    saas_sensor = await _create_sensor(workspace_id)
    await _add_readings(saas_sensor, _series(now - timedelta(hours=1), now, 10))

    assert await create_missing_states(now) == 0
    async with AsyncSession(engine) as session:
        assert await load_state(session, saas_sensor) is None


@pytest.mark.asyncio
async def test_top_up_advances_to_the_new_horizon(now: datetime) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(
        sensor_id, _series(now - timedelta(hours=3), now + timedelta(minutes=10), 10)
    )
    await run_tick(now)
    before = await _minute_rows(sensor_id)

    later = now + timedelta(minutes=5)
    assert await top_up_current(later) == 1

    async with AsyncSession(engine) as session:
        state = await load_state(session, sensor_id)
    assert state is not None and state.built_until == settled_horizon(later)
    assert await _minute_rows(sensor_id) == before + 5


# ── 読む: 速い道は、従来の道と同じ答え ──────────────────────────


@pytest.mark.asyncio
async def test_fast_downsample_matches_legacy(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=36), now, 5))
    await run_tick(now)

    # 区間の幅が 1 分の倍数で、範囲が分の境目なので、区間ごとに完全に一致する
    for lo, hi, buckets in [
        (now - timedelta(hours=30), now - timedelta(minutes=30), 30),  # 1 区間 59 分
        (now - timedelta(hours=30), now, 30),  # 終わりが「今」（作っていない分を含む）
        (now - timedelta(hours=12), now - timedelta(hours=2), 10),
    ]:
        fast, legacy = await _fast_and_legacy_buckets(monkeypatch, sensor_id, lo, hi, buckets)
        assert fast == legacy
        assert sum(b.cnt for b in fast) > 0


@pytest.mark.asyncio
async def test_fast_downsample_with_unaligned_range_has_the_same_totals(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=20), now, 7))
    await run_tick(now)
    lo = now - timedelta(hours=15, minutes=7, seconds=-23)
    hi = now - timedelta(minutes=40, seconds=-11)

    fast, legacy = await _fast_and_legacy_buckets(monkeypatch, sensor_id, lo, hi, 13)

    # 分の途中の区間の境目では、1 分の集計が 1 つの区間に入るので、区間ごとの件数は少しずれる。
    # 全体の件数・最小・最大・重みづけ平均は同じ
    assert sum(b.cnt for b in fast) == sum(b.cnt for b in legacy)
    assert min(b.min for b in fast) == min(b.min for b in legacy)
    assert max(b.max for b in fast) == max(b.max for b in legacy)
    fast_mean = sum(b.avg * b.cnt for b in fast) / sum(b.cnt for b in fast)
    legacy_mean = sum(b.avg * b.cnt for b in legacy) / sum(b.cnt for b in legacy)
    assert fast_mean == pytest.approx(legacy_mean, abs=1e-6)
    # ずれは、区間の境目の 1 分ぶん（7 秒ごとなら 9 件）だけ
    for fast_bucket, legacy_bucket in zip(fast, legacy, strict=True):
        assert abs(fast_bucket.cnt - legacy_bucket.cnt) <= 18


@pytest.mark.asyncio
async def test_fast_sum_and_count_is_exact_even_for_unaligned_edges(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=8), now, 3))
    await run_tick(now)

    for lo, hi in [
        (now - timedelta(hours=5, seconds=-17), now - timedelta(minutes=20, seconds=-41)),
        (now - timedelta(hours=1, seconds=-5), None),  # 「直近 1 時間」のように終わりが無い
        (now - timedelta(minutes=30), now),
    ]:
        fast, legacy = await _fast_and_legacy_sum(monkeypatch, sensor_id, lo, hi)
        assert fast == legacy
        assert fast[1] > 0


@pytest.mark.asyncio
async def test_short_ranges_use_the_legacy_path(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    """範囲が 10 分未満・区間が 2 分未満のときは、1 分の集計を読まない。"""
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=2), now, 10))
    await run_tick(now)
    async with AsyncSession(engine) as session:
        await session.execute(text("UPDATE readings_minute SET count = 999999"))
        await session.commit()

    fast, legacy = await _fast_and_legacy_buckets(
        monkeypatch, sensor_id, now - timedelta(minutes=60), now, 300  # 区間 12 秒
    )
    assert fast == legacy
    sums = await _fast_and_legacy_sum(monkeypatch, sensor_id, now - timedelta(minutes=5), now)
    assert sums[0] == sums[1]


@pytest.mark.asyncio
async def test_setting_zero_ignores_the_minute_cache(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=6), now, 10))
    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    await run_tick(now)
    async with AsyncSession(engine) as session:
        await session.execute(text("UPDATE readings_minute SET count = count + 1000"))
        await session.commit()

    lo, hi = now - timedelta(hours=5), now - timedelta(hours=1)
    fast, legacy = await _fast_and_legacy_buckets(monkeypatch, sensor_id, lo, hi, 4)

    # 設定 7 では集計を読み（壊した件数が出る）、設定 0 では読まない
    assert sum(b.cnt for b in fast) > sum(b.cnt for b in legacy)
    assert sum(b.cnt for b in legacy) == 4 * 360 + 1  # 範囲の両端を含む


@pytest.mark.asyncio
async def test_reads_are_correct_while_the_first_build_is_in_progress(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(days=3), now, 20))
    await create_missing_states(now)
    for _ in range(2):  # 3 日分のうち、2 日分だけ作った途中の状態
        assert await build_window(sensor_id, now) in (True, False)
        fast, legacy = await _fast_and_legacy_buckets(
            monkeypatch, sensor_id, now - timedelta(days=2, hours=12), now, 30
        )
        assert fast == legacy
    async with AsyncSession(engine) as session:
        state = await load_state(session, sensor_id)
    assert state is not None and state.built_until < settled_horizon(now)


# ── 遅れて届いた行 ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_normal_rows_are_not_marked_but_late_rows_are(
    now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    real_now = datetime.now(UTC)
    late_minute = floor_minute(real_now) - timedelta(minutes=5)  # 同じ分に 2 行（1 件にまとまる）
    async with AsyncSession(engine) as session:
        recorded = await mark_late_rows(
            session,
            [
                (sensor_id, real_now - timedelta(seconds=1)),  # 通常の行
                (sensor_id, late_minute + timedelta(seconds=10)),  # 遅れて届いた行
                (sensor_id, late_minute + timedelta(seconds=40)),
            ],
            real_now,
        )
        await session.commit()

    assert recorded == 1
    assert await _dirty_rows(sensor_id) == [late_minute]


@pytest.mark.asyncio
async def test_ingest_does_not_mark_when_the_setting_is_zero(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    monkeypatch.setattr(settings, "readings_rollup_days", 0)
    sensor_id = await _create_sensor()

    await _write_like_ingest(sensor_id, [(now - timedelta(hours=2), 1.0)])

    assert await _dirty_rows(sensor_id) == []


@pytest.mark.asyncio
async def test_late_and_overwritten_rows_are_reflected_before_reading(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    series = _series(now - timedelta(hours=8), now, 10)
    await _add_readings(sensor_id, series)
    await run_tick(now)

    # 閉じた分に、新しい行（遅れて届く）と、同じ時刻の上書き（値が変わる）を書く
    new_row = (now - timedelta(hours=3, seconds=-3), 500.0)  # 10 秒ごとの行の間
    overwritten = (series[1000][0], 1234.0)
    await _write_like_ingest(sensor_id, [new_row, overwritten])
    assert len(await _dirty_rows(sensor_id)) == 2

    lo, hi = now - timedelta(hours=7), now - timedelta(hours=1)
    fast, legacy = await _fast_and_legacy_buckets(monkeypatch, sensor_id, lo, hi, 6)

    assert fast == legacy
    assert max(b.max for b in fast) == 1234.0
    assert await _dirty_rows(sensor_id) == []  # 読む前に作り直して、記録を消した
    sums = await _fast_and_legacy_sum(monkeypatch, sensor_id, lo, hi)
    assert sums[0] == sums[1]


@pytest.mark.asyncio
async def test_settle_dirty_ignores_minutes_not_built_yet(
    now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=2), now, 10))
    await run_tick(now)
    future_minute = settled_horizon(now) + timedelta(minutes=5)
    async with AsyncSession(engine) as session:
        await session.execute(
            text("INSERT INTO readings_dirty_minutes VALUES (:s, :m)"),
            {"s": sensor_id, "m": future_minute},
        )
        await session.commit()

    assert await settle_dirty(sensor_id) == 0
    assert await _dirty_rows(sensor_id) == [future_minute]  # 作るときに、生の行から入るので残す


# ── 夜のまとめ（rollup.py）との関係 ─────────────────────────────


@pytest.mark.asyncio
async def test_nightly_rollup_moves_minutes_without_double_counting(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(days=10), now, 30))
    await run_tick(now)
    lo, hi = now - timedelta(days=10), now
    before_sum = await _fast_and_legacy_sum(monkeypatch, sensor_id, lo, None)
    before_buckets, _ = await _fast_and_legacy_buckets(monkeypatch, sensor_id, lo, hi, 10)
    minute_rows_before = await _minute_rows(sensor_id)

    result = await rollup_old_readings(7, now=now)

    assert result.deleted_rows > 0
    cutoff = floor_minute(now - timedelta(days=7))
    async with AsyncSession(engine) as session:
        state = await load_state(session, sensor_id)
        old_minutes = (
            await session.exec(
                select(func.count(1)).where(
                    ReadingMinute.sensor_id == sensor_id, ReadingMinute.bucket_start < cutoff
                )
            )
        ).one()
    assert state is not None and state.finalized_until == cutoff
    assert old_minutes == 0  # まとめた分の集計は、まとめた行に移って、ここには無い
    assert await _minute_rows(sensor_id) < minute_rows_before

    # まとめる前と、後で、答えが同じ（二重に数えない）
    after_sum = await _fast_and_legacy_sum(monkeypatch, sensor_id, lo, None)
    after_buckets, after_legacy = await _fast_and_legacy_buckets(monkeypatch, sensor_id, lo, hi, 10)
    assert after_sum[0] == before_sum[0] == after_sum[1]
    assert after_buckets == before_buckets == after_legacy

    # もう一度まとめても、集計をもう一度作っても、同じ
    await rollup_old_readings(7, now=now)
    await run_tick(now)
    again = await _fast_and_legacy_sum(monkeypatch, sensor_id, lo, None)
    assert again == after_sum


@pytest.mark.asyncio
async def test_late_row_older_than_the_finalized_boundary_is_counted_once(
    monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(days=9), now, 60))
    await run_tick(now)
    await rollup_old_readings(7, now=now)
    lo = now - timedelta(days=9)

    # 8 日前の分は、もう生の行が消えて、まとめた行になっている。そこへ遅れて行が届く
    late = (now - timedelta(days=8, seconds=-17), 777.0)
    await _write_like_ingest(sensor_id, [late])
    during = await _fast_and_legacy_sum(monkeypatch, sensor_id, lo, None)
    assert during[0] == during[1]  # まとめる前でも、速い道は「古い生の行」として数える

    assert await settle_dirty(sensor_id) == 0  # 作り直せない分の記録は、消すだけ
    assert await _dirty_rows(sensor_id) == []
    assert await _minute_rows_before(sensor_id, floor_minute(late[0])) == 0

    await rollup_old_readings(7, now=now)  # 次の夜のまとめで、まとめた行に足される
    after = await _fast_and_legacy_sum(monkeypatch, sensor_id, lo, None)
    assert after[0] == after[1] == during[0]


async def _minute_rows_before(sensor_id: UUID, minute: datetime) -> int:
    async with AsyncSession(engine) as session:
        return (
            await session.exec(
                select(func.count(1)).where(
                    ReadingMinute.sensor_id == sensor_id, ReadingMinute.bucket_start == minute
                )
            )
        ).one()


@pytest.mark.asyncio
async def test_rollup_does_not_touch_sensors_without_state(
    now: datetime, minute_cache_on: None
) -> None:
    """印の無いセンサー（1 分の集計をまだ作っていない）でも、夜のまとめは今までどおり動く。"""
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(days=9), now, 60))

    result = await rollup_old_readings(7, now=now)

    assert result.deleted_rows > 0
    async with AsyncSession(engine) as session:
        assert await load_state(session, sensor_id) is None


# ── 後始末・API ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reset_cache_empties_the_three_tables(now: datetime, minute_cache_on: None) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=2), now, 10))
    await run_tick(now)
    await _write_like_ingest(sensor_id, [(now - timedelta(hours=1, seconds=-3), 5.0)])
    assert await _minute_rows(sensor_id) > 0 and await _dirty_rows(sensor_id)

    await reset_cache()

    assert await _minute_rows(sensor_id) == 0
    assert await _dirty_rows(sensor_id) == []
    async with AsyncSession(engine) as session:
        states = await session.exec(select(func.count(1)).select_from(ReadingMinuteState))
        assert states.one() == 0


@pytest.mark.asyncio
async def test_downsampled_api_uses_the_fast_path(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, now: datetime, minute_cache_on: None
) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _series(now - timedelta(hours=30), now, 20))
    await run_tick(now)
    url = f"/api/sensors/{sensor_id}/readings/downsampled"
    params: dict[str, str | int] = {
        "from": (now - timedelta(hours=24)).isoformat(),
        "to": now.isoformat(),
        "buckets": 24,
    }

    fast = (await client.get(url, params=params)).json()
    monkeypatch.setattr(settings, "readings_rollup_days", 0)
    legacy = (await client.get(url, params=params)).json()

    assert fast == legacy
    assert sum(b["count"] for b in fast["buckets"]) == 24 * 3600 // 20
