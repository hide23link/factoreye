"""アラーム通知（app.notifications.send_alarm_discord）のテスト。

実際のDiscordには接続せず、httpx.AsyncClient.postをモックして検証する。
"""
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

from app.config import settings
from app.db.models import ThresholdBreached
from app.notifications import AlarmNotification, send_alarm_discord


def _sample_notification() -> AlarmNotification:
    return AlarmNotification(
        sensor_name="テストセンサー",
        sensor_unit="C",
        value=99.9,
        threshold_breached=ThresholdBreached.MAX,
        triggered_at=datetime.now(UTC),
    )


async def test_send_alarm_discord_skips_when_webhook_not_configured() -> None:
    # conftest/テスト環境では DISCORD_WEBHOOK_URL が未設定（デフォルト空文字）
    assert not settings.discord_webhook_url

    with patch("app.notifications.httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        await send_alarm_discord(_sample_notification())

    mock_post.assert_not_called()


async def test_send_alarm_discord_sends_when_configured() -> None:
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None

    with (
        patch.object(settings, "discord_webhook_url", "https://discord.com/api/webhooks/xxx/yyy"),
        patch(
            "app.notifications.httpx.AsyncClient.post",
            new_callable=AsyncMock,
            return_value=mock_response,
        ) as mock_post,
    ):
        await send_alarm_discord(_sample_notification())

    mock_post.assert_called_once()
    _, kwargs = mock_post.call_args
    assert "テストセンサー" in kwargs["json"]["content"]


async def test_send_alarm_discord_swallows_send_exception() -> None:
    # 送信失敗がingest/flushパイプライン全体を落とさないことを確認
    with (
        patch.object(settings, "discord_webhook_url", "https://discord.com/api/webhooks/xxx/yyy"),
        patch(
            "app.notifications.httpx.AsyncClient.post",
            new_callable=AsyncMock,
            side_effect=OSError("connection refused"),
        ),
    ):
        await send_alarm_discord(_sample_notification())  # 例外を再送出しないこと
