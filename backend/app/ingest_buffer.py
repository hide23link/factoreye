"""Ingestバッファ: POST /api/ingest/readings 受信毎にメモリへ追加、1秒毎にbatch flush。

docs/factoreye-architecture.md §Ingest バッファ & バッチ書き込み 参照。
トレードオフ: 最大1秒分のデータがクラッシュで喪失される可能性（Phase 0 では許容）。
"""
import asyncio
import logging
from collections.abc import Coroutine
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlmodel.ext.asyncio.session import AsyncSession

from app.alarm_engine import evaluate_alarms
from app.db.models import Reading
from app.db.session import engine
from app.notifications import send_alarm_email
from app.plugins.base import SensorReadingEvent
from app.plugins.manager import dispatch_reading

FLUSH_INTERVAL_SECONDS = 1.0

logger = logging.getLogger(__name__)


@dataclass
class PendingReading:
    sensor_id: UUID
    value: float
    recorded_at: datetime


class IngestBuffer:
    def __init__(self) -> None:
        self._pending: list[PendingReading] = []
        self._lock = asyncio.Lock()

    async def add(self, reading: PendingReading) -> None:
        async with self._lock:
            self._pending.append(reading)

    async def drain(self) -> list[PendingReading]:
        async with self._lock:
            pending, self._pending = self._pending, []
        return pending


buffer = IngestBuffer()

# fire-and-forgetタスクへの強参照を保持（asyncio.create_task結果を即座に手放すと
# イベントループによってはタスクがGCされ、送信前に消えることがあるため）
_background_tasks: set[asyncio.Task[None]] = set()


def _fire_and_forget(coro: Coroutine[Any, Any, None]) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def flush_once() -> int:
    """バッファの内容を1回だけDBへbatch INSERTする。戻り値は書き込んだ件数。"""
    pending = await buffer.drain()
    if not pending:
        return 0

    async with AsyncSession(engine) as session:
        session.add_all(
            [
                Reading(sensor_id=p.sensor_id, value=p.value, recorded_at=p.recorded_at)
                for p in pending
            ]
        )
        notifications = await evaluate_alarms(session, pending)
        await session.commit()

    for notification in notifications:
        _fire_and_forget(send_alarm_email(notification))

    for p in pending:
        await dispatch_reading(
            SensorReadingEvent(
                sensor_id=str(p.sensor_id),
                value=p.value,
                timestamp=p.recorded_at.isoformat(),
            )
        )

    return len(pending)


async def flush_loop() -> None:
    """バックグラウンドタスク: FLUSH_INTERVAL_SECONDS毎にバッファをDBへ書き込み続ける。"""
    while True:
        await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
        try:
            await flush_once()
        except Exception:
            # 1回のflush失敗でタスク全体を落とさない（次の周期でリトライ）
            logger.exception("ingest buffer flush failed")
