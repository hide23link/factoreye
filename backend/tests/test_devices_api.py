"""機器の管理API（/api/devices）のテスト。キー 1 回だけ・目印・所属・失効・削除。SaaS は 404。"""

import httpx
import pytest
from sqlmodel.ext.asyncio.session import AsyncSession

from app import device_keys
from app.config import AuthMode, settings
from app.db.session import engine
from app.ingest_buffer import flush_once


async def _sensor(client: httpx.AsyncClient, ingest_key: str) -> None:
    resp = await client.post(
        "/api/sensors", json={"name": f"dv-{ingest_key}", "ingestKey": ingest_key, "unit": "V"}
    )
    assert resp.status_code == 201


async def test_create_returns_key_once_and_list_hides_it(client: httpx.AsyncClient) -> None:
    created = await client.post("/api/devices", json={"name": "atom01", "line": " 第1ライン "})
    assert created.status_code == 201
    body = created.json()
    assert len(body["key"]) >= 40
    assert body["line"] == "第1ライン"
    assert body["sensors"] == []
    assert body["lastReceivedAt"] is None

    listed = await client.get("/api/devices")
    assert listed.status_code == 200
    assert [d["name"] for d in listed.json()] == ["atom01"]
    assert "key" not in listed.json()[0]
    assert body["key"] not in listed.text


async def test_key_hint_is_the_first_six_characters_only(client: httpx.AsyncClient) -> None:
    created = (await client.post("/api/devices", json={"name": "hint01"})).json()
    assert created["keyHint"] == created["key"][:6]

    listed = (await client.get("/api/devices")).json()
    assert listed[0]["keyHint"] == created["key"][:6]
    # 一覧には、キーの残り（7 文字目以降）は出ない
    assert created["key"][:7] not in str(listed)


async def test_duplicate_name_and_bad_input(client: httpx.AsyncClient) -> None:
    assert (await client.post("/api/devices", json={"name": "a"})).status_code == 201
    assert (await client.post("/api/devices", json={"name": "a"})).status_code == 409
    assert (await client.post("/api/devices", json={"name": "   "})).status_code == 422
    too_long = {"name": "b", "line": "x" * 41}
    assert (await client.post("/api/devices", json=too_long)).status_code == 422
    # 失敗した名前は作られていない
    assert [d["name"] for d in (await client.get("/api/devices")).json()] == ["a"]


async def test_attach_then_send_with_key_and_last_received(client: httpx.AsyncClient) -> None:
    await _sensor(client, "d1-temp")
    created = (await client.post("/api/devices", json={"name": "d1"})).json()

    attached = await client.post(
        f"/api/devices/{created['id']}/sensors", json={"ingestKeys": ["d1-temp", "no-such"]}
    )
    assert attached.status_code == 200
    assert attached.json() == {"missing": ["no-such"]}

    sent = await client.post(
        "/api/ingest/readings",
        headers={"X-Device-Key": created["key"]},
        json={"ingestKey": "d1-temp", "value": 1.5},
    )
    assert sent.status_code == 202
    await flush_once()

    device = (await client.get("/api/devices")).json()[0]
    assert device["sensors"] == ["d1-temp"]
    assert device["lastReceivedAt"] is not None


async def test_revoke_blocks_key_and_blocks_attach(client: httpx.AsyncClient) -> None:
    await _sensor(client, "d2-temp")
    created = (await client.post("/api/devices", json={"name": "d2"})).json()
    await client.post(f"/api/devices/{created['id']}/sensors", json={"ingestKeys": ["d2-temp"]})

    revoked = await client.post(f"/api/devices/{created['id']}/revoke")
    assert revoked.status_code == 200
    assert revoked.json()["revokedAt"] is not None
    # 2 回目も同じ結果（失効の時刻は変わらない）
    again = await client.post(f"/api/devices/{created['id']}/revoke")
    assert again.json()["revokedAt"] == revoked.json()["revokedAt"]

    sent = await client.post(
        "/api/ingest/readings",
        headers={"X-Device-Key": created["key"]},
        json={"ingestKey": "d2-temp", "value": 1},
    )
    assert sent.status_code == 401
    blocked = await client.post(
        f"/api/devices/{created['id']}/sensors", json={"ingestKeys": ["d2-temp"]}
    )
    assert blocked.status_code == 409


async def test_attach_does_not_steal_sensor_from_another_device(client: httpx.AsyncClient) -> None:
    await _sensor(client, "own-temp")
    first = (await client.post("/api/devices", json={"name": "first"})).json()
    second = (await client.post("/api/devices", json={"name": "second"})).json()
    ok = await client.post(f"/api/devices/{first['id']}/sensors", json={"ingestKeys": ["own-temp"]})
    assert ok.status_code == 200

    stolen = await client.post(
        f"/api/devices/{second['id']}/sensors", json={"ingestKeys": ["own-temp"]}
    )
    assert stolen.status_code == 409
    assert "own-temp" in stolen.json()["detail"]
    # 元の機器のキーで、引き続き送れる
    sent = await client.post(
        "/api/ingest/readings",
        headers={"X-Device-Key": first["key"]},
        json={"ingestKey": "own-temp", "value": 1},
    )
    assert sent.status_code == 202
    # 同じ機器への再実行は、そのまま成功する
    again = await client.post(
        f"/api/devices/{first['id']}/sensors", json={"ingestKeys": ["own-temp"]}
    )
    assert again.status_code == 200


async def test_unknown_device_is_404(client: httpx.AsyncClient) -> None:
    missing = "00000000-0000-0000-0000-000000000000"
    assert (await client.post(f"/api/devices/{missing}/revoke")).status_code == 404
    resp = await client.post(f"/api/devices/{missing}/sensors", json={"ingestKeys": ["x"]})
    assert resp.status_code == 404


async def test_devices_made_by_cli_functions_are_listed(client: httpx.AsyncClient) -> None:
    async with AsyncSession(engine) as session:
        await device_keys.create_device(session, "cli-made")
    assert [d["name"] for d in (await client.get("/api/devices")).json()] == ["cli-made"]


async def test_saas_mode_has_no_devices_api(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    assert (await client.get("/api/devices")).status_code == 404


async def test_delete_requires_revoke_and_keeps_sensors(client: httpx.AsyncClient) -> None:
    await _sensor(client, "del-temp")
    created = (await client.post("/api/devices", json={"name": "del1"})).json()
    await client.post(f"/api/devices/{created['id']}/sensors", json={"ingestKeys": ["del-temp"]})
    sent = await client.post(
        "/api/ingest/readings",
        headers={"X-Device-Key": created["key"]},
        json={"ingestKey": "del-temp", "value": 2.5},
    )
    assert sent.status_code in (200, 201, 202)
    await flush_once()

    # 有効な機器は削除できない
    assert (await client.delete(f"/api/devices/{created['id']}")).status_code == 409
    assert [d["name"] for d in (await client.get("/api/devices")).json()] == ["del1"]

    await client.post(f"/api/devices/{created['id']}/revoke")
    assert (await client.delete(f"/api/devices/{created['id']}")).status_code == 204
    assert (await client.get("/api/devices")).json() == []

    # センサーと測定値は残り、センサーは機器なしに戻る
    sensors = {s["ingestKey"]: s for s in (await client.get("/api/sensors")).json()}
    assert sensors["del-temp"]["deviceId"] is None
    sensor_id = sensors["del-temp"]["id"]
    readings = await client.get(f"/api/sensors/{sensor_id}/readings")
    assert readings.status_code == 200
    assert readings.json()["total"] == 1

    # 2 回目は 404。同じ名前で作り直せる
    assert (await client.delete(f"/api/devices/{created['id']}")).status_code == 404
    assert (await client.post("/api/devices", json={"name": "del1"})).status_code == 201
