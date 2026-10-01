"""POST /api/ingest/readings — センサー値の取り込み（単発 or バッチ）。"""
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import verify_ingest_api_key
from app.db.models import Sensor
from app.db.session import get_session
from app.ingest_buffer import PendingReading, buffer
from app.rate_limit import limiter
from app.schemas import IngestAccepted, IngestRequest

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


@router.post(
    "/readings",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(verify_ingest_api_key)],
)
@limiter.limit("100/minute")
async def ingest_readings(
    request: Request, session: AsyncSession = Depends(get_session)
) -> IngestAccepted:
    try:
        raw_body = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid JSON body"
        ) from exc

    try:
        payload = IngestRequest.model_validate(raw_body)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=exc.errors()
        ) from exc

    readings = payload.to_readings()
    if not readings:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="value or readings is required"
        )

    # SQLModelのクラス属性はmypyには素のPython型に見えるため.is_()はunion-attrで誤検知される
    sensor_query = select(Sensor).where(
        Sensor.ingest_key == payload.ingest_key,
        Sensor.deleted_at.is_(None),  # type: ignore[union-attr]
    )
    result = await session.exec(sensor_query)
    sensor = result.first()
    if sensor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown ingestKey")
    if not sensor.enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="sensor disabled")

    # ingest時刻を採用（デバイス側timestampは信頼しない、docs §Reading参照）
    received_at = datetime.now(UTC)
    for reading in readings:
        await buffer.add(
            PendingReading(sensor_id=sensor.id, value=reading.value, recorded_at=received_at)
        )

    return IngestAccepted(accepted=len(readings))
