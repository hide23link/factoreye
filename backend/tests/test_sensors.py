"""センサー管理API（CRUD）のテスト。JSON配線フォーマットはcamelCase。"""
import httpx


async def test_create_sensor(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/sensors",
        json={
            "name": "圧力計A-1",
            "ingestKey": "pressure-a1",
            "unit": "MPa",
            "thresholdMin": 2.0,
            "thresholdMax": 8.5,
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["id"]
    assert body["name"] == "圧力計A-1"
    assert body["ingestKey"] == "pressure-a1"
    assert body["thresholdMax"] == 8.5
    assert body["enabled"] is True


async def test_create_sensor_duplicate_ingest_key_conflicts(client: httpx.AsyncClient) -> None:
    payload = {"name": "センサーA", "ingestKey": "dup-key", "unit": "C"}
    first = await client.post("/api/sensors", json=payload)
    assert first.status_code == 201

    second = await client.post(
        "/api/sensors", json={**payload, "name": "センサーB"}
    )
    assert second.status_code == 409


async def test_get_update_delete_sensor(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/sensors", json={"name": "湿度計B-1", "ingestKey": "humidity-b1", "unit": "%"}
    )
    sensor_id = created.json()["id"]

    got = await client.get(f"/api/sensors/{sensor_id}")
    assert got.status_code == 200
    assert got.json()["unit"] == "%"

    updated = await client.put(f"/api/sensors/{sensor_id}", json={"thresholdMax": 65.0})
    assert updated.status_code == 200
    assert updated.json()["thresholdMax"] == 65.0

    deleted = await client.delete(f"/api/sensors/{sensor_id}")
    assert deleted.status_code == 204

    after_delete = await client.get(f"/api/sensors/{sensor_id}")
    assert after_delete.status_code == 404


async def test_list_sensors_excludes_deleted(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/sensors", json={"name": "一時センサー", "ingestKey": "temp-sensor", "unit": "C"}
    )
    sensor_id = created.json()["id"]
    await client.delete(f"/api/sensors/{sensor_id}")

    listed = await client.get("/api/sensors")
    assert listed.status_code == 200
    assert all(s["id"] != sensor_id for s in listed.json())
