"""アラーム評価エンジン（閾値比較・dedupe・解除）とACK APIのテスト。"""
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import settings
from app.db.models import Alarm
from app.db.session import engine
from app.ingest_buffer import flush_once

VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


async def _create_sensor(
    client: httpx.AsyncClient,
    ingest_key: str,
    threshold_min: float | None = None,
    threshold_max: float | None = None,
    threshold_min_warning: float | None = None,
    threshold_max_warning: float | None = None,
    threshold_dead_band: float = 0.0,
) -> str:
    """threshold_min/threshold_max は重故障（critical）側のしきい値を指す
    （既存テストは単一閾値=重故障相当だったため、名前は変えずに意味を保つ）。"""
    resp = await client.post(
        "/api/sensors",
        json={
            "name": f"sensor-{ingest_key}",
            "ingestKey": ingest_key,
            "unit": "C",
            "thresholdMinCritical": threshold_min,
            "thresholdMaxCritical": threshold_max,
            "thresholdMinWarning": threshold_min_warning,
            "thresholdMaxWarning": threshold_max_warning,
            "thresholdDeadBand": threshold_dead_band,
        },
    )
    assert resp.status_code == 201
    return str(resp.json()["id"])


async def _ingest(client: httpx.AsyncClient, ingest_key: str, value: float) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": ingest_key, "value": value},
    )
    assert resp.status_code == 202


async def test_alarm_triggers_on_max_breach(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "max-breach-sensor", threshold_max=40.0)
    await _ingest(client, "max-breach-sensor", 45.0)
    await flush_once()

    resp = await client.get("/api/alarms", params={"status": "active"})
    assert resp.status_code == 200
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["sensorId"] == sensor_id
    assert alarms[0]["thresholdBreached"] == "max"
    assert alarms[0]["status"] == "active"
    assert alarms[0]["severity"] == "critical"


async def test_alarm_triggers_on_min_breach(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "min-breach-sensor", threshold_min=10.0)
    await _ingest(client, "min-breach-sensor", 5.0)
    await flush_once()

    resp = await client.get("/api/alarms", params={"status": "active"})
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["thresholdBreached"] == "min"
    assert alarms[0]["severity"] == "critical"


async def test_alarm_triggers_on_warning_breach_only(client: httpx.AsyncClient) -> None:
    """軽故障のしきい値のみ設定: 超えたら軽故障、重故障のしきい値は未設定なのでそのまま。"""
    await _create_sensor(client, "warning-only-sensor", threshold_max_warning=30.0)
    await _ingest(client, "warning-only-sensor", 35.0)
    await flush_once()

    resp = await client.get("/api/alarms", params={"status": "active"})
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["severity"] == "warning"


async def test_alarm_severity_escalates_without_creating_new_alarm(
    client: httpx.AsyncClient,
) -> None:
    """軽故障で発生中のアラームが、重故障のしきい値も超えたら重故障に昇格する
    （新規アラームは作らず、同じアラームのseverityが更新される）。"""
    await _create_sensor(
        client,
        "escalate-sensor",
        threshold_max=50.0,
        threshold_max_warning=30.0,
    )
    await _ingest(client, "escalate-sensor", 35.0)
    await flush_once()

    first = await client.get("/api/alarms", params={"status": "active"})
    first_alarms = first.json()["alarms"]
    assert len(first_alarms) == 1
    assert first_alarms[0]["severity"] == "warning"
    alarm_id = first_alarms[0]["id"]

    await _ingest(client, "escalate-sensor", 55.0)
    await flush_once()

    second = await client.get("/api/alarms", params={"status": "active"})
    second_alarms = second.json()["alarms"]
    assert len(second_alarms) == 1
    assert second_alarms[0]["id"] == alarm_id
    assert second_alarms[0]["severity"] == "critical"
    assert second_alarms[0]["value"] == 55.0


async def test_alarm_dead_band_prevents_premature_resolve(client: httpx.AsyncClient) -> None:
    """不感帯5.0: 40で発生後、37(=40-5+2)まで戻っただけではまだ解除しない。
    閾値-不感帯=35を下回って初めて解除される。"""
    await _create_sensor(
        client, "dead-band-sensor", threshold_max=40.0, threshold_dead_band=5.0
    )
    await _ingest(client, "dead-band-sensor", 45.0)
    await flush_once()

    await _ingest(client, "dead-band-sensor", 37.0)
    await flush_once()

    still_active = await client.get("/api/alarms", params={"status": "active"})
    assert still_active.json()["total"] == 1

    await _ingest(client, "dead-band-sensor", 34.0)
    await flush_once()

    resolved = await client.get("/api/alarms", params={"status": "active"})
    assert resolved.json()["total"] == 0


async def test_alarm_dedup_within_one_flush(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "dedup-sensor", threshold_max=40.0)
    for value in (45, 46, 47):
        await _ingest(client, "dedup-sensor", value)
    await flush_once()

    resp = await client.get("/api/alarms", params={"status": "active"})
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["value"] == 45


async def test_alarm_dedup_across_flushes(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "dedup-sensor-2", threshold_max=40.0)
    await _ingest(client, "dedup-sensor-2", 45.0)
    await flush_once()
    await _ingest(client, "dedup-sensor-2", 46.0)
    await flush_once()

    resp = await client.get("/api/alarms")
    assert resp.json()["total"] == 1


async def test_alarm_resolves_when_back_in_range(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "resolve-sensor", threshold_max=40.0)
    await _ingest(client, "resolve-sensor", 45.0)
    await flush_once()

    await _ingest(client, "resolve-sensor", 20.0)
    await flush_once()

    resp = await client.get("/api/alarms")
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["status"] == "resolved"
    assert alarms[0]["resolvedAt"] is not None

    active_resp = await client.get("/api/alarms", params={"status": "active"})
    assert active_resp.json()["total"] == 0


async def test_acknowledge_alarm(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "ack-sensor", threshold_max=40.0)
    await _ingest(client, "ack-sensor", 45.0)
    await flush_once()

    alarm_id = (await client.get("/api/alarms")).json()["alarms"][0]["id"]

    resp = await client.patch(f"/api/alarms/{alarm_id}/ack", json={"acknowledgedBy": "admin"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "acknowledged"
    assert body["acknowledgedBy"] == "admin"
    assert body["acknowledgedAt"] is not None


async def test_acknowledge_already_acknowledged_conflicts(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "ack-conflict-sensor", threshold_max=40.0)
    await _ingest(client, "ack-conflict-sensor", 45.0)
    await flush_once()
    alarm_id = (await client.get("/api/alarms")).json()["alarms"][0]["id"]

    first = await client.patch(f"/api/alarms/{alarm_id}/ack", json={"acknowledgedBy": "admin"})
    assert first.status_code == 200

    second = await client.patch(f"/api/alarms/{alarm_id}/ack", json={"acknowledgedBy": "admin"})
    assert second.status_code == 409


async def test_alarm_delete_not_allowed(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "no-delete-sensor", threshold_max=40.0)
    await _ingest(client, "no-delete-sensor", 45.0)
    await flush_once()
    alarm_id = (await client.get("/api/alarms")).json()["alarms"][0]["id"]

    resp = await client.delete(f"/api/alarms/{alarm_id}")
    assert resp.status_code in (404, 405)


async def test_get_alarm_by_id(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "get-alarm-sensor", threshold_max=40.0)
    await _ingest(client, "get-alarm-sensor", 45.0)
    await flush_once()
    alarm_id = (await client.get("/api/alarms")).json()["alarms"][0]["id"]

    resp = await client.get(f"/api/alarms/{alarm_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == alarm_id


async def test_get_alarm_not_found_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/alarms/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


async def test_list_alarms_filtered_by_sensor_id(client: httpx.AsyncClient) -> None:
    sensor_a = await _create_sensor(client, "filter-alarm-a", threshold_max=40.0)
    await _create_sensor(client, "filter-alarm-b", threshold_max=40.0)
    await _ingest(client, "filter-alarm-a", 45.0)
    await _ingest(client, "filter-alarm-b", 45.0)
    await flush_once()

    # list_alarmsのsensor_idクエリパラメータはaliasが無く、JSONボディと違いcamelCase化されない
    resp = await client.get("/api/alarms", params={"sensor_id": sensor_a})
    assert resp.status_code == 200
    alarms = resp.json()["alarms"]
    assert len(alarms) == 1
    assert alarms[0]["sensorId"] == sensor_a


async def test_critical_alarm_repeats_when_enabled_and_interval_elapsed(
    client: httpx.AsyncClient,
) -> None:
    await client.put(
        "/api/settings/notifications",
        json={"criticalRepeatEnabled": True, "criticalRepeatIntervalMinutes": 1},
    )
    await _create_sensor(client, "repeat-sensor", threshold_max=40.0)
    await _ingest(client, "repeat-sensor", 45.0)
    await flush_once()

    alarms = (await client.get("/api/alarms", params={"status": "active"})).json()["alarms"]
    assert len(alarms) == 1
    alarm_id = alarms[0]["id"]
    original_triggered_at = alarms[0]["triggeredAt"]

    # last_notified_atを2分前に書き換え、再通知の間隔（1分）を超えた状態を作る
    async with AsyncSession(engine) as session:
        alarm = await session.get(Alarm, UUID(alarm_id))
        assert alarm is not None
        alarm.last_notified_at = datetime.now(UTC) - timedelta(minutes=2)
        session.add(alarm)
        await session.commit()

    await _ingest(client, "repeat-sensor", 46.0)
    await flush_once()

    updated = (await client.get(f"/api/alarms/{alarm_id}")).json()
    assert updated["value"] == 46.0
    assert updated["status"] == "active"
    # 新規アラームではなく再通知なので、元の発生時刻は変わらない
    assert updated["triggeredAt"] == original_triggered_at

    total = (await client.get("/api/alarms")).json()["total"]
    assert total == 1


async def test_critical_alarm_does_not_repeat_when_disabled(client: httpx.AsyncClient) -> None:
    # デフォルトはcriticalRepeatEnabled=false
    await _create_sensor(client, "no-repeat-sensor", threshold_max=40.0)
    await _ingest(client, "no-repeat-sensor", 45.0)
    await flush_once()

    alarms = (await client.get("/api/alarms", params={"status": "active"})).json()["alarms"]
    alarm_id = alarms[0]["id"]

    async with AsyncSession(engine) as session:
        alarm = await session.get(Alarm, UUID(alarm_id))
        assert alarm is not None
        alarm.last_notified_at = datetime.now(UTC) - timedelta(hours=1)
        session.add(alarm)
        await session.commit()

    await _ingest(client, "no-repeat-sensor", 46.0)
    await flush_once()

    # 再通知が無効なら値も更新されない（dedupeのまま何もしない）
    updated = (await client.get(f"/api/alarms/{alarm_id}")).json()
    assert updated["value"] == 45.0
