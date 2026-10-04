"""Free Tier 90日データ削除バッチ。

毎日 UTC 03:00 に実行し、90日以上前の Reading を削除する。
self-hosted（workspace_id IS NULL のセンサー）は対象外。

なぜ SaaS だけか: OSS（self-hosted）の利用者は、測定値を無期限に残すかどうかを自分で決める。
SaaS の無料枠では、保存量を一定に保つため、古い測定値を消す。
"""
import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import delete, select
from sqlalchemy.engine import CursorResult
from sqlmodel import col
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Reading, Sensor
from app.db.session import engine

# 測定値を残す日数（SaaS の無料枠の上限）
_RETENTION_DAYS = 90
_logger = logging.getLogger(__name__)


async def purge_old_readings() -> int:
    """90日以上前の Reading を削除し、削除件数を返す。"""
    cutoff = datetime.now(UTC) - timedelta(days=_RETENTION_DAYS)

    # 対象は、ワークスペースに属するセンサー（workspace_id が NULL でないもの）の測定値だけ。
    # self-hosted のセンサーは、この条件に入らないので消えない
    multi_tenant_sensor_ids = select(col(Sensor.id)).where(col(Sensor.workspace_id).is_not(None))

    stmt = (
        delete(Reading)
        .where(
            col(Reading.recorded_at) < cutoff,
            col(Reading.sensor_id).in_(multi_tenant_sensor_ids),
        )
        .execution_options(synchronize_session=False)
    )

    # 削除は1回の SQL で行う（件数が多くても、1件ずつ消さない）
    async with AsyncSession(engine) as session:
        result = cast(CursorResult[Any], await session.execute(stmt))
        await session.commit()

    deleted = result.rowcount
    _logger.info("purge_old_readings: deleted %d rows (cutoff=%s)", deleted, cutoff.date())
    return deleted


async def purge_loop() -> None:
    """毎日 UTC 03:00 に purge_old_readings を実行するループ（常駐タスク）。

    次の実行時刻を計算して眠り、起きたら削除する。失敗しても、ループは止めずに次の日を待つ。
    """
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
