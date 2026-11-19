"""古い 1 秒ごとの測定値を、1 分ごとにまとめる（OSS 版。設定 READINGS_ROLLUP_DAYS）。

1 秒ごとの測定値は、センサー 1 つで 1 日 8.6 万行ずつ増える。長い期間のグラフが遅くなるので、
設定した日数より古い分は、1 分ごとの「件数・合計・最小・最大・最後の値」（readings_rollup）に
まとめて、元の行を消す。グラフ・集計の API は、生の行とまとめた行を合わせて答えるので、
見た目と数字は変わらない（1 分より細かくは見えなくなる）。app/readings_query.py。

【やり方】センサーごとに、古い方から 1 日分ずつ「消した行を、そのままその場でまとめて足す」
1 つの SQL（DELETE ... RETURNING → 1 分ごとに集計 → INSERT ... ON CONFLICT で足し込む）を、
1 回のトランザクションで実行する。消した行と足した行が必ず同じになるので、途中で止まっても二重に
数えない（止まった所は何も起きていない）。何度実行しても、同じ結果になる（冪等）。
遅れて届いた古い測定値（INGEST_DEVICE_TIME で、機器の時刻を使うとき）は、次の実行で、
その分のまとめた行に足し込まれる。
【対象】self-hosted のセンサー（workspace_id が NULL）だけ。SaaS は app/purge.py の 14 日削除。
【負荷】1 日分ごとに別のトランザクションで、間に短い休みを入れる（取り込みの邪魔をしない）。
最初の実行は数百万行になるので、進み具合をログに出す。

【誰が・いつ呼ぶか】rollup_loop を、main.py が、READINGS_ROLLUP_DAYS が 1 以上のときだけ、
起動時に 1 回起動する（毎日 UTC 19:00 ＝ 日本時間 04:00。WAL-G の毎日のバックアップ
UTC 18:30 を避ける）。
すぐ実行したいときは、`python -m app.rollup_cli run`（app/rollup_cli.py）。
"""
import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import settings
from app.db.models import Sensor
from app.db.session import engine

_logger = logging.getLogger(__name__)

# 1 回のトランザクションで、まとめる範囲（センサー 1 つの、この長さ）。1 秒ごとなら約 8.6 万行
_WINDOW = timedelta(days=1)
# 1 日分ごとの休み（秒）。取り込みの書き込みを待たせすぎないため
_PAUSE_SECONDS = 0.2
# 毎日の実行時刻（UTC）。WAL-G の毎日のバックアップ（UTC 18:30）を避ける
_RUN_HOUR_UTC = 19

# 消した行をその場でまとめて、1 分ごとの行へ足し込む（足し込みは、同じ分の行があれば合算）。
# date_trunc の第 3 引数で、サーバーの時間帯に関係なく UTC の分に切る
_ROLLUP_WINDOW_SQL = text(
    """
    WITH moved AS (
        DELETE FROM readings
        WHERE sensor_id = :sensor_id AND recorded_at >= :window_start AND recorded_at < :window_end
        RETURNING value, recorded_at
    ), grouped AS (
        SELECT date_trunc('minute', recorded_at, 'UTC') AS bucket_start,
               count(*) AS cnt,
               sum(value) AS total,
               min(value) AS minimum,
               max(value) AS maximum,
               (array_agg(value ORDER BY recorded_at DESC))[1] AS last_value,
               max(recorded_at) AS last_at
        FROM moved
        GROUP BY 1
    ), merged AS (
        INSERT INTO readings_rollup AS r
            (sensor_id, bucket_start, count, sum, min, max, last_value, last_at)
        SELECT :sensor_id, bucket_start, cnt, total, minimum, maximum, last_value, last_at
        FROM grouped
        ON CONFLICT (sensor_id, bucket_start) DO UPDATE SET
            count = r.count + EXCLUDED.count,
            sum = r.sum + EXCLUDED.sum,
            min = LEAST(r.min, EXCLUDED.min),
            max = GREATEST(r.max, EXCLUDED.max),
            last_value = CASE WHEN EXCLUDED.last_at >= r.last_at
                              THEN EXCLUDED.last_value ELSE r.last_value END,
            last_at = GREATEST(r.last_at, EXCLUDED.last_at)
        RETURNING 1
    )
    SELECT (SELECT count(*) FROM moved) AS deleted, (SELECT count(*) FROM merged) AS buckets
    """
)

_OLDEST_RAW_SQL = text(
    "SELECT min(recorded_at) FROM readings WHERE sensor_id = :sensor_id AND recorded_at < :cutoff"
)


@dataclass
class RollupResult:
    """まとめた結果。deleted_rows = 消した（まとめた）生の行の数、buckets = 足した 1 分の行の数。"""

    sensors: int = 0
    deleted_rows: int = 0
    buckets: int = 0


def floor_to_minute(moment: datetime) -> datetime:
    """秒以下を切り捨てる。例: 10:15:42.5 → 10:15:00。"""
    return moment.replace(second=0, microsecond=0)


def rollup_cutoff(now: datetime, days: int) -> datetime:
    """この時刻より古い生の行をまとめる。「今から days 日前」を、分に切り捨てた時刻。

    分に切り捨てるのは、1 つの分の行が、生とまとめに分かれないようにするため。
    例: now=2026-11-19 10:15:42, days=7 → 2026-11-12 10:15:00。
    """
    return floor_to_minute(now - timedelta(days=days))


async def _rollup_sensor(sensor_id: UUID, cutoff: datetime, label: str) -> RollupResult:
    """1 つのセンサーの、cutoff より古い生の行を、古い方から 1 日分ずつまとめる。"""
    result = RollupResult(sensors=1)
    while True:
        async with AsyncSession(engine) as session:
            oldest = (
                await session.execute(_OLDEST_RAW_SQL, {"sensor_id": sensor_id, "cutoff": cutoff})
            ).scalar_one()
        if oldest is None:  # まとめる行が尽きた
            return result
        window_start = floor_to_minute(oldest)
        window_end = min(window_start + _WINDOW, cutoff)
        async with AsyncSession(engine) as session:
            row = (
                await session.execute(
                    _ROLLUP_WINDOW_SQL,
                    {
                        "sensor_id": sensor_id,
                        "window_start": window_start,
                        "window_end": window_end,
                    },
                )
            ).one()
            await session.commit()
        result.deleted_rows += row.deleted
        result.buckets += row.buckets
        _logger.info(
            "rollup: %s %s 〜 %s → 生の行 %d 件 → 1 分の行 %d 件（このセンサーの累計 %d 件）",
            label,
            window_start.date(),
            window_end.date(),
            row.deleted,
            row.buckets,
            result.deleted_rows,
        )
        await asyncio.sleep(_PAUSE_SECONDS)


async def rollup_old_readings(
    days: int | None = None, now: datetime | None = None
) -> RollupResult:
    """days 日より古い生の測定値を、1 分ごとにまとめる。まとめた件数を返す。

    引数: days = 残す日数（省略は設定 READINGS_ROLLUP_DAYS。0 以下は何もしない）、
    now = 今の時刻（試験用）。
    対象は self-hosted のセンサー（workspace_id が NULL）だけ。
    例: rollup_old_readings(7) → 7 日より古い 1 秒ごとの行を、1 分ごとの行にして、元を消す。
    """
    keep_days = settings.readings_rollup_days if days is None else days
    total = RollupResult()
    if keep_days <= 0:
        return total
    cutoff = rollup_cutoff(now or datetime.now(UTC), keep_days)
    async with AsyncSession(engine) as session:
        sensors = (
            await session.exec(
                select(col(Sensor.id), col(Sensor.name))
                .where(col(Sensor.workspace_id).is_(None))
                .order_by(col(Sensor.name))
            )
        ).all()
    _logger.info(
        "rollup: 開始（%d 日より古い生の行が対象、cutoff=%s、センサー %d 件）",
        keep_days,
        cutoff.isoformat(),
        len(sensors),
    )
    for sensor_id, name in sensors:
        done = await _rollup_sensor(sensor_id, cutoff, name)
        total.sensors += 1
        total.deleted_rows += done.deleted_rows
        total.buckets += done.buckets
    _logger.info(
        "rollup: 完了（生の行 %d 件 → 1 分の行 %d 件）", total.deleted_rows, total.buckets
    )
    return total


async def rollup_loop() -> None:
    """毎日 UTC 19:00 に、古い測定値をまとめるループ（常駐タスク）。

    次の実行時刻を計算して眠り、起きたらまとめる。失敗しても、ループは止めずに次の日を待つ。
    """
    while True:
        now = datetime.now(UTC)
        next_run = now.replace(hour=_RUN_HOUR_UTC, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        wait_seconds = (next_run - now).total_seconds()
        _logger.info("rollup_loop: next run at %s (%.0fs)", next_run.isoformat(), wait_seconds)
        await asyncio.sleep(wait_seconds)
        try:
            await rollup_old_readings()
        except Exception:
            _logger.exception("rollup_loop: error during rollup_old_readings")
