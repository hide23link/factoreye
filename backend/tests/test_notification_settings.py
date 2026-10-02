"""通知設定API（/api/settings/notifications）のテスト。シングルトン行（id=1）の読み書き。
重故障・軽故障で別々のDiscord Webhook URLを持つ。
"""
import httpx


async def test_get_notification_settings_defaults(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/settings/notifications")
    assert resp.status_code == 200
    body = resp.json()
    assert body["discordWebhookUrlCritical"] == ""
    assert body["discordWebhookUrlWarning"] == ""
    assert body["enabled"] is True
    assert body["criticalRepeatEnabled"] is False
    assert body["criticalRepeatIntervalMinutes"] == 30


async def test_update_critical_repeat_settings(client: httpx.AsyncClient) -> None:
    resp = await client.put(
        "/api/settings/notifications",
        json={"criticalRepeatEnabled": True, "criticalRepeatIntervalMinutes": 15},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["criticalRepeatEnabled"] is True
    assert body["criticalRepeatIntervalMinutes"] == 15

    got = await client.get("/api/settings/notifications")
    assert got.json()["criticalRepeatEnabled"] is True
    assert got.json()["criticalRepeatIntervalMinutes"] == 15


async def test_update_critical_repeat_interval_rejects_non_positive(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.put(
        "/api/settings/notifications", json={"criticalRepeatIntervalMinutes": 0}
    )
    assert resp.status_code == 422


async def test_update_notification_settings(client: httpx.AsyncClient) -> None:
    resp = await client.put(
        "/api/settings/notifications",
        json={
            "discordWebhookUrlCritical": "https://discord.com/api/webhooks/critical/xxx",
            "discordWebhookUrlWarning": "https://discord.com/api/webhooks/warning/yyy",
            "enabled": False,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["discordWebhookUrlCritical"] == "https://discord.com/api/webhooks/critical/xxx"
    assert body["discordWebhookUrlWarning"] == "https://discord.com/api/webhooks/warning/yyy"
    assert body["enabled"] is False

    got = await client.get("/api/settings/notifications")
    assert got.json()["discordWebhookUrlCritical"] == (
        "https://discord.com/api/webhooks/critical/xxx"
    )
    assert got.json()["discordWebhookUrlWarning"] == (
        "https://discord.com/api/webhooks/warning/yyy"
    )
    assert got.json()["enabled"] is False


async def test_update_notification_settings_partial(client: httpx.AsyncClient) -> None:
    await client.put(
        "/api/settings/notifications",
        json={"discordWebhookUrlCritical": "https://discord.com/api/webhooks/critical/xxx"},
    )
    # discordWebhookUrlWarning/enabledを指定しない更新は既存値を変更しない
    resp = await client.put("/api/settings/notifications", json={"enabled": False})
    assert resp.status_code == 200
    body = resp.json()
    assert body["discordWebhookUrlCritical"] == "https://discord.com/api/webhooks/critical/xxx"
    assert body["discordWebhookUrlWarning"] == ""
    assert body["enabled"] is False
