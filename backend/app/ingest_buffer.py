"""Ingestバッファ: POST /api/ingest/readings 受信毎にメモリへ追加、1秒毎にbatch flush。

docs/architecture.md §5 センサーの取り込み 参照。
トレードオフ: 最大1秒分のデータがクラッシュで喪失される可能性（Phase 0 では許容）。

流れ:
1. 受信（API）: 測定値をメモリ上のバッファに入れて、すぐ応答する（DB は待たない）
2. flush（1秒ごと）: バッファを空にして、まとめて DB に書く
3. 同じ flush の中で、アラームの評価（alarm_engine）、Discord 通知、Webhook 配信を行う
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
from app.webhooks import send_webhook

FLUSH_INTERVAL_SECONDS = 1.0

# DB 障害が長引いたときに、再試行待ちの測定値でメモリを使い切らないための上限
# （1件あたり約 200 バイト → 約 20 MB）。超えた分は古いものから捨てる
MAX_PENDING_READINGS = 100_000

logger = logging.getLogger(__name__)


@dataclass
class PendingReading:
    """バッファに入っている1件の測定値（まだ DB に書いていないもの）。"""

    sensor_id: UUID
    value: float
    recorded_at: datetime


class IngestBuffer:
    """受信した測定値を一時的に溜めるバッファ。

    複数の受信処理（リクエスト）が同時に add しても、順番が壊れないように lock で守る。
    """

    def __init__(self) -> None:
        self._pending: list[PendingReading] = []
        self._lock = asyncio.Lock()

    async def add(self, reading: PendingReading) -> None:
        """測定値を1件、バッファの末尾に追加する。"""
        async with self._lock:
            self._pending.append(reading)

    async def drain(self) -> list[PendingReading]:
        """バッファの中身をすべて取り出し、バッファを空にする。

        取り出す（入れ替える）作業だけを lock の中で行い、DB への書き込みは lock の外で行う。
        """
        async with self._lock:
            pending, self._pending = self._pending, []
        return pending

    async def requeue(self, readings: list[PendingReading]) -> None:
        """DB に書けなかった測定値を、バッファの先頭に戻す（次の flush で再試行する）。

        drain の後に届いた値より前に置き、到着順を保つ。上限を超えた分は古いものから捨てる。
        """
        async with self._lock:
            self._pending = readings + self._pending
            overflow = len(self._pending) - MAX_PENDING_READINGS
            if overflow > 0:
                del self._pending[:overflow]
        if overflow > 0:
            logger.warning(
                "ingest buffer over capacity: dropped %d oldest readings", overflow
            )


# アプリ全体で1つのバッファ（API の受信処理と、flush_loop の両方から使う）
buffer = IngestBuffer()

# fire-and-forgetタスクへの強参照を保持（asyncio.create_task結果を即座に手放すと
# イベントループによってはタスクがGCされ、送信前に消えることがあるため）
_background_tasks: set[asyncio.Task[None]] = set()


def _fire_and_forget(coro: Coroutine[Any, Any, None]) -> None:
    """結果を待たずに、バックグラウンドで実行する（Webhook や Discord の送信に使う）。

    送信が遅くても、DB への書き込みや API の応答を待たせない。
    """
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
    """測定値を受信したとき（reading.received）の Webhook を、購読者へ送る。

    送信先は、センサーのワークスペースの購読に従う（ワークスペースごとに分ける）。
    """
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
    """アラームが発生したとき（alarm.triggered）の Webhook を、購読者へ送る。"""
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


async def _load_notification_settings(
    session: AsyncSession, workspace_ids: set[UUID | None]
) -> dict[UUID | None, NotificationSettings]:
    """ワークスペースごとの通知設定を返す（self-hosted は NULL のキー）。

    行が無いワークスペースは含めない（＝Discord通知しない）。
    self-hosted の行は NULL ワークスペースのもの。
    """
    result_by_workspace: dict[UUID | None, NotificationSettings] = {}

    non_null_ids = {w for w in workspace_ids if w is not None}
    if non_null_ids:
        rows = await session.exec(
            select(NotificationSettings).where(
                col(NotificationSettings.workspace_id).in_(non_null_ids)
            )
        )
        for row in rows.all():
            result_by_workspace[row.workspace_id] = row

    if None in workspace_ids:
        self_hosted = await session.exec(
            select(NotificationSettings).where(col(NotificationSettings.workspace_id).is_(None))
        )
        self_hosted_row = self_hosted.first()
        if self_hosted_row is not None:
            result_by_workspace[None] = self_hosted_row

    return result_by_workspace


async def flush_once() -> int:
    """バッファの内容を1回だけDBへbatch INSERTする。戻り値は書き込んだ件数。

    処理の順序（ここが重要）:
    1. 測定値を DB に書く → 2. アラームを評価する → 3. commit する（ここで初めて確定）
    4. commit の後で、Webhook と Discord 通知を送る（送信に失敗しても、DB は確定済み）

    commit より前に失敗した場合は、取り出した測定値をバッファに戻して例外を投げ直す
    （次の周期で再試行する）。commit の後の失敗では戻さない（二重に書かないため）。
    """
    pending = await buffer.drain()
    if not pending:
        return 0

    async with AsyncSession(engine) as session:
        try:
            pending, discord_jobs, notifications = await _write_and_evaluate(
                session, pending
            )
        except BaseException:
            # CancelledError（停止時）も含めて戻す。戻さないと取り出した分が消える
            await buffer.requeue(pending)
            raise
        if not pending:
            return 0

        # 汎用Webhook配信はDiscord専用通知の有効/無効フラグとは独立に動く
        # （セッションがまだ開いているうちに購読先を引いておく）
        await _dispatch_reading_webhooks(session, pending)
        if notifications:
            await _dispatch_alarm_webhooks(session, notifications)

    for webhook_url, notification in discord_jobs:
        _fire_and_forget(send_alarm_discord(webhook_url, notification))

    return len(pending)


async def _write_and_evaluate(
    session: AsyncSession, pending: list[PendingReading]
) -> tuple[list[PendingReading], list[tuple[str, AlarmNotification]], list[AlarmNotification]]:
    """測定値の書き込み・アラーム評価・commit までを行う。戻り値の測定値は、実際に書いたもの。"""
    # 通知設定はワークスペースごとに持つ（Settings画面から変更）。センサーのワークスペースに
    # 対応する設定を使う。重故障の再通知判定にも使うためevaluate_alarms呼び出し前に取得する
    sensors_result = await session.exec(
        select(Sensor.id, Sensor.workspace_id).where(
            col(Sensor.id).in_({p.sensor_id for p in pending})
        )
    )
    workspace_by_sensor: dict[UUID, UUID | None] = dict(sensors_result.all())

    # 受信から flush までの間に削除されたセンサーの値は捨てる。残すと外部キー違反で
    # バッチ全体が失敗し、再試行のたびに失敗し続けて、他のセンサーの値も書けなくなる
    existing = [p for p in pending if p.sensor_id in workspace_by_sensor]
    if len(existing) < len(pending):
        logger.info(
            "dropped %d readings for deleted sensors", len(pending) - len(existing)
        )
    if not existing:
        return [], [], []

    session.add_all(
        [
            Reading(sensor_id=p.sensor_id, value=p.value, recorded_at=p.recorded_at)
            for p in existing
        ]
    )
    settings_by_workspace = await _load_notification_settings(
        session, set(workspace_by_sensor.values())
    )
    notifications = await evaluate_alarms(session, existing, settings_by_workspace)
    # 送信先（重故障・軽故障で別々のURL）を、セッションがまだ開いている今のうちに
    # プレーン値へ退避する。有効フラグがオフのワークスペースは送らない
    discord_jobs: list[tuple[str, AlarmNotification]] = []
    for notification in notifications:
        settings_row = settings_by_workspace.get(notification.workspace_id)
        if settings_row is None or not settings_row.enabled:
            continue
        if notification.severity == AlarmSeverity.CRITICAL:
            url = settings_row.discord_webhook_url_critical
        else:
            url = settings_row.discord_webhook_url_warning
        if url:
            discord_jobs.append((url, notification))
    # ここで初めて確定する。これより前に失敗した場合、測定値もアラームも残らない
    await session.commit()
    return existing, discord_jobs, notifications


async def flush_loop() -> None:
    """常駐タスク（app/main.py の lifespan で起動する）。

    FLUSH_INTERVAL_SECONDS 毎にバッファを DB へ書き込み続ける。
    """
    while True:
        await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
        try:
            await flush_once()
        except Exception:
            # 1回のflush失敗でタスク全体を落とさない。値は flush_once がバッファに戻しており、
            # 次の周期で再試行される
            logger.exception("ingest buffer flush failed")
