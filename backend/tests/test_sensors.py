"""センサー管理API（CRUD）のテスト。JSON配線フォーマットはcamelCase。"""
from datetime import UTC, datetime, timedelta

import httpx

from app.config import settings
from app.ingest_buffer import flush_once


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


async def test_update_sensor_duplicate_name_conflicts(client: httpx.AsyncClient) -> None:
    payload_a = {"name": "センサーC", "ingestKey": "sensor-c", "unit": "C"}
    payload_b = {"name": "センサーD", "ingestKey": "sensor-d", "unit": "C"}
    await client.post("/api/sensors", json=payload_a)
    created_b = await client.post("/api/sensors", json=payload_b)
    sensor_b_id = created_b.json()["id"]

    resp = await client.put(f"/api/sensors/{sensor_b_id}", json={"name": "センサーC"})
    assert resp.status_code == 409

    # 自分自身の現在の名前に「更新」するのは衝突として扱わない
    unchanged = await client.put(f"/api/sensors/{sensor_b_id}", json={"name": "センサーD"})
    assert unchanged.status_code == 200


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


async def test_delete_sensor_allows_reuse_of_name_and_ingest_key(
    client: httpx.AsyncClient,
) -> None:
    """物理削除なので、削除済みと同じ名前・ingestKeyで再登録できる
    （旧soft-delete方式はunique制約に引っかかって不可能だった）。"""
    payload = {"name": "再利用センサー", "ingestKey": "reuse-sensor", "unit": "C"}
    first = await client.post("/api/sensors", json=payload)
    assert first.status_code == 201
    await client.delete(f"/api/sensors/{first.json()['id']}")

    second = await client.post("/api/sensors", json=payload)
    assert second.status_code == 201
    assert second.json()["id"] != first.json()["id"]


async def test_delete_sensor_cascades_readings_and_alarms(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/sensors",
        json={
            "name": "カスケード削除テスト用",
            "ingestKey": "cascade-delete-sensor",
            "unit": "C",
            "thresholdMax": 10.0,
        },
    )
    sensor_id = created.json()["id"]

    await client.post(
        "/api/ingest/readings",
        headers={"X-API-Key": settings.ingest_api_key},
        json={"ingestKey": "cascade-delete-sensor", "value": 15.0},
    )
    await flush_once()

    # 測定値・アラームが作られたことを前提条件として確認
    readings_before = await client.get("/api/readings", params={"sensor_id": sensor_id})
    assert readings_before.json()["total"] >= 1
    alarms_before = await client.get("/api/alarms")
    assert any(a["sensorId"] == sensor_id for a in alarms_before.json()["alarms"])

    deleted = await client.delete(f"/api/sensors/{sensor_id}")
    assert deleted.status_code == 204

    readings_after = await client.get("/api/readings", params={"sensor_id": sensor_id})
    assert readings_after.json()["total"] == 0
    alarms_after = await client.get("/api/alarms")
    assert all(a["sensorId"] != sensor_id for a in alarms_after.json()["alarms"])


async def test_delete_sensor_nulls_widget_reference_without_deleting_widget(
    client: httpx.AsyncClient,
) -> None:
    dashboard = await client.post("/api/dashboards", json={"name": "ウィジェットNULL化テスト用"})
    dashboard_id = dashboard.json()["id"]

    sensor = await client.post(
        "/api/sensors",
        json={"name": "ウィジェット紐付けテスト用", "ingestKey": "widget-null-sensor", "unit": "C"},
    )
    sensor_id = sensor.json()["id"]

    widget = await client.post(
        f"/api/dashboards/{dashboard_id}/widgets",
        json={
            "type": "SensorGraph",
            "sensorId": sensor_id,
            "gridColumn": 1,
            "gridRow": 1,
            "gridWidth": 2,
            "gridHeight": 1,
            "config": {},
        },
    )
    widget_id = widget.json()["id"]

    await client.delete(f"/api/sensors/{sensor_id}")

    detail = await client.get(f"/api/dashboards/{dashboard_id}")
    widgets = detail.json()["widgets"]
    assert len(widgets) == 1
    assert widgets[0]["id"] == widget_id
    assert widgets[0]["sensorId"] is None


async def test_sensor_readings_filtered_by_from_and_to(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/sensors",
        json={"name": "範囲フィルタ用", "ingestKey": "range-filter-sensor", "unit": "C"},
    )
    sensor_id = created.json()["id"]

    await client.post(
        "/api/ingest/readings",
        headers={"X-API-Key": settings.ingest_api_key},
        json={"ingestKey": "range-filter-sensor", "value": 1.0},
    )
    await flush_once()

    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()

    # fromが未来 → 該当なし
    none_resp = await client.get(
        f"/api/sensors/{sensor_id}/readings", params={"from": future}
    )
    assert none_resp.json()["total"] == 0

    # toが過去 → 該当なし
    none_resp_to = await client.get(
        f"/api/sensors/{sensor_id}/readings", params={"to": past}
    )
    assert none_resp_to.json()["total"] == 0

    # from/toが現在時刻を跨ぐ → 該当あり
    some_resp = await client.get(
        f"/api/sensors/{sensor_id}/readings", params={"from": past, "to": future}
    )
    assert some_resp.json()["total"] == 1
