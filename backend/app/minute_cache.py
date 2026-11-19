"""直近の測定値の 1 分ごとの集計（readings_minute）を作って保つ処理。

OSS 版で、設定 READINGS_ROLLUP_DAYS が 1 以上のときに使う。

【なぜ要るか】1 秒ごとに届くセンサーは、直近 7 日分の生の行が 60 万行ある。7 日のグラフは、これを
300 区間に集計するだけで Pi では 1.6 秒かかる。そこで、生の行が残っている分も 1 分ごとの
「件数・合計・最小・最大・最後の値」に集計して持ち（readings_minute）、グラフ・集計の API は
1 区間が 2 分以上のとき、それを読む（app/readings_query.py）。7 日分で 1 万行余りになる。

【分の 3 つの置き場】センサーごとの印（readings_minute_state）で、時刻の区間を分ける。
    finalized_until より前 : 生の行が消えて readings_rollup にまとめ済み
                             （app/rollup.py の夜のまとめ）
    finalized_until〜built_until : 生の行が残っていて、readings_minute に集計がある
    built_until 以後 : まだ集計が無い（今の分と、できたての分）。生の行を直接読む
どの分も、置き場はちょうど 1 つ（二重に数えない）。読み出しは、この 3 つを合わせる。

【作り方】集計は、生の行から「作り直して上書き」する（足し算ではない）。なので何度やっても同じ結果。
  - 常駐処理（minute_loop）が 30 秒ごとに、閉じた分（今から 10 秒以上前に終わった分）まで足す。
  - 初めてのセンサーは、古い方から 1 日分ずつ作る（間に休みを入れる。作っている途中でも、
    読み出しは built_until より後を生の行から読むので、正しい答えが返る）。
  - 遅れて届いた行（その時点の「閉じた分」より前の時刻の行。機器が時刻をつけて送り直したとき）は、
    取り込みのとき、(センサー・分) だけを readings_dirty_minutes に記録する（1 秒ごとの通常の行は
    何も足さない）。常駐処理と、読み出しの直前に、その分を生の行から作り直す。
  - 生の行が消える夜のまとめ（rollup.py）は、同じトランザクションで、その分の集計をここから消して
    readings_rollup に足す。
同じセンサーに対する、夜のまとめ・初めての作成・作り直しは、センサーごとの排他ロック
（pg_advisory_xact_lock）で順番に行う。

【誰が・いつ呼ぶか】minute_loop を main.py が、READINGS_ROLLUP_DAYS が 1 以上のときだけ起動する。
settle_dirty を readings_query.py が、読む前に呼ぶ。mark_late_rows を ingest_buffer.py が、
測定値を書くときに呼ぶ。すぐ作りたいときは `python -m app.rollup_cli minute-build`。
"""
import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import NamedTuple
from uuid import UUID

from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.session import engine

_logger = logging.getLogger(__name__)

# 分が閉じてから、集計を作るまでの待ち。取り込みのバッファ（1 秒ごとの書き込み）の遅れを待つ
SETTLE_LAG = timedelta(seconds=10)
# 常駐処理の周期（秒）
_TICK_SECONDS = 30
# 初めての作成で、1 回のトランザクションで作る範囲（センサー 1 つの、この長さ）
_WINDOW = timedelta(days=1)
# 1 回の作成ごとの休み（秒）。取り込みの書き込みを待たせすぎないため
_PAUSE_SECONDS = 0.2
# built_until がこれより古いセンサーは「作成が遅れている」として、1 つずつ作る（まとめて足さない）
_LAGGING = timedelta(hours=2)
# 排他ロックの種類の番号（pg_advisory_xact_lock の第 1 引数）
_LOCK_SENSOR = 1747
_LOCK_BATCH = 1748

# 範囲 [start, end) の分の集計を、生の行から作り直す（古い行を消してから入れる）
_DELETE_RANGE_SQL = text(
    "DELETE FROM readings_minute "
    "WHERE sensor_id = :sensor_id AND bucket_start >= :start AND bucket_start < :end"
)
_INSERT_RANGE_SQL = text(
    """
    INSERT INTO readings_minute (sensor_id, bucket_start, count, sum, min, max, last_value, last_at)
    SELECT sensor_id, date_trunc('minute', recorded_at, 'UTC'), count(*), sum(value),
           min(value), max(value), (array_agg(value ORDER BY recorded_at DESC))[1],
           max(recorded_at)
    FROM readings
    WHERE sensor_id = :sensor_id AND recorded_at >= :start AND recorded_at < :end
    GROUP BY sensor_id, 2
    """
)
# 指定した分（配列）だけを、生の行から作り直す（遅れて届いた行の分）
_DELETE_MINUTES_SQL = text(
    "DELETE FROM readings_minute "
    "WHERE sensor_id = :sensor_id AND bucket_start = ANY(CAST(:minutes AS timestamptz[]))"
)
_INSERT_MINUTES_SQL = text(
    """
    INSERT INTO readings_minute (sensor_id, bucket_start, count, sum, min, max, last_value, last_at)
    SELECT r.sensor_id, d.minute, count(*), sum(r.value), min(r.value), max(r.value),
           (array_agg(r.value ORDER BY r.recorded_at DESC))[1], max(r.recorded_at)
    FROM unnest(CAST(:minutes AS timestamptz[])) AS d(minute)
    JOIN readings r ON r.sensor_id = :sensor_id
        AND r.recorded_at >= d.minute AND r.recorded_at < d.minute + interval '1 minute'
    GROUP BY r.sensor_id, d.minute
    """
)
_LOCK_SENSOR_SQL = text("SELECT pg_advisory_xact_lock(:kind, hashtext(CAST(:sensor_id AS text)))")


class CacheState(NamedTuple):
    """センサーの印。finalized_until・built_until は、どちらも分に切った UTC の時刻。"""

    finalized_until: datetime
    built_until: datetime


@dataclass
class TickResult:
    """minute_loop 1 回分の結果（ログ・コマンド用）。"""

    new_states: int = 0
    window_builds: int = 0
    topped_up: int = 0
    settled_minutes: int = 0


def floor_minute(moment: datetime) -> datetime:
    """秒以下を切り捨てる。例: 10:15:42.5 → 10:15:00。"""
    return moment.replace(second=0, microsecond=0)


def settled_horizon(now: datetime) -> datetime:
    """この時刻より前の分は「閉じて、遅れも待った」。今から SETTLE_LAG 前を、分に切り捨てた時刻。

    例: 12:00:05 → 11:59:00（10 秒前の 11:59:55 の分は、まだ閉じて 10 秒たっていない）、
    12:00:15 → 12:00:00。
    """
    return floor_minute(now - SETTLE_LAG)


async def _lock_sensor(session: AsyncSession, sensor_id: UUID) -> None:
    """このセンサーの作成・作り直し・夜のまとめを、順番に行うためのロック（トランザクションの終わりまで）。"""
    await session.execute(_LOCK_SENSOR_SQL, {"kind": _LOCK_SENSOR, "sensor_id": str(sensor_id)})


async def lock_sensor_for_rollup(session: AsyncSession, sensor_id: UUID) -> None:
    """夜のまとめ（rollup.py）が、同じロックを取るための入口。"""
    await _lock_sensor(session, sensor_id)


async def load_state(session: AsyncSession, sensor_id: UUID) -> CacheState | None:
    """センサーの印（無ければ None＝このセンサーは従来の読み出し）。"""
    row = (
        await session.execute(
            text(
                "SELECT finalized_until, built_until FROM readings_minute_state "
                "WHERE sensor_id = :sensor_id"
            ),
            {"sensor_id": sensor_id},
        )
    ).first()
    return None if row is None else CacheState(row.finalized_until, row.built_until)


async def _build_range(
    session: AsyncSession, sensor_id: UUID, start: datetime, end: datetime
) -> None:
    """[start, end)（どちらも分の境目）の分の集計を、生の行から作り直す。"""
    params = {"sensor_id": sensor_id, "start": start, "end": end}
    await session.execute(_DELETE_RANGE_SQL, params)
    await session.execute(_INSERT_RANGE_SQL, params)


async def create_missing_states(now: datetime) -> int:
    """印の無い self-hosted のセンサーに、印を作る。作った数を返す。

    finalized_until = そのセンサーのいちばん古い生の行の分（生の行が無ければ、今の閉じた分）、
    built_until = finalized_until（まだ何も作っていない）。
    例: 生の行が 2026-11-12 02:41:07 から → finalized_until = built_until = 2026-11-12 02:41:00。
    """
    horizon = settled_horizon(now)
    async with AsyncSession(engine) as session:
        result = await session.execute(
            text(
                """
                INSERT INTO readings_minute_state (sensor_id, finalized_until, built_until)
                SELECT s.id, m.start, m.start
                FROM sensors s
                CROSS JOIN LATERAL (
                    SELECT COALESCE(
                        date_trunc('minute', (SELECT min(recorded_at) FROM readings
                                              WHERE sensor_id = s.id), 'UTC'),
                        CAST(:horizon AS timestamptz)
                    ) AS start
                ) m
                WHERE s.workspace_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM readings_minute_state t WHERE t.sensor_id = s.id)
                ON CONFLICT (sensor_id) DO NOTHING
                """
            ),
            {"horizon": horizon},
        )
        await session.commit()
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def build_window(sensor_id: UUID, now: datetime) -> bool:
    """1 つのセンサーの、built_until から 1 日分（または閉じた分まで）の集計を作る。

    まだ続きがあれば True を返す。夜のまとめと順番に行うため、センサーごとのロックを取る。
    作る範囲は、finalized_until 以後（まとめ済みの分は作らない）。
    """
    horizon = settled_horizon(now)
    async with AsyncSession(engine) as session:
        await _lock_sensor(session, sensor_id)
        state = await load_state(session, sensor_id)
        if state is None:
            return False
        start = max(state.built_until, state.finalized_until)
        end = min(start + _WINDOW, horizon)
        if end <= start:
            return False
        await _build_range(session, sensor_id, start, end)
        await session.execute(
            text(
                "UPDATE readings_minute_state SET built_until = :end WHERE sensor_id = :sensor_id"
            ),
            {"sensor_id": sensor_id, "end": end},
        )
        await session.commit()
        return end < horizon


async def top_up_current(now: datetime) -> int:
    """作成が遅れていない全センサーの集計を、閉じた分まで、まとめて足す。足したセンサーの数を返す。

    1 つの SQL で、全センサーの [built_until, 閉じた分) を生の行から集計して入れ、印を進める
    （毎回の処理を軽くするため、センサーごとに分けない）。
    """
    horizon = settled_horizon(now)
    lagging_limit = horizon - _LAGGING
    params = {"horizon": horizon, "lagging_limit": lagging_limit}
    async with AsyncSession(engine) as session:
        await session.execute(text("SELECT pg_advisory_xact_lock(:kind)"), {"kind": _LOCK_BATCH})
        await session.execute(
            text(
                """
                INSERT INTO readings_minute
                    (sensor_id, bucket_start, count, sum, min, max, last_value, last_at)
                SELECT r.sensor_id, date_trunc('minute', r.recorded_at, 'UTC'), count(*),
                       sum(r.value), min(r.value), max(r.value),
                       (array_agg(r.value ORDER BY r.recorded_at DESC))[1], max(r.recorded_at)
                FROM readings_minute_state t
                JOIN readings r ON r.sensor_id = t.sensor_id
                    AND r.recorded_at >= t.built_until AND r.recorded_at < :horizon
                WHERE t.built_until < :horizon AND t.built_until >= :lagging_limit
                GROUP BY r.sensor_id, 2
                ON CONFLICT (sensor_id, bucket_start) DO UPDATE SET
                    count = EXCLUDED.count, sum = EXCLUDED.sum, min = EXCLUDED.min,
                    max = EXCLUDED.max, last_value = EXCLUDED.last_value, last_at = EXCLUDED.last_at
                """
            ),
            params,
        )
        result = await session.execute(
            text(
                "UPDATE readings_minute_state SET built_until = :horizon "
                "WHERE built_until < :horizon AND built_until >= :lagging_limit"
            ),
            params,
        )
        await session.commit()
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def settle_dirty(sensor_id: UUID) -> int:
    """遅れて届いた行の分を、生の行から作り直す。作り直した分の数を返す（何も無ければ 0）。

    記録（readings_dirty_minutes）のうち built_until より前の分だけを扱う（それ以後の分は、
    作るときに生の行から入る）。finalized_until より前の分は、生の行が消えていて作り直せない
    （夜のまとめが足し込む）ので、記録だけ消す。
    先に記録を消してから作り直すので、作り直している間に届いた行は、新しい記録になって次に回る。
    """
    async with AsyncSession(engine) as session:
        # 記録が無ければ、ロックも取らずに終わる（読み出しのたびに通る道を軽くする）
        has_any = (
            await session.execute(
                text("SELECT 1 FROM readings_dirty_minutes WHERE sensor_id = :sensor_id LIMIT 1"),
                {"sensor_id": sensor_id},
            )
        ).first()
        if has_any is None:
            return 0
        await _lock_sensor(session, sensor_id)
        state = await load_state(session, sensor_id)
        if state is None:
            return 0
        deleted = (
            await session.execute(
                text(
                    "DELETE FROM readings_dirty_minutes "
                    "WHERE sensor_id = :sensor_id AND bucket_start < :built RETURNING bucket_start"
                ),
                {"sensor_id": sensor_id, "built": state.built_until},
            )
        ).all()
        minutes = [row.bucket_start for row in deleted if row.bucket_start >= state.finalized_until]
        if minutes:
            params = {"sensor_id": sensor_id, "minutes": minutes}
            await session.execute(_DELETE_MINUTES_SQL, params)
            await session.execute(_INSERT_MINUTES_SQL, params)
        await session.commit()
    return len(minutes)


async def settle_all_dirty() -> int:
    """記録のあるすべてのセンサーについて settle_dirty する。作り直した分の合計を返す。"""
    async with AsyncSession(engine) as session:
        sensor_ids = [
            row.sensor_id
            for row in (
                await session.execute(
                    text("SELECT DISTINCT sensor_id FROM readings_dirty_minutes")
                )
            ).all()
        ]
    total = 0
    for sensor_id in sensor_ids:
        total += await settle_dirty(sensor_id)
    return total


async def run_tick(now: datetime | None = None) -> TickResult:
    """1 回分の処理: 印を作る → 作成が遅れたセンサーを進める → 全センサーを閉じた分まで足す →
    遅れて届いた行の分を作り直す。常駐処理（minute_loop）と、コマンド（minute-build）が呼ぶ。
    """
    moment = now or datetime.now(UTC)
    result = TickResult()
    result.new_states = await create_missing_states(moment)

    # 作成が遅れているセンサー（初めての作成など）を、1 つずつ、1 日分ずつ進める
    horizon = settled_horizon(moment)
    async with AsyncSession(engine) as session:
        lagging = [
            row.sensor_id
            for row in (
                await session.execute(
                    text(
                        "SELECT sensor_id FROM readings_minute_state "
                        "WHERE built_until < :limit ORDER BY built_until"
                    ),
                    {"limit": horizon - _LAGGING},
                )
            ).all()
        ]
    for sensor_id in lagging:
        while await build_window(sensor_id, moment):
            result.window_builds += 1
            await asyncio.sleep(_PAUSE_SECONDS)
        result.window_builds += 1
        await asyncio.sleep(_PAUSE_SECONDS)

    result.topped_up = await top_up_current(moment)
    result.settled_minutes = await settle_all_dirty()
    return result


async def minute_loop() -> None:
    """30 秒ごとに run_tick する常駐タスク。失敗しても止めずに、次の周期で再試行する。"""
    while True:
        try:
            result = await run_tick()
            if result.new_states or result.window_builds or result.settled_minutes:
                _logger.info(
                    "minute_cache: 印 %d 件を作成、1 日分の作成 %d 回、"
                    "遅れて届いた分の作り直し %d 件",
                    result.new_states,
                    result.window_builds,
                    result.settled_minutes,
                )
        except Exception:
            _logger.exception("minute_cache: run_tick に失敗しました（次の周期で再試行します）")
        await asyncio.sleep(_TICK_SECONDS)


async def mark_late_rows(
    session: AsyncSession, rows: list[tuple[UUID, datetime]], now: datetime
) -> int:
    """取り込みで書いた行のうち、遅れて届いた行の (センサー・分) を記録する。記録した数を返す。

    引数: rows = 書いた行の (センサー ID, 測定の時刻)、now = 今。
    「遅れて届いた」= 測定の時刻が settled_horizon(now) より前
    （集計がもう作られているかもしれない分）。
    1 秒ごとの通常の行（時刻が今ごろ）は含まれないので、通常は何もしない。
    取り込みと同じトランザクションの中で書く（行と記録が、一緒に確定する）。
    例: now=12:00:30 → 11:59:00 より前の時刻の行が記録の対象。
    """
    horizon = settled_horizon(now)
    minutes = {(sensor_id, floor_minute(at)) for sensor_id, at in rows if at < horizon}
    if not minutes:
        return 0
    await session.execute(
        text(
            "INSERT INTO readings_dirty_minutes (sensor_id, bucket_start) "
            "SELECT * FROM unnest(CAST(:sensor_ids AS uuid[]), CAST(:minutes AS timestamptz[])) "
            "ON CONFLICT DO NOTHING"
        ),
        {
            "sensor_ids": [sensor_id for sensor_id, _ in minutes],
            "minutes": [minute for _, minute in minutes],
        },
    )
    return len(minutes)


async def reset_cache() -> None:
    """3 つの表を空にする（読み出しは従来の方法に戻り、常駐処理が作り直す）。

    生の行を直接書き換えた（バックアップから戻した・データを取り込んだ）あとに使う。
    """
    async with AsyncSession(engine) as session:
        for table in ("readings_dirty_minutes", "readings_minute", "readings_minute_state"):
            await session.execute(text(f"DELETE FROM {table}"))  # noqa: S608 固定の表名
        await session.commit()
