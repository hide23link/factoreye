"""センサー一覧の ETag（変わっていなければ 304）と、応答の形のテスト。"""
import httpx


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
