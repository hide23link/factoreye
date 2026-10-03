"""センサー管理 API（一覧/作成/詳細/更新/削除）と測定値履歴。"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import Reading, Sensor
from app.db.session import get_session
from app.schemas import (
    ReadingAggregate,
    ReadingListResponse,
    ReadingRead,
    SensorCreate,
    SensorRead,
    SensorUpdate,
)

router = APIRouter(prefix="/api/sensors", tags=["sensors"])

# Free Tier: 1ワークスペースあたりのセンサー上限
_FREE_TIER_SENSOR_LIMIT = 10


async def _get_active_sensor(
    session: AsyncSession, sensor_id: UUID, workspace_id: UUID | None = None
) -> Sensor:
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
    # Free Tier 上限チェック（multi-tenant のみ）
    if workspace_id is not None:
        count_result = await session.exec(
            select(func.count()).where(Sensor.workspace_id == workspace_id)
        )
        if (count_result.one() or 0) >= _FREE_TIER_SENSOR_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail=f"free tier limit reached ({_FREE_TIER_SENSOR_LIMIT} sensors)",
            )

    # name / ingest_key の重複チェック（同ワークスペース内）
    dup_query = select(Sensor).where(
        (Sensor.name == payload.name) | (Sensor.ingest_key == payload.ingest_key)
    )
    if workspace_id is not None:
        dup_query = dup_query.where(Sensor.workspace_id == workspace_id)
    existing = await session.exec(dup_query)
    if existing.first() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="name or ingestKey already in use"
        )

    sensor = Sensor(workspace_id=workspace_id, **payload.model_dump())
    session.add(sensor)
    await session.commit()
    await session.refresh(sensor)
    return sensor


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
    sensor = await _get_active_sensor(session, sensor_id, workspace_id)

    if payload.name is not None and payload.name != sensor.name:
        dup_query = select(Sensor).where(Sensor.name == payload.name, Sensor.id != sensor_id)
        if workspace_id is not None:
            dup_query = dup_query.where(Sensor.workspace_id == workspace_id)
        existing = await session.exec(dup_query)
        if existing.first() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="name already in use"
            )

    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(sensor, field, value)
    sensor.updated_at = datetime.now(UTC)
    session.add(sensor)
    await session.commit()
    await session.refresh(sensor)
    return sensor


@router.delete("/{sensor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sensor(
    sensor_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> None:
    """物理削除。測定値・アラーム履歴もCASCADEで一緒に消える（2026-10-02、社長の明示的な
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
