"""センサー一覧の JSON キャッシュ（版ごと）のテスト。古い内容を返さず、件数の上限を守ること。"""
import httpx

from app.api import sensors as sensors_api


async def test_repeated_full_reads_return_identical_bodies(client: httpx.AsyncClient) -> None:
    await client.post("/api/sensors", json={"name": "cache-a", "ingestKey": "cache-a", "unit": "C"})

    first = await client.get("/api/sensors")
    second = await client.get("/api/sensors")
    assert first.content == second.content
    assert first.headers["etag"] == second.headers["etag"]


async def test_a_change_is_visible_on_the_next_full_read(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/sensors", json={"name": "cache-b", "ingestKey": "cache-b", "unit": "C"}
    )
    sensor_id = created.json()["id"]
    assert (await client.get("/api/sensors")).json()[0]["thresholdMaxCritical"] is None

    await client.put(f"/api/sensors/{sensor_id}", json={"thresholdMaxCritical": 55.0})

    # キャッシュがあっても、版（ETag）が変わるため、新しい内容が返る
    after = await client.get("/api/sensors")
    assert after.json()[0]["thresholdMaxCritical"] == 55.0


async def test_cache_size_is_bounded(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/sensors", json={"name": "cache-c", "ingestKey": "cache-c", "unit": "C"}
    )
    sensor_id = created.json()["id"]
    for i in range(sensors_api._SENSOR_LIST_CACHE_SIZE + 5):
        await client.put(f"/api/sensors/{sensor_id}", json={"thresholdMaxCritical": float(i)})
        assert (await client.get("/api/sensors")).status_code == 200

    assert len(sensors_api._sensor_list_cache) <= sensors_api._SENSOR_LIST_CACHE_SIZE
