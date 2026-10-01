"""GET /api/alarms — アラーム一覧（評価エンジン本体はSprint 4で実装）。"""
from fastapi import APIRouter, Depends, Query
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Alarm, AlarmStatus
from app.db.session import get_session
from app.schemas import AlarmListResponse, AlarmRead

router = APIRouter(prefix="/api/alarms", tags=["alarms"])


@router.get("", response_model=AlarmListResponse)
async def list_alarms(
    session: AsyncSession = Depends(get_session),
    status_filter: AlarmStatus | None = Query(default=None, alias="status"),
) -> AlarmListResponse:
    query = select(Alarm)
    if status_filter is not None:
        query = query.where(Alarm.status == status_filter)
    # SQLModelのクラス属性はmypyには素のPython型に見えるため.desc()はattr-definedで誤検知される
    query = query.order_by(Alarm.triggered_at.desc())  # type: ignore[attr-defined]

    result = await session.exec(query)
    alarms = list(result.all())
    return AlarmListResponse(
        alarms=[AlarmRead.model_validate(a) for a in alarms], total=len(alarms)
    )
