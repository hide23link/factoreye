"""テストの共通部品。

DB を使うテストは TEST_SCRATCH_DSN（作業用の Postgres の管理用 DB。例:
postgresql://factoreye:password@localhost:5432/postgres）と psql が必要。無ければ飛ばす。
本番や開発用の DB は指定しない（テストは bk_* の DB を作って消す）。
"""

import gzip
import os
import shutil
from pathlib import Path

import pytest

SCRATCH_DSN = os.environ.get("TEST_SCRATCH_DSN", "")

needs_db = pytest.mark.skipif(
    not SCRATCH_DSN or shutil.which("psql") is None,
    reason="TEST_SCRATCH_DSN と psql が必要",
)

WS_A = "11111111-1111-1111-1111-111111111111"
WS_B = "22222222-2222-2222-2222-222222222222"

# pg_dump の出力に似せた、小さなダンプ（所有者の指定・alembic_version を含む）
DUMP_SQL = f"""
SET client_encoding = 'UTF8';
CREATE TABLE public.alembic_version (version_num varchar(32) NOT NULL);
ALTER TABLE public.alembic_version OWNER TO fe_test_owner;
CREATE TABLE public.users (id uuid PRIMARY KEY, email varchar(254), password_hash varchar(200),
  created_at timestamptz);
ALTER TABLE public.users OWNER TO fe_test_owner;
CREATE TABLE public.workspaces (id uuid PRIMARY KEY, name varchar(100), owner_id uuid,
  plan varchar(20), created_at timestamptz);
ALTER TABLE public.workspaces OWNER TO fe_test_owner;
CREATE TABLE public.sensors (id uuid PRIMARY KEY, workspace_id uuid, name varchar(100),
  created_at timestamptz);
ALTER TABLE public.sensors OWNER TO fe_test_owner;
CREATE TABLE public.readings (id serial PRIMARY KEY, sensor_id uuid, value double precision,
  recorded_at timestamptz);
ALTER TABLE public.readings OWNER TO fe_test_owner;
INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');
INSERT INTO public.users VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com', 'secret-hash', '2026-10-01T00:00:00Z'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'b@example.com', 'secret-hash', '2026-10-01T00:00:00Z');
INSERT INTO public.workspaces VALUES
  ('{WS_A}', 'Factory A', 'aaaaaaaa-0000-0000-0000-000000000001', 'free', '2026-10-01T00:00:00Z'),
  ('{WS_B}', 'Factory B', 'aaaaaaaa-0000-0000-0000-000000000002', 'free', '2026-10-02T00:00:00Z');
INSERT INTO public.sensors VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', '{WS_A}', 'temp', '2026-10-01T00:00:00Z'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '{WS_B}', 'power', '2026-10-02T00:00:00Z');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 20.5, '2026-10-05T00:00:00Z'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 21.0, '2026-10-06T00:00:00Z'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 1.5, '2026-10-07T00:00:00Z');
"""


def write_dump(directory: Path, name: str, sql: str = DUMP_SQL) -> Path:
    path = directory / name
    with gzip.open(path, "wb") as f:
        f.write(sql.encode())
    return path
