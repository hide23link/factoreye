"""Free Tier 90日データ削除バッチ。

毎日 UTC 03:00 に実行し、90日以上前の Reading を削除する。
self-hosted（workspace_id IS NULL のセンサー）は対象外。
"""
import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Reading, Sensor
from app.db.session import engine

_RETENTION_DAYS = 90
_logger = logging.getLogger(__name__)


async def purge_old_readings() -> int:
    """90日以上前の Reading を削除し、削除件数を返す。"""
    cutoff = datetime.now(UTC) - timedelta(days=_RETENTION_DAYS)

    # multi-tenant ワークスペースのセンサー ID サブクエリ
    multi_tenant_sensor_ids = select(Sensor.id).where(Sensor.workspace_id.isnot(None))  # type: ignore[attr-defined]

    stmt = (
        delete(Reading)
        .where(
            Reading.recorded_at < cutoff,
            Reading.sensor_id.in_(multi_tenant_sensor_ids),  # type: ignore[attr-defined]
        )
    )

    async with AsyncSession(engine) as session:
        result = await session.execute(stmt)
        await session.commit()

    deleted = result.rowcount
    _logger.info("purge_old_readings: deleted %d rows (cutoff=%s)", deleted, cutoff.date())
    return deleted


async def purge_loop() -> None:
    """毎日 UTC 03:00 に purge_old_readings を実行するループ。"""
    while True:
        now = datetime.now(UTC)
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        wait_seconds = (next_run - now).total_seconds()
        _logger.info("purge_loop: next run at %s (%.0fs)", next_run.isoformat(), wait_seconds)
        await asyncio.sleep(wait_seconds)
        try:
            await purge_old_readings()
        except Exception:
            _logger.exception("purge_loop: error during purge")
