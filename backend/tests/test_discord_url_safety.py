"""Discord の Webhook URL の SSRF 対策と、送信失敗ログへの URL 漏えい防止のテスト。"""

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.config import settings
from app.db.models import AlarmSeverity, MinMax
from app.notifications import AlarmNotification, send_alarm_discord
from app.webhooks import send_webhook

SECRET_URL = "https://discord.com/api/webhooks/123456/SECRET-TOKEN-abc"


def _notification() -> AlarmNotification:
    from datetime import UTC, datetime

    return AlarmNotification(
        sensor_name="s",
        sensor_unit="C",
        value=1.0,
        threshold_breached=MinMax.MAX,
        severity=AlarmSeverity.CRITICAL,
        triggered_at=datetime.now(UTC),
    )


@pytest.fixture
def private_networks_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "webhook_allow_private_networks", False)


# ── 登録時の検証 ──────────────────────────────────────────────


@pytest.mark.parametrize("field", ["discordWebhookUrlCritical", "discordWebhookUrlWarning"])
@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data",
        "https://localhost/hook",
        "https://127.0.0.1/hook",
        "https://10.0.0.5/hook",
        "https://192.168.1.10/hook",
        "https://[::1]/hook",
        "http://discord.com/api/webhooks/1/x",  # https 以外
        "not a url",
    ],
)
async def test_internal_discord_url_is_rejected(
    client: httpx.AsyncClient, private_networks_off: None, field: str, url: str
) -> None:
    def resolve(host: str) -> list[str]:
        return [host.strip("[]")] if host[0].isdigit() or host[0] == "[" else ["127.0.0.1"]

    with patch("app.webhooks._addresses_for_host", resolve):
        resp = await client.put("/api/settings/notifications", json={field: url})
    assert resp.status_code == 422
    got = await client.get("/api/settings/notifications")
    assert got.json()[field] == ""


async def test_hostname_resolving_to_internal_is_rejected(
    client: httpx.AsyncClient, private_networks_off: None
) -> None:
    with patch("app.webhooks._addresses_for_host", lambda host: ["10.1.2.3"]):
        resp = await client.put(
            "/api/settings/notifications",
            json={"discordWebhookUrlCritical": "https://evil.example.com/x"},
        )
    assert resp.status_code == 422


async def test_empty_discord_url_is_allowed(client: httpx.AsyncClient) -> None:
    resp = await client.put(
        "/api/settings/notifications",
        json={"discordWebhookUrlCritical": "", "enabled": False},
    )
    assert resp.status_code == 200


async def test_private_discord_url_allowed_when_env_allows(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "webhook_allow_private_networks", True)
    resp = await client.put(
        "/api/settings/notifications",
        json={"discordWebhookUrlCritical": "http://192.168.1.10:8065/hooks/abc"},
    )
    assert resp.status_code == 200


# ── 送信時の検証 ──────────────────────────────────────────────


async def test_send_alarm_discord_revalidates_resolved_ip(
    private_networks_off: None,
) -> None:
    with (
        patch("app.webhooks._addresses_for_host", lambda host: ["169.254.169.254"]),
        patch("app.notifications.httpx.AsyncClient.post", new_callable=AsyncMock) as post,
    ):
        await send_alarm_discord(SECRET_URL, _notification())
    post.assert_not_called()


# ── ログに URL を出さない ─────────────────────────────────────


def _http_error(url: str) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", url)
    response = httpx.Response(404, request=request)
    return httpx.HTTPStatusError(
        f"Client error '404' for url '{url}'", request=request, response=response
    )


async def test_discord_failure_log_has_no_url(caplog: pytest.LogCaptureFixture) -> None:
    resp = MagicMock()
    resp.raise_for_status.side_effect = _http_error(SECRET_URL)
    with (
        caplog.at_level(logging.DEBUG),
        patch(
            "app.notifications.httpx.AsyncClient.post",
            new_callable=AsyncMock,
            return_value=resp,
        ),
    ):
        await send_alarm_discord(SECRET_URL, _notification())
    assert caplog.records
    text = caplog.text + "".join(str(r.exc_info) for r in caplog.records)
    assert "SECRET-TOKEN" not in text
    assert "123456" not in text
    assert "discord.com" in caplog.text  # ホスト名までは出してよい


async def test_discord_connect_error_log_has_no_url(caplog: pytest.LogCaptureFixture) -> None:
    err = httpx.ConnectError(f"cannot connect to {SECRET_URL}")
    with (
        caplog.at_level(logging.DEBUG),
        patch("app.notifications.httpx.AsyncClient.post", new_callable=AsyncMock, side_effect=err),
    ):
        await send_alarm_discord(SECRET_URL, _notification())
    assert caplog.records
    text = caplog.text + "".join(str(r.exc_info) for r in caplog.records)
    assert "SECRET-TOKEN" not in text


async def test_webhook_failure_log_has_no_url(caplog: pytest.LogCaptureFixture) -> None:
    url = "https://hooks.zapier.com/hooks/catch/111/SECRETPATH/"
    resp = MagicMock()
    resp.raise_for_status.side_effect = _http_error(url)
    with (
        caplog.at_level(logging.DEBUG),
        patch("app.webhooks.httpx.AsyncClient.post", new_callable=AsyncMock, return_value=resp),
    ):
        await send_webhook(url, {"a": 1})
    assert caplog.records
    text = caplog.text + "".join(str(r.exc_info) for r in caplog.records)
    assert "SECRETPATH" not in text
    assert "hooks.zapier.com" in caplog.text
