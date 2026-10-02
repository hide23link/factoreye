"""ダッシュボード/ウィジェットAPIのテスト。"""
import httpx


async def test_create_and_get_dashboard(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/dashboards",
        json={"name": "工場A監視盤", "description": "メイン監視画面", "layoutConfig": {"cols": 3}},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "工場A監視盤"
    assert body["widgets"] == []
    dashboard_id = body["id"]

    got = await client.get(f"/api/dashboards/{dashboard_id}")
    assert got.status_code == 200
    assert got.json()["layoutConfig"] == {"cols": 3}


async def test_list_dashboards_excludes_deleted(client: httpx.AsyncClient) -> None:
    created = await client.post("/api/dashboards", json={"name": "一時ダッシュボード"})
    dashboard_id = created.json()["id"]

    await client.delete(f"/api/dashboards/{dashboard_id}")

    listed = await client.get("/api/dashboards")
    assert all(d["id"] != dashboard_id for d in listed.json())

    got = await client.get(f"/api/dashboards/{dashboard_id}")
    assert got.status_code == 404


async def test_update_dashboard(client: httpx.AsyncClient) -> None:
    created = await client.post("/api/dashboards", json={"name": "旧名称"})
    dashboard_id = created.json()["id"]

    updated = await client.put(f"/api/dashboards/{dashboard_id}", json={"name": "新名称"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "新名称"


async def test_add_update_delete_widget(client: httpx.AsyncClient) -> None:
    dashboard = await client.post("/api/dashboards", json={"name": "ウィジェットテスト用"})
    dashboard_id = dashboard.json()["id"]

    sensor = await client.post(
        "/api/sensors", json={"name": "温度", "ingestKey": "widget-test-sensor", "unit": "C"}
    )
    sensor_id = sensor.json()["id"]

    created = await client.post(
        f"/api/dashboards/{dashboard_id}/widgets",
        json={
            "type": "SensorGraph",
            "sensorId": sensor_id,
            "gridColumn": 1,
            "gridRow": 1,
            "gridWidth": 2,
            "gridHeight": 1,
            "config": {"graphType": "line", "timeRange": "1h"},
        },
    )
    assert created.status_code == 201
    widget_id = created.json()["id"]
    assert created.json()["dashboardId"] == dashboard_id

    detail = await client.get(f"/api/dashboards/{dashboard_id}")
    assert len(detail.json()["widgets"]) == 1

    updated = await client.put(f"/api/widgets/{widget_id}", json={"gridWidth": 3})
    assert updated.status_code == 200
    assert updated.json()["gridWidth"] == 3

    deleted = await client.delete(f"/api/widgets/{widget_id}")
    assert deleted.status_code == 204

    detail_after = await client.get(f"/api/dashboards/{dashboard_id}")
    assert detail_after.json()["widgets"] == []


async def test_update_widget_not_found_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.put(
        "/api/widgets/00000000-0000-0000-0000-000000000000", json={"gridWidth": 2}
    )
    assert resp.status_code == 404
