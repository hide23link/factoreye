"""GET /api/readings — ダッシュボードpolling用の直近測定値一覧。

画面は数秒ごとにこの API を呼んで、新しい測定値を取り直す。
件数は limit で制限する（既定 1000、最大 10000）。

【呼ばれ方】GET /api/readings?sensor_id=<センサーのID>&limit=500
  sensor_id と limit は省略できる。返事: {"readings": [...新しい順...], "total": 件数}
【引数】session（DB との会話）と workspace_id（SaaS のとき、ログイン中の利用者の
ワークスペース。self-hosted では None）は、FastAPI が Depends で自動で渡す。
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import Reading, Sensor
from app.db.session import get_session
from app.schemas import ReadingListResponse, ReadingRead

router = APIRouter(prefix="/api/readings", tags=["readings"])


@router.get("", response_model=ReadingListResponse)
async def list_readings(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
    sensor_id: UUID | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=10000),
) -> ReadingListResponse:
    """直近の測定値（新しい順）。sensor_id で1センサーに絞れる。"""
    # SQLModelのクラス属性はmypyには素のPython型に見えるため.desc()はattr-definedで誤検知される
    query = select(Reading).order_by(Reading.recorded_at.desc()).limit(limit)  # type: ignore[attr-defined]

    if workspace_id is not None:
        # センサーJOINでワークスペース絞り込み
        query = query.join(Sensor, Reading.sensor_id == Sensor.id).where(  # type: ignore[arg-type]
            Sensor.workspace_id == workspace_id
        )
    if sensor_id is not None:
        query = query.where(Reading.sensor_id == sensor_id)

    result = await session.exec(query)
    readings = list(result.all())
    return ReadingListResponse(
        readings=[ReadingRead.model_validate(reading) for reading in readings], total=len(readings)
    )
