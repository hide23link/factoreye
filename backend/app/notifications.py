"""アラーム発火時のEmail通知（Phase 0: 汎用SMTP、aiosmtplib使用）。

SendGrid等の外部SaaSには依存しない（self-hostedの原則、OSS戦略参照）。
SMTP_HOST / SMTP_TO が未設定の場合は送信をスキップする。

通知内容はORMオブジェクトではなくプレーンなdataclassで受け取る: 送信はDBセッション終了後に
バックグラウンドタスクとして実行されるため、detachされたORMインスタンスの遅延属性アクセスは
DetachedInstanceErrorになる（セッションが閉じた後にSensor/Alarmの属性へアクセスできない）。
"""
import logging
from dataclasses import dataclass
from datetime import datetime
from email.message import EmailMessage

import aiosmtplib

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


async def send_alarm_email(notification: AlarmNotification) -> None:
    if not settings.smtp_host or not settings.smtp_to:
        return

    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = settings.smtp_to
    message["Subject"] = f"[FactorEye] アラーム発生: {notification.sensor_name}"
    message.set_content(
        f"センサー: {notification.sensor_name}\n"
        f"値: {notification.value} {notification.sensor_unit}\n"
        f"閾値超過: {notification.threshold_breached.value}\n"
        f"発生時刻: {notification.triggered_at.isoformat()}\n"
    )

    try:
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_user or None,
            password=settings.smtp_password or None,
            use_tls=settings.smtp_use_tls,
        )
    except Exception:
        # 通知失敗でingest/flushパイプラインを落とさない
        logger.exception("failed to send alarm email for sensor %s", notification.sensor_name)
