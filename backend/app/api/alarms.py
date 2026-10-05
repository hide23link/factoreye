"""アラームAPI: 一覧/詳細/確認（ACK）。評価エンジン本体は app.alarm_engine。

DELETE は提供しない（Alarmは監査ログのため追記専用、docs参照）。
"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.api.responses import json_response
from app.db.models import Alarm, AlarmStatus, Sensor
from app.db.session import get_session
from app.schemas import AlarmAck, AlarmListResponse, AlarmRead

router = APIRouter(prefix="/api/alarms", tags=["alarms"])

# 一覧で使う列だけを読む（ORM のオブジェクトを作らないため、CPU を使わない）
_LIST_COLUMNS = (
    Alarm.id,
    Alarm.sensor_id,
    Alarm.triggered_at,
    Alarm.resolved_at,
    Alarm.acknowledged_at,
    Alarm.acknowledged_by,
    Alarm.value,
    Alarm.status,
    Alarm.threshold_breached,
    Alarm.severity,
)


async def _get_alarm(
    session: AsyncSession, alarm_id: UUID, workspace_id: UUID | None = None
) -> Alarm:
    """アラームを1件取り出す。無い・他のワークスペースのものは 404。"""
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
    limit: int | None = Query(
        default=None, ge=1, le=500, description="返す件数（省略時は条件に合うすべて）"
    ),
    offset: int = Query(default=0, ge=0, description="先頭から飛ばす件数"),
) -> Response:
    """アラームの一覧（新しい順）。状態・センサーで絞り込める。limit / offset でページを取れる。

    total は、ページで区切る前の、条件に合う件数。
    """
    # 絞り込みの条件（ページで区切る前）
    # 列を並べた select の型は、mypy では素直に推論できないため
    query = select(*_LIST_COLUMNS)  # type: ignore[call-overload]

    if workspace_id is not None:
        # センサーJOINでワークスペース絞り込み
        query = query.join(Sensor, Alarm.sensor_id == Sensor.id).where(
            Sensor.workspace_id == workspace_id
        )
    if status_filter is not None:
        query = query.where(Alarm.status == status_filter)
    if sensor_id is not None:
        query = query.where(Alarm.sensor_id == sensor_id)

    total = (await session.exec(select(func.count()).select_from(query.subquery()))).one()

    # 並びは新しい順。同時刻のものが並び替わって、ページの境界で重複・抜けが出ないように id も並べる
    # SQLModelのクラス属性はmypyには素のPython型に見えるため.desc()はattr-definedで誤検知される
    page = query.order_by(Alarm.triggered_at.desc(), Alarm.id.desc()).offset(offset)  # type: ignore[attr-defined]
    if limit is not None:
        page = page.limit(limit)

    result = await session.exec(page)
    alarms = [AlarmRead.model_validate(row) for row in result.all()]
    return json_response(AlarmListResponse(alarms=alarms, total=total))


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
    """アラームを確認済み（acknowledged）にする。発生中（active）のものだけ確認できる。

    既に確認済み・解除済みのものは 409。誰が確認したか（acknowledged_by）も記録する。
    """
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
