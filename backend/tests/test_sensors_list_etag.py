"""センサー一覧の ETag（変わっていなければ 304）と、応答の形のテスト。"""
import httpx
from sqlmodel.ext.asyncio.session import AsyncSession

from app import device_keys
from app.db.session import engine


async def _create(client: httpx.AsyncClient, key: str) -> str:
    resp = await client.post("/api/sensors", json={"name": key, "ingestKey": key, "unit": "C"})
    assert resp.status_code == 201
    return str(resp.json()["id"])


async def test_list_returns_camel_case_json_array_with_etag(client: httpx.AsyncClient) -> None:
    await _create(client, "etag-shape")

    resp = await client.get("/api/sensors")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.headers["cache-control"] == "no-cache"
    assert resp.headers["etag"].startswith('"')
    sensors = resp.json()
    assert isinstance(sensors, list) and len(sensors) == 1
    expected = {"ingestKey", "thresholdMaxCritical", "createdAt", "updatedAt", "enabled"}
    assert expected <= set(sensors[0])


async def test_unchanged_list_returns_304_without_body(client: httpx.AsyncClient) -> None:
    await _create(client, "etag-304")
    first = await client.get("/api/sensors")
    etag = first.headers["etag"]

    second = await client.get("/api/sensors", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""
    assert second.headers["etag"] == etag


async def test_create_update_and_delete_change_the_etag(client: httpx.AsyncClient) -> None:
    sensor_id = await _create(client, "etag-change")
    etag0 = (await client.get("/api/sensors")).headers["etag"]

    # 作成: 件数が変わる
    await _create(client, "etag-change-2")
    etag1 = (await client.get("/api/sensors")).headers["etag"]
    assert etag1 != etag0

    # 更新: 最終更新時刻が変わる（件数は同じ）
    resp = await client.put(f"/api/sensors/{sensor_id}", json={"thresholdMaxCritical": 40.0})
    assert resp.status_code == 200
    etag2 = (await client.get("/api/sensors")).headers["etag"]
    assert etag2 != etag1

    # 更新された後に、古い ETag を送ると、本体（200）が返る
    stale = await client.get("/api/sensors", headers={"If-None-Match": etag1})
    assert stale.status_code == 200
    assert {s["thresholdMaxCritical"] for s in stale.json()} >= {40.0}

    # 削除: 件数が変わる
    assert (await client.delete(f"/api/sensors/{sensor_id}")).status_code == 204
    etag3 = (await client.get("/api/sensors")).headers["etag"]
    assert etag3 != etag2


async def test_empty_list_has_an_etag_and_empty_array(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/sensors")
    assert resp.status_code == 200
    assert resp.json() == []
    assert resp.headers["etag"].startswith('"')


async def _attach(device_name: str, ingest_keys: list[str]) -> None:
    async with AsyncSession(engine) as session:
        await device_keys.create_device(session, device_name)
        device = await device_keys.get_device_by_name(session, device_name)
        assert device is not None
        assert await device_keys.attach_sensors(session, device, ingest_keys) == []


async def test_list_and_detail_include_the_device_of_the_sensor(client: httpx.AsyncClient) -> None:
    attached_id = await _create(client, "dev-in")
    free_id = await _create(client, "dev-out")
    await _attach("r-shelf-01", ["dev-in"])

    by_id = {item["id"]: item for item in (await client.get("/api/sensors")).json()}
    assert by_id[attached_id]["deviceName"] == "r-shelf-01"
    assert by_id[attached_id]["deviceId"] is not None
    # 機器に所属しないセンサーも一覧に出る（外部結合）。機器の項目は null
    assert by_id[free_id]["deviceId"] is None and by_id[free_id]["deviceName"] is None

    # 詳細・更新も、一覧と同じ形（機器の名前つき）で返す
    detail = (await client.get(f"/api/sensors/{attached_id}")).json()
    assert detail["deviceName"] == "r-shelf-01"
    updated = await client.put(f"/api/sensors/{attached_id}", json={"unit": "A"})
    assert updated.json()["deviceName"] == "r-shelf-01"


async def test_attaching_a_sensor_to_a_device_changes_the_etag(client: httpx.AsyncClient) -> None:
    await _create(client, "dev-etag")
    etag_before = (await client.get("/api/sensors")).headers["etag"]

    await _attach("r-shelf-02", ["dev-etag"])

    # 所属を変えたのに版が同じだと、画面が古い一覧（機器なし）のまま 304 を受け取ってしまう
    response = await client.get("/api/sensors", headers={"If-None-Match": etag_before})
    assert response.status_code == 200
    assert response.json()[0]["deviceName"] == "r-shelf-02"
