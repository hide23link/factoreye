"""アラーム発火時のDiscord Webhook通知（Phase 0）。

外部SaaSには依存せず、Discordの素のWebhook URLのみを使う（self-hostedの原則、OSS戦略参照）。
Webhook URL・有効/無効はSettings画面からDB（NotificationSettings）で管理する
（2026-10-02、.envの環境変数運用から移行）。呼び出し側（app.ingest_buffer）が
有効かつURL設定済みの場合のみこの関数を呼ぶ。

通知内容はORMオブジェクトではなくプレーンなdataclassで受け取る: 送信はDBセッション終了後に
バックグラウンドタスクとして実行されるため、detachされたORMインスタンスの遅延属性アクセスは
DetachedInstanceErrorになる（セッションが閉じた後にSensor/Alarmの属性へアクセスできない）。
"""
import logging
from dataclasses import dataclass
from datetime import datetime

import httpx

from app.db.models import AlarmSeverity, ThresholdBreached

logger = logging.getLogger(__name__)

# Discord Webhook/MessageのSUPPRESS_NOTIFICATIONSフラグ。付けて送信すると、チャンネルには
# 表示されるが受信者への通知音・プッシュ通知は出ない（軽故障をサイレントにするために使う）
_DISCORD_FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12


@dataclass
class AlarmNotification:
    sensor_name: str
    sensor_unit: str
    value: float
    threshold_breached: ThresholdBreached
    severity: AlarmSeverity
    # 重故障の再通知（NotificationSettings.critical_repeat_enabled）で送られた通知かどうか。
    # triggered_atは元の発生時刻のまま（再通知のたびに更新はしない）
    triggered_at: datetime
    is_repeat: bool = False


async def send_alarm_discord(webhook_url: str, notification: AlarmNotification) -> None:
    label = "🚨 重故障" if notification.severity == AlarmSeverity.CRITICAL else "⚠️ 軽故障"
    if notification.is_repeat:
        label += "（再通知・未解決）"

    content = (
        f"**[FactorEye] {label}: {notification.sensor_name}**\n"
        f"値: {notification.value} {notification.sensor_unit}\n"
        f"閾値超過: {notification.threshold_breached.value}\n"
        f"発生時刻: {notification.triggered_at.isoformat()}"
    )

    body: dict[str, object] = {"content": content}
    if notification.severity == AlarmSeverity.WARNING:
        # 軽故障はサイレント送信（通知音・プッシュ無し、チャンネルには表示される）
        body["flags"] = _DISCORD_FLAG_SUPPRESS_NOTIFICATIONS

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(webhook_url, json=body)
            response.raise_for_status()
    except Exception:
        # 通知失敗でingest/flushパイプラインを落とさない
        logger.exception(
            "failed to send alarm discord notification for sensor %s", notification.sensor_name
        )
