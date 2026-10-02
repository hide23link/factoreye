"""アラーム通知メール（app.notifications.send_alarm_email）のテスト。

実際のSMTPサーバーには接続せず、aiosmtplib.send をモックして検証する。
"""
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

from app.config import settings
from app.db.models import ThresholdBreached
from app.notifications import AlarmNotification, send_alarm_email


def _sample_notification() -> AlarmNotification:
    return AlarmNotification(
        sensor_name="テストセンサー",
        sensor_unit="C",
        value=99.9,
        threshold_breached=ThresholdBreached.MAX,
        triggered_at=datetime.now(UTC),
    )


async def test_send_alarm_email_skips_when_smtp_not_configured() -> None:
    # conftest/テスト環境では SMTP_HOST / SMTP_TO が未設定（デフォルト空文字）
    assert not settings.smtp_host
    assert not settings.smtp_to

    with patch("app.notifications.aiosmtplib.send", new_callable=AsyncMock) as mock_send:
        await send_alarm_email(_sample_notification())

    mock_send.assert_not_called()


async def test_send_alarm_email_sends_when_configured() -> None:
    with (
        patch.object(settings, "smtp_host", "smtp.example.com"),
        patch.object(settings, "smtp_to", "ops@example.com"),
        patch("app.notifications.aiosmtplib.send", new_callable=AsyncMock) as mock_send,
    ):
        await send_alarm_email(_sample_notification())

    mock_send.assert_called_once()
    message = mock_send.call_args.args[0]
    assert "テストセンサー" in message["Subject"]
    assert message["To"] == "ops@example.com"


async def test_send_alarm_email_swallows_send_exception() -> None:
    # SMTP送信失敗がingest/flushパイプライン全体を落とさないことを確認
    with (
        patch.object(settings, "smtp_host", "smtp.example.com"),
        patch.object(settings, "smtp_to", "ops@example.com"),
        patch(
            "app.notifications.aiosmtplib.send",
            new_callable=AsyncMock,
            side_effect=OSError("connection refused"),
        ),
    ):
        await send_alarm_email(_sample_notification())  # 例外を再送出しないこと
