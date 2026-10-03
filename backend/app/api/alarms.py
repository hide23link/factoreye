"""アラームAPI: 一覧/詳細/確認（ACK）。評価エンジン本体は app.alarm_engine。

DELETE は提供しない（Alarmは監査ログのため追記専用、docs参照）。
"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import Alarm, AlarmStatus, Sensor
from app.db.session import get_session
from app.schemas import AlarmAck, AlarmListResponse, AlarmRead

router = APIRouter(prefix="/api/alarms", tags=["alarms"])


async def _get_alarm(
    session: AsyncSession, alarm_id: UUID, workspace_id: UUID | None = None
) -> Alarm:
    alarm = await session.get(Alarm, alarm_id)
    if alarm is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alarm not found")
    # multi-tenant: センサー経由でワークスペース所有確認
    if workspace_id is not None:
        sensor = await session.get(Sensor, alarm.sensor_id)
        if sensor is None or sensor.workspace_id != workspace_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alarm not found")
    return alarm


@router.get("", response_model=AlarmListResponse)
async def list_alarms(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
    status_filter: AlarmStatus | None = Query(default=None, alias="status"),
    sensor_id: UUID | None = Query(default=None),
) -> AlarmListResponse:
    # SQLModelのクラス属性はmypyには素のPython型に見えるため.desc()はattr-definedで誤検知される
    query = select(Alarm).order_by(Alarm.triggered_at.desc())  # type: ignore[attr-defined]

    if workspace_id is not None:
        # センサーJOINでワークスペース絞り込み
        query = query.join(Sensor, Alarm.sensor_id == Sensor.id).where(  # type: ignore[arg-type]
            Sensor.workspace_id == workspace_id
        )
    if status_filter is not None:
        query = query.where(Alarm.status == status_filter)
    if sensor_id is not None:
        query = query.where(Alarm.sensor_id == sensor_id)

    result = await session.exec(query)
    alarms = list(result.all())
    return AlarmListResponse(
        alarms=[AlarmRead.model_validate(a) for a in alarms], total=len(alarms)
    )


@router.get("/{alarm_id}", response_model=AlarmRead)
async def get_alarm(
    alarm_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> Alarm:
    return await _get_alarm(session, alarm_id, workspace_id)


@router.patch("/{alarm_id}/ack", response_model=AlarmRead)
async def acknowledge_alarm(
    alarm_id: UUID,
    payload: AlarmAck,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> Alarm:
    alarm = await _get_alarm(session, alarm_id, workspace_id)
    if alarm.status != AlarmStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"alarm is not active (status={alarm.status.value})",
        )

    alarm.status = AlarmStatus.ACKNOWLEDGED
    alarm.acknowledged_at = datetime.now(UTC)
    alarm.acknowledged_by = payload.acknowledged_by
    session.add(alarm)
    await session.commit()
    await session.refresh(alarm)
    return alarm
