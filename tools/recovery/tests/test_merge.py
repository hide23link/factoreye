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
    )
    app = create_app(
        settings, CompositeSource([LocalSource(tmp_path), LocalSource(snapshots)]), s
    )
    token = base64.b64encode(b"admin:correct-horse-battery").decode()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Basic {token}"},
    ) as c:
        assert (await c.get("/api/info")).json()["merge_enabled"] is True
        dry = (await c.post(f"/api/backups/{backup}/merge", json={"workspace_ids": [WS_B]})).json()
        assert dry["applied"] is False and dry["snapshot"] is None
        r = await c.post(
            f"/api/backups/{backup}/merge", json={"workspace_ids": [WS_B], "apply": True}
        )
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
