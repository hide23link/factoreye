"""プラグインシステム（discovery/lifecycle/on_reading dispatch）のテスト。

`reading_logger`（app/plugins/installed/reading_logger）をサンプルプラグインとして使う。
lifespan はテストのASGITransportでは発火しないため、本番の起動処理と同じ
`manager.load_plugins()` をテスト側から明示的に呼ぶ（test_ingest.py が
`flush_once()` を直接呼ぶのと同じ方針）。
"""
from collections.abc import AsyncGenerator

import httpx
import pytest_asyncio
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import settings
from app.db.session import engine
from app.ingest_buffer import flush_once
from app.main import app
from app.plugins import manager
from app.plugins.installed.reading_logger import plugin as reading_logger_plugin

PLUGIN_NAME = "reading_logger"
VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


@pytest_asyncio.fixture(autouse=True)
async def _reset_plugin_runtime_state() -> AsyncGenerator[None, None]:
    # _loaded はモジュールレベルのランタイム状態（DBとは独立）なので、
    # テスト間のenabled/started状態が漏れないようテスト毎にリセットする。
    manager._reset_registry_for_tests()
    reading_logger_plugin.readings_seen = 0
    yield


async def _load_plugins() -> None:
    async with AsyncSession(engine) as session:
        await manager.load_plugins(app, session)


async def test_discover_registers_plugin_row(client: httpx.AsyncClient) -> None:
    await _load_plugins()

    resp = await client.get("/api/plugins")
    assert resp.status_code == 200
    names = {p["name"]: p for p in resp.json()}
    assert PLUGIN_NAME in names
    assert names[PLUGIN_NAME]["enabled"] is False
    assert names[PLUGIN_NAME]["version"] == "0.1.0"


async def test_enable_unknown_plugin_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.patch("/api/plugins/does-not-exist/enable")
    assert resp.status_code == 404


async def test_update_plugin_config(client: httpx.AsyncClient) -> None:
    await _load_plugins()

    resp = await client.put(
        f"/api/plugins/{PLUGIN_NAME}/config", json={"config": {"verbose": True}}
    )
    assert resp.status_code == 200
    assert resp.json()["config"] == {"verbose": True}


async def test_enable_mounts_routes_and_receives_readings(client: httpx.AsyncClient) -> None:
    await _load_plugins()

    enabled = await client.patch(f"/api/plugins/{PLUGIN_NAME}/enable")
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True

    stats = await client.get(f"/api/plugins/{PLUGIN_NAME}/stats")
    assert stats.status_code == 200
    assert stats.json()["readingsSeen"] == 0

    sensor = await client.post(
        "/api/sensors",
        json={"name": "plugin-test-sensor", "ingestKey": "plugin-test-sensor", "unit": "C"},
    )
    assert sensor.status_code == 201

    ingested = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "plugin-test-sensor", "value": 1.0},
    )
    assert ingested.status_code == 202
    await flush_once()

    stats = await client.get(f"/api/plugins/{PLUGIN_NAME}/stats")
    assert stats.json()["readingsSeen"] == 1


async def test_disable_stops_reading_dispatch(client: httpx.AsyncClient) -> None:
    await _load_plugins()
    await client.patch(f"/api/plugins/{PLUGIN_NAME}/enable")

    disabled = await client.patch(f"/api/plugins/{PLUGIN_NAME}/disable")
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False

    sensor = await client.post(
        "/api/sensors",
        json={"name": "disabled-plugin-sensor", "ingestKey": "disabled-plugin-sensor", "unit": "C"},
    )
    assert sensor.status_code == 201

    await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "disabled-plugin-sensor", "value": 1.0},
    )
    await flush_once()

    stats = await client.get(f"/api/plugins/{PLUGIN_NAME}/stats")
    assert stats.json()["readingsSeen"] == 0
