"""センサー管理 API（一覧/作成/詳細/更新/削除）と測定値履歴。"""
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Reading, Sensor
from app.db.session import get_session
from app.schemas import ReadingListResponse, ReadingRead, SensorCreate, SensorRead, SensorUpdate

router = APIRouter(prefix="/api/sensors", tags=["sensors"])


async def _get_active_sensor(session: AsyncSession, sensor_id: UUID) -> Sensor:
    sensor = await session.get(Sensor, sensor_id)
    if sensor is None or sensor.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="sensor not found")
    return sensor


@router.get("", response_model=list[SensorRead])
async def list_sensors(session: AsyncSession = Depends(get_session)) -> list[Sensor]:
    # SQLModelのクラス属性はmypyには素のPython型に見えるため.is_()はunion-attrで誤検知される
    query = select(Sensor).where(Sensor.deleted_at.is_(None))  # type: ignore[union-attr]
    result = await session.exec(query)
    return list(result.all())


@router.post("", response_model=SensorRead, status_code=status.HTTP_201_CREATED)
async def create_sensor(
    payload: SensorCreate, session: AsyncSession = Depends(get_session)
) -> Sensor:
    existing = await session.exec(
        select(Sensor).where(
            (Sensor.name == payload.name) | (Sensor.ingest_key == payload.ingest_key)
        )
    )
    if existing.first() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="name or ingestKey already in use"
        )

    sensor = Sensor(**payload.model_dump())
    session.add(sensor)
    await session.commit()
    await session.refresh(sensor)
    return sensor


@router.get("/{sensor_id}", response_model=SensorRead)
async def get_sensor(sensor_id: UUID, session: AsyncSession = Depends(get_session)) -> Sensor:
    return await _get_active_sensor(session, sensor_id)


@router.put("/{sensor_id}", response_model=SensorRead)
async def update_sensor(
    sensor_id: UUID, payload: SensorUpdate, session: AsyncSession = Depends(get_session)
) -> Sensor:
    sensor = await _get_active_sensor(session, sensor_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(sensor, field, value)
    sensor.updated_at = datetime.now(UTC)
    session.add(sensor)
    await session.commit()
    await session.refresh(sensor)
    return sensor


@router.delete("/{sensor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sensor(sensor_id: UUID, session: AsyncSession = Depends(get_session)) -> None:
    sensor = await _get_active_sensor(session, sensor_id)
    sensor.deleted_at = datetime.now(UTC)
    sensor.enabled = False
    session.add(sensor)
    await session.commit()


@router.get("/{sensor_id}/readings", response_model=ReadingListResponse)
async def get_sensor_readings(
    sensor_id: UUID,
    session: AsyncSession = Depends(get_session),
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=10000),
) -> ReadingListResponse:
    await _get_active_sensor(session, sensor_id)

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
