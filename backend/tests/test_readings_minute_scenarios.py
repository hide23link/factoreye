"""間引き（1 分の集計 readings_minute ＋ 夜のまとめ readings_rollup）の、いろいろな場面の確認。

QA で追加。

test_minute_cache.py にない場面を足す: 1 秒ごと・複数センサー、範囲の端（6 時間・2 日・2 分の
境目ちょうど、分の途中、10 分未満）、欠測、未来の時刻、同じ分への複数回の遅れた取り込み、
印の無いセンサー・印が途中で消える、夜のまとめをまたぐ範囲（分の途中の端）、夜のまとめと
読み出しの同時実行、遅れた行がある状態での同時読み出し（小さいプール）、集計 API の速い道。

見るのは、どの場面でも「速い道（設定 7）の答え ＝ 従来の道（設定 0）の答え」であること。
件数・合計・最小・最大は完全に一致、平均は 1e-9 で比べる。
"""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession

from app import minute_cache, readings_query
from app.config import settings
from app.db.models import Sensor
from app.db.session import engine
from app.ingest_buffer import PendingReading, _insert_readings
from app.minute_cache import floor_minute, reset_cache, run_tick
from app.readings_query import downsample, sum_and_count
from app.rollup import rollup_old_readings

Totals = tuple[int, float, float, float]  # 件数・合計・最小・最大
Row = tuple[datetime, float, float, float, int]  # 区間の開始・最小・平均・最大・件数


@pytest.fixture
def now() -> datetime:
    return floor_minute(datetime.now(UTC))


@pytest.fixture(autouse=True)
def _cache_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    monkeypatch.setattr(minute_cache, "_PAUSE_SECONDS", 0.0)


async def _sensor() -> UUID:
    async with AsyncSession(engine) as session:
        sensor = Sensor(name=f"q-{uuid4().hex[:6]}", ingest_key=uuid4().hex, unit="℃")
        session.add(sensor)
        sensor_id = sensor.id
        await session.commit()
    return sensor_id


async def _seconds(
    sensor_id: UUID, start: datetime, end: datetime, step: int = 1, seed: int = 0
) -> None:
    """start 以上 end 未満を step 秒ごとに（SQL で一気に入れる）。値は秒から決まる。"""
    async with AsyncSession(engine) as session:
        await session.execute(
            text(
                """
                INSERT INTO readings (sensor_id, recorded_at, value)
                SELECT :s, t, ((extract(epoch FROM t)::bigint * 7 + :seed) % 101) - 50.5
                FROM generate_series(CAST(:a AS timestamptz),
                                     CAST(:b AS timestamptz) - interval '1 microsecond',
                                     make_interval(secs => :step)) AS t
                """
            ),
            {"s": sensor_id, "a": start, "b": end, "step": step, "seed": seed},
        )
        await session.commit()


async def _ingest(sensor_id: UUID, rows: list[tuple[datetime, float]]) -> None:
    """取り込みと同じ書き方（遅れて届いた行の記録もつく）。"""
    async with AsyncSession(engine) as session:
        await _insert_readings(
            session, [PendingReading(sensor_id=sensor_id, value=v, recorded_at=t) for t, v in rows]
        )
        await session.commit()


async def _graph(sensor_id: UUID, lo: datetime, hi: datetime, buckets: int) -> list[Row]:
    async with AsyncSession(engine) as session:
        result = await downsample(session, sensor_id, lo, hi, buckets)
    return [(b.start, b.min, round(b.avg, 9), b.max, b.count) for b in result.to_model().buckets]


async def _sum(sensor_id: UUID, lo: datetime, hi: datetime | None) -> tuple[float, int]:
    async with AsyncSession(engine) as session:
        total, count = await sum_and_count(session, sensor_id, lo, hi)
    return round(total, 6), count


async def _both(monkeypatch: pytest.MonkeyPatch, reader, *args):  # type: ignore[no-untyped-def]
    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    fast = await reader(*args)
    monkeypatch.setattr(settings, "readings_rollup_days", 0)
    legacy = await reader(*args)
    monkeypatch.setattr(settings, "readings_rollup_days", 7)
    return fast, legacy


def _totals(buckets: list[Row]) -> Totals:
    count = sum(b[4] for b in buckets)
    total = round(sum(b[2] * b[4] for b in buckets), 4)
    return count, total, min(b[1] for b in buckets), max(b[3] for b in buckets)


async def _assert_same(
    monkeypatch: pytest.MonkeyPatch, sensor_id: UUID, lo: datetime, hi: datetime, buckets: int
) -> None:
    """グラフは、全体の件数・合計・最小・最大が一致する。

    区間の境目が分の途中なら、区間ごとは最大 1 分ずれる。合計・件数 API は完全一致。
    """
    fast, legacy = await _both(monkeypatch, _graph, sensor_id, lo, hi, buckets)
    assert _totals(fast) == _totals(legacy), (lo, hi, buckets)
    width = (hi - lo).total_seconds() / buckets
    if lo == floor_minute(lo) and width % 60 == 0:
        assert fast == legacy  # 境目がすべて分の境目なら、区間ごとに完全一致
    sums = await _both(monkeypatch, _sum, sensor_id, lo, hi)
    assert sums[0] == sums[1], (lo, hi)


# ── 1 秒ごと・複数センサー ────────────────────────────────────────


@pytest.mark.asyncio
async def test_one_second_data_multiple_sensors(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    sensors = [await _sensor() for _ in range(3)]
    for i, s in enumerate(sensors):
        await _seconds(s, now - timedelta(days=3), now + timedelta(seconds=30), seed=i * 13)
    await run_tick(now)
    for s in sensors:
        await _assert_same(monkeypatch, s, now - timedelta(days=2, hours=23), now, 300)
        # 他のセンサーの行が混ざらない（件数は 1 秒ごとの数そのもの）
        assert (await _sum(s, now - timedelta(days=2), now))[1] == 2 * 86400 + 1


# ── 範囲の端 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_range_edges(monkeypatch: pytest.MonkeyPatch, now: datetime) -> None:
    s = await _sensor()
    await _seconds(s, now - timedelta(days=3), now + timedelta(seconds=45))
    await run_tick(now)
    six = timedelta(hours=6)
    cases = [
        (now - six, now, 180),  # ちょうど 6 時間・区間 120 秒ちょうど（速い道の境目）
        (now - six + timedelta(seconds=1), now, 180),  # 6 時間に 1 秒足りない（従来の道）
        (now - six, now, 181),  # 区間 119.3 秒（従来の道）
        (now - six - timedelta(seconds=29), now - timedelta(seconds=13), 7),  # 分の途中・途中
        (now - timedelta(hours=8, seconds=-1), now - timedelta(hours=1, seconds=1), 300),
        (now - timedelta(minutes=9, seconds=30), now, 10),  # 10 分未満
        (now - timedelta(days=2), now, 48),  # 2 日ちょうど（合計の速い道の境目）
        (now - timedelta(days=2) + timedelta(seconds=1), now, 48),  # 2 日に 1 秒足りない
        (now - timedelta(days=2, minutes=30, seconds=7), now + timedelta(seconds=40), 97),
    ]
    for lo, hi, buckets in cases:
        await _assert_same(monkeypatch, s, lo, hi, buckets)
    # 終わりなし（「今まで」）も一致
    for lo in (now - timedelta(days=2), now - timedelta(days=2, seconds=-1)):
        fast, legacy = await _both(monkeypatch, _sum, s, lo, None)
        assert fast == legacy


# ── 欠測・未来の時刻 ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gaps_and_future_rows(monkeypatch: pytest.MonkeyPatch, now: datetime) -> None:
    s = await _sensor()
    await _seconds(s, now - timedelta(days=3), now - timedelta(days=2))
    # 欠測 6 時間 37 分 13 秒、そのあと 5 秒ごと
    await _seconds(s, now - timedelta(hours=41, minutes=22, seconds=47), now, step=5)
    # 機器の時計が進んでいる（未来の時刻の行）
    await _seconds(s, now + timedelta(minutes=3), now + timedelta(minutes=50), step=2)
    await run_tick(now)
    await _assert_same(monkeypatch, s, now - timedelta(days=3), now + timedelta(hours=1), 120)
    await _assert_same(monkeypatch, s, now - timedelta(hours=50), now - timedelta(hours=42), 60)
    # 範囲がまるごと欠測の中・まるごと未来
    await _assert_same(monkeypatch, s, now - timedelta(hours=47), now - timedelta(hours=41), 30)
    await _assert_same(monkeypatch, s, now + timedelta(minutes=1), now + timedelta(hours=7), 30)
    # 時間がたって、未来だった分が「閉じた分」になっても同じ（集計に入る）
    later = now + timedelta(hours=1)
    await run_tick(later)
    await _assert_same(monkeypatch, s, now - timedelta(hours=7), later, 60)


# ── 遅れて届いた行 ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_late_rows_same_minute_many_times(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    s = await _sensor()
    await _seconds(s, now - timedelta(hours=30), now, step=10)
    await run_tick(now)
    minute = now - timedelta(hours=12)
    # 同じ分に 3 回（間に読み出しを挟む・挟まない）。時刻を戻した機器（時刻の飛び）を想定
    await _ingest(s, [(minute + timedelta(seconds=3), 900.0)])
    await _ingest(
        s, [(minute + timedelta(seconds=4), -900.0), (minute + timedelta(seconds=10), 1.5)]
    )
    await _assert_same(monkeypatch, s, now - timedelta(hours=24), now, 48)
    await _ingest(s, [(minute + timedelta(seconds=5), 950.0)])
    await _ingest(s, [(minute + timedelta(seconds=5), 960.0)])  # 同じ時刻の上書き
    await _assert_same(monkeypatch, s, now - timedelta(hours=24), now, 48)
    graph = await _graph(s, now - timedelta(hours=24), now, 48)
    assert max(b[3] for b in graph) == 960.0 and min(b[1] for b in graph) == -900.0


# ── 印 ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_new_sensor_without_state_then_with_empty_state(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    s = await _sensor()
    await _seconds(s, now - timedelta(days=2, hours=3), now)
    # 印が無い（常駐処理がまだ回っていない）→ 従来の道
    await _assert_same(monkeypatch, s, now - timedelta(days=2), now, 96)
    # 印だけある（finalized = built、集計 0 行）→ 速い道の「h 以後」だけで答える
    await minute_cache.create_missing_states(now)
    await _assert_same(monkeypatch, s, now - timedelta(days=2), now, 96)


@pytest.mark.asyncio
async def test_state_disappears_between_check_and_read(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """速い道を選んだ後（commit の後）に印が消えても、従来の道で正しく答える。"""
    s = await _sensor()
    await _seconds(s, now - timedelta(days=3), now, step=3)
    await run_tick(now)
    monkeypatch.setattr(settings, "readings_rollup_days", 0)
    expected_graph = await _graph(s, now - timedelta(days=2, hours=1), now, 50)
    expected_sum = await _sum(s, now - timedelta(days=2, hours=1), now)
    monkeypatch.setattr(settings, "readings_rollup_days", 7)

    real_settle = minute_cache.settle_dirty

    async def settle_then_reset(sensor_id: UUID) -> int:
        result = await real_settle(sensor_id)
        await reset_cache()  # 起動時の「設定 0 で空にする」や、手動の reset と重なった
        return result

    monkeypatch.setattr(readings_query, "settle_dirty", settle_then_reset)
    assert await _graph(s, now - timedelta(days=2, hours=1), now, 50) == expected_graph
    await run_tick(now)
    assert await _sum(s, now - timedelta(days=2, hours=1), now) == expected_sum


# ── 夜のまとめ ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_range_across_the_rollup_boundary_with_unaligned_edges(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    s = await _sensor()
    await _seconds(s, now - timedelta(days=9), now, step=2)
    await run_tick(now)
    before = await _sum(s, now - timedelta(days=9), None)
    await rollup_old_readings(7, now=now)
    after = await _sum(s, now - timedelta(days=9), None)
    assert before == after
    # まとめた側の端は 1 分の粒度。端を分の境目にして、まとめた側と生の側をまたぐ
    cut = floor_minute(now - timedelta(days=7))
    await _assert_same(monkeypatch, s, cut - timedelta(hours=5), cut + timedelta(hours=5), 60)
    await _assert_same(monkeypatch, s, cut - timedelta(days=1), now, 300)
    # 生の側の端（後ろ）が分の途中でも一致
    await _assert_same(
        monkeypatch, s, cut - timedelta(hours=3), now - timedelta(days=5, seconds=37), 100
    )


@pytest.mark.asyncio
async def test_reads_during_nightly_rollup_never_double_count(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """夜のまとめが動いている間に、速い道のグラフ・合計を読み続けても、答えが変わらない。"""
    s = await _sensor()
    await _seconds(s, now - timedelta(days=10), now, step=5)
    await run_tick(now)
    lo = now - timedelta(days=10)
    expected_sum = await _sum(s, lo, now)
    expected_total = _totals(await _graph(s, lo, now, 240))

    seen: list[tuple[tuple[float, int], Totals]] = []
    stop = asyncio.Event()

    async def reader() -> None:
        while not stop.is_set():
            seen.append((await _sum(s, lo, now), _totals(await _graph(s, lo, now, 240))))

    tasks = [asyncio.create_task(reader()) for _ in range(4)]
    await rollup_old_readings(7, now=now)
    await asyncio.sleep(0.2)
    stop.set()
    await asyncio.gather(*tasks)

    assert len(seen) >= 4
    for summed, totals in seen:
        assert summed == expected_sum
        assert totals == expected_total


class _RollupAfterFirstStatement(AsyncSession):
    """最初の SQL 文の直後に、夜のまとめを確定させる session（読み出しの途中で、まとめが入る）。

    生の行とまとめた行を 2 つの文で読むと、2 つ目の文はまとめた後の状態を見るので、
    同じ分を二重に数える（READ COMMITTED では、文ごとに別の時点を見る）。1 つの文なら、
    まとめる前の状態だけを見る。exec と execute の両方を差し替える（どちらで読んでも入る）。
    """

    rollup_now: datetime
    done = False

    async def _after_statement(self) -> None:
        if not self.done:
            self.done = True
            await rollup_old_readings(7, now=self.rollup_now)

    async def exec(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        result = await super().exec(*args, **kwargs)
        await self._after_statement()
        return result

    async def execute(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        result = await super().execute(*args, **kwargs)
        await self._after_statement()
        return result


async def _read_during_rollup(now: datetime, reader):  # type: ignore[no-untyped-def]
    async with _RollupAfterFirstStatement(engine) as session:
        session.rollup_now = now
        result = await reader(session)
        assert session.done  # まとめが、本当に読み出しの途中で入った
    return result


@pytest.mark.asyncio
async def test_legacy_path_during_nightly_rollup(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """従来の道（短い範囲）の合計・件数は、読み出しの途中で夜のまとめが入っても二重に数えない。"""
    s = await _sensor()
    await _seconds(s, now - timedelta(days=8), now, step=5)
    cut = floor_minute(now - timedelta(days=7))
    lo, hi = cut - timedelta(hours=1), cut + timedelta(hours=1)  # 2 時間 → 従来の道
    expected = await _sum(s, lo, hi)

    got = await _read_during_rollup(now, lambda session: sum_and_count(session, s, lo, hi))
    assert (round(got[0], 6), got[1]) == expected
    assert await _sum(s, lo, hi) == expected  # まとめた後も同じ


@pytest.mark.asyncio
async def test_legacy_graph_during_nightly_rollup(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """従来の道（短い範囲）のグラフは、読み出しの途中で夜のまとめが入っても二重に数えない。"""
    s = await _sensor()
    await _seconds(s, now - timedelta(days=8), now, step=5)
    cut = floor_minute(now - timedelta(days=7))
    lo, hi = cut - timedelta(hours=1), cut + timedelta(hours=1)  # 2 時間 → 従来の道
    expected = _totals(await _graph(s, lo, hi, 60))

    result = await _read_during_rollup(
        now, lambda session: readings_query.downsample(session, s, lo, hi, 60)
    )
    got = [(b.start, b.min, round(b.avg, 9), b.max, b.count) for b in result.to_model().buckets]
    assert _totals(got) == expected
    assert _totals(await _graph(s, lo, hi, 60)) == expected  # まとめた後も同じ


@pytest.mark.asyncio
async def test_recent_readings_during_nightly_rollup(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """履歴（生の行 → 足りなければまとめた行）は、読み出しの途中で夜のまとめが入っても、
    同じ分を生の行とまとめた行の両方から返さない。

    いちばん古い生の行が分の途中（7 秒）にあると、2 つの文で読んだとき、その分がまとめた行
    （開始時刻 = 分の頭で、生の行より前）としてもう一度入る。
    """
    s = await _sensor()
    cut = floor_minute(now - timedelta(days=7))
    lo, hi = cut - timedelta(hours=1), cut + timedelta(hours=1)
    await _seconds(s, lo + timedelta(seconds=7), hi, step=5)

    async def recent(session: AsyncSession) -> list[tuple[datetime, float]]:
        rows = await readings_query.recent_readings(session, s, lo, hi, 5000)
        return [(r.recorded_at, r.value) for r in rows]

    async with AsyncSession(engine) as session:
        expected = await recent(session)  # まとめる前（生の行だけ）
    got = await _read_during_rollup(now, recent)
    assert got == expected
    # まとめた後は、まとめた分が 1 分 1 件になる（重なりなし・新しい順）
    async with AsyncSession(engine) as session:
        after = await recent(session)
    times = [t for t, _ in after]
    assert times == sorted(times, reverse=True) and len(set(times)) == len(times)
    assert sum(1 for t in times if t < cut) == 60


# ── 接続プール ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_concurrent_reads_with_late_rows_and_a_small_pool(
    monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """遅れた行の記録があり、settle_dirty がセンサーのロックを取り合う状態でも、プール 2 本で
    12 本の同時読み出しが止まらず、全員が同じ答え。"""
    s = await _sensor()
    await _seconds(s, now - timedelta(days=3), now, step=10)
    await run_tick(now)
    await _ingest(s, [(now - timedelta(hours=20, seconds=-3), 400.0)])

    small = create_async_engine(settings.database_url, pool_size=2, max_overflow=0, pool_timeout=5)
    monkeypatch.setattr(minute_cache, "engine", small)

    async def read(i: int) -> tuple[str, float, float]:
        async with AsyncSession(small) as session:
            await session.get(Sensor, s)
            if i % 2:
                total, count = await sum_and_count(
                    session, s, now - timedelta(days=2, hours=1), now
                )
                return ("sum", round(total, 6), count)
            result = await downsample(session, s, now - timedelta(days=2, hours=1), now, 50)
            return (
                "graph",
                sum(b.count for b in result.to_model().buckets),
                max(b.max for b in result.to_model().buckets),
            )

    try:
        results = await asyncio.wait_for(asyncio.gather(*(read(i) for i in range(12))), 30)
    finally:
        await small.dispose()
    assert len({r for r in results if r[0] == "sum"}) == 1
    assert len({r for r in results if r[0] == "graph"}) == 1
    assert {r[2] for r in results if r[0] == "graph"} == {400.0}


@pytest.mark.asyncio
async def test_aggregate_api_uses_fast_path_without_expired_attribute_errors(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, now: datetime
) -> None:
    """集計 API（速い道・commit あり）が、期限切れのオブジェクトで失敗しない。"""
    s = await _sensor()
    await _seconds(s, now - timedelta(days=3), now, step=4)
    await run_tick(now)
    url = f"/api/sensors/{s}/readings/aggregate"
    params = {"from": (now - timedelta(days=2, hours=5)).isoformat(), "to": now.isoformat()}
    fast = await client.get(url, params=params)
    monkeypatch.setattr(settings, "readings_rollup_days", 0)
    legacy = await client.get(url, params=params)
    assert fast.status_code == legacy.status_code == 200
    assert fast.json()["count"] == legacy.json()["count"]
    assert fast.json()["sum"] == pytest.approx(legacy.json()["sum"], abs=1e-6)
