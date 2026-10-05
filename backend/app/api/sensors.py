"""センサー管理 API（一覧/作成/詳細/更新/削除）と測定値履歴。

SaaS（multi_tenant）では、各 API が「自分のワークスペースのセンサーだけ」を扱うように絞る。
他人のセンサーは 404 で返す（存在そのものを知らせないため）。
"""
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import Reading, Sensor
from app.db.session import get_session
from app.schemas import (
    DownsampledBucket,
    DownsampledReadings,
    ReadingAggregate,
    ReadingListResponse,
    ReadingRead,
    SensorCreate,
    SensorRead,
    SensorUpdate,
)

router = APIRouter(prefix="/api/sensors", tags=["sensors"])

# Free Tier（SaaS の無料枠）: 1ワークスペースあたりのセンサー上限。self-hosted は制限なし
_FREE_TIER_SENSOR_LIMIT = 10


async def _get_active_sensor(
    session: AsyncSession, sensor_id: UUID, workspace_id: UUID | None = None
) -> Sensor:
    """ID でセンサーを1件取り出す。無い・他のワークスペースのものは、どちらも 404。"""
    sensor = await session.get(Sensor, sensor_id)
    if sensor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="sensor not found")
    # multi-tenant: ワークスペース所有確認（404で応答しリソース列挙を防ぐ）
    if workspace_id is not None and sensor.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="sensor not found")
    return sensor


@router.get("", response_model=list[SensorRead])
async def list_sensors(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> list[Sensor]:
    query = select(Sensor)
    if workspace_id is not None:
        query = query.where(Sensor.workspace_id == workspace_id)
    result = await session.exec(query)
    return list(result.all())


@router.post("", response_model=SensorRead, status_code=status.HTTP_201_CREATED)
async def create_sensor(
    payload: SensorCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> Sensor:
    # Free Tier 上限チェック（multi-tenant のみ）。上限に達していたら 402（支払いが必要）
    if workspace_id is not None:
        count_result = await session.exec(
            select(func.count()).where(Sensor.workspace_id == workspace_id)
        )
        if (count_result.one() or 0) >= _FREE_TIER_SENSOR_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail=f"free tier limit reached ({_FREE_TIER_SENSOR_LIMIT} sensors)",
            )

    # 重複チェック: 名前はワークスペース内で一意、ingestKey は全体で一意
    # （取り込みAPIがキーだけでセンサーを特定するため）。事前に調べ、同時作成は DB の制約で弾く
    dup_query = select(Sensor.id).where(
        or_(
            _name_in_scope(workspace_id, payload.name),
            col(Sensor.ingest_key) == payload.ingest_key,
        )
    )
    if (await session.exec(dup_query)).first() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="name or ingestKey already in use"
        )

    # 利用者の入力（payload）と、所有者（workspace_id）を合わせて作る
    sensor = Sensor(workspace_id=workspace_id, **payload.model_dump())
    session.add(sensor)
    try:
        await session.commit()
    except IntegrityError as exc:
        # 同時に作成された場合は DB の一意制約で弾かれる（500 にせず 409 を返す）
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="name or ingestKey already in use"
        ) from exc
    await session.refresh(sensor)
    return sensor


def _name_in_scope(workspace_id: UUID | None, name: str) -> Any:
    """同じワークスペース（self-hosted は NULL）の中で、同名のセンサーを表す条件。"""
    scope = (
        col(Sensor.workspace_id).is_(None)
        if workspace_id is None
        else col(Sensor.workspace_id) == workspace_id
    )
    return and_(scope, col(Sensor.name) == name)


@router.get("/{sensor_id}", response_model=SensorRead)
async def get_sensor(
    sensor_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> Sensor:
    return await _get_active_sensor(session, sensor_id, workspace_id)


@router.put("/{sensor_id}", response_model=SensorRead)
async def update_sensor(
    sensor_id: UUID,
    payload: SensorUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> Sensor:
    """センサーの更新。送られた項目だけを変える（exclude_unset）。名前の変更は、重複を確かめる。"""
    sensor = await _get_active_sensor(session, sensor_id, workspace_id)

    if payload.name is not None and payload.name != sensor.name:
        dup_query = select(Sensor.id).where(
            _name_in_scope(workspace_id, payload.name), Sensor.id != sensor_id
        )
        if (await session.exec(dup_query)).first() is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="name already in use")

    # exclude_unset=True: 利用者が送った項目だけを使う（送っていない項目は、今の値のまま）
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(sensor, field, value)
    sensor.updated_at = datetime.now(UTC)
    session.add(sensor)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="name already in use"
        ) from exc
    await session.refresh(sensor)
    return sensor


@router.delete("/{sensor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sensor(
    sensor_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> None:
    """物理削除。測定値・アラーム履歴もCASCADEで一緒に消える（2026-10-02、運用者の明示的な
    判断）。ウィジェットは消さず、紐付け（sensor_id）だけがNULLになる。"""
    sensor = await _get_active_sensor(session, sensor_id, workspace_id)
    await session.delete(sensor)
    await session.commit()


@router.get("/{sensor_id}/readings", response_model=ReadingListResponse)
async def get_sensor_readings(
    sensor_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=10000),
) -> ReadingListResponse:
    await _get_active_sensor(session, sensor_id, workspace_id)

    # 新しい順に、limit 件まで返す（グラフ用）。期間は from / to で絞る
    query = select(Reading).where(Reading.sensor_id == sensor_id)
    if from_ is not None:
        query = query.where(Reading.recorded_at >= from_)
    if to is not None:
        query = query.where(Reading.recorded_at <= to)
    query = query.order_by(Reading.recorded_at.desc()).limit(limit)  # type: ignore[attr-defined]

    result = await session.exec(query)
    readings = list(result.all())
    return ReadingListResponse(
        readings=[ReadingRead.model_validate(r) for r in readings], total=len(readings)
    )


@router.get("/{sensor_id}/readings/aggregate", response_model=ReadingAggregate)
async def get_sensor_readings_aggregate(
    sensor_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
    from_: datetime = Query(..., alias="from"),
    to: datetime | None = Query(default=None),
) -> ReadingAggregate:
    """指定区間のReading合計値・件数。生産数センサーの「直近1時間」「本日累計」等、
    時間/日単位の集計をフロントで生データ全件集計せずに済ませるためのエンドポイント。
    """
    await _get_active_sensor(session, sensor_id, workspace_id)

    # func.count(Reading.id)はSQLModelのクラス属性がmypyには素のPython型(int | None)に
    # 見えてしまい弾かれるため、カラムを渡さずCOUNT(1)として行数を数える
    query = select(func.sum(Reading.value), func.count(1)).where(
        Reading.sensor_id == sensor_id, Reading.recorded_at >= from_
    )
    if to is not None:
        query = query.where(Reading.recorded_at <= to)

    result = await session.exec(query)
    total, count = result.one()
    return ReadingAggregate(sum=float(total or 0.0), count=count)


@router.get("/{sensor_id}/readings/downsampled", response_model=DownsampledReadings)
async def get_sensor_readings_downsampled(
    sensor_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
    from_: datetime = Query(..., alias="from"),
    to: datetime = Query(...),
    buckets: int = Query(default=500, ge=1, le=1000),
) -> DownsampledReadings:
    """グラフ用。from〜to を buckets 区間に分け、区間ごとの最小・平均・最大・件数を返す。

    生データを返すと、長い期間では点が多すぎて重い。区間は表示の幅（ピクセル数）に合わせて
    取る想定。区間の幅は (to - from) / buckets で、区間の境界は from から等間隔。
    """
    if to <= from_:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="to must be after from"
        )
    await _get_active_sensor(session, sensor_id, workspace_id)

    width = (to - from_).total_seconds() / buckets
    start_epoch = from_.timestamp()
    # 区間の番号（0 始まり）。to ちょうどの測定値は最後の区間に入れる
    index = func.least(
        func.floor(
            (func.extract("epoch", Reading.recorded_at) - start_epoch) / width  # type: ignore[arg-type]
        ),
        buckets - 1,
    )
    # 列は 5 つ（区間・最小・平均・最大・件数）。SQLModel の select は 4 つまでの型のため一覧で渡す
    columns = [
        index,
        func.min(Reading.value),
        func.avg(Reading.value),
        func.max(Reading.value),
        func.count(1),
    ]
    query = (
        select(*columns)
        .where(
            Reading.sensor_id == sensor_id,
            Reading.recorded_at >= from_,
            Reading.recorded_at <= to,
        )
        .group_by(index)
        .order_by(index)
    )

    result = await session.exec(query)
    rows = result.all()
    return DownsampledReadings(
        bucket_seconds=width,
        buckets=[
            DownsampledBucket(
                start=datetime.fromtimestamp(from_.timestamp() + int(i) * width, tz=UTC),
                min=float(mn),
                avg=float(avg),
                max=float(mx),
                count=count,
            )
            for i, mn, avg, mx, count in rows
        ],
    )
