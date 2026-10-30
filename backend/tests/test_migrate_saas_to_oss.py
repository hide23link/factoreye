"""SaaS → OSS 移行ツール（書き出し・取り込み）のテスト。

テストDBの中で、SaaS 側のワークスペースを書き出し → 削除 → OSS 側（workspace_id NULL）へ
取り込み、中身（件数・ID・取り込みキー・参照関係）が保たれることを確かめる。
"""

import gzip
import json
import subprocess
import sys
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import (
    Alarm,
    AlarmSeverity,
    Dashboard,
    MinMax,
    NotificationSettings,
    Reading,
    Sensor,
    User,
    WebhookEventType,
    WebhookSubscription,
    Widget,
    Workspace,
)
from app.db.session import engine
from app.migrate_saas_to_oss import MigrationError, export_workspace, import_bundle


@pytest_asyncio.fixture
async def alembic_table() -> AsyncGenerator[None, None]:
    # 本番と同じく alembic_version を持つ状態にする（スキーマ版の照合に使う）
    async with engine.begin() as conn:
        await conn.execute(
            sa.text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        )
        await conn.execute(sa.text("INSERT INTO alembic_version VALUES ('testrev')"))
    yield
    async with engine.begin() as conn:
        await conn.execute(sa.text("DROP TABLE alembic_version"))


@pytest_asyncio.fixture
async def saas_data(alembic_table: None) -> AsyncGenerator[dict[str, UUID], None]:
    """SaaS 側のデータ: ワークスペース A（移す対象）と B（残すもの）。"""
    async with AsyncSession(engine) as session:
        user = User(email="owner@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        ws_a = Workspace(name="A", owner_id=user.id)
        ws_b = Workspace(name="B", owner_id=user.id)
        session.add_all([ws_a, ws_b])
        await session.flush()

        sensor = Sensor(
            workspace_id=ws_a.id,
            name="釜A温度",
            ingest_key="saas-key-a1",
            unit="℃",
            threshold_max_critical=80.0,
        )
        other = Sensor(workspace_id=ws_b.id, name="釜A温度", ingest_key="saas-key-b1", unit="℃")
        session.add_all([sensor, other])
        await session.flush()

        t0 = datetime.now(UTC)
        session.add_all(
            [
                Reading(sensor_id=sensor.id, value=float(v), recorded_at=t0 + timedelta(seconds=i))
                for i, v in enumerate((10, 20, 30))
            ]
        )
        session.add(
            Alarm(
                sensor_id=sensor.id,
                value=90.0,
                threshold_breached=MinMax.MAX,
                severity=AlarmSeverity.CRITICAL,
            )
        )

        dashboard = Dashboard(workspace_id=ws_a.id, name="main")
        deleted = Dashboard(workspace_id=ws_a.id, name="old", deleted_at=datetime.now(UTC))
        session.add_all([dashboard, deleted])
        await session.flush()

        widget = Widget(
            dashboard_id=dashboard.id,
            sensor_id=sensor.id,
            type="temperature-graph",
            grid_column=1,
            grid_row=1,
            grid_width=4,
            grid_height=3,
        )
        widget_on_deleted = Widget(
            dashboard_id=deleted.id,
            type="temperature-graph",
            grid_column=1,
            grid_row=1,
            grid_width=4,
            grid_height=3,
        )
        session.add_all([widget, widget_on_deleted])
        await session.flush()

        session.add(
            WebhookSubscription(
                workspace_id=ws_a.id,
                event_type=WebhookEventType.ALARM_TRIGGERED,
                url="https://example.com/hook",
            )
        )
        session.add(
            NotificationSettings(
                workspace_id=ws_a.id,
                discord_webhook_url_critical="https://discord.example/critical",
            )
        )
        # コミット後は属性が期限切れになるため、ID はコミット前に取り出す
        ids = {"ws_a": ws_a.id, "ws_b": ws_b.id, "sensor": sensor.id, "dashboard": dashboard.id}
        await session.commit()
    yield ids


async def _remove_workspace_a(ws_a: UUID) -> None:
    # 移し終えた想定: SaaS 側から A を消す。widgets.dashboard_id は CASCADE ではないため先に消す
    async with engine.begin() as conn:
        dashboard_ids = "SELECT id FROM dashboards WHERE workspace_id = :id"
        await conn.execute(
            sa.text(f"DELETE FROM widgets WHERE dashboard_id IN ({dashboard_ids})"), {"id": ws_a}
        )
        await conn.execute(
            sa.text("DELETE FROM notification_settings WHERE workspace_id = :id"), {"id": ws_a}
        )
        await conn.execute(sa.text("DELETE FROM workspaces WHERE id = :id"), {"id": ws_a})


async def _count(sql: str, **params: object) -> int:
    async with engine.connect() as conn:
        return int(await conn.scalar(sa.text(sql), params) or 0)


@pytest.mark.asyncio
async def test_export_counts_exclude_deleted_dashboards(
    tmp_path: Path, saas_data: dict[str, UUID]
) -> None:
    out = tmp_path / "a.jsonl.gz"
    counts = await export_workspace(engine, saas_data["ws_a"], out)

    assert counts["sensors"] == 1
    assert counts["readings"] == 3
    assert counts["alarms"] == 1
    assert counts["dashboards"] == 1
    assert counts["widgets"] == 1
    assert counts["webhook_subscriptions"] == 1
    assert counts["notification_settings"] == 1


@pytest.mark.asyncio
async def test_export_self_hosted_scope_excludes_saas_workspaces(
    tmp_path: Path, saas_data: dict[str, UUID]
) -> None:
    """workspace_id=None を指定すると、self-hosted のデータ（NULL）だけが対象になる。"""
    async with AsyncSession(engine) as session:
        session.add(Sensor(workspace_id=None, name="自宅温度", ingest_key="oss-key-x1", unit="℃"))
        await session.commit()

    out = tmp_path / "self-hosted.jsonl.gz"
    counts = await export_workspace(engine, None, out)

    # SaaS 側（ws_a・ws_b）のセンサーは含めず、self-hosted の1件だけ
    assert counts["sensors"] == 1
    with gzip.open(out, "rt", encoding="utf-8") as f:
        header = json.loads(f.readline())
        rows = [json.loads(line) for line in f]
    assert header["workspace_id"] is None
    sensor_rows = [r["r"] for r in rows if r["t"] == "sensors"]
    assert [r["ingest_key"] for r in sensor_rows] == ["oss-key-x1"]


@pytest.mark.asyncio
async def test_import_moves_workspace_to_self_hosted(
    tmp_path: Path, saas_data: dict[str, UUID]
) -> None:
    out = tmp_path / "a.jsonl.gz"
    await export_workspace(engine, saas_data["ws_a"], out)
    await _remove_workspace_a(saas_data["ws_a"])

    counts = await import_bundle(engine, out)

    assert counts["sensors"] == 1
    assert counts["readings"] == 3
    # 同じ ID と取り込みキーのまま、self-hosted（workspace_id NULL）に入る
    assert (
        await _count(
            "SELECT COUNT(*) FROM sensors "
            "WHERE id = :id AND workspace_id IS NULL AND ingest_key = 'saas-key-a1'",
            id=saas_data["sensor"],
        )
        == 1
    )
    assert (
        await _count("SELECT COUNT(*) FROM readings WHERE sensor_id = :id", id=saas_data["sensor"])
        == 3
    )
    assert (
        await _count("SELECT COUNT(*) FROM alarms WHERE sensor_id = :id", id=saas_data["sensor"])
        == 1
    )
    assert (
        await _count(
            "SELECT COUNT(*) FROM dashboards WHERE id = :id AND workspace_id IS NULL",
            id=saas_data["dashboard"],
        )
        == 1
    )
    assert (
        await _count("SELECT COUNT(*) FROM widgets WHERE sensor_id = :id", id=saas_data["sensor"])
        == 1
    )
    assert (
        await _count("SELECT COUNT(*) FROM webhook_subscriptions WHERE workspace_id IS NULL") == 1
    )
    # 通知設定は --with-notifications なしでは移さない
    assert await _count("SELECT COUNT(*) FROM notification_settings") == 0
    # 別のワークスペース B のセンサーには触れない
    assert await _count("SELECT COUNT(*) FROM sensors WHERE ingest_key = 'saas-key-b1'") == 1


@pytest.mark.asyncio
async def test_import_with_notifications_sets_self_hosted_row(
    tmp_path: Path, saas_data: dict[str, UUID]
) -> None:
    out = tmp_path / "a.jsonl.gz"
    await export_workspace(engine, saas_data["ws_a"], out)
    await _remove_workspace_a(saas_data["ws_a"])

    await import_bundle(engine, out, with_notifications=True)

    assert (
        await _count(
            "SELECT COUNT(*) FROM notification_settings WHERE id = 1 AND workspace_id IS NULL "
            "AND discord_webhook_url_critical = 'https://discord.example/critical'"
        )
        == 1
    )


@pytest.mark.asyncio
async def test_dry_run_leaves_nothing_behind(tmp_path: Path, saas_data: dict[str, UUID]) -> None:
    out = tmp_path / "a.jsonl.gz"
    await export_workspace(engine, saas_data["ws_a"], out)
    await _remove_workspace_a(saas_data["ws_a"])

    counts = await import_bundle(engine, out, dry_run=True)

    assert counts["readings"] == 3
    assert await _count("SELECT COUNT(*) FROM sensors WHERE workspace_id IS NULL") == 0
    assert await _count("SELECT COUNT(*) FROM readings") == 0


@pytest.mark.asyncio
async def test_import_conflict_rolls_back_everything(
    tmp_path: Path, saas_data: dict[str, UUID]
) -> None:
    out = tmp_path / "a.jsonl.gz"
    await export_workspace(engine, saas_data["ws_a"], out)
    await _remove_workspace_a(saas_data["ws_a"])
    await import_bundle(engine, out)

    # 同じファイルをもう一度入れると、ID 重複で止まり、途中まで入った分も残らない
    with pytest.raises(IntegrityError):
        await import_bundle(engine, out)
    assert await _count("SELECT COUNT(*) FROM sensors WHERE workspace_id IS NULL") == 1
    assert await _count("SELECT COUNT(*) FROM readings") == 3


@pytest.mark.asyncio
async def test_import_rejects_schema_version_mismatch(
    tmp_path: Path, saas_data: dict[str, UUID]
) -> None:
    out = tmp_path / "a.jsonl.gz"
    await export_workspace(engine, saas_data["ws_a"], out)
    await _remove_workspace_a(saas_data["ws_a"])
    async with engine.begin() as conn:
        await conn.execute(sa.text("UPDATE alembic_version SET version_num = 'otherrev'"))

    with pytest.raises(MigrationError, match="スキーマ版が違います"):
        await import_bundle(engine, out)
    assert await _count("SELECT COUNT(*) FROM sensors") == 1  # ワークスペース B のセンサーだけ


def test_cli_process_registers_tables_without_other_imports() -> None:
    # CLI は単独プロセスで起動される。テーブル定義を別の経路で読み込んでいなくても動くことを確かめる
    code = (
        "import app.migrate_saas_to_oss as m\n"
        "from sqlmodel import SQLModel\n"
        "assert all(name in SQLModel.metadata.tables for name in m.TABLES)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.asyncio
async def test_import_missing_file_is_a_clear_error(tmp_path: Path) -> None:
    with pytest.raises(MigrationError, match="見つかりません"):
        await import_bundle(engine, tmp_path / "nope.jsonl.gz")


@pytest.mark.asyncio
async def test_readings_roundtrip_is_exact_across_line_boundaries(
    tmp_path: Path, alembic_table: None
) -> None:
    """測定値は、行の境界（5,000件ごと）をまたいでも、時刻（マイクロ秒）と値が完全に戻る。"""
    base = datetime(2026, 1, 1, tzinfo=UTC)
    async with AsyncSession(engine) as session:
        user = User(email="rt@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        ws = Workspace(name="RT", owner_id=user.id)
        session.add(ws)
        await session.flush()
        s1 = Sensor(workspace_id=ws.id, name="rt-1", ingest_key="rt-key-1", unit="℃")
        s2 = Sensor(workspace_id=ws.id, name="rt-2", ingest_key="rt-key-2", unit="℃")
        session.add_all([s1, s2])
        await session.flush()
        ws_id, s1_id, s2_id = ws.id, s1.id, s2.id

        expected: list[tuple[UUID, float, datetime]] = []
        # 5,001件: 行の境界（5,000件）をまたぐように。時刻は µs の端数を含む
        for i in range(5001):
            at = base + timedelta(seconds=5 * i, microseconds=(i * 37) % 1_000_000)
            value = i / 7
            session.add(Reading(sensor_id=s1_id, value=value, recorded_at=at))
            expected.append((s1_id, value, at))
        for i in range(3):
            at = base + timedelta(microseconds=i * 999_999)
            session.add(Reading(sensor_id=s2_id, value=-float(i), recorded_at=at))
            expected.append((s2_id, -float(i), at))
        await session.commit()

    out = tmp_path / "rt.jsonl.gz"
    counts = await export_workspace(engine, ws_id, out)
    assert counts["readings"] == 5004

    await _remove_workspace_a(ws_id)
    await import_bundle(engine, out)

    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                sa.text(
                    "SELECT sensor_id, value, recorded_at FROM readings "
                    "ORDER BY sensor_id, recorded_at"
                )
            )
        ).all()
    got = [(r[0], r[1], r[2]) for r in rows]
    assert sorted(got) == sorted(expected)


def _write_bundle(
    path: Path, lines: list[dict[str, object]], alembic_version: str = "testrev"
) -> None:
    """テスト用に、書き出し形式（ヘッダー + 行）のファイルを直接作る。"""
    import json

    header = {
        "format": "factoreye-workspace-export",
        "version": 3,
        "workspace_id": "00000000-0000-4000-8000-000000000001",
        "exported_at": "2026-10-04T00:00:00+00:00",
        "alembic_version": alembic_version,
    }
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write(json.dumps(header) + "\n")
        for line in lines:
            f.write(json.dumps(line) + "\n")


_SENSOR_ROW = {
    "id": "00000000-0000-4000-8000-0000000000aa",
    "workspace_id": None,
    "name": "bad-value",
    "ingest_key": "bad-key-1",
    "unit": "℃",
    "threshold_min_warning": None,
    "threshold_min_critical": None,
    "threshold_max_warning": None,
    "threshold_max_critical": None,
    "threshold_dead_band": 0.0,
    "enabled": True,
    "created_at": "2026-10-04T00:00:00+00:00",
    "updated_at": "2026-10-04T00:00:00+00:00",
}


@pytest.mark.asyncio
async def test_malformed_uuid_is_a_migration_error(tmp_path: Path, alembic_table: None) -> None:
    path = tmp_path / "bad-uuid.jsonl.gz"
    _write_bundle(path, [{"t": "sensors", "r": {**_SENSOR_ROW, "id": "not-a-uuid"}}])
    with pytest.raises(MigrationError):
        await import_bundle(engine, path)


@pytest.mark.asyncio
async def test_value_of_wrong_type_is_a_migration_error(
    tmp_path: Path, alembic_table: None
) -> None:
    path = tmp_path / "bad-type.jsonl.gz"
    row = {**_SENSOR_ROW, "threshold_max_critical": "たくさん"}
    _write_bundle(path, [{"t": "sensors", "r": row}])
    with pytest.raises(MigrationError, match="形式と合いません"):
        await import_bundle(engine, path)
    assert await _count("SELECT COUNT(*) FROM sensors") == 0
