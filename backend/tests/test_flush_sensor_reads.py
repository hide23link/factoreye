"""flush_once がセンサーを読む回数と、複数ワークスペース混在時の結果のテスト。

1 回の flush で、同じセンサーの集合を 1 回だけ読み、その結果を保存・アラーム評価・
Webhook 配信で共有する（以前は 3 回読んでいた）。結果（書かれる値、アラーム、送信先）は変えない。
"""
import asyncio
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import app.ingest_buffer as ingest_buffer
from app.db.models import (
    Alarm,
    NotificationSettings,
    Reading,
    Sensor,
    User,
    WebhookEventType,
    WebhookSubscription,
    Workspace,
)
from app.db.session import engine
from app.ingest_buffer import PendingReading, buffer, flush_once
from app.notifications import AlarmNotification

_SENSOR_SELECT = re.compile(r"\bFROM sensors\b", re.IGNORECASE)


@contextmanager
def _count_sensor_selects() -> Iterator[list[str]]:
    statements: list[str] = []

    def _before(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        if statement.lstrip().upper().startswith("SELECT") and _SENSOR_SELECT.search(statement):
            statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", _before)
    try:
        yield statements
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _before)


def _pending(sensor_id: UUID, value: float) -> PendingReading:
    return PendingReading(sensor_id=sensor_id, value=value, recorded_at=datetime.now(UTC))


async def _settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_flush_reads_sensors_once() -> None:
    async with AsyncSession(engine) as session:
        sensors = [
            Sensor(name=f"s{i}", ingest_key=f"k{i}", unit="C", threshold_max_warning=10.0)
            for i in range(5)
        ]
        session.add_all(sensors)
        ids = [s.id for s in sensors]
        await session.commit()

    for sid in ids:
        await buffer.add(_pending(sid, 20.0))

    with _count_sensor_selects() as statements:
        assert await flush_once() == 5

    assert len(statements) == 1, statements


async def test_flush_mixed_workspaces_deleted_and_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent_webhooks: list[tuple[str, dict[str, Any]]] = []
    sent_discord: list[tuple[str, AlarmNotification]] = []

    async def _fake_webhook(url: str, payload: dict[str, Any]) -> None:
        sent_webhooks.append((url, payload))

    async def _fake_discord(url: str, notification: AlarmNotification) -> None:
        sent_discord.append((url, notification))

    monkeypatch.setattr(ingest_buffer, "send_webhook", _fake_webhook)
    monkeypatch.setattr(ingest_buffer, "send_alarm_discord", _fake_discord)

    async with AsyncSession(engine) as session:
        owner = User(email="o@example.com", password_hash="x")
        session.add(owner)
        await session.flush()
        ws1 = Workspace(name="w1", owner_id=owner.id)
        ws2 = Workspace(name="w2", owner_id=owner.id)
        session.add_all([ws1, ws2])
        await session.flush()

        def mk(name: str, ws: UUID | None, **kw: Any) -> Sensor:
            return Sensor(
                name=name, ingest_key=name, unit="C", workspace_id=ws,
                threshold_max_warning=10.0, threshold_max_critical=50.0, **kw,
            )

        s_self = mk("self", None)
        s_w1 = mk("w1", ws1.id)
        s_w2 = mk("w2", ws2.id)
        s_off = mk("off", ws2.id, enabled=False)
        session.add_all([s_self, s_w1, s_w2, s_off])
        for ws, label in ((None, "self"), (ws1.id, "w1"), (ws2.id, "w2")):
            session.add(
                NotificationSettings(
                    workspace_id=ws,
                    discord_webhook_url_critical=f"https://d/{label}/c",
                    discord_webhook_url_warning=f"https://d/{label}/w",
                )
            )
            for ev in (WebhookEventType.READING_RECEIVED, WebhookEventType.ALARM_TRIGGERED):
                session.add(
                    WebhookSubscription(
                        workspace_id=ws, event_type=ev, url=f"https://h/{label}/{ev.value}"
                    )
                )
        ids = {"self": s_self.id, "w1": s_w1.id, "w2": s_w2.id, "off": s_off.id}
        ws1_id, ws2_id = ws1.id, ws2.id
        await session.commit()

    gone = uuid4()  # 受信後に削除された（存在しない）センサー
    for sid, v in [
        (ids["self"], 5.0),
        (ids["w1"], 20.0),   # 軽故障
        (ids["w2"], 60.0),   # 重故障
        (ids["off"], 20.0),  # 無効センサーでも、バッファにある値は従来どおり書く
        (gone, 99.0),
    ]:
        await buffer.add(_pending(sid, v))

    assert await flush_once() == 4
    await _settle()

    async with AsyncSession(engine) as session:
        readings = (await session.exec(select(Reading))).all()
        assert sorted(r.sensor_id.hex for r in readings) == sorted(
            i.hex for i in ids.values()
        )
        alarms = {a.sensor_id: a for a in (await session.exec(select(Alarm))).all()}
        assert set(alarms) == {ids["w1"], ids["w2"], ids["off"]}

    # reading.received: センサーのワークスペースの購読にだけ送る
    received = {
        (url, p["sensorId"])
        for url, p in sent_webhooks
        if p["event"] == "reading.received"
    }
    assert received == {
        ("https://h/self/reading.received", str(ids["self"])),
        ("https://h/w1/reading.received", str(ids["w1"])),
        ("https://h/w2/reading.received", str(ids["w2"])),
        ("https://h/w2/reading.received", str(ids["off"])),
    }
    triggered = {
        (url, p["sensorId"])
        for url, p in sent_webhooks
        if p["event"] == "alarm.triggered"
    }
    assert triggered == {
        ("https://h/w1/alarm.triggered", str(ids["w1"])),
        ("https://h/w2/alarm.triggered", str(ids["w2"])),
        ("https://h/w2/alarm.triggered", str(ids["off"])),
    }
    assert {(u, n.sensor_id, n.workspace_id) for u, n in sent_discord} == {
        ("https://d/w1/w", ids["w1"], ws1_id),
        ("https://d/w2/c", ids["w2"], ws2_id),
        ("https://d/w2/w", ids["off"], ws2_id),
    }
