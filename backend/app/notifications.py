"""アラーム発火時のDiscord Webhook通知（Phase 0）。

外部SaaSには依存せず、Discordの素のWebhook URLのみを使う（self-hostedの原則、OSS戦略参照）。
Webhook URL・有効/無効はSettings画面からDB（NotificationSettings）で管理する
（2026-10-02、.envの環境変数運用から移行）。呼び出し側（app.ingest_buffer）が
有効かつURL設定済みの場合のみこの関数を呼ぶ。

通知内容はORMオブジェクトではなくプレーンなdataclassで受け取る: 送信はDBセッション終了後に
バックグラウンドタスクとして実行されるため、detachされたORMインスタンスの遅延属性アクセスは
DetachedInstanceErrorになる（セッションが閉じた後にSensor/Alarmの属性へアクセスできない）。

【誰が・いつ呼ぶか】send_alarm_discord は、ingest_buffer.py の flush_once が、アラームを DB に
確定（commit）した後に、バックグラウンドで呼ぶ（結果は待たない）。
渡すもの: webhook_url（Discord の送信先 URL）、notification（通知の内容 AlarmNotification）。
失敗しても例外は出さず、ログに残すだけ。
"""
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx

from app.db.models import AlarmSeverity, ThresholdBreached
from app.webhooks import assert_webhook_url_allowed, describe_send_error, redact_url

logger = logging.getLogger(__name__)

# Discord Webhook/MessageのSUPPRESS_NOTIFICATIONSフラグ。付けて送信すると、チャンネルには
# 表示されるが受信者への通知音・プッシュ通知は出ない（軽故障をサイレントにするために使う）
_DISCORD_FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12

# 通知の時刻は日本時間で表示する（利用者は日本の工場にいるため）
_JST = ZoneInfo("Asia/Tokyo")

# 重要度ごとの表示（絵文字と日本語の名前）
_SEVERITY_LABEL = {AlarmSeverity.CRITICAL: ("🚨", "重故障"), AlarmSeverity.WARNING: ("⚠️", "軽故障")}
# しきい値のどちら側を超えたかの表示
_DIRECTION_LABEL = {ThresholdBreached.MAX: "上限超過", ThresholdBreached.MIN: "下限未達"}


def _format_jst(moment: datetime) -> str:
    """ISO 8601のUTC表記は読みにくいため、日本時間の短い表記にする（例: 10月2日 21時41分）。"""
    local = moment.astimezone(_JST)
    return f"{local.month}月{local.day}日 {local.hour}時{local.minute:02d}分"


@dataclass
class AlarmNotification:
    """1件のアラーム通知の内容（プレーンな値だけを持つ。DB のオブジェクトは持たない）。"""

    sensor_name: str
    sensor_unit: str
    value: float
    threshold_breached: ThresholdBreached
    severity: AlarmSeverity
    # 重故障の再通知（NotificationSettings.critical_repeat_enabled）で送られた通知かどうか。
    # triggered_atは元の発生時刻のまま（再通知のたびに更新はしない）
    triggered_at: datetime
    is_repeat: bool = False
    # 汎用Webhook（app.webhooks）配信先の絞り込みに使う。Discord送信には使わない
    sensor_id: UUID | None = None
    workspace_id: UUID | None = None


async def send_alarm_discord(webhook_url: str, notification: AlarmNotification) -> None:
    """アラーム内容を、Discord の Webhook URL へ送る。

    送信に失敗しても、例外は外へ出さずログに残すだけにする（測定値の受信を止めないため）。
    """
    emoji, severity_label = _SEVERITY_LABEL[notification.severity]
    repeat_suffix = "（再通知・未解決）" if notification.is_repeat else ""
    direction = _DIRECTION_LABEL[notification.threshold_breached]
    # 再通知時は発生時刻と送信時刻がずれる（triggered_atは最初の発生時刻のまま）ため、
    # どれだけ未解決のまま継続しているかが分かるよう両方を併記する
    sent_at = datetime.now(UTC)

    content = (
        f"{emoji} **{severity_label}: {notification.sensor_name}**{repeat_suffix}\n"
        f"{notification.value}{notification.sensor_unit}（{direction}）\n"
        f"発生: {_format_jst(notification.triggered_at)}\n"
        f"送信: {_format_jst(sent_at)}"
    )

    body: dict[str, object] = {"content": content}
    if notification.severity == AlarmSeverity.WARNING:
        # 軽故障はサイレント送信（通知音・プッシュ無し、チャンネルには表示される）
        body["flags"] = _DISCORD_FLAG_SUPPRESS_NOTIFICATIONS

    try:
        # 登録後に宛先が内部を指すよう変わった場合に備え、送信直前（DNS 解決後の IP）にも検証する
        await assert_webhook_url_allowed(webhook_url)
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            response = await client.post(webhook_url, json=body)
            response.raise_for_status()
    except Exception as error:
        # 通知失敗でingest/flushパイプラインを落とさない。
        # Discord の URL はトークンを含む秘密なので、例外の本文・トレースバックは出さない
        logger.warning(
            "failed to send alarm discord notification for sensor %s to %s: %s",
            notification.sensor_name,
            redact_url(webhook_url),
            describe_send_error(error),
        )
