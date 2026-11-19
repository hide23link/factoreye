"""測定値の読み出し（生の行 ＋ 1 分にまとめた行を合わせて答える）。

OSS 版で READINGS_ROLLUP_DAYS を設定すると、古い 1 秒ごとの測定値は 1 分ごとの行
（readings_rollup。app/rollup.py）にまとめられて、元の行は消える。グラフ・集計・最新の値の API は、
どれもこのファイルの関数を通して、生の行（readings）とまとめた行を合わせて同じ形で答える。
同じ計算を API ごとに書かない（合わせ方を 1 か所に置く）。

【約束】1 つの分の測定値は、生の行かまとめた行のどちらか一方にだけある（二重に数えない）。
設定が 0（まとめない）のときは、まとめた行の表が空なので、答えは今までと同じ。
【精度】まとめた行は 1 分の粒度なので、期間の端（from・to）が分の途中のときは、最大 1 分ぶんの
誤差が出る（その分の行を、開始時刻で入れるか入れないかで決める）。

【速い道】範囲が 10 分以上（グラフは 1 区間が 2 分以上）で、センサーに 1 分の集計の印
（readings_minute_state。app/minute_cache.py）があるときは、直近の生の行（1 秒ごとなら 7 日で
60 万行）を読まずに、1 分の集計（readings_minute）と合わせて答える。範囲を 6 つに分け、
1 つの SQL で（同じ時点の状態で）読む（_FAST_SOURCES_SQL）。範囲の端は、生の行から読むので正確
（まとめ済みの古い分だけは、1 分の粒度の誤差）。印が無いとき・設定が 0 のときは、従来どおり。

【誰が使うか】app/api/sensors.py（readings・aggregate・downsampled・latest）。
"""
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, text, true
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import settings
from app.db.models import Reading, ReadingRollup, Sensor
from app.minute_cache import floor_minute, settle_dirty
from app.schemas import DownsampledBucket, DownsampledReadings, ReadingRead

# 区間ごとの集計 1 行: (区間の番号, 最小, 平均, 最大, 件数)
BucketRow = tuple[int, float, float, float, int]


def merge_bucket_rows(raw_rows: list[BucketRow], rolled_rows: list[BucketRow]) -> list[BucketRow]:
    """生の行の区間集計と、まとめた行の区間集計を、区間の番号ごとに 1 つに合わせる。

    合わせ方: 最小は小さい方、最大は大きい方、件数は足し算、平均は「合計 ÷ 件数」（重みづけ平均）。
    片方にしかない区間は、そのまま使う（生の行だけのときは、今までと同じ値）。
    例: 生 (0, 1.0, 3.0, 5.0, 2) と まとめ (0, 0.0, 8.0, 9.0, 2) → (0, 0.0, 5.5, 9.0, 4)
    """
    if not rolled_rows:
        return raw_rows
    merged: dict[int, BucketRow] = {row[0]: row for row in raw_rows}
    for index, minimum, avg, maximum, count in rolled_rows:
        if index not in merged:
            merged[index] = (index, minimum, avg, maximum, count)
            continue
        _, raw_min, raw_avg, raw_max, raw_count = merged[index]
        total_count = raw_count + count
        weighted = (raw_avg * raw_count + avg * count) / total_count
        merged[index] = (index, min(raw_min, minimum), weighted, max(raw_max, maximum), total_count)
    return [merged[index] for index in sorted(merged)]


# 終わりを決めない取得（from 以後すべて）を、速い道の SQL で表すための、ずっと先の時刻
_FAR_FUTURE = datetime(9999, 12, 31, tzinfo=UTC)
# 速い道を使う、いちばん短い範囲（これより短いときは、生の行が少ないので従来どおり）
_FAST_MIN_RANGE = timedelta(minutes=10)
# 速い道を使う、いちばん細かい区間の幅（秒）。1 分の集計を区間に入れるので、これ未満では粗すぎる
_FAST_MIN_BUCKET_SECONDS = 120.0

# 速い道の読み出し元。センサーの印（finalized_until=f、built_until=h）で、範囲 [lo, hi] を分ける。
#   1. readings_rollup : f より前の、まとめ済みの分（開始時刻が [lo, hi] にある行）
#   2. readings        : f より前の、まとめられていない古い生の行（遅れて届いた分。普通は 0 件）
#   3. readings_minute : f 以後 h より前の、1 分の集計（分の境目 lo_ceil〜hi_floor の間）
#   4. readings        : 3 の前の端 [max(lo, f), min(lo_ceil, h))（分の途中から始まる分）
#   5. readings        : 3 の後ろの端 [max(hi_floor, f), hi]（h より前の分）
#   6. readings        : h 以後（まだ集計が無い分）
# 列は (時刻, 最小, 合計, 最大, 件数)。生の行は 1 行ごとに (時刻, 値, 値, 値, 1)。1 つの文なので、
# 夜のまとめが動いていても、同じ時点の状態で読める。先頭に印の行（kind = 'state'）を付けて、
# 印が消えていないことを確かめる。
_FAST_SOURCES_SQL = """
    WITH st AS (
        SELECT finalized_until AS f, built_until AS h
        FROM readings_minute_state WHERE sensor_id = :sensor_id
    ), src AS (
        SELECT 'state' AS kind, f AS t, 0.0 AS mn, 0.0 AS sm, 0.0 AS mx, 0 AS cnt FROM st
        UNION ALL
        SELECT 'rollup', r.bucket_start, r.min, r.sum, r.max, r.count
        FROM readings_rollup r, st
        WHERE r.sensor_id = :sensor_id AND r.bucket_start >= :lo AND r.bucket_start <= :hi
          AND r.bucket_start < st.f
        UNION ALL
        SELECT 'late', x.recorded_at, x.value, x.value, x.value, 1
        FROM readings x, st
        WHERE x.sensor_id = :sensor_id AND x.recorded_at >= :lo AND x.recorded_at <= :hi
          AND x.recorded_at < st.f
        UNION ALL
        SELECT 'minute', m.bucket_start, m.min, m.sum, m.max, m.count
        FROM readings_minute m, st
        WHERE m.sensor_id = :sensor_id AND m.bucket_start >= GREATEST(:lo_ceil, st.f)
          AND m.bucket_start < LEAST(:hi_floor, st.h)
        UNION ALL
        SELECT 'edge_start', x.recorded_at, x.value, x.value, x.value, 1
        FROM readings x, st
        WHERE x.sensor_id = :sensor_id AND x.recorded_at >= GREATEST(:lo, st.f)
          AND x.recorded_at < LEAST(:lo_ceil, st.h)
        UNION ALL
        SELECT 'edge_end', x.recorded_at, x.value, x.value, x.value, 1
        FROM readings x, st
        WHERE x.sensor_id = :sensor_id AND x.recorded_at >= GREATEST(:hi_floor, st.f)
          AND x.recorded_at <= :hi AND x.recorded_at < st.h
        UNION ALL
        SELECT 'tail', x.recorded_at, x.value, x.value, x.value, 1
        FROM readings x, st
        WHERE x.sensor_id = :sensor_id AND x.recorded_at >= GREATEST(:lo, st.h)
          AND x.recorded_at <= :hi
    )
"""


def _ceil_minute(moment: datetime) -> datetime:
    """次の分の境目に切り上げる（すでに境目ならそのまま）。

    例: 10:15:42 → 10:16:00、10:15:00 → 10:15:00。
    """
    floored = floor_minute(moment)
    return floored if floored == moment else floored + timedelta(minutes=1)


def _fast_params(sensor_id: UUID, lo: datetime, hi: datetime) -> dict[str, Any]:
    """速い道の SQL に渡す引数（範囲と、分の境目に合わせた端）。"""
    return {
        "sensor_id": sensor_id,
        "lo": lo,
        "hi": hi,
        "lo_ceil": _ceil_minute(lo),
        "hi_floor": floor_minute(hi),
    }


async def _can_use_fast_path(
    session: AsyncSession, sensor_id: UUID, lo: datetime, hi: datetime
) -> bool:
    """速い道を使えるか（設定が有効で、範囲が 10 分以上で、センサーに印がある）。

    使えるときは、遅れて届いた行の分を先に作り直しておく（読む答えを、直前の取り込みと合わせる）。
    """
    if settings.readings_rollup_days <= 0 or hi - lo < _FAST_MIN_RANGE:
        return False
    has_state = (
        await session.execute(
            text("SELECT 1 FROM readings_minute_state WHERE sensor_id = :sensor_id"),
            {"sensor_id": sensor_id},
        )
    ).first()
    if has_state is None:
        return False
    await settle_dirty(sensor_id)
    return True


async def _fast_sum_and_count(
    session: AsyncSession, sensor_id: UUID, lo: datetime, hi: datetime
) -> tuple[float, int] | None:
    """速い道での、合計と件数。印が途中で消えていたら None（従来の道で答える）。"""
    rows = (
        await session.execute(
            text(
                _FAST_SOURCES_SQL
                + "SELECT kind, sum(sm) AS total, sum(cnt) AS cnt FROM src GROUP BY kind"
            ),
            _fast_params(sensor_id, lo, hi),
        )
    ).all()
    if not any(row.kind == "state" for row in rows):
        return None
    total = sum(float(row.total) for row in rows if row.kind != "state")
    count = sum(int(row.cnt) for row in rows if row.kind != "state")
    return total, count


async def sum_and_count(
    session: AsyncSession, sensor_id: UUID, from_: datetime, to: datetime | None
) -> tuple[float, int]:
    """指定区間の測定値の合計と件数（生産数の「直近 1 時間」「本日累計」など）。

    まとめた行は、開始時刻が from_ 以後（to があれば to 以前）の分を足す。
    """
    # 速い道: 終わりが無いときは、ずっと先まで（従来の「from 以後すべて」と同じ）として読む
    upper = to if to is not None else _FAR_FUTURE
    if await _can_use_fast_path(session, sensor_id, from_, upper):
        fast = await _fast_sum_and_count(session, sensor_id, from_, upper)
        if fast is not None:
            return fast
    raw_query = select(func.sum(Reading.value), func.count(1)).where(
        Reading.sensor_id == sensor_id, Reading.recorded_at >= from_
    )
    rolled_query = select(func.sum(ReadingRollup.sum), func.sum(ReadingRollup.count)).where(
        ReadingRollup.sensor_id == sensor_id, ReadingRollup.bucket_start >= from_
    )
    if to is not None:
        raw_query = raw_query.where(Reading.recorded_at <= to)
        rolled_query = rolled_query.where(ReadingRollup.bucket_start <= to)

    raw_total, raw_count = (await session.exec(raw_query)).one()
    rolled_total, rolled_count = (await session.exec(rolled_query)).one()
    return float(raw_total or 0.0) + float(rolled_total or 0.0), raw_count + int(rolled_count or 0)


def _to_downsampled(from_: datetime, width: float, rows: list[BucketRow]) -> DownsampledReadings:
    """区間ごとの集計（番号・最小・平均・最大・件数）を、API の返す形にする。"""
    return DownsampledReadings(
        bucket_seconds=width,
        buckets=[
            DownsampledBucket(
                start=datetime.fromtimestamp(from_.timestamp() + index * width, tz=UTC),
                min=minimum,
                avg=avg,
                max=maximum,
                count=count,
            )
            for index, minimum, avg, maximum, count in rows
        ],
    )


async def _fast_bucket_rows(
    session: AsyncSession,
    sensor_id: UUID,
    lo: datetime,
    hi: datetime,
    buckets: int,
    width: float,
) -> list[BucketRow] | None:
    """速い道での、区間ごとの集計。印が途中で消えていたら None（従来の道で答える）。

    印の行（kind = 'state'）は番号 -1 にして、結果から除く（印があることの確認だけに使う）。
    """
    params = _fast_params(sensor_id, lo, hi)
    params.update({"start_epoch": lo.timestamp(), "width": width, "buckets": buckets})
    rows = (
        await session.execute(
            text(
                _FAST_SOURCES_SQL
                + """
                SELECT CASE WHEN kind = 'state' THEN -1
                            ELSE least(floor((extract(epoch FROM t) - :start_epoch) / :width),
                                       :buckets - 1) END AS idx,
                       min(mn) AS mn, sum(sm) AS total, max(mx) AS mx, sum(cnt) AS cnt
                FROM src GROUP BY 1 ORDER BY 1
                """
            ),
            params,
        )
    ).all()
    if not any(int(row.idx) == -1 for row in rows):
        return None
    return [
        (int(row.idx), float(row.mn), float(row.total) / int(row.cnt), float(row.mx), int(row.cnt))
        for row in rows
        if int(row.idx) >= 0
    ]


async def downsample(
    session: AsyncSession, sensor_id: UUID, from_: datetime, to: datetime, buckets: int
) -> DownsampledReadings:
    """from〜to を buckets 区間に分け、区間ごとの最小・平均・最大・件数を返す（グラフ用）。

    区間の幅は (to - from) / buckets、境界は from から等間隔。まとめた行は、開始時刻で区間に入れる
    （1 分より細かい区間では、1 分の粒度になる）。to ちょうどの測定値は最後の区間に入れる。
    """
    width = (to - from_).total_seconds() / buckets
    start_epoch = from_.timestamp()

    # 速い道: 1 区間が 2 分以上のときは、1 分の集計を使う（直近の生の行を読まない）
    fast_bucket_width = width >= _FAST_MIN_BUCKET_SECONDS
    if fast_bucket_width and await _can_use_fast_path(session, sensor_id, from_, to):
        fast_rows = await _fast_bucket_rows(session, sensor_id, from_, to, buckets, width)
        if fast_rows is not None:
            return _to_downsampled(from_, width, fast_rows)

    def index_of(time_column: Any) -> Any:
        """区間の番号（0 始まり）。"""
        return func.least(
            func.floor((func.extract("epoch", time_column) - start_epoch) / width), buckets - 1
        )

    raw_index = index_of(Reading.recorded_at)
    # 列は 5 つ（区間・最小・平均・最大・件数）。SQLModel の select は 4 つまでの型のため一覧で渡す
    raw_columns = [
        raw_index,
        func.min(Reading.value),
        func.avg(Reading.value),
        func.max(Reading.value),
        func.count(1),
    ]
    raw_query = (
        select(*raw_columns)
        .where(
            Reading.sensor_id == sensor_id,
            Reading.recorded_at >= from_,
            Reading.recorded_at <= to,
        )
        .group_by(raw_index)
        .order_by(raw_index)
    )
    raw_rows: list[BucketRow] = [
        (int(i), float(mn), float(avg), float(mx), int(count))
        for i, mn, avg, mx, count in (await session.exec(raw_query)).all()
    ]

    rolled_index = index_of(ReadingRollup.bucket_start)
    rolled_columns = [
        rolled_index,
        func.min(ReadingRollup.min),
        func.sum(ReadingRollup.sum),
        func.max(ReadingRollup.max),
        func.sum(ReadingRollup.count),
    ]
    rolled_query = (
        select(*rolled_columns)
        .where(
            ReadingRollup.sensor_id == sensor_id,
            ReadingRollup.bucket_start >= from_,
            ReadingRollup.bucket_start <= to,
        )
        .group_by(rolled_index)
        .order_by(rolled_index)
    )
    rolled_rows: list[BucketRow] = [
        (int(i), float(mn), float(total) / int(count), float(mx), int(count))
        for i, mn, total, mx, count in (await session.exec(rolled_query)).all()
    ]

    return _to_downsampled(from_, width, merge_bucket_rows(raw_rows, rolled_rows))


async def recent_readings(
    session: AsyncSession,
    sensor_id: UUID,
    from_: datetime | None,
    to: datetime | None,
    limit: int,
) -> list[ReadingRead]:
    """新しい順に、limit 件まで（グラフ用の履歴）。

    生の行を先に使い、足りなければまとめた行で埋める。

    まとめた行は、1 分の平均（合計 ÷ 件数）を、その分の開始時刻の値として返す。
    """
    raw_query = select(Reading.sensor_id, Reading.value, Reading.recorded_at).where(
        Reading.sensor_id == sensor_id
    )
    if from_ is not None:
        raw_query = raw_query.where(Reading.recorded_at >= from_)
    if to is not None:
        raw_query = raw_query.where(Reading.recorded_at <= to)
    raw_query = raw_query.order_by(Reading.recorded_at.desc()).limit(limit)  # type: ignore[attr-defined]
    readings = [ReadingRead.model_validate(row) for row in (await session.exec(raw_query)).all()]
    if len(readings) >= limit:
        return readings

    # 足りない分を、まとめた行から（生の行より古い分だけ）
    # 列の名前を、ReadingRead の項目名（sensor_id・value・recorded_at）にそろえる
    rolled_columns: list[Any] = [
        ReadingRollup.sensor_id,
        (col(ReadingRollup.sum) / col(ReadingRollup.count)).label("value"),
        col(ReadingRollup.bucket_start).label("recorded_at"),
    ]
    rolled_query = select(*rolled_columns).where(ReadingRollup.sensor_id == sensor_id)
    if from_ is not None:
        rolled_query = rolled_query.where(ReadingRollup.bucket_start >= from_)
    upper = to
    if readings:
        oldest_raw = readings[-1].recorded_at
        upper = oldest_raw if upper is None else min(upper, oldest_raw)
        rolled_query = rolled_query.where(ReadingRollup.bucket_start < upper)
    elif upper is not None:
        rolled_query = rolled_query.where(ReadingRollup.bucket_start <= upper)
    rolled_query = rolled_query.order_by(col(ReadingRollup.bucket_start).desc()).limit(
        limit - len(readings)
    )
    readings.extend(
        ReadingRead.model_validate(row) for row in (await session.exec(rolled_query)).all()
    )
    return readings


async def latest_values(
    session: AsyncSession, workspace_id: UUID | None, before: datetime | None
) -> list[ReadingRead]:
    """センサーごとの、いちばん新しい測定値 1 件（before があれば、その時刻以前で）。

    受信の無いセンサーは含めない。

    生の行の最新を先に使い、無ければ（古い分がまとめられて消えているとき）まとめた行の「最後の値」を使う。
    センサーごとに主キーの索引を後ろから 1 件だけ読む（LATERAL）ので、測定値が何百万件あっても、
    センサーの数に比例する時間で済む。
    """
    # 「このセンサーの、いちばん新しい 1 件」。外側のセンサーの行ごとに実行される（LATERAL）
    raw_at_or_before = [] if before is None else [Reading.recorded_at <= before]
    newest_raw = (
        select(Reading.value, Reading.recorded_at)
        .where(Reading.sensor_id == Sensor.id, *raw_at_or_before)
        .order_by(Reading.recorded_at.desc())  # type: ignore[attr-defined]
        .limit(1)
        .lateral("newest")
    )
    # まとめた行は、その分の「最後の値の時刻」が before 以前のものだけ（分の途中の before で、
    # before より後の値を返さない）
    rolled_at_or_before = [] if before is None else [ReadingRollup.last_at <= before]
    newest_rolled = (
        select(ReadingRollup.last_value, ReadingRollup.last_at)
        .where(ReadingRollup.sensor_id == Sensor.id, *rolled_at_or_before)
        .order_by(col(ReadingRollup.bucket_start).desc())
        .limit(1)
        .lateral("newest_rolled")
    )
    # SaaS は自分のワークスペースのセンサーだけ（self-hosted は全部）
    in_workspace = [] if workspace_id is None else [Sensor.workspace_id == workspace_id]
    # 列は 5 つ（センサー・生の値と時刻・まとめた行の最後の値と時刻）。
    # select は 4 つまでの型のため一覧で渡す
    columns: list[Any] = [
        col(Sensor.id),
        newest_raw.c.value,
        newest_raw.c.recorded_at,
        newest_rolled.c.last_value,
        newest_rolled.c.last_at,
    ]
    query = (
        select(*columns)
        .select_from(Sensor)
        .join(newest_raw, true(), isouter=True)
        .join(newest_rolled, true(), isouter=True)
        .where(*in_workspace)
    )

    readings: list[ReadingRead] = []
    for sensor_id, raw_value, raw_at, rolled_value, rolled_at in (await session.exec(query)).all():
        if raw_at is not None:
            readings.append(ReadingRead(sensor_id=sensor_id, value=raw_value, recorded_at=raw_at))
        elif rolled_at is not None:
            readings.append(
                ReadingRead(sensor_id=sensor_id, value=rolled_value, recorded_at=rolled_at)
            )
    return readings
