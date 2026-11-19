"""古い測定値を 1 分ごとにまとめる処理（app/rollup.py）と、生＋まとめを合わせる読み出しのテスト。

見るのは「まとめる前と後で、グラフ・集計・最新の値が同じ数字になること」。
時刻は固定（NOW）にして、まとめる処理にも now として渡す（今の時刻に左右されない）。
"""
import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import rollup as rollup_module
from app.db.models import Reading, ReadingRollup, Sensor, User, Workspace
from app.db.session import engine
from app.readings_query import merge_bucket_rows
from app.rollup import rollup_cutoff, rollup_old_readings

NOW = datetime(2026, 11, 19, 12, 0, 0, tzinfo=UTC)
# 7 日残す設定のときの、まとめる境目（NOW の 7 日前）
CUTOFF = datetime(2026, 11, 12, 12, 0, 0, tzinfo=UTC)


async def _create_sensor(workspace_id: UUID | None = None, name: str | None = None) -> UUID:
    async with AsyncSession(engine) as session:
        sensor = Sensor(
            workspace_id=workspace_id,
            name=name or f"s-{uuid4().hex[:6]}",
            ingest_key=uuid4().hex,
            unit="個",
        )
        session.add(sensor)
        sensor_id = sensor.id  # commit のあとは属性が読み直しになるので、先に取っておく
        await session.commit()
        return sensor_id


async def _add_readings(sensor_id: UUID, values: list[tuple[datetime, float]]) -> None:
    async with AsyncSession(engine) as session:
        session.add_all(
            [Reading(sensor_id=sensor_id, value=v, recorded_at=t) for t, v in values]
        )
        await session.commit()


async def _counts(sensor_id: UUID) -> tuple[int, int]:
    """(生の行の数, まとめた行の数)。"""
    async with AsyncSession(engine) as session:
        raw = (
            await session.exec(select(func.count(1)).where(Reading.sensor_id == sensor_id))
        ).one()
        rolled = (
            await session.exec(
                select(func.count(1)).where(ReadingRollup.sensor_id == sensor_id)
            )
        ).one()
    return raw, rolled


def _second_values(start: datetime, count: int, base: float = 0.0) -> list[tuple[datetime, float]]:
    """start から 1 秒おきに count 件。値は base, base+1, ...。"""
    return [(start + timedelta(seconds=i), base + i) for i in range(count)]


async def _api_snapshot(
    client: httpx.AsyncClient, sensor_id: UUID, from_: datetime, to: datetime
) -> dict[str, object]:
    """aggregate・downsampled・readings の答えを、比べやすい形にして返す。"""
    params = {"from": from_.isoformat(), "to": to.isoformat()}
    aggregate = (
        await client.get(f"/api/sensors/{sensor_id}/readings/aggregate", params=params)
    ).json()
    downsampled = (
        await client.get(
            f"/api/sensors/{sensor_id}/readings/downsampled", params={**params, "buckets": 4}
        )
    ).json()
    return {
        "sum": aggregate["sum"],
        "count": aggregate["count"],
        "buckets": [
            (b["start"], round(b["min"], 9), round(b["avg"], 9), round(b["max"], 9), b["count"])
            for b in downsampled["buckets"]
        ],
    }


# ── 純粋な関数 ────────────────────────────────────────────────

def test_cutoff_is_floored_to_the_minute() -> None:
    now = datetime(2026, 11, 19, 10, 15, 42, 500000, tzinfo=UTC)
    assert rollup_cutoff(now, 7) == datetime(2026, 11, 12, 10, 15, 0, tzinfo=UTC)


def test_merge_bucket_rows_uses_weighted_average() -> None:
    raw = [(0, 1.0, 3.0, 5.0, 2), (2, 4.0, 4.0, 4.0, 1)]
    rolled = [(0, 0.0, 8.0, 9.0, 2), (1, 7.0, 7.0, 7.0, 3)]
    assert merge_bucket_rows(raw, rolled) == [
        (0, 0.0, 5.5, 9.0, 4),
        (1, 7.0, 7.0, 7.0, 3),
        (2, 4.0, 4.0, 4.0, 1),
    ]


def test_merge_bucket_rows_without_rolled_rows_is_unchanged() -> None:
    raw = [(0, 1.0, 3.0, 5.0, 2)]
    assert merge_bucket_rows(raw, []) is raw


# ── まとめる処理 ──────────────────────────────────────────────

async def test_rollup_keeps_totals_min_max_count_and_last_value() -> None:
    sensor_id = await _create_sensor()
    # 14 日前の 10:00:00 から 150 秒（2.5 分）。値は 0〜149
    start = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(start, 150))

    result = await rollup_old_readings(7, now=NOW)

    assert result.deleted_rows == 150
    assert result.buckets == 3
    assert await _counts(sensor_id) == (0, 3)
    async with AsyncSession(engine) as session:
        rows = (
            await session.exec(
                select(ReadingRollup)
                .where(ReadingRollup.sensor_id == sensor_id)
                .order_by(ReadingRollup.bucket_start)  # type: ignore[arg-type]
            )
        ).all()
    first, second, third = rows
    assert (first.bucket_start, first.count, first.sum, first.min, first.max) == (
        start,
        60,
        sum(range(60)),
        0.0,
        59.0,
    )
    assert (first.last_value, first.last_at) == (59.0, start + timedelta(seconds=59))
    assert (second.count, second.min, second.max) == (60, 60.0, 119.0)
    assert (third.count, third.min, third.max, third.last_value) == (30, 120.0, 149.0, 149.0)


async def test_api_answers_are_the_same_before_and_after_rollup(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor()
    # 古い 3 分（まとめられる）と、新しい 2 分（生のまま）
    old_start = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    new_start = datetime(2026, 11, 18, 9, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(old_start, 180, base=10.0))
    await _add_readings(sensor_id, _second_values(new_start, 120, base=500.0))
    from_, to = datetime(2026, 11, 5, 0, 0, tzinfo=UTC), datetime(2026, 11, 19, 0, 0, tzinfo=UTC)

    before = await _api_snapshot(client, sensor_id, from_, to)
    await rollup_old_readings(7, now=NOW)
    after = await _api_snapshot(client, sensor_id, from_, to)

    assert await _counts(sensor_id) == (120, 3)
    assert after["sum"] == pytest.approx(before["sum"])  # type: ignore[arg-type]
    assert after["count"] == before["count"] == 300
    assert after["buckets"] == before["buckets"]


async def test_range_only_in_rolled_part_and_only_in_raw_part(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor()
    old_start = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    new_start = datetime(2026, 11, 18, 9, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(old_start, 120, base=1.0))
    await _add_readings(sensor_id, _second_values(new_start, 120, base=1.0))
    old_range = (datetime(2026, 11, 5, 0, 0, tzinfo=UTC), datetime(2026, 11, 6, 0, 0, tzinfo=UTC))
    new_range = (datetime(2026, 11, 18, 0, 0, tzinfo=UTC), datetime(2026, 11, 19, 0, 0, tzinfo=UTC))

    old_before = await _api_snapshot(client, sensor_id, *old_range)
    new_before = await _api_snapshot(client, sensor_id, *new_range)
    await rollup_old_readings(7, now=NOW)

    assert await _api_snapshot(client, sensor_id, *old_range) == old_before
    assert await _api_snapshot(client, sensor_id, *new_range) == new_before


async def test_rollup_is_idempotent_and_atomic_per_window(monkeypatch: pytest.MonkeyPatch) -> None:
    sensor_id = await _create_sensor()
    # 1 日以上離れた古い行が 2 組（1 日ごとの窓が 2 つになる）
    group_a = _second_values(datetime(2026, 11, 3, 23, 59, 0, tzinfo=UTC), 60, base=1.0)
    group_b = _second_values(datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC), 60, base=100.0)
    await _add_readings(sensor_id, group_a + group_b)
    total_before = sum(v for _, v in group_a + group_b)

    # 1 つ目の窓を終えたあと、2 つ目の窓の前で止める（休みの sleep で失敗させる）
    calls = {"n": 0}

    async def failing_sleep(_: float) -> None:
        calls["n"] += 1
        raise RuntimeError("途中で止まった")

    monkeypatch.setattr(rollup_module.asyncio, "sleep", failing_sleep)
    with pytest.raises(RuntimeError):
        await rollup_old_readings(7, now=NOW)
    monkeypatch.undo()

    # 止まった時点でも、生とまとめの合計は元のまま（二重にも欠けにもなっていない）
    async with AsyncSession(engine) as session:
        raw_sum, raw_n = (
            await session.exec(
                select(func.sum(Reading.value), func.count(1)).where(Reading.sensor_id == sensor_id)
            )
        ).one()
        rolled_sum, rolled_n = (
            await session.exec(
                select(func.sum(ReadingRollup.sum), func.sum(ReadingRollup.count)).where(
                    ReadingRollup.sensor_id == sensor_id
                )
            )
        ).one()
    assert float(raw_sum or 0) + float(rolled_sum or 0) == total_before
    assert (raw_n or 0) + (rolled_n or 0) == 120
    assert calls["n"] == 1 and (raw_n or 0) == 60  # 2 つ目の窓は、まだ生のまま

    # 続きを実行しても、もう一度実行しても、同じ結果
    await rollup_old_readings(7, now=NOW)
    first = await _counts(sensor_id)
    again = await rollup_old_readings(7, now=NOW)
    assert again.deleted_rows == 0
    assert await _counts(sensor_id) == first == (0, 2)  # 2 組とも 1 分ぶん


async def test_boundary_row_exactly_at_cutoff_stays_raw() -> None:
    sensor_id = await _create_sensor()
    await _add_readings(
        sensor_id,
        [
            (CUTOFF - timedelta(seconds=1), 1.0),  # 境目より 1 秒古い → まとめる
            (CUTOFF, 2.0),  # ちょうど境目 → 生のまま
            (CUTOFF + timedelta(seconds=1), 3.0),
        ],
    )

    await rollup_old_readings(7, now=NOW)

    assert await _counts(sensor_id) == (2, 1)


async def test_saas_sensors_are_not_rolled_up() -> None:
    from app.auth import hash_password

    async with AsyncSession(engine) as session:
        user = User(email=f"r-{uuid4().hex[:6]}@example.com", password_hash=hash_password("pw"))
        session.add(user)
        await session.flush()
        ws = Workspace(name="rollup-ws", owner_id=user.id)
        session.add(ws)
        workspace_id = ws.id
        await session.commit()
    saas_sensor = await _create_sensor(workspace_id=workspace_id)
    own_sensor = await _create_sensor()
    old = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    await _add_readings(saas_sensor, _second_values(old, 10))
    await _add_readings(own_sensor, _second_values(old, 10))

    await rollup_old_readings(7, now=NOW)

    assert await _counts(saas_sensor) == (10, 0)
    assert await _counts(own_sensor) == (0, 1)


async def test_zero_days_does_nothing() -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _second_values(datetime(2026, 11, 5, tzinfo=UTC), 10))

    result = await rollup_old_readings(0, now=NOW)

    assert (result.deleted_rows, result.buckets) == (0, 0)
    assert await _counts(sensor_id) == (10, 0)


async def test_default_setting_is_off() -> None:
    from app.config import settings

    assert settings.readings_rollup_days == 0


async def test_late_row_is_merged_into_existing_bucket() -> None:
    """まとめたあとに、同じ分の古い値が遅れて届いたら、次の実行でその分の行に足し込む。"""
    sensor_id = await _create_sensor()
    start = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, [(start, 10.0), (start + timedelta(seconds=30), 20.0)])
    await rollup_old_readings(7, now=NOW)
    await _add_readings(sensor_id, [(start + timedelta(seconds=45), 99.0)])  # 遅れて届いた

    await rollup_old_readings(7, now=NOW)

    assert await _counts(sensor_id) == (0, 1)
    async with AsyncSession(engine) as session:
        row = (
            await session.exec(select(ReadingRollup).where(ReadingRollup.sensor_id == sensor_id))
        ).one()
    assert (row.count, row.sum, row.min, row.max) == (3, 129.0, 10.0, 99.0)
    assert (row.last_value, row.last_at) == (99.0, start + timedelta(seconds=45))


# ── 読み出し ──────────────────────────────────────────────────

async def test_latest_falls_back_to_rolled_last_value(client: httpx.AsyncClient) -> None:
    """生の行が全部まとめられたセンサー（止まって 7 日以上）も、最後の値を返す。before つきも。"""
    sensor_id = await _create_sensor()
    start = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(start, 90, base=100.0))
    await rollup_old_readings(7, now=NOW)
    assert (await _counts(sensor_id))[0] == 0

    latest = (await client.get("/api/sensors/latest")).json()["readings"]
    assert [(r["sensorId"], r["value"]) for r in latest] == [(str(sensor_id), 189.0)]
    assert latest[0]["recordedAt"].startswith("2026-11-05T10:01:29")

    # 10:00 の分は 0〜59 秒（最後の値 159、時刻 10:00:59）、10:01 の分は 0〜29 秒（最後の値 189）
    async def latest_before(moment: str) -> list[float]:
        body = (await client.get("/api/sensors/latest", params={"before": moment})).json()
        return [r["value"] for r in body["readings"]]

    # before より後の値は返さない: 10:01:10 の時点では、10:01 の分の最後（10:01:29）は未来なので、
    # 1 つ前の 10:00 の分の最後の値（159）になる
    assert await latest_before("2026-11-05T10:01:10Z") == [159.0]
    assert await latest_before("2026-11-05T10:01:30Z") == [189.0]
    # 10:00 の分の最後（10:00:59）より前の時刻では、まだ値が無い
    assert await latest_before("2026-11-05T10:00:30Z") == []
    too_early = (
        await client.get("/api/sensors/latest", params={"before": "2026-11-05T09:00:00Z"})
    ).json()["readings"]
    assert too_early == []


async def test_latest_prefers_raw_rows(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _second_values(datetime(2026, 11, 5, 10, 0, tzinfo=UTC), 5))
    await _add_readings(sensor_id, [(datetime(2026, 11, 18, 9, 0, tzinfo=UTC), 777.0)])
    await rollup_old_readings(7, now=NOW)

    latest = (await client.get("/api/sensors/latest")).json()["readings"]

    assert [r["value"] for r in latest] == [777.0]


async def test_readings_history_continues_into_rolled_rows(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _second_values(datetime(2026, 11, 5, 10, 0, tzinfo=UTC), 120))
    new_start = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(new_start, 3, 500.0))
    await rollup_old_readings(7, now=NOW)

    body = (await client.get(f"/api/sensors/{sensor_id}/readings", params={"limit": 10})).json()

    values = [r["value"] for r in body["readings"]]
    # 新しい順: 生の 3 件、続けて 1 分ごとの平均（10:01 → 89.5、10:00 → 29.5）
    assert values == [502.0, 501.0, 500.0, 89.5, 29.5]
    limited = (await client.get(f"/api/sensors/{sensor_id}/readings", params={"limit": 4})).json()
    assert [r["value"] for r in limited["readings"]] == [502.0, 501.0, 500.0, 89.5]


async def test_aggregate_for_today_style_range(client: httpx.AsyncClient) -> None:
    """生産数の「本日累計」のように、分に揃った from でまとめた行を足す。"""
    sensor_id = await _create_sensor()
    day = datetime(2026, 11, 5, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, [(day + timedelta(hours=h), 1.0) for h in range(24)])
    before = (
        await client.get(
            f"/api/sensors/{sensor_id}/readings/aggregate", params={"from": day.isoformat()}
        )
    ).json()
    await rollup_old_readings(7, now=NOW)
    after = (
        await client.get(
            f"/api/sensors/{sensor_id}/readings/aggregate", params={"from": day.isoformat()}
        )
    ).json()
    assert before == after == {"sum": 24.0, "count": 24}


async def test_rollup_runs_without_blocking_event_loop_tasks() -> None:
    """まとめている間も、ほかの処理（取り込みなど）が進む（窓ごとに await で譲る）。"""
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _second_values(datetime(2026, 11, 5, 10, 0, tzinfo=UTC), 300))
    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    task = asyncio.create_task(ticker())
    await rollup_old_readings(7, now=NOW)
    task.cancel()
    assert ticks > 0


# ── データ移行（書き出し・取り込み） ──────────────────────────

async def test_migration_export_and_import_keep_rolled_rows(tmp_path: object) -> None:
    """まとめた行（1 分の行）も、書き出して取り込めば、そのまま戻る（履歴が消えない）。"""
    from sqlalchemy import text

    # 本番と同じく alembic_version を持つ状態にする（取り込みがスキーマ版を照合するため）
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"))
        await conn.execute(text("INSERT INTO alembic_version VALUES ('testrev')"))
    try:
        await _check_rolled_rows_survive_migration(Path(str(tmp_path)) / "export.jsonl.gz")
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE alembic_version"))


async def _check_rolled_rows_survive_migration(out: Path) -> None:
    from sqlalchemy import text

    from app.migrate_saas_to_oss import export_workspace, import_bundle

    sensor_id = await _create_sensor()
    start = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(start, 90, base=10.0))
    await rollup_old_readings(7, now=NOW)
    async with AsyncSession(engine) as session:
        expected = [
            (r.bucket_start, r.count, r.sum, r.min, r.max, r.last_value, r.last_at)
            for r in (
                await session.exec(select(ReadingRollup).order_by(ReadingRollup.bucket_start))  # type: ignore[arg-type]
            ).all()
        ]

    counts = await export_workspace(engine, None, out)
    assert counts["readings_rollup"] == 2
    # 取り込み先を空にして、取り込み直す
    async with engine.begin() as conn:
        for table in ("readings_rollup", "readings", "alarms", "widgets", "sensors"):
            await conn.execute(text(f"DELETE FROM {table}"))
    imported = await import_bundle(engine, out, dry_run=False, with_notifications=False)

    assert imported["readings_rollup"] == 2
    async with AsyncSession(engine) as session:
        restored = [
            (r.bucket_start, r.count, r.sum, r.min, r.max, r.last_value, r.last_at)
            for r in (
                await session.exec(select(ReadingRollup).order_by(ReadingRollup.bucket_start))  # type: ignore[arg-type]
            ).all()
        ]
    assert restored == expected


async def test_aggregate_with_range_end_in_the_middle_of_a_minute(
    client: httpx.AsyncClient,
) -> None:
    """to が分の途中のときは、その分の行（開始時刻が to 以前）を丸ごと足す（誤差は最大 1 分）。"""
    sensor_id = await _create_sensor()
    start = datetime(2026, 11, 5, 10, 0, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(start, 120, base=1.0))
    url = f"/api/sensors/{sensor_id}/readings/aggregate"
    mid = (start + timedelta(seconds=30)).isoformat()

    raw = (await client.get(url, params={"from": start.isoformat(), "to": mid})).json()
    assert raw["count"] == 31  # まとめる前は、秒まで正確
    await rollup_old_readings(7, now=NOW)
    rolled = (await client.get(url, params={"from": start.isoformat(), "to": mid})).json()

    assert rolled["count"] == 60  # 10:00 の分を丸ごと（誤差は 1 分以内）
    assert rolled["sum"] == pytest.approx(sum(range(1, 61)))
    # from が分の途中のときは、開始時刻が from 以後の分だけ（10:01 の分）
    after_mid = (await client.get(url, params={"from": mid})).json()
    assert after_mid["count"] == 60


@pytest.mark.parametrize("limit", [1, 2, 3, 4, 5, 6])
async def test_history_limit_is_cut_at_the_same_place_across_raw_and_rolled_rows(
    client: httpx.AsyncClient, limit: int
) -> None:
    """履歴の limit が、生の行とまとめた行の境目の前後でも、全体の先頭から limit 件になる。"""
    sensor_id = await _create_sensor()
    await _add_readings(sensor_id, _second_values(datetime(2026, 11, 5, 10, 0, tzinfo=UTC), 120))
    new_start = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)
    await _add_readings(sensor_id, _second_values(new_start, 3, 500.0))
    await rollup_old_readings(7, now=NOW)
    # 全体（新しい順）: 生 3 件 → 1 分の平均 2 件
    everything = [502.0, 501.0, 500.0, 89.5, 29.5]

    body = (
        await client.get(f"/api/sensors/{sensor_id}/readings", params={"limit": limit})
    ).json()

    assert [r["value"] for r in body["readings"]] == everything[:limit]


def test_next_run_time_is_19_utc_and_never_in_the_past() -> None:
    from app.rollup import next_run_time

    assert next_run_time(datetime(2026, 11, 19, 10, 0, tzinfo=UTC)) == datetime(
        2026, 11, 19, 19, 0, tzinfo=UTC
    )
    # ちょうど 19:00 なら、翌日（同じ時刻にもう一度走らない）
    assert next_run_time(datetime(2026, 11, 19, 19, 0, tzinfo=UTC)) == datetime(
        2026, 11, 20, 19, 0, tzinfo=UTC
    )
    assert next_run_time(datetime(2026, 11, 19, 23, 59, 59, tzinfo=UTC)) == datetime(
        2026, 11, 20, 19, 0, tzinfo=UTC
    )


async def test_import_rejects_an_older_export_format(tmp_path: Path) -> None:
    """形式の版 3（1 分にまとめた測定値の表を持たない書き出し）は、拒否する。"""
    import gzip
    import json

    from sqlalchemy import text

    from app.migrate_saas_to_oss import MigrationError, import_bundle

    path = tmp_path / "old-format.jsonl.gz"
    header = {
        "format": "factoreye-workspace-export",
        "version": 3,
        "workspace_id": None,
        "exported_at": "2026-11-18T00:00:00+00:00",
        "alembic_version": "testrev",
    }
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write(json.dumps(header) + "\n")
    async with engine.begin() as conn:
        await conn.execute(
            text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        )
        await conn.execute(text("INSERT INTO alembic_version VALUES ('testrev')"))
    try:
        with pytest.raises(MigrationError):
            await import_bundle(engine, path, dry_run=False, with_notifications=False)
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("DROP TABLE alembic_version"))


async def test_vacuum_full_gives_up_when_the_lock_cannot_be_taken(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """readings のロックが取れないときは、何も変えず、分かるメッセージで終わる（終了コード 1）。"""
    from sqlalchemy import text

    from app import rollup_cli

    monkeypatch.setattr(rollup_cli, "_VACUUM_LOCK_TIMEOUT", "200ms")
    async with engine.connect() as holder:
        await holder.execute(text("LOCK TABLE readings IN ACCESS EXCLUSIVE MODE"))
        code = await rollup_cli._vacuum_full()
        await holder.rollback()

    assert code == 1
    assert "ロックを 200ms 以内に取れませんでした" in capsys.readouterr().out
