"""Webhook連携（Phase 1）のテスト。

設定CRUD(/api/settings/webhooks)と、flush_once()からの配信(reading.received/alarm.triggered)を
それぞれ検証する。実際のHTTP送信は行わず、app.ingest_buffer.send_webhookをモックする
（test_notifications.pyがsend_alarm_discordをモックするのと同方針）。
"""
from unittest.mock import AsyncMock, patch

import httpx

from app.config import settings
from app.ingest_buffer import flush_once

VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


async def _create_sensor(client: httpx.AsyncClient, ingest_key: str, **thresholds: float) -> str:
    resp = await client.post(
        "/api/sensors",
        json={"name": ingest_key, "ingestKey": ingest_key, "unit": "C", **thresholds},
    )
    assert resp.status_code == 201
    return str(resp.json()["id"])


# ──────────────────────────────────────────────────────────────
# CRUD
# ──────────────────────────────────────────────────────────────


async def test_list_webhooks_empty_by_default(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/settings/webhooks")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_create_and_list_webhook(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/settings/webhooks",
        json={"eventType": "reading.received", "url": "https://hooks.example.com/abc"},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["eventType"] == "reading.received"
    assert body["url"] == "https://hooks.example.com/abc"
    assert body["enabled"] is True

    listed = await client.get("/api/settings/webhooks")
    assert len(listed.json()) == 1


async def test_update_webhook_url_and_enabled(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/settings/webhooks",
        json={"eventType": "alarm.triggered", "url": "https://hooks.example.com/old"},
    )
    webhook_id = created.json()["id"]

    updated = await client.put(
        f"/api/settings/webhooks/{webhook_id}",
        json={"url": "https://hooks.example.com/new", "enabled": False},
    )
    assert updated.status_code == 200
    assert updated.json()["url"] == "https://hooks.example.com/new"
    assert updated.json()["enabled"] is False


async def test_update_unknown_webhook_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.put(
        "/api/settings/webhooks/00000000-0000-0000-0000-000000000000",
        json={"enabled": False},
    )
    assert resp.status_code == 404


async def test_delete_webhook(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/settings/webhooks",
        json={"eventType": "reading.received", "url": "https://hooks.example.com/abc"},
    )
    webhook_id = created.json()["id"]

    deleted = await client.delete(f"/api/settings/webhooks/{webhook_id}")
    assert deleted.status_code == 204

    listed = await client.get("/api/settings/webhooks")
    assert listed.json() == []


# ──────────────────────────────────────────────────────────────
# 配信: reading.received
# ──────────────────────────────────────────────────────────────


async def test_reading_received_webhook_fires_on_flush(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "webhook-reading-sensor")
    await client.post(
        "/api/settings/webhooks",
        json={"eventType": "reading.received", "url": "https://hooks.example.com/reading"},
    )

    with patch("app.ingest_buffer.send_webhook", new_callable=AsyncMock) as mock_send:
        ingested = await client.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={"ingestKey": "webhook-reading-sensor", "value": 42.0},
        )
        assert ingested.status_code == 202
        await flush_once()

    mock_send.assert_called_once()
    url, payload = mock_send.call_args[0]
    assert url == "https://hooks.example.com/reading"
    assert payload["event"] == "reading.received"
    assert payload["sensorId"] == sensor_id
    assert payload["value"] == 42.0


async def test_disabled_reading_webhook_does_not_fire(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "webhook-disabled-sensor")
    created = await client.post(
        "/api/settings/webhooks",
        json={"eventType": "reading.received", "url": "https://hooks.example.com/reading"},
    )
    await client.put(
        f"/api/settings/webhooks/{created.json()['id']}", json={"enabled": False}
    )

    with patch("app.ingest_buffer.send_webhook", new_callable=AsyncMock) as mock_send:
        await client.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={"ingestKey": "webhook-disabled-sensor", "value": 1.0},
        )
        await flush_once()

    mock_send.assert_not_called()


async def test_reading_webhook_for_other_event_type_does_not_fire(
    client: httpx.AsyncClient,
) -> None:
    await _create_sensor(client, "webhook-alarm-only-sensor")
    await client.post(
        "/api/settings/webhooks",
        json={"eventType": "alarm.triggered", "url": "https://hooks.example.com/alarm-only"},
    )

    with patch("app.ingest_buffer.send_webhook", new_callable=AsyncMock) as mock_send:
        await client.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={"ingestKey": "webhook-alarm-only-sensor", "value": 1.0},
        )
        await flush_once()

    mock_send.assert_not_called()


# ──────────────────────────────────────────────────────────────
# 配信: alarm.triggered
# ──────────────────────────────────────────────────────────────


async def test_alarm_triggered_webhook_fires_on_threshold_breach(
    client: httpx.AsyncClient,
) -> None:
    await _create_sensor(client, "webhook-alarm-sensor", thresholdMaxCritical=50.0)
    await client.post(
        "/api/settings/webhooks",
        json={"eventType": "alarm.triggered", "url": "https://hooks.example.com/alarm"},
    )

    with patch("app.ingest_buffer.send_webhook", new_callable=AsyncMock) as mock_send:
        await client.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={"ingestKey": "webhook-alarm-sensor", "value": 99.0},
        )
        await flush_once()

    mock_send.assert_called_once()
    url, payload = mock_send.call_args[0]
    assert url == "https://hooks.example.com/alarm"
    assert payload["event"] == "alarm.triggered"
    assert payload["severity"] == "critical"
    assert payload["value"] == 99.0


async def test_alarm_not_triggered_does_not_fire_alarm_webhook(
    client: httpx.AsyncClient,
) -> None:
    await _create_sensor(client, "webhook-no-alarm-sensor", thresholdMaxCritical=50.0)
    await client.post(
        "/api/settings/webhooks",
        json={"eventType": "alarm.triggered", "url": "https://hooks.example.com/alarm"},
    )

    with patch("app.ingest_buffer.send_webhook", new_callable=AsyncMock) as mock_send:
        await client.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={"ingestKey": "webhook-no-alarm-sensor", "value": 1.0},
        )
        await flush_once()

    mock_send.assert_not_called()
