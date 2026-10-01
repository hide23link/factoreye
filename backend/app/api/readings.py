"""GET /api/readings — ダッシュボードpolling用の直近測定値一覧。"""
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Reading
from app.db.session import get_session
from app.schemas import ReadingListResponse, ReadingRead

router = APIRouter(prefix="/api/readings", tags=["readings"])


@router.get("", response_model=ReadingListResponse)
async def list_readings(
    session: AsyncSession = Depends(get_session),
    sensor_id: UUID | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=10000),
) -> ReadingListResponse:
    query = select(Reading)
    if sensor_id is not None:
        query = query.where(Reading.sensor_id == sensor_id)
    # SQLModelのクラス属性はmypyには素のPython型に見えるため.desc()はattr-definedで誤検知される
    query = query.order_by(Reading.recorded_at.desc()).limit(limit)  # type: ignore[attr-defined]

    result = await session.exec(query)
    readings = list(result.all())
    return ReadingListResponse(
        readings=[ReadingRead.model_validate(r) for r in readings], total=len(readings)
    )
