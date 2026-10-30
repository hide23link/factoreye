"""機器ごとのキー（ingest_devices・sensors.device_id）の書き戻しのテスト。

機器に所属したセンサーを戻すとき、参照先の機器の行が無いと外部キー違反になる。
- 同じ OSS 版への復元: 機器の行（名前とキーのハッシュ）も戻す
- SaaS 版への書き戻し: 機器は持ち込まず、センサーの所属（device_id）は外す
"""

import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import pytest

from recovery import dbinfo, merge
from recovery.scratch import Scratch
from tests.conftest import DUMP_SQL, SCRATCH_DSN, needs_db, write_dump

pytestmark = needs_db

_SENSORS_DDL = (
    "CREATE TABLE public.sensors (id uuid PRIMARY KEY, workspace_id uuid, "
    "name varchar(100),\n  created_at timestamptz);"
)
_DEVICES_AND_SENSORS_DDL = """CREATE TABLE public.ingest_devices (id uuid PRIMARY KEY,
  name varchar(100) UNIQUE, key_hash varchar(64) UNIQUE, created_at timestamptz,
  revoked_at timestamptz);
ALTER TABLE public.ingest_devices OWNER TO fe_test_owner;
CREATE TABLE public.sensors (id uuid PRIMARY KEY, workspace_id uuid, name varchar(100),
  created_at timestamptz, device_id uuid REFERENCES public.ingest_devices(id));"""

_SCHEMA = DUMP_SQL.split("INSERT INTO public.alembic_version")[0]
assert _SENSORS_DDL in _SCHEMA
SCHEMA = _SCHEMA.replace(_SENSORS_DDL, _DEVICES_AND_SENSORS_DDL)

DEVICE = "cccccccc-0000-0000-0000-000000000001"
SENSOR = "eeeeeeee-0000-0000-0000-000000000009"
KEY_HASH = "a" * 64
WS_C = "33333333-3333-3333-3333-333333333333"

OSS_SQL = SCHEMA + f"""
INSERT INTO public.alembic_version VALUES ('h8c9d0e1f2a3');
INSERT INTO public.ingest_devices VALUES
  ('{DEVICE}', 'line-1', '{KEY_HASH}', '2026-10-01T00:00:00Z', NULL);
INSERT INTO public.sensors (id, workspace_id, name, created_at, device_id) VALUES
  ('{SENSOR}', NULL, 'oss-volt', '2026-10-01T00:00:00Z', '{DEVICE}');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{SENSOR}', 12.3, '2026-10-05T00:00:00Z');
"""
OSS_EMPTY_SQL = SCHEMA + "INSERT INTO public.alembic_version VALUES ('h8c9d0e1f2a3');\n"
SAAS_SQL = SCHEMA + f"""
INSERT INTO public.alembic_version VALUES ('h8c9d0e1f2a3');
INSERT INTO public.users VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003', 'c@example.com', 'secret-hash', '2026-10-08T00:00:00Z');
INSERT INTO public.workspaces VALUES
  ('{WS_C}', 'Factory C', 'aaaaaaaa-0000-0000-0000-000000000003', 'free', '2026-10-08T00:00:00Z');
"""


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}.sql.gz"


@pytest.fixture
async def dbs(tmp_path: Path) -> AsyncIterator[tuple[Scratch, dict[str, str]]]:
    s = Scratch(SCRATCH_DSN)
    sql = {"oss_backup": OSS_SQL, "oss_current": OSS_EMPTY_SQL, "saas_current": SAAS_SQL}
    names = {k: _name(k) for k in sql}
    for k, n in names.items():
        await s.load(n, write_dump(tmp_path, n, sql[k]))
    yield s, names
    for n in names.values():
        await s.drop(n)


async def _run(
    s: Scratch, backup: str, current: str, sel: merge.MergeSelection, mode: str | None = None
) -> merge.MergeResult:
    async with dbinfo.read_only(s.dsn_for(backup)) as src, merge.connect_target(
        s.dsn_for(current)
    ) as dst:
        if mode is None:
            return await merge.merge(src, dst, sel, apply=True)
        return await merge.merge(src, dst, sel, apply=True, target_mode=mode)


async def _fetch(dsn: str, sql: str) -> list[asyncpg.Record]:
    conn = await asyncpg.connect(dsn)
    try:
        return list(await conn.fetch(sql))
    finally:
        await conn.close()


async def test_devices_are_restored_with_attached_sensors(
    dbs: tuple[Scratch, dict[str, str]],
) -> None:
    s, n = dbs
    sel = merge.MergeSelection([], include_self_hosted=True)

    r = await _run(s, n["oss_backup"], n["oss_current"], sel)

    by_table = {t.table: (t.inserted, t.existing) for t in r.tables}
    assert by_table["ingest_devices"] == (1, 0)
    dsn = s.dsn_for(n["oss_current"])
    devices = await _fetch(dsn, "SELECT id::text, name, key_hash FROM ingest_devices")
    assert [tuple(d) for d in devices] == [(DEVICE, "line-1", KEY_HASH)]
    sensors = await _fetch(dsn, "SELECT device_id::text FROM sensors")
    assert [row[0] for row in sensors] == [DEVICE]


async def test_remap_into_saas_drops_device_link_and_does_not_fail(
    dbs: tuple[Scratch, dict[str, str]],
) -> None:
    s, n = dbs
    sel = merge.MergeSelection([], include_self_hosted=True, into_workspace_id=uuid.UUID(WS_C))

    r = await _run(s, n["oss_backup"], n["saas_current"], sel, mode="saas")

    assert "ingest_devices" not in {t.table for t in r.tables}
    dsn = s.dsn_for(n["saas_current"])
    assert (await _fetch(dsn, "SELECT count(*) FROM ingest_devices"))[0][0] == 0
    sensors = await _fetch(dsn, "SELECT workspace_id::text, device_id FROM sensors")
    assert [(row[0], row[1]) for row in sensors] == [(WS_C, None)]
