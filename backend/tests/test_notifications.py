"""アラーム通知（app.notifications.send_alarm_discord）のテスト。

実際のDiscordには接続せず、httpx.AsyncClient.postをモックして検証する。
Webhook URL・有効/無効のDB設定からの読み出しはapp.ingest_buffer側の責務であり、
ここではsend_alarm_discordに直接webhook_urlを渡した場合の送信内容のみを検証する。
"""
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

from app.db.models import AlarmSeverity, ThresholdBreached
from app.notifications import AlarmNotification, send_alarm_discord

WEBHOOK_URL = "https://discord.com/api/webhooks/xxx/yyy"


def _sample_notification(severity: AlarmSeverity, is_repeat: bool = False) -> AlarmNotification:
    return AlarmNotification(
        sensor_name="テストセンサー",
        sensor_unit="C",
        value=99.9,
        threshold_breached=ThresholdBreached.MAX,
        severity=severity,
        triggered_at=datetime.now(UTC),
        is_repeat=is_repeat,
    )


async def test_send_alarm_discord_critical_sends_without_silent_flag() -> None:
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None

    with patch(
        "app.notifications.httpx.AsyncClient.post",
        new_callable=AsyncMock,
        return_value=mock_response,
    ) as mock_post:
        await send_alarm_discord(WEBHOOK_URL, _sample_notification(AlarmSeverity.CRITICAL))

    mock_post.assert_called_once()
    args, kwargs = mock_post.call_args
    assert args[0] == WEBHOOK_URL
    assert "テストセンサー" in kwargs["json"]["content"]
    assert "重故障" in kwargs["json"]["content"]
    assert "flags" not in kwargs["json"]


async def test_send_alarm_discord_warning_sends_with_silent_flag() -> None:
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None

    with patch(
        "app.notifications.httpx.AsyncClient.post",
        new_callable=AsyncMock,
        return_value=mock_response,
    ) as mock_post:
        await send_alarm_discord(WEBHOOK_URL, _sample_notification(AlarmSeverity.WARNING))

    mock_post.assert_called_once()
    _, kwargs = mock_post.call_args
    assert "軽故障" in kwargs["json"]["content"]
    # SUPPRESS_NOTIFICATIONS (1 << 12): 通知音・プッシュ無しでサイレント送信
    assert kwargs["json"]["flags"] == 1 << 12


async def test_send_alarm_discord_repeat_notes_it_in_content() -> None:
    mock_response = MagicMock()
    mock_response.raise_for_status.return_value = None

    with patch(
        "app.notifications.httpx.AsyncClient.post",
        new_callable=AsyncMock,
        return_value=mock_response,
    ) as mock_post:
        await send_alarm_discord(
            WEBHOOK_URL, _sample_notification(AlarmSeverity.CRITICAL, is_repeat=True)
        )

    _, kwargs = mock_post.call_args
    assert "再通知" in kwargs["json"]["content"]


async def test_send_alarm_discord_swallows_send_exception() -> None:
    # 送信失敗がingest/flushパイプライン全体を落とさないことを確認
    with patch(
        "app.notifications.httpx.AsyncClient.post",
        new_callable=AsyncMock,
        side_effect=OSError("connection refused"),
    ):
        await send_alarm_discord(
            WEBHOOK_URL, _sample_notification(AlarmSeverity.CRITICAL)
        )  # 例外を再送出しないこと
