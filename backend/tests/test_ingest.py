"""POST /api/ingest/readings のテスト。

docs/factoreye-architecture.md §Testing Strategy のシナリオ（認証・不正ペイロード・
高頻度バッチ）を実装に合わせて踏襲。Alarm評価・dedupeはSprint 4で追加。
"""
import time

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


async def test_invalid_api_key_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={"X-API-Key": "invalid"},
        json={"ingestKey": "sensor-1", "value": 42},
    )
    assert resp.status_code == 401


async def test_malformed_payload_does_not_crash_server(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content="invalid json {{{",
    )
    assert resp.status_code == 400
    assert (await client.get("/health")).status_code == 200


async def test_ingest_unknown_ingest_key_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "does-not-exist", "value": 1.0},
    )
    assert resp.status_code == 404


async def test_ingest_missing_ingest_key_returns_400(client: httpx.AsyncClient) -> None:
    # ingestKey自体が無い（Pydanticのバリデーションエラー経路）
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"value": 1.0},
    )
    assert resp.status_code == 400


async def test_ingest_neither_value_nor_readings_returns_400(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "empty-payload-sensor")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "empty-payload-sensor"},
    )
    assert resp.status_code == 400


async def test_ingest_disabled_sensor_returns_403(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "disabled-ingest-sensor")
    disable = await client.put(f"/api/sensors/{sensor_id}", json={"enabled": False})
    assert disable.status_code == 200

    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "disabled-ingest-sensor", "value": 1.0},
    )
    assert resp.status_code == 403


async def test_ingest_single_reading_persists_after_flush(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "single-reading-sensor")

    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "single-reading-sensor", "value": 23.5},
    )
    assert resp.status_code == 202
    assert resp.json()["accepted"] == 1

    await flush_once()

    readings = await client.get(f"/api/sensors/{sensor_id}/readings")
    assert readings.status_code == 200
    body = readings.json()
    assert body["total"] == 1
    assert body["readings"][0]["value"] == 23.5


async def test_ingest_batch_handles_many_readings(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "batch-sensor")
    readings = [{"value": i * 0.1} for i in range(1000)]

    start = time.monotonic()
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "batch-sensor", "readings": readings},
    )
    elapsed = time.monotonic() - start

    assert resp.status_code == 202
    assert resp.json()["accepted"] == 1000
    assert elapsed < 5.0

    flushed = await flush_once()
    assert flushed == 1000


async def test_flush_once_with_empty_buffer_returns_zero() -> None:
    # 何も溜まっていない状態でflushが呼ばれても0件として正常終了する
    assert await flush_once() == 0
