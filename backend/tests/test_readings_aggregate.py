"""GET /api/sensors/{id}/readings/aggregate（時間/日単位の合計値）のテスト。"""
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx

from app.config import settings
from app.ingest_buffer import flush_once

VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


async def _create_sensor(client: httpx.AsyncClient, ingest_key: str) -> str:
    resp = await client.post(
        "/api/sensors",
        json={"name": f"sensor-{ingest_key}", "ingestKey": ingest_key, "unit": "個"},
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


async def test_aggregate_sums_values_in_range(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "aggregate-sum-sensor")
    await _ingest(client, "aggregate-sum-sensor", 3.0)
    await _ingest(client, "aggregate-sum-sensor", 5.0)
    await flush_once()

    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/aggregate", params={"from": past}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sum"] == 8.0
    assert body["count"] == 2


async def test_aggregate_excludes_readings_outside_range(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "aggregate-range-sensor")
    await _ingest(client, "aggregate-range-sensor", 10.0)
    await flush_once()

    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/aggregate", params={"from": future}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sum"] == 0.0
    assert body["count"] == 0


async def test_aggregate_respects_to_upper_bound(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "aggregate-to-sensor")
    await _ingest(client, "aggregate-to-sensor", 7.0)
    await flush_once()

    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    just_before_now = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/aggregate",
        params={"from": past, "to": just_before_now},
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


async def test_aggregate_returns_zero_for_sensor_with_no_readings(
    client: httpx.AsyncClient,
) -> None:
    sensor_id = await _create_sensor(client, "aggregate-empty-sensor")

    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/aggregate", params={"from": past}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["sum"] == 0.0
    assert body["count"] == 0


async def test_aggregate_404_for_unknown_sensor(client: httpx.AsyncClient) -> None:
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    resp = await client.get(
        f"/api/sensors/{uuid4()}/readings/aggregate", params={"from": past}
    )
    assert resp.status_code == 404


async def test_aggregate_requires_from_param(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "aggregate-missing-from-sensor")
    resp = await client.get(f"/api/sensors/{sensor_id}/readings/aggregate")
    assert resp.status_code == 422
