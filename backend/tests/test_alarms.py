"""アラーム評価エンジン（閾値比較・dedupe・解除）とACK APIのテスト。"""
import httpx

from app.config import settings
from app.ingest_buffer import flush_once

VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


async def _create_sensor(
    client: httpx.AsyncClient,
    ingest_key: str,
    threshold_min: float | None = None,
    threshold_max: float | None = None,
) -> str:
    resp = await client.post(
        "/api/sensors",
        json={
            "name": f"sensor-{ingest_key}",
            "ingestKey": ingest_key,
            "unit": "C",
            "thresholdMin": threshold_min,
            "thresholdMax": threshold_max,
        },
    )
    assert resp.status_code == 201
    return str(resp.json()["id"])


async def _ingest(client: httpx.AsyncClient, ingest_key: str, value: float) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": ingest_key, "value": value},
    )
    assert resp.status_code == 202


async def test_alarm_triggers_on_max_breach(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "max-breach-sensor", threshold_max=40.0)
    await _ingest(client, "max-breach-sensor", 45.0)
    await flush_once()

    resp = await client.get("/api/alarms", params={"status": "active"})
    assert resp.status_code == 200
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["sensorId"] == sensor_id
    assert alarms[0]["thresholdBreached"] == "max"
    assert alarms[0]["status"] == "active"


async def test_alarm_triggers_on_min_breach(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "min-breach-sensor", threshold_min=10.0)
    await _ingest(client, "min-breach-sensor", 5.0)
    await flush_once()

    resp = await client.get("/api/alarms", params={"status": "active"})
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["thresholdBreached"] == "min"


async def test_alarm_dedup_within_one_flush(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "dedup-sensor", threshold_max=40.0)
    for value in (45, 46, 47):
        await _ingest(client, "dedup-sensor", value)
    await flush_once()

    resp = await client.get("/api/alarms", params={"status": "active"})
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["value"] == 45


async def test_alarm_dedup_across_flushes(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "dedup-sensor-2", threshold_max=40.0)
    await _ingest(client, "dedup-sensor-2", 45.0)
    await flush_once()
    await _ingest(client, "dedup-sensor-2", 46.0)
    await flush_once()

    resp = await client.get("/api/alarms")
    assert resp.json()["total"] == 1


async def test_alarm_resolves_when_back_in_range(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "resolve-sensor", threshold_max=40.0)
    await _ingest(client, "resolve-sensor", 45.0)
    await flush_once()

    await _ingest(client, "resolve-sensor", 20.0)
    await flush_once()

    resp = await client.get("/api/alarms")
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["status"] == "resolved"
    assert alarms[0]["resolvedAt"] is not None

    active_resp = await client.get("/api/alarms", params={"status": "active"})
    assert active_resp.json()["total"] == 0


async def test_acknowledge_alarm(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "ack-sensor", threshold_max=40.0)
    await _ingest(client, "ack-sensor", 45.0)
    await flush_once()

    alarm_id = (await client.get("/api/alarms")).json()["alarms"][0]["id"]

    resp = await client.patch(f"/api/alarms/{alarm_id}/ack", json={"acknowledgedBy": "admin"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "acknowledged"
    assert body["acknowledgedBy"] == "admin"
    assert body["acknowledgedAt"] is not None


async def test_acknowledge_already_acknowledged_conflicts(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "ack-conflict-sensor", threshold_max=40.0)
    await _ingest(client, "ack-conflict-sensor", 45.0)
    await flush_once()
    alarm_id = (await client.get("/api/alarms")).json()["alarms"][0]["id"]

    first = await client.patch(f"/api/alarms/{alarm_id}/ack", json={"acknowledgedBy": "admin"})
    assert first.status_code == 200

    second = await client.patch(f"/api/alarms/{alarm_id}/ack", json={"acknowledgedBy": "admin"})
    assert second.status_code == 409


async def test_alarm_delete_not_allowed(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "no-delete-sensor", threshold_max=40.0)
    await _ingest(client, "no-delete-sensor", 45.0)
    await flush_once()
    alarm_id = (await client.get("/api/alarms")).json()["alarms"][0]["id"]

    resp = await client.delete(f"/api/alarms/{alarm_id}")
    assert resp.status_code in (404, 405)
