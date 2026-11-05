"""書き戻し（バックアップ → 今の DB）のテスト。今の DB の代わりに、展開した別のダンプを使う。"""

import base64
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import httpx
import pytest

from recovery import dbinfo, merge
from recovery.app import create_app
from recovery.config import Settings
from recovery.scratch import Scratch
from recovery.sources import CompositeSource, LocalSource
from tests.conftest import DUMP_SQL, SCRATCH_DSN, WS_A, WS_B, needs_db, write_dump

pytestmark = needs_db

# 今の DB: A は測定値が 1 件欠け（10/5 の分だけ）、B は失われ、C が新しくできた。
# 測定値の id は、作り直した DB の連番を想定してバックアップと重ねる
# （id ではなく中身で突き合わせることを確かめる）
WS_C = "33333333-3333-3333-3333-333333333333"
CURRENT_SQL = DUMP_SQL.split("INSERT INTO public.alembic_version")[0] + f"""
INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');
INSERT INTO public.users VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com', 'secret-hash', '2026-10-01T00:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'c@example.com', 'secret-hash', '2026-10-08T00:00:00Z');
INSERT INTO public.workspaces VALUES
  ('{WS_A}', 'Factory A', 'aaaaaaaa-0000-0000-0000-000000000001', 'free', '2026-10-01T00:00:00Z'),
  ('{WS_C}', 'Factory C', 'aaaaaaaa-0000-0000-0000-000000000003', 'free', '2026-10-08T00:00:00Z');
INSERT INTO public.sensors VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', '{WS_A}', 'temp', '2026-10-01T00:00:00Z');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 20.5, '2026-10-05T00:00:00Z');
-- 消失の後に、同じセンサーで新しいアラームが発生している
INSERT INTO public.alarms VALUES
  ('dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001',
   '2026-10-08T00:00:00Z', NULL, 'ACTIVE');
"""


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}.sql.gz"


@pytest.fixture
async def dbs(tmp_path: Path) -> AsyncIterator[tuple[Scratch, str, str]]:
    """(scratch, バックアップの名前, 今の DB の名前)。"""
    s = Scratch(SCRATCH_DSN)
    backup, current = _name("factoreye"), _name("current")
    await s.load(backup, write_dump(tmp_path, backup))
    await s.load(current, write_dump(tmp_path, current, CURRENT_SQL))
    yield s, backup, current
    await s.drop(backup)
    await s.drop(current)


async def _run(
    s: Scratch, backup: str, current: str, sel: merge.MergeSelection, apply: bool
) -> merge.MergeResult:
    async with dbinfo.read_only(s.dsn_for(backup)) as src, merge.connect_target(
        s.dsn_for(current)
    ) as dst:
        return await merge.merge(src, dst, sel, apply)


async def _count(dsn: str, sql: str) -> int:
    conn = await asyncpg.connect(dsn)
    try:
        return int(await conn.fetchval(sql))
    finally:
        await conn.close()


def _by_table(r: merge.MergeResult) -> dict[str, tuple[int, int]]:
    return {t.table: (t.inserted, t.existing) for t in r.tables}


async def test_dry_run_reports_and_changes_nothing(dbs: tuple[Scratch, str, str]) -> None:
    s, backup, current = dbs
    r = await _run(s, backup, current, merge.MergeSelection([uuid.UUID(WS_B)]), apply=False)

    assert not r.applied
    t = _by_table(r)
    assert t["users"] == (1, 0) and t["workspaces"] == (1, 0)
    assert t["sensors"] == (1, 0) and t["readings"] == (1, 0)
    assert await _count(s.dsn_for(current), "SELECT count(*) FROM workspaces") == 2


async def test_apply_restores_lost_workspace_and_is_idempotent(
    dbs: tuple[Scratch, str, str],
) -> None:
    s, backup, current = dbs
    sel = merge.MergeSelection([uuid.UUID(WS_B)])

    await _run(s, backup, current, sel, apply=True)
    again = await _run(s, backup, current, sel, apply=True)

    dsn = s.dsn_for(current)
    assert await _count(dsn, f"SELECT count(*) FROM workspaces WHERE id = '{WS_B}'") == 1
    assert await _count(dsn, "SELECT count(*) FROM readings") == 2
    # 2 回目は何も足さない
    assert all(t.inserted == 0 for t in again.tables)


async def test_fills_missing_readings_by_content_not_id(dbs: tuple[Scratch, str, str]) -> None:
    s, backup, current = dbs
    r = await _run(s, backup, current, merge.MergeSelection([uuid.UUID(WS_A)]), apply=True)

    t = _by_table(r)
    # 10/5 の分は id が重なるが中身が同じなので飛ばし、10/6 の分だけ足す
    assert t["readings"] == (1, 1)
    assert t["users"] == (0, 1) and t["sensors"] == (0, 1)
    assert await _count(s.dsn_for(current), "SELECT count(*) FROM readings") == 2


async def test_time_range_limits_readings(dbs: tuple[Scratch, str, str]) -> None:
    s, backup, current = dbs
    sel = merge.MergeSelection(
        [uuid.UUID(WS_B)], time_from=datetime(2026, 10, 8, tzinfo=UTC)
    )
    r = await _run(s, backup, current, sel, apply=False)

    # B の測定値は 10/7 の 1 件だけなので、10/8 以降に絞ると 0 件
    assert _by_table(r)["readings"] == (0, 0)
    assert _by_table(r)["sensors"] == (1, 0)


async def test_conflict_aborts_everything(tmp_path: Path) -> None:
    # 今の DB に、同じメールの別のユーザーがいる（B の所有者が作り直された）
    s = Scratch(SCRATCH_DSN)
    backup, current = _name("factoreye"), _name("current")
    conflict_sql = CURRENT_SQL.replace(
        "('aaaaaaaa-0000-0000-0000-000000000003', 'c@example.com'",
        "('aaaaaaaa-0000-0000-0000-000000000003', 'b@example.com'",
    )
    await s.load(backup, write_dump(tmp_path, backup))
    await s.load(current, write_dump(tmp_path, current, conflict_sql))
    try:
        with pytest.raises(merge.MergeError, match="users"):
            await _run(s, backup, current, merge.MergeSelection([uuid.UUID(WS_B)]), apply=True)
        assert await _count(s.dsn_for(current), "SELECT count(*) FROM workspaces") == 2
    finally:
        await s.drop(backup)
        await s.drop(current)


async def test_schema_version_mismatch_is_rejected(tmp_path: Path) -> None:
    s = Scratch(SCRATCH_DSN)
    backup, current = _name("factoreye"), _name("current")
    await s.load(backup, write_dump(tmp_path, backup))
    await s.load(current, write_dump(tmp_path, current, CURRENT_SQL.replace("d4e5f6a7b8c9", "zzz")))
    try:
        with pytest.raises(merge.MergeError, match="スキーマの版"):
            await _run(s, backup, current, merge.MergeSelection([uuid.UUID(WS_B)]), apply=False)
    finally:
        await s.drop(backup)
        await s.drop(current)


async def test_requires_selection(dbs: tuple[Scratch, str, str]) -> None:
    s, backup, current = dbs
    with pytest.raises(merge.MergeError):
        await _run(s, backup, current, merge.MergeSelection([]), apply=False)


async def test_api_merge_takes_snapshot_first(
    tmp_path: Path, dbs: tuple[Scratch, str, str]
) -> None:
    s, backup, current = dbs
    snapshots = tmp_path / "snapshots"
    settings = Settings(
        backup_source=str(tmp_path), scratch_dsn=SCRATCH_DSN, target_dsn=s.dsn_for(current),
        cache_dir=tmp_path, username="admin", password="correct-horse-battery",
        s3_endpoint_url=None, target_write_dsn=s.dsn_for(current), snapshot_dir=snapshots,
        target_mode="saas",
    )
    app = create_app(
        settings, CompositeSource([LocalSource(tmp_path)], optional=[LocalSource(snapshots)]), s
    )
    token = base64.b64encode(b"admin:correct-horse-battery").decode()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Basic {token}"},
    ) as c:
        assert (await c.get("/api/info")).json()["merge_enabled"] is True
        dry = (await c.post(f"/api/backups/{backup}/merge", json={"workspace_ids": [WS_B]})).json()
        assert dry["applied"] is False and dry["snapshot"] is None
        planned = sum(t["inserted"] for t in dry["tables"])
        # 試行をせずに実行・試行と違う件数で実行は、どちらも拒否する
        no_plan = await c.post(
            f"/api/backups/{backup}/merge", json={"workspace_ids": [WS_B], "apply": True}
        )
        assert no_plan.status_code == 422
        stale = await c.post(f"/api/backups/{backup}/merge", json={
            "workspace_ids": [WS_B], "apply": True, "expected_inserted": planned + 1,
        })
        assert stale.status_code == 409
        assert not snapshots.exists() or not list(snapshots.glob("*.sql.gz"))
        r = await c.post(f"/api/backups/{backup}/merge", json={
            "workspace_ids": [WS_B], "apply": True, "expected_inserted": planned,
        })
        assert r.status_code == 200, r.text
        snap = r.json()["snapshot"]
        listed = [b["name"] for b in (await c.get("/api/backups")).json()]

    assert snap in listed
    # 控えは書き戻しの前の状態（B が無い）
    snap_name = str(snap)
    has_b = f"SELECT count(*) FROM workspaces WHERE id = '{WS_B}'"
    await s.load(snap_name, snapshots / snap_name)
    try:
        assert await _count(s.dsn_for(snap_name), has_b) == 0
    finally:
        await s.drop(snap_name)
    assert await _count(s.dsn_for(current), has_b) == 1


async def test_api_merge_disabled_without_write_dsn(
    tmp_path: Path, dbs: tuple[Scratch, str, str]
) -> None:
    s, backup, current = dbs
    settings = Settings(
        backup_source=str(tmp_path), scratch_dsn=SCRATCH_DSN, target_dsn=s.dsn_for(current),
        cache_dir=tmp_path, username="admin", password="correct-horse-battery",
        s3_endpoint_url=None, target_write_dsn=None, snapshot_dir=tmp_path / "snap",
        target_mode=None,
    )
    app = create_app(settings, LocalSource(tmp_path), s)
    token = base64.b64encode(b"admin:correct-horse-battery").decode()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Basic {token}"},
    ) as c:
        r = await c.post(f"/api/backups/{backup}/merge", json={"workspace_ids": [WS_B]})
    assert r.status_code == 403


def test_bind_numbers_only_used_parameters() -> None:
    sel = merge.MergeSelection([uuid.uuid4()], time_to=datetime(2026, 1, 1, tzinfo=UTC))
    sql, args = merge.bind("id = ANY(:ids)", sel, "recorded_at")
    assert sql == 'id = ANY($1::uuid[]) AND "recorded_at" < $2::timestamptz'
    assert args == [sel.workspace_ids, sel.time_to]


async def test_open_alarm_is_closed_when_sensor_already_has_one(
    dbs: tuple[Scratch, str, str],
) -> None:
    s, backup, current = dbs
    r = await _run(s, backup, current, merge.MergeSelection([uuid.UUID(WS_A)]), apply=True)

    alarms = next(t for t in r.tables if t.table == "alarms")
    assert (alarms.inserted, alarms.closed) == (1, 1) and alarms.note
    dsn = s.dsn_for(current)
    restored = "SELECT status::text FROM alarms WHERE id = 'dddddddd-0000-0000-0000-000000000001'"
    newer = "SELECT status::text FROM alarms WHERE id = 'dddddddd-0000-0000-0000-000000000002'"
    conn = await asyncpg.connect(dsn)
    try:
        assert await conn.fetchval(restored) == "RESOLVED"
        assert await conn.fetchval(newer) == "ACTIVE"
    finally:
        await conn.close()


async def test_self_hosted_settings_keep_id_and_advance_sequence(
    dbs: tuple[Scratch, str, str],
) -> None:
    s, backup, current = dbs
    sel = merge.MergeSelection([], include_self_hosted=True)

    dry = await _run(s, backup, current, sel, apply=False)
    await _run(s, backup, current, sel, apply=True)
    again = await _run(s, backup, current, sel, apply=True)

    # 通知設定は、ワークスペースの分と self-hosted の分の 2 行で報告する
    assert [t.inserted for t in dry.tables if t.table == "notification_settings"] == [0, 1]
    assert all(t.inserted == 0 for t in again.tables)
    conn = await asyncpg.connect(s.dsn_for(current))
    try:
        # backend は self-hosted の設定を id=1 で読む
        assert await conn.fetchval(
            "SELECT id FROM notification_settings WHERE workspace_id IS NULL"
        ) == 1
        # 次の採番が id=1 と重ならない
        assert await conn.fetchval("SELECT nextval('notification_settings_id_seq')") == 2
    finally:
        await conn.close()


async def test_workspace_settings_get_new_ids(dbs: tuple[Scratch, str, str]) -> None:
    s, backup, current = dbs
    r = await _run(s, backup, current, merge.MergeSelection([uuid.UUID(WS_A)]), apply=True)

    assert [t.inserted for t in r.tables if t.table == "notification_settings"] == [1]
    assert await _count(
        s.dsn_for(current),
        f"SELECT count(*) FROM notification_settings WHERE workspace_id = '{WS_A}'",
    ) == 1


# ── OSS 版 ⇄ SaaS 版（所属を変えて書き戻す） ──

_SCHEMA = DUMP_SQL.split("INSERT INTO public.alembic_version")[0]
_OSS_SENSOR = "eeeeeeee-0000-0000-0000-000000000001"
OSS_SQL = _SCHEMA + f"""
INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');
INSERT INTO public.sensors VALUES ('{_OSS_SENSOR}', NULL, 'oss-temp', '2026-10-01T00:00:00Z');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{_OSS_SENSOR}', 1.0, '2026-10-05T00:00:00Z'), ('{_OSS_SENSOR}', 2.0, '2026-10-06T00:00:00Z');
INSERT INTO public.alarms VALUES
  ('dddddddd-0000-0000-0000-0000000000aa', '{_OSS_SENSOR}', '2026-10-06T00:00:00Z', NULL, 'ACTIVE');
INSERT INTO public.notification_settings (id, workspace_id, enabled) VALUES (1, NULL, false);
SELECT setval('public.notification_settings_id_seq', 1);
"""
OSS_EMPTY_SQL = _SCHEMA + "INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');\n"


@pytest.fixture
async def cross(tmp_path: Path) -> AsyncIterator[tuple[Scratch, dict[str, str]]]:
    """OSS 版・SaaS 版のバックアップと、今の DB（SaaS 版・空の OSS 版）を展開する。"""
    s = Scratch(SCRATCH_DSN)
    names = {k: _name(k) for k in ("oss_backup", "saas_backup", "saas_current", "oss_current")}
    sql = {"oss_backup": OSS_SQL, "saas_backup": DUMP_SQL, "saas_current": CURRENT_SQL,
           "oss_current": OSS_EMPTY_SQL}
    for k, n in names.items():
        await s.load(n, write_dump(tmp_path, n, sql[k]))
    yield s, names
    for n in names.values():
        await s.drop(n)


async def _run_mode(
    s: Scratch, backup: str, current: str, sel: merge.MergeSelection, mode: str
) -> merge.MergeResult:
    async with dbinfo.read_only(s.dsn_for(backup)) as src, merge.connect_target(
        s.dsn_for(current)
    ) as dst:
        return await merge.merge(src, dst, sel, apply=True, target_mode=mode)


async def test_oss_backup_into_saas_workspace(cross: tuple[Scratch, dict[str, str]]) -> None:
    s, n = cross
    sel = merge.MergeSelection([], include_self_hosted=True, into_workspace_id=uuid.UUID(WS_C))

    r = await _run_mode(s, n["oss_backup"], n["saas_current"], sel, "saas")

    t = _by_table(r)
    assert "users" not in t and "workspaces" not in t
    dsn = s.dsn_for(n["saas_current"])
    assert await _count(dsn, f"SELECT count(*) FROM sensors WHERE workspace_id = '{WS_C}'") == 1
    assert await _count(dsn, "SELECT count(*) FROM sensors WHERE workspace_id IS NULL") == 0
    assert await _count(
        dsn, f"SELECT count(*) FROM readings WHERE sensor_id = '{_OSS_SENSOR}'"
    ) == 2
    # 通知設定は、書き戻し先のワークスペースのものとして入る（OSS 版の NULL の行は作らない）
    assert await _count(
        dsn, f"SELECT count(*) FROM notification_settings WHERE workspace_id = '{WS_C}'"
    ) == 1
    assert await _count(
        dsn, "SELECT count(*) FROM notification_settings WHERE workspace_id IS NULL"
    ) == 0


async def test_saas_backup_into_oss(cross: tuple[Scratch, dict[str, str]]) -> None:
    s, n = cross
    sel = merge.MergeSelection([uuid.UUID(WS_A), uuid.UUID(WS_B)], into_self_hosted=True)

    await _run_mode(s, n["saas_backup"], n["oss_current"], sel, "oss")

    dsn = s.dsn_for(n["oss_current"])
    assert await _count(dsn, "SELECT count(*) FROM sensors WHERE workspace_id IS NULL") == 2
    assert await _count(dsn, "SELECT count(*) FROM readings") == 3
    # ユーザー・ワークスペースの行は入れない（OSS 版では使わない）
    assert await _count(dsn, "SELECT count(*) FROM users") == 0
    assert await _count(dsn, "SELECT count(*) FROM workspaces") == 0
    conn = await asyncpg.connect(dsn)
    try:
        # OSS 版の通知設定は 1 行だけ、backend が読む id=1 で入り、連番も進む
        rows = await conn.fetch("SELECT id, workspace_id FROM notification_settings")
        assert [(r["id"], r["workspace_id"]) for r in rows] == [(1, None)]
        assert await conn.fetchval("SELECT nextval('notification_settings_id_seq')") == 2
    finally:
        await conn.close()


@pytest.mark.parametrize(
    ("sel", "mode", "message"),
    [
        (merge.MergeSelection([], include_self_hosted=True), "saas", "書き戻し先のワークスペース"),
        (
            merge.MergeSelection([], include_self_hosted=True, into_self_hosted=True),
            "saas", "SaaS 版",
        ),
        (merge.MergeSelection([uuid.UUID(WS_A)]), "oss", "書き戻し先を OSS 版"),
        (
            merge.MergeSelection([uuid.UUID(WS_A)], into_workspace_id=uuid.UUID(WS_A)),
            "oss", "OSS 版",
        ),
    ],
)
def test_check_mode_rejects_unusable_destinations(
    sel: merge.MergeSelection, mode: str, message: str
) -> None:
    with pytest.raises(merge.MergeError, match=message):
        merge.check_mode(sel, mode)


async def test_destination_workspace_must_exist(cross: tuple[Scratch, dict[str, str]]) -> None:
    s, n = cross
    sel = merge.MergeSelection([], include_self_hosted=True, into_workspace_id=uuid.uuid4())
    with pytest.raises(merge.MergeError, match="ありません"):
        await _run_mode(s, n["oss_backup"], n["saas_current"], sel, "saas")
