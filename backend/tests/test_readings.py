"""GET /api/readings（ダッシュボードpolling用の直近測定値一覧）のテスト。"""
import httpx
import pytest

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


# ──────────────────────────────────────────────────────────────
# from / to のタイムゾーン（TZ なしは 500 でなく 422）
# ──────────────────────────────────────────────────────────────


async def _sensor_for_range(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/api/sensors", json={"name": "range", "ingestKey": "k-range", "unit": "C"}
    )
    return str(resp.json()["id"])


@pytest.mark.parametrize(
    ("path", "params"),
    [
        ("readings", {"from": "2026-10-01T00:00:00"}),
        ("readings", {"to": "2026-10-01T00:00:00"}),
        ("readings/aggregate", {"from": "2026-10-01T00:00:00"}),
        ("readings/aggregate", {"from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00"}),
        ("readings/downsampled", {"from": "2026-10-01T00:00:00", "to": "2026-10-02T00:00:00"}),
        # 片方だけ TZ なし（比較で TypeError になっていた）
        ("readings/downsampled", {"from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00"}),
    ],
)
async def test_naive_datetime_in_range_is_422(
    client: httpx.AsyncClient, path: str, params: dict[str, str]
) -> None:
    sensor_id = await _sensor_for_range(client)
    resp = await client.get(f"/api/sensors/{sensor_id}/{path}", params=params)
    assert resp.status_code == 422


async def test_aware_datetime_in_range_is_accepted(client: httpx.AsyncClient) -> None:
    sensor_id = await _sensor_for_range(client)
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings",
        params={"from": "2026-10-01T09:00:00+09:00", "to": "2026-10-02T00:00:00Z"},
    )
    assert resp.status_code == 200
