"""POST /api/ingest/readings のテスト。

docs/architecture.md §12 テスト のシナリオ（認証・不正ペイロード・
高頻度バッチ）を実装に合わせて踏襲。Alarm評価・dedupeはSprint 4で追加。
"""
import time
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest

import app.ingest_buffer as ingest_buffer
import app.main as main_module
from app.config import settings
from app.ingest_buffer import IngestBuffer, PendingReading, flush_once
from app.main import app, lifespan

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


async def test_non_ascii_api_key_returns_401(client: httpx.AsyncClient) -> None:
    # 一定時間の比較でも、ASCII 以外のキーで 500 にならない
    resp = await client.post(
        "/api/ingest/readings",
        headers={b"X-API-Key": "キー".encode()},
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


async def test_flush_failure_requeues_readings_for_retry(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # commit 前に失敗しても値は消えず、次の flush で書かれる
    sensor_id = await _create_sensor(client, "retry-sensor")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "retry-sensor", "value": 7.0},
    )
    assert resp.status_code == 202

    async def _fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("db unavailable")

    with monkeypatch.context() as m:
        m.setattr(ingest_buffer, "evaluate_alarms", _fail)
        with pytest.raises(RuntimeError):
            await flush_once()

    assert await flush_once() == 1
    body = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    assert body["total"] == 1
    assert body["readings"][0]["value"] == 7.0


async def test_flush_drops_readings_of_deleted_sensor_without_blocking_others(
    client: httpx.AsyncClient,
) -> None:
    deleted_id = await _create_sensor(client, "deleted-before-flush")
    kept_id = await _create_sensor(client, "kept-sensor")
    for key in ("deleted-before-flush", "kept-sensor"):
        resp = await client.post(
            "/api/ingest/readings", headers=VALID_HEADERS, json={"ingestKey": key, "value": 1.0}
        )
        assert resp.status_code == 202
    assert (await client.delete(f"/api/sensors/{deleted_id}")).status_code in (200, 204)

    assert await flush_once() == 1
    assert await flush_once() == 0
    body = (await client.get(f"/api/sensors/{kept_id}/readings")).json()
    assert body["total"] == 1


async def test_requeue_keeps_order_and_drops_oldest_over_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ingest_buffer, "MAX_PENDING_READINGS", 3)
    buf = IngestBuffer()
    sensor_id = uuid4()

    def reading(value: float) -> PendingReading:
        return PendingReading(sensor_id=sensor_id, value=value, recorded_at=datetime.now(UTC))

    await buf.add(reading(3.0))
    await buf.add(reading(4.0))
    await buf.requeue([reading(1.0), reading(2.0)])

    assert [p.value for p in await buf.drain()] == [2.0, 3.0, 4.0]


async def test_shutdown_flushes_remaining_readings(client: httpx.AsyncClient) -> None:
    # 停止時、まだ DB に書いていない値を書いてから終了する
    sensor_id = await _create_sensor(client, "shutdown-sensor")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "shutdown-sensor", "value": 9.0},
    )
    assert resp.status_code == 202

    async with lifespan(app):
        pass

    body = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    assert body["total"] == 1


async def test_shutdown_continues_when_final_flush_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fail() -> int:
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(main_module, "flush_once", _fail)
    async with lifespan(app):
        pass


async def test_non_utf8_body_returns_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content=b"\xff\xfe\xfa",
    )
    assert resp.status_code == 400


@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity"])
async def test_non_finite_value_returns_400(client: httpx.AsyncClient, bad: str) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content=f'{{"ingestKey": "k", "value": {bad}}}'.encode(),
    )
    assert resp.status_code == 400


async def test_too_many_readings_returns_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "k", "readings": [{"value": 1}] * 1001},
    )
    assert resp.status_code == 400


async def test_exactly_max_readings_is_accepted(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "max-batch")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "max-batch", "readings": [{"value": 1}] * 1000},
    )
    assert resp.status_code == 202


async def test_non_finite_value_inside_readings_returns_400(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content=b'{"ingestKey": "k", "readings": [{"value": 1}, {"value": NaN}]}',
    )
    assert resp.status_code == 400
