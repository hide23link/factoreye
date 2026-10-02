"""GET /api/readings（ダッシュボードpolling用の直近測定値一覧）のテスト。"""
import httpx

from app.config import settings
from app.ingest_buffer import flush_once

VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


async def _create_sensor(client: httpx.AsyncClient, ingest_key: str) -> str:
    resp = await client.post(
        "/api/sensors",
        json={"name": f"sensor-{ingest_key}", "ingestKey": ingest_key, "unit": "C"},
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


async def test_list_readings_returns_recent_values(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "readings-list-sensor")
    await _ingest(client, "readings-list-sensor", 1.0)
    await _ingest(client, "readings-list-sensor", 2.0)
    await flush_once()

    resp = await client.get("/api/readings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] >= 2
    values = {r["value"] for r in body["readings"]}
    assert {1.0, 2.0} <= values


async def test_list_readings_filtered_by_sensor_id(client: httpx.AsyncClient) -> None:
    sensor_a = await _create_sensor(client, "readings-filter-a")
    await _create_sensor(client, "readings-filter-b")
    await _ingest(client, "readings-filter-a", 10.0)
    await _ingest(client, "readings-filter-b", 20.0)
    await flush_once()

    # list_readingsのsensor_idクエリパラメータはaliasが無く、JSONボディと違いcamelCase化されない
    resp = await client.get("/api/readings", params={"sensor_id": sensor_a})
    assert resp.status_code == 200
    body = resp.json()
    assert all(r["sensorId"] == sensor_a for r in body["readings"])
    assert any(r["value"] == 10.0 for r in body["readings"])


async def test_list_readings_respects_limit(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "readings-limit-sensor")
    for value in range(5):
        await _ingest(client, "readings-limit-sensor", float(value))
    await flush_once()

    resp = await client.get("/api/readings", params={"limit": 2})
    assert resp.status_code == 200
    assert len(resp.json()["readings"]) <= 2
