"""更新 API に null を送ったときのテスト。

NULL を許さない項目に null を送ると、保存されて以降の取得が 500 になったり、誤った 409 や
500 になったりしていた。NULL を許さない項目は 422、NULL を許す項目（ダッシュボードの説明、
ウィジェットのセンサー紐付け、センサーの閾値）は null で消せる。
"""
import httpx
import pytest


async def _dashboard(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/dashboards", json={"name": "盤", "layoutConfig": {"cols": 3}})
    assert resp.status_code == 201
    return str(resp.json()["id"])


async def _widget(client: httpx.AsyncClient, dashboard_id: str) -> str:
    resp = await client.post(
        f"/api/dashboards/{dashboard_id}/widgets",
        json={"type": "SensorGraph", "gridColumn": 1, "gridRow": 1, "gridWidth": 4,
              "gridHeight": 2, "config": {"a": 1}},
    )
    assert resp.status_code == 201
    return str(resp.json()["id"])


@pytest.mark.parametrize("field", ["name", "layoutConfig"])
async def test_dashboard_update_rejects_null_and_keeps_data_readable(
    client: httpx.AsyncClient, field: str
) -> None:
    dashboard_id = await _dashboard(client)
    resp = await client.put(f"/api/dashboards/{dashboard_id}", json={field: None})
    assert resp.status_code == 422
    # 保存されていない（一覧・詳細が壊れない）
    assert (await client.get("/api/dashboards")).status_code == 200
    got = await client.get(f"/api/dashboards/{dashboard_id}")
    assert got.status_code == 200
    assert got.json()["layoutConfig"] == {"cols": 3}


async def test_dashboard_description_can_be_cleared_with_null(client: httpx.AsyncClient) -> None:
    created = await client.post("/api/dashboards", json={"name": "盤", "description": "説明"})
    dashboard_id = created.json()["id"]
    resp = await client.put(f"/api/dashboards/{dashboard_id}", json={"description": None})
    assert resp.status_code == 200
    assert resp.json()["description"] is None


@pytest.mark.parametrize("field", ["config", "gridColumn", "gridRow", "gridWidth", "gridHeight"])
async def test_widget_update_rejects_null(client: httpx.AsyncClient, field: str) -> None:
    dashboard_id = await _dashboard(client)
    widget_id = await _widget(client, dashboard_id)
    resp = await client.put(f"/api/widgets/{widget_id}", json={field: None})
    assert resp.status_code == 422
    got = await client.get(f"/api/dashboards/{dashboard_id}")
    assert got.status_code == 200
    assert got.json()["widgets"][0]["config"] == {"a": 1}


async def test_widget_update_refreshes_updated_at(client: httpx.AsyncClient) -> None:
    dashboard_id = await _dashboard(client)
    widget_id = await _widget(client, dashboard_id)
    before = (await client.get(f"/api/dashboards/{dashboard_id}")).json()["widgets"][0]
    resp = await client.put(f"/api/widgets/{widget_id}", json={"gridRow": 3})
    assert resp.status_code == 200
    assert resp.json()["updatedAt"] > before["updatedAt"]


@pytest.mark.parametrize("field", ["name", "unit", "thresholdDeadBand", "enabled"])
async def test_sensor_update_rejects_null_with_422(client: httpx.AsyncClient, field: str) -> None:
    created = await client.post(
        "/api/sensors", json={"name": "温度", "ingestKey": "k-null-1", "unit": "C"}
    )
    sensor_id = created.json()["id"]
    resp = await client.put(f"/api/sensors/{sensor_id}", json={field: None})
    assert resp.status_code == 422
    assert (await client.get(f"/api/sensors/{sensor_id}")).json()["name"] == "温度"


async def test_sensor_threshold_can_be_cleared_with_null(client: httpx.AsyncClient) -> None:
    created = await client.post(
        "/api/sensors",
        json={"name": "温度", "ingestKey": "k-null-2", "unit": "C", "thresholdMaxCritical": 90},
    )
    sensor_id = created.json()["id"]
    resp = await client.put(f"/api/sensors/{sensor_id}", json={"thresholdMaxCritical": None})
    assert resp.status_code == 200
    assert resp.json()["thresholdMaxCritical"] is None


@pytest.mark.parametrize(
    "field",
    ["enabled", "discordWebhookUrlCritical", "discordWebhookUrlWarning",
     "criticalRepeatEnabled", "criticalRepeatIntervalMinutes"],
)
async def test_notification_settings_update_rejects_null(
    client: httpx.AsyncClient, field: str
) -> None:
    resp = await client.put("/api/settings/notifications", json={field: None})
    assert resp.status_code == 422
    assert (await client.get("/api/settings/notifications")).status_code == 200


@pytest.mark.parametrize("field", ["url", "enabled"])
async def test_webhook_update_rejects_null(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, field: str
) -> None:
    monkeypatch.setattr("app.webhooks._addresses_for_host", lambda host: ["93.184.216.34"])
    created = await client.post(
        "/api/settings/webhooks",
        json={"eventType": "reading.received", "url": "https://example.com/hook"},
    )
    assert created.status_code == 201
    subscription_id = created.json()["id"]
    resp = await client.put(f"/api/settings/webhooks/{subscription_id}", json={field: None})
    assert resp.status_code == 422
    assert (await client.get("/api/settings/webhooks")).status_code == 200
