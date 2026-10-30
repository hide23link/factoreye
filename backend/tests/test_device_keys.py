"""機器ごとのキー（X-Device-Key）・機器への所属・キーの失効・chunked の本文の上限のテスト。"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime

import httpx
import pytest
from sqlmodel.ext.asyncio.session import AsyncSession

from app import device_keys
from app.config import AuthMode, settings
from app.db.session import engine
from app.ingest_buffer import flush_once


async def _sensor(client: httpx.AsyncClient, ingest_key: str) -> str:
    resp = await client.post(
        "/api/sensors",
        json={"name": f"dk-{ingest_key}", "ingestKey": ingest_key, "unit": "V"},
    )
    assert resp.status_code == 201
    return str(resp.json()["id"])


async def _make_device(name: str, ingest_keys: list[str]) -> str:
    async with AsyncSession(engine) as session:
        key = await device_keys.create_device(session, name)
        device = await device_keys.get_device_by_name(session, name)
        assert device is not None
        missing = await device_keys.attach_sensors(session, device, ingest_keys)
        assert missing == []
    return key


async def _send(
    client: httpx.AsyncClient, body: dict[str, object], key: str | None
) -> httpx.Response:
    headers = {"X-Device-Key": key} if key is not None else {}
    return await client.post("/api/ingest/readings", headers=headers, json=body)


async def test_device_key_sends_to_its_own_sensor(client: httpx.AsyncClient) -> None:
    sensor_id = await _sensor(client, "dk-own")
    key = await _make_device("dk-line-1", ["dk-own"])
    resp = await _send(client, {"ingestKey": "dk-own", "value": 1}, key)
    assert resp.status_code == 202
    await flush_once()
    body = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    assert body["total"] == 1


async def test_attached_sensor_needs_a_device_key(client: httpx.AsyncClient) -> None:
    await _sensor(client, "dk-needs")
    await _make_device("dk-line-2", ["dk-needs"])
    resp = await _send(client, {"ingestKey": "dk-needs", "value": 1}, None)
    assert resp.status_code == 401


async def test_wrong_device_key_is_401(client: httpx.AsyncClient) -> None:
    await _sensor(client, "dk-wrong")
    await _make_device("dk-line-3", ["dk-wrong"])
    resp = await _send(client, {"ingestKey": "dk-wrong", "value": 1}, "not-a-real-key")
    assert resp.status_code == 401


async def test_device_key_cannot_send_to_another_devices_sensor(
    client: httpx.AsyncClient,
) -> None:
    await _sensor(client, "dk-other")
    key_a = await _make_device("dk-line-a", [])
    await _make_device("dk-line-b", ["dk-other"])
    resp = await _send(client, {"ingestKey": "dk-other", "value": 1}, key_a)
    assert resp.status_code == 403


async def test_device_key_cannot_send_to_unattached_sensor(client: httpx.AsyncClient) -> None:
    await _sensor(client, "dk-free")
    key = await _make_device("dk-line-4", [])
    resp = await _send(client, {"ingestKey": "dk-free", "value": 1}, key)
    assert resp.status_code == 403


async def test_sensors_form_reports_device_mismatch_per_sensor(
    client: httpx.AsyncClient,
) -> None:
    await _sensor(client, "dk-mine")
    await _sensor(client, "dk-theirs")
    key = await _make_device("dk-line-5", ["dk-mine"])
    await _make_device("dk-line-6", ["dk-theirs"])
    resp = await _send(
        client,
        {
            "samples": [
                {"values": {"dk-mine": 1, "dk-theirs": 2}},
            ]
        },
        key,
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["accepted"] == 1
    assert [(r["ingestKey"], r["status"]) for r in body["rejected"]] == [("dk-theirs", 403)]


async def test_revoked_key_is_401(client: httpx.AsyncClient) -> None:
    await _sensor(client, "dk-revoked")
    key = await _make_device("dk-line-7", ["dk-revoked"])
    async with AsyncSession(engine) as session:
        device = await device_keys.get_device_by_name(session, "dk-line-7")
        assert device is not None
        await device_keys.revoke_device(session, device)
    resp = await _send(client, {"ingestKey": "dk-revoked", "value": 1}, key)
    assert resp.status_code == 401


async def test_device_key_is_ignored_in_saas_mode(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SaaS（multi_tenant）では、機器のキーを使わない（従来どおり、ingestKey だけで識別する）。"""
    await _sensor(client, "dk-saas")
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    resp = await _send(client, {"ingestKey": "dk-saas", "value": 1}, "anything")
    assert resp.status_code == 202


async def test_only_stored_hash_is_kept(client: httpx.AsyncClient) -> None:
    key = await _make_device("dk-line-8", [])
    async with AsyncSession(engine) as session:
        device = await device_keys.get_device_by_name(session, "dk-line-8")
        assert device is not None
        assert device.key_hash != key
        assert device.key_hash == device_keys.hash_device_key(key)
        assert datetime.now(UTC) >= device.created_at


async def _chunks(total: int) -> AsyncIterator[bytes]:
    piece = b"x" * (1024 * 1024)
    sent = 0
    while sent < total:
        yield piece
        sent += len(piece)


async def test_chunked_body_over_limit_is_413(client: httpx.AsyncClient) -> None:
    """Content-Length が無い（chunked）送信でも、8MB を超えたら 413（QA High-1）。"""
    await _sensor(client, "dk-chunk")
    resp = await client.post(
        "/api/ingest/readings",
        content=_chunks(9 * 1024 * 1024),
        headers={"Content-Type": "application/json", "X-API-Key": settings.ingest_api_key},
    )
    assert resp.status_code == 413


async def test_chunked_body_within_limit_is_accepted(client: httpx.AsyncClient) -> None:
    await _sensor(client, "dk-chunk-ok")
    body = b'{"ingestKey": "dk-chunk-ok", "value": 1}'

    async def gen() -> AsyncIterator[bytes]:
        yield body[:10]
        yield body[10:]

    resp = await client.post(
        "/api/ingest/readings",
        content=gen(),
        headers={"Content-Type": "application/json", "X-API-Key": settings.ingest_api_key},
    )
    assert resp.status_code == 202
