"""マルチテナントの分離（センサー名・取り込みキー・通知設定がワークスペースをまたいで混ざらないこと）のテスト。

ワークスペースはエンドポイントの依存関係 get_current_workspace_id を差し替えて切り替える。
Discord 送信は app.ingest_buffer.send_alarm_discord をモックして、送信先と内容を検証する。
"""

from collections.abc import AsyncGenerator, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.exc import IntegrityError
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import NotificationSettings, Sensor, User, Workspace
from app.db.session import engine
from app.ingest_buffer import PendingReading, buffer, flush_once
from app.main import app


async def _make_workspace(session: AsyncSession) -> UUID:
    user = User(email=f"{uuid4()}@example.com", password_hash="x")
    session.add(user)
    await session.flush()
    workspace = Workspace(name="テスト用", owner_id=user.id)
    workspace_id = workspace.id  # コミット後は属性が期限切れになるため、先に取っておく
    session.add(workspace)
    await session.commit()
    return workspace_id


async def _make_sensor(
    session: AsyncSession,
    workspace_id: UUID | None,
    name: str,
    threshold_max_warning: float | None = None,
    threshold_max_critical: float | None = None,
) -> Sensor:
    sensor = Sensor(
        workspace_id=workspace_id,
        name=name,
        ingest_key=f"key-{uuid4()}",
        unit="C",
        threshold_max_warning=threshold_max_warning,
        threshold_max_critical=threshold_max_critical,
    )
    session.add(sensor)
    await session.commit()
    await session.refresh(sensor)
    return sensor


@pytest.fixture
def as_workspace() -> Iterator[Any]:
    """依存関係を差し替え、テスト中に別のワークスペースとして振る舞えるようにする。"""

    def _set(workspace_id: UUID | None) -> None:
        app.dependency_overrides[get_current_workspace_id] = lambda: workspace_id

    yield _set
    app.dependency_overrides.pop(get_current_workspace_id, None)


@pytest_asyncio.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    # コミット後も属性を読めるように、期限切れにしない（複数のセンサーを作るテストで使う）
    async with AsyncSession(engine, expire_on_commit=False) as s:
        yield s


# ──────────────────────────────────────────────────────────────
# センサー名・取り込みキーの一意性
# ──────────────────────────────────────────────────────────────


async def test_same_sensor_name_is_allowed_in_different_workspaces(session: AsyncSession) -> None:
    ws_a = await _make_workspace(session)
    ws_b = await _make_workspace(session)
    await _make_sensor(session, ws_a, "温度")
    await _make_sensor(session, ws_b, "温度")  # 別のワークスペースなので成功する


async def test_same_sensor_name_is_rejected_within_one_workspace(session: AsyncSession) -> None:
    ws = await _make_workspace(session)
    await _make_sensor(session, ws, "温度")
    with pytest.raises(IntegrityError):
        await _make_sensor(session, ws, "温度")
    await session.rollback()


async def test_self_hosted_sensor_name_is_unique(session: AsyncSession) -> None:
    await _make_sensor(session, None, "温度")
    with pytest.raises(IntegrityError):
        await _make_sensor(session, None, "温度")
    await session.rollback()


async def test_api_allows_same_name_in_another_workspace(
    client: httpx.AsyncClient, session: AsyncSession, as_workspace: Any
) -> None:
    ws_a = await _make_workspace(session)
    ws_b = await _make_workspace(session)
    await _make_sensor(session, ws_a, "温度")

    as_workspace(ws_b)
    resp = await client.post(
        "/api/sensors", json={"name": "温度", "ingestKey": f"k-{uuid4()}", "unit": "C"}
    )
    assert resp.status_code == 201


async def test_api_rejects_duplicate_name_within_same_workspace(
    client: httpx.AsyncClient, session: AsyncSession, as_workspace: Any
) -> None:
    ws = await _make_workspace(session)
    await _make_sensor(session, ws, "温度")

    as_workspace(ws)
    resp = await client.post(
        "/api/sensors", json={"name": "温度", "ingestKey": f"k-{uuid4()}", "unit": "C"}
    )
    assert resp.status_code == 409


async def test_api_rejects_ingest_key_used_in_another_workspace_with_409(
    client: httpx.AsyncClient, session: AsyncSession, as_workspace: Any
) -> None:
    # 取り込みキーは全体で一意。別のワークスペースのキーと衝突したら500ではなく409を返す
    ws_a = await _make_workspace(session)
    ws_b = await _make_workspace(session)
    taken = f"k-{uuid4()}"
    await _make_sensor(session, ws_a, "A の温度")
    session.add(Sensor(workspace_id=ws_a, name="A の湿度", ingest_key=taken, unit="%"))
    await session.commit()

    as_workspace(ws_b)
    resp = await client.post(
        "/api/sensors", json={"name": "B の温度", "ingestKey": taken, "unit": "C"}
    )
    assert resp.status_code == 409


async def test_api_rename_conflict_is_scoped_to_workspace(
    client: httpx.AsyncClient, session: AsyncSession, as_workspace: Any
) -> None:
    ws_a = await _make_workspace(session)
    ws_b = await _make_workspace(session)
    await _make_sensor(session, ws_a, "湿度")
    mine = await _make_sensor(session, ws_b, "温度")

    as_workspace(ws_b)
    # ワークスペースAの「湿度」と同名でも、ワークスペースBでは重複ではない
    resp = await client.put(f"/api/sensors/{mine.id}", json={"name": "湿度"})
    assert resp.status_code == 200


# ──────────────────────────────────────────────────────────────
# 通知設定の参照（アラームのワークスペースの設定を使う）
# ──────────────────────────────────────────────────────────────


async def _notification_row(
    session: AsyncSession,
    workspace_id: UUID | None,
    critical_url: str,
    warning_url: str,
    enabled: bool = True,
    repeat_enabled: bool = False,
) -> None:
    session.add(
        NotificationSettings(
            workspace_id=workspace_id,
            discord_webhook_url_critical=critical_url,
            discord_webhook_url_warning=warning_url,
            enabled=enabled,
            critical_repeat_enabled=repeat_enabled,
            critical_repeat_interval_minutes=1,
        )
    )
    await session.commit()


def _sent(mock: AsyncMock) -> set[tuple[str, str, str]]:
    """送信内容を (送信先, センサー名, 重要度) の集合にする。"""
    result = set()
    for call in mock.call_args_list:
        url, notification = call.args
        result.add((url, notification.sensor_name, notification.severity.value))
    return result


async def test_each_alarm_is_sent_to_its_own_workspace_settings(session: AsyncSession) -> None:
    ws_a = await _make_workspace(session)
    ws_b = await _make_workspace(session)
    ws_none = await _make_workspace(session)  # 通知設定を作っていないワークスペース
    await _notification_row(session, ws_a, "https://a/crit", "https://a/warn")
    await _notification_row(session, ws_b, "https://b/crit", "https://b/warn")
    # self-hosted（workspace_id NULL）の設定は id=1 の1行
    await _notification_row(session, None, "https://self/crit", "https://self/warn")

    a = await _make_sensor(
        session, ws_a, "A-温度", threshold_max_warning=50, threshold_max_critical=80
    )
    b = await _make_sensor(
        session, ws_b, "B-温度", threshold_max_warning=50, threshold_max_critical=80
    )
    c = await _make_sensor(
        session, ws_none, "C-温度", threshold_max_warning=50, threshold_max_critical=80
    )
    s = await _make_sensor(
        session, None, "S-温度", threshold_max_warning=50, threshold_max_critical=80
    )

    now = datetime.now(UTC)
    await buffer.drain()  # 他のテストの残りを捨てる
    await buffer.add(PendingReading(sensor_id=a.id, value=90, recorded_at=now))  # A: 重故障
    await buffer.add(PendingReading(sensor_id=b.id, value=60, recorded_at=now))  # B: 軽故障
    await buffer.add(PendingReading(sensor_id=c.id, value=90, recorded_at=now))  # C: 設定なし
    await buffer.add(
        PendingReading(sensor_id=s.id, value=60, recorded_at=now)
    )  # self-hosted: 軽故障

    with patch("app.ingest_buffer.send_alarm_discord", new_callable=AsyncMock) as mock_send:
        await flush_once()

    assert _sent(mock_send) == {
        ("https://a/crit", "A-温度", "critical"),
        ("https://b/warn", "B-温度", "warning"),
        ("https://self/warn", "S-温度", "warning"),
    }


async def test_disabled_workspace_settings_do_not_send(session: AsyncSession) -> None:
    ws = await _make_workspace(session)
    await _notification_row(session, ws, "https://a/crit", "https://a/warn", enabled=False)
    sensor = await _make_sensor(
        session, ws, "停止中", threshold_max_warning=50, threshold_max_critical=80
    )

    await buffer.drain()
    await buffer.add(PendingReading(sensor_id=sensor.id, value=90, recorded_at=datetime.now(UTC)))
    with patch("app.ingest_buffer.send_alarm_discord", new_callable=AsyncMock) as mock_send:
        await flush_once()

    mock_send.assert_not_called()


async def test_repeat_notification_follows_each_workspace_setting(session: AsyncSession) -> None:
    ws_on = await _make_workspace(session)
    ws_off = await _make_workspace(session)
    await _notification_row(
        session, ws_on, "https://on/crit", "https://on/warn", repeat_enabled=True
    )
    await _notification_row(
        session, ws_off, "https://off/crit", "https://off/warn", repeat_enabled=False
    )
    s_on = await _make_sensor(
        session, ws_on, "再通知あり", threshold_max_warning=50, threshold_max_critical=80
    )
    s_off = await _make_sensor(
        session, ws_off, "再通知なし", threshold_max_warning=50, threshold_max_critical=80
    )

    t0 = datetime.now(UTC)
    await buffer.drain()
    await buffer.add(PendingReading(sensor_id=s_on.id, value=90, recorded_at=t0))
    await buffer.add(PendingReading(sensor_id=s_off.id, value=90, recorded_at=t0))
    with patch("app.ingest_buffer.send_alarm_discord", new_callable=AsyncMock):
        await flush_once()

    # 2分後も未解決のまま。再通知の間隔（1分）を超えるのは、再通知ありのワークスペースだけ
    t1 = t0 + timedelta(minutes=2)
    await buffer.drain()
    await buffer.add(PendingReading(sensor_id=s_on.id, value=90, recorded_at=t1))
    await buffer.add(PendingReading(sensor_id=s_off.id, value=90, recorded_at=t1))
    with patch("app.ingest_buffer.send_alarm_discord", new_callable=AsyncMock) as mock_send:
        await flush_once()

    repeated = {(url, name) for url, name, _ in _sent(mock_send)}
    assert repeated == {("https://on/crit", "再通知あり")}


# ──────────────────────────────────────────────────────────────
# ウィジェットの sensorId（存在と所有の確認）
# ──────────────────────────────────────────────────────────────

_WIDGET = {"type": "SensorGraph", "gridColumn": 1, "gridRow": 1, "gridWidth": 4, "gridHeight": 2}


async def test_widget_create_rejects_sensor_of_another_workspace(
    client: httpx.AsyncClient, session: AsyncSession, as_workspace: Any
) -> None:
    ws_a = await _make_workspace(session)
    ws_b = await _make_workspace(session)
    foreign = await _make_sensor(session, ws_b, "B のセンサー")

    as_workspace(ws_a)
    dashboard = await client.post("/api/dashboards", json={"name": "A の盤"})
    dashboard_id = dashboard.json()["id"]
    resp = await client.post(
        f"/api/dashboards/{dashboard_id}/widgets", json={**_WIDGET, "sensorId": str(foreign.id)}
    )
    assert resp.status_code == 404
    got = await client.get(f"/api/dashboards/{dashboard_id}")
    assert got.json()["widgets"] == []


async def test_widget_create_rejects_unknown_sensor_with_404_not_500(
    client: httpx.AsyncClient, session: AsyncSession, as_workspace: Any
) -> None:
    ws = await _make_workspace(session)
    as_workspace(ws)
    dashboard_id = (await client.post("/api/dashboards", json={"name": "盤"})).json()["id"]
    resp = await client.post(
        f"/api/dashboards/{dashboard_id}/widgets", json={**_WIDGET, "sensorId": str(uuid4())}
    )
    assert resp.status_code == 404


async def test_widget_update_rejects_sensor_of_another_workspace_or_unknown(
    client: httpx.AsyncClient, session: AsyncSession, as_workspace: Any
) -> None:
    ws_a = await _make_workspace(session)
    ws_b = await _make_workspace(session)
    own = await _make_sensor(session, ws_a, "A のセンサー")
    foreign = await _make_sensor(session, ws_b, "B のセンサー")

    as_workspace(ws_a)
    dashboard_id = (await client.post("/api/dashboards", json={"name": "A の盤"})).json()["id"]
    widget = await client.post(
        f"/api/dashboards/{dashboard_id}/widgets", json={**_WIDGET, "sensorId": str(own.id)}
    )
    assert widget.status_code == 201
    widget_id = widget.json()["id"]

    for bad in (str(foreign.id), str(uuid4())):
        resp = await client.put(f"/api/widgets/{widget_id}", json={"sensorId": bad})
        assert resp.status_code == 404
    got = await client.get(f"/api/dashboards/{dashboard_id}")
    assert got.json()["widgets"][0]["sensorId"] == str(own.id)

    # 自分のワークスペースのセンサーへの付け替えと、紐付けの解除（null）はできる
    other = await _make_sensor(session, ws_a, "A の別のセンサー")
    resp = await client.put(f"/api/widgets/{widget_id}", json={"sensorId": str(other.id)})
    assert resp.status_code == 200
    resp = await client.put(f"/api/widgets/{widget_id}", json={"sensorId": None})
    assert resp.status_code == 200
    assert resp.json()["sensorId"] is None
