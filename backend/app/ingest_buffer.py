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

from sqlalchemy import or_
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.alarm_engine import evaluate_alarms
from app.db.models import (
    AlarmSeverity,
    NotificationSettings,
    Reading,
    Sensor,
    WebhookEventType,
    WebhookSubscription,
)
from app.db.session import engine
from app.notifications import AlarmNotification, send_alarm_discord
from app.plugins.base import SensorReadingEvent
from app.plugins.manager import dispatch_reading
from app.webhooks import send_webhook

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


async def _load_webhook_subscriptions(
    session: AsyncSession, event_type: WebhookEventType, workspace_ids: set[UUID | None]
) -> dict[UUID | None, list[WebhookSubscription]]:
    """指定イベント種別・有効なものだけを、workspace_id別にまとめて返す。

    workspace_idはNULL（self-hosted）を含みうるため、`IN`だけでは拾えないNULLを
    `IS NULL`で別途補う（SQLの`IN (NULL, ...)`はNULL自身にはマッチしない）。
    """
    conditions = []
    non_null_ids = {w for w in workspace_ids if w is not None}
    if non_null_ids:
        conditions.append(col(WebhookSubscription.workspace_id).in_(non_null_ids))
    if None in workspace_ids:
        conditions.append(col(WebhookSubscription.workspace_id).is_(None))
    if not conditions:
        return {}

    result = await session.exec(
        select(WebhookSubscription).where(
            WebhookSubscription.event_type == event_type,
            col(WebhookSubscription.enabled).is_(True),
            or_(*conditions),
        )
    )
    subs_by_workspace: dict[UUID | None, list[WebhookSubscription]] = {}
    for sub in result.all():
        subs_by_workspace.setdefault(sub.workspace_id, []).append(sub)
    return subs_by_workspace


async def _dispatch_reading_webhooks(
    session: AsyncSession, pending: list[PendingReading]
) -> None:
    sensor_ids = {p.sensor_id for p in pending}
    sensors_result = await session.exec(
        select(Sensor.id, Sensor.workspace_id).where(col(Sensor.id).in_(sensor_ids))
    )
    workspace_by_sensor: dict[UUID, UUID | None] = dict(sensors_result.all())

    subs_by_workspace = await _load_webhook_subscriptions(
        session, WebhookEventType.READING_RECEIVED, set(workspace_by_sensor.values())
    )
    if not subs_by_workspace:
        return

    for p in pending:
        for sub in subs_by_workspace.get(workspace_by_sensor.get(p.sensor_id), []):
            _fire_and_forget(
                send_webhook(
                    sub.url,
                    {
                        "event": WebhookEventType.READING_RECEIVED.value,
                        "sensorId": str(p.sensor_id),
                        "value": p.value,
                        "recordedAt": p.recorded_at.isoformat(),
                    },
                )
            )


async def _dispatch_alarm_webhooks(
    session: AsyncSession, notifications: list[AlarmNotification]
) -> None:
    workspace_ids = {n.workspace_id for n in notifications}
    subs_by_workspace = await _load_webhook_subscriptions(
        session, WebhookEventType.ALARM_TRIGGERED, workspace_ids
    )
    if not subs_by_workspace:
        return

    for notification in notifications:
        for sub in subs_by_workspace.get(notification.workspace_id, []):
            _fire_and_forget(
                send_webhook(
                    sub.url,
                    {
                        "event": WebhookEventType.ALARM_TRIGGERED.value,
                        "sensorId": str(notification.sensor_id) if notification.sensor_id else None,
                        "sensorName": notification.sensor_name,
                        "value": notification.value,
                        "severity": notification.severity.value,
                        "thresholdBreached": notification.threshold_breached.value,
                        "triggeredAt": notification.triggered_at.isoformat(),
                        "isRepeat": notification.is_repeat,
                    },
                )
            )


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
        # Webhook URL/有効フラグ/再通知設定はDB管理（Settings画面から変更、2026-10-02に
        # .envから移行）。重故障の再通知判定にも使うためevaluate_alarms呼び出し前に取得する
        notif_settings = await session.get(NotificationSettings, 1)
        notifications = await evaluate_alarms(session, pending, notif_settings)
        # 重故障・軽故障で別々のURLに送り分ける。セッションがまだ開いている今のうちに
        # プレーン値へ退避する
        webhook_urls = {
            AlarmSeverity.CRITICAL: (
                notif_settings.discord_webhook_url_critical if notif_settings else ""
            ),
            AlarmSeverity.WARNING: (
                notif_settings.discord_webhook_url_warning if notif_settings else ""
            ),
        }
        notify_enabled = notif_settings.enabled if notif_settings else False
        await session.commit()

        # 汎用Webhook配信はDiscord専用通知の有効/無効フラグとは独立に動く
        # （セッションがまだ開いているうちに購読先を引いておく）
        await _dispatch_reading_webhooks(session, pending)
        if notifications:
            await _dispatch_alarm_webhooks(session, notifications)

    if notify_enabled:
        for notification in notifications:
            webhook_url = webhook_urls[notification.severity]
            if webhook_url:
                _fire_and_forget(send_alarm_discord(webhook_url, notification))

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
