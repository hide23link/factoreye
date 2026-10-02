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
from zoneinfo import ZoneInfo

import httpx

from app.db.models import AlarmSeverity, ThresholdBreached

logger = logging.getLogger(__name__)

# Discord Webhook/MessageのSUPPRESS_NOTIFICATIONSフラグ。付けて送信すると、チャンネルには
# 表示されるが受信者への通知音・プッシュ通知は出ない（軽故障をサイレントにするために使う）
_DISCORD_FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12

_JST = ZoneInfo("Asia/Tokyo")

_SEVERITY_LABEL = {AlarmSeverity.CRITICAL: ("🚨", "重故障"), AlarmSeverity.WARNING: ("⚠️", "軽故障")}
_DIRECTION_LABEL = {ThresholdBreached.MAX: "上限超過", ThresholdBreached.MIN: "下限未達"}


def _format_jst(dt: datetime) -> str:
    """ISO 8601のUTC表記は読みにくいため、日本時間の短い表記にする（例: 10月2日 21時41分）。"""
    local = dt.astimezone(_JST)
    return f"{local.month}月{local.day}日 {local.hour}時{local.minute:02d}分"


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
    emoji, severity_label = _SEVERITY_LABEL[notification.severity]
    repeat_suffix = "（再通知・未解決）" if notification.is_repeat else ""
    direction = _DIRECTION_LABEL[notification.threshold_breached]

    content = (
        f"{emoji} **{severity_label}: {notification.sensor_name}**{repeat_suffix}\n"
        f"{notification.value}{notification.sensor_unit}（{direction}）\n"
        f"{_format_jst(notification.triggered_at)}"
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
