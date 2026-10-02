"""アラーム発火時のDiscord Webhook通知（Phase 0）。

外部SaaSには依存せず、Discordの素のWebhook URLのみを使う（self-hostedの原則、OSS戦略参照）。
DISCORD_WEBHOOK_URLが未設定の場合は送信をスキップする。

通知内容はORMオブジェクトではなくプレーンなdataclassで受け取る: 送信はDBセッション終了後に
バックグラウンドタスクとして実行されるため、detachされたORMインスタンスの遅延属性アクセスは
DetachedInstanceErrorになる（セッションが閉じた後にSensor/Alarmの属性へアクセスできない）。
"""
import logging
from dataclasses import dataclass
from datetime import datetime

import httpx

from app.config import settings
from app.db.models import ThresholdBreached

logger = logging.getLogger(__name__)


@dataclass
class AlarmNotification:
    sensor_name: str
    sensor_unit: str
    value: float
    threshold_breached: ThresholdBreached
    triggered_at: datetime


async def send_alarm_discord(notification: AlarmNotification) -> None:
    if not settings.discord_webhook_url:
        return

    content = (
        f"🚨 **[FactorEye] アラーム発生: {notification.sensor_name}**\n"
        f"値: {notification.value} {notification.sensor_unit}\n"
        f"閾値超過: {notification.threshold_breached.value}\n"
        f"発生時刻: {notification.triggered_at.isoformat()}"
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(settings.discord_webhook_url, json={"content": content})
            response.raise_for_status()
    except Exception:
        # 通知失敗でingest/flushパイプラインを落とさない
        logger.exception(
            "failed to send alarm discord notification for sensor %s", notification.sensor_name
        )
