"""測定値の読み出し（生の行 ＋ 1 分にまとめた行を合わせて答える）。

OSS 版で READINGS_ROLLUP_DAYS を設定すると、古い 1 秒ごとの測定値は 1 分ごとの行
（readings_rollup。app/rollup.py）にまとめられて、元の行は消える。グラフ・集計・最新の値の API は、
どれもこのファイルの関数を通して、生の行（readings）とまとめた行を合わせて同じ形で答える。
同じ計算を API ごとに書かない（合わせ方を 1 か所に置く）。

【約束】1 つの分の測定値は、生の行かまとめた行のどちらか一方にだけある（二重に数えない）。
設定が 0（まとめない）のときは、まとめた行の表が空なので、答えは今までと同じ。
【精度】まとめた行は 1 分の粒度なので、期間の端（from・to）が分の途中のときは、最大 1 分ぶんの
誤差が出る（その分の行を、開始時刻で入れるか入れないかで決める）。

【誰が使うか】app/api/sensors.py（readings・aggregate・downsampled・latest）。
"""
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, true
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Reading, ReadingRollup, Sensor
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


async def sum_and_count(
    session: AsyncSession, sensor_id: UUID, from_: datetime, to: datetime | None
) -> tuple[float, int]:
    """指定区間の測定値の合計と件数（生産数の「直近 1 時間」「本日累計」など）。

    まとめた行は、開始時刻が from_ 以後（to があれば to 以前）の分を足す。
    """
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


async def downsample(
    session: AsyncSession, sensor_id: UUID, from_: datetime, to: datetime, buckets: int
) -> DownsampledReadings:
    """from〜to を buckets 区間に分け、区間ごとの最小・平均・最大・件数を返す（グラフ用）。

    区間の幅は (to - from) / buckets、境界は from から等間隔。まとめた行は、開始時刻で区間に入れる
    （1 分より細かい区間では、1 分の粒度になる）。to ちょうどの測定値は最後の区間に入れる。
    """
    width = (to - from_).total_seconds() / buckets
    start_epoch = from_.timestamp()

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
            for index, minimum, avg, maximum, count in merge_bucket_rows(raw_rows, rolled_rows)
        ],
    )


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
