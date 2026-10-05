"""GET /api/sensors/{id}/readings/downsampled（グラフ用の間引き）のテスト。"""

from datetime import UTC, datetime, timedelta

import httpx

from app.config import settings
from app.ingest_buffer import flush_once

VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


async def _create_sensor(client: httpx.AsyncClient, ingest_key: str) -> str:
    resp = await client.post(
        "/api/sensors",
        json={"name": f"sensor-{ingest_key}", "ingestKey": ingest_key, "unit": "℃"},
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


async def test_one_bucket_gives_min_avg_max_and_count(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "downsample-one-bucket")
    for value in (1.0, 3.0, 5.0):
        await _ingest(client, "downsample-one-bucket", value)
    await flush_once()

    now = datetime.now(UTC)
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/downsampled",
        params={
            "from": (now - timedelta(hours=1)).isoformat(),
            "to": (now + timedelta(hours=1)).isoformat(),
            "buckets": 1,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["buckets"]) == 1
    bucket = body["buckets"][0]
    assert bucket["min"] == 1.0
    assert bucket["max"] == 5.0
    assert bucket["avg"] == 3.0
    assert bucket["count"] == 3


async def test_empty_range_returns_no_buckets(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "downsample-empty")
    await _ingest(client, "downsample-empty", 10.0)
    await flush_once()

    past = datetime.now(UTC) - timedelta(days=10)
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/downsampled",
        params={
            "from": past.isoformat(),
            "to": (past + timedelta(hours=1)).isoformat(),
            "buckets": 10,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["buckets"] == []
    assert body["bucketSeconds"] == 360.0


async def test_bucket_start_is_aligned_to_from(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "downsample-aligned")
    await _ingest(client, "downsample-aligned", 7.0)
    await flush_once()

    # 測定値の時刻はテストの now より数ミリ秒前なので、区間の境界（10 分の位置）に
    # 重ならないよう、from を 12 分前にして区間 2（10〜15 分の位置）の中央に入れる
    now = datetime.now(UTC)
    start = now - timedelta(minutes=12)
    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/downsampled",
        params={
            "from": start.isoformat(),
            "to": (now + timedelta(minutes=8)).isoformat(),
            "buckets": 4,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    # 区間の幅は 20 分 / 4 = 5 分。区間 2 の開始は from + 10 分
    assert body["bucketSeconds"] == 300.0
    assert len(body["buckets"]) == 1
    bucket_start = datetime.fromisoformat(body["buckets"][0]["start"])
    expected = start + timedelta(seconds=300 * 2)
    assert abs((bucket_start - expected).total_seconds()) < 1


async def test_to_must_be_after_from(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "downsample-bad-range")
    now = datetime.now(UTC).isoformat()

    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/downsampled",
        params={"from": now, "to": now},
    )

    assert resp.status_code == 400


async def test_buckets_must_be_within_limit(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "downsample-too-many")
    now = datetime.now(UTC)

    resp = await client.get(
        f"/api/sensors/{sensor_id}/readings/downsampled",
        params={
            "from": (now - timedelta(hours=1)).isoformat(),
            "to": now.isoformat(),
            "buckets": 1001,
        },
    )

    assert resp.status_code == 422


async def test_unknown_sensor_returns_404(client: httpx.AsyncClient) -> None:
    now = datetime.now(UTC)
    resp = await client.get(
        "/api/sensors/00000000-0000-0000-0000-000000000000/readings/downsampled",
        params={
            "from": (now - timedelta(hours=1)).isoformat(),
            "to": now.isoformat(),
        },
    )

    assert resp.status_code == 404
