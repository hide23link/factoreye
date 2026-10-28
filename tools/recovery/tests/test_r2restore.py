"""R2 の WAL-G のバックアップ（ベース ＋ WAL）からの復旧のテスト。

実際の R2 の代わりに、WAL-G のファイルの置き場（WALG_FILE_PREFIX）を使う。
置き場を作るために、試験の準備でだけ wal-push・backup-push を使う（本体のコードは読み取りだけ）。
wal-g・initdb・pg_ctl・psql と TEST_SCRATCH_DSN が無ければ飛ばす。
"""

import asyncio
import base64
import os
import shutil
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import asyncpg
import httpx
import pytest

from recovery.app import create_app
from recovery.config import Settings
from recovery.scratch import Scratch
from recovery.sources import CompositeSource, HandoffSource, LocalSource
from recovery.walg import R2Restore, parse_env_file
from tests.conftest import DUMP_SQL, SCRATCH_DSN, WS_A, WS_B, needs_db, write_dump
from tests.test_handoff import A_PROD, HANDOFF_SQL, S1, S2, U1, U2, _put_handoff

needs_walg = pytest.mark.skipif(
    not all(shutil.which(c) for c in ("wal-g", "initdb", "pg_ctl", "psql")) or not SCRATCH_DSN,
    reason="wal-g・PostgreSQL のコマンド・TEST_SCRATCH_DSN が必要",
)
pytestmark = [needs_walg, needs_db]

_SCHEMA = DUMP_SQL.split("INSERT INTO public.alembic_version")[0]
ALEMBIC = "d4e5f6a7b8c9"

# R2 に残っている、本番の最後の状態。readings の後半 2 件は、ベースの後に書かれた（WAL にだけある）
BASE_DATA = f"""
INSERT INTO public.alembic_version VALUES ('{ALEMBIC}');
INSERT INTO public.users VALUES
  ('{U1}', 'a@example.com', 'r2-hash', '2026-10-01T00:00:00Z'),
  ('{U2}', 'b@example.com', 'r2-hash', '2026-10-02T00:00:00Z');
INSERT INTO public.workspaces VALUES
  ('{WS_A}', 'Factory A', '{U1}', 'free', '2026-10-01T00:00:00Z'),
  ('{WS_B}', 'Factory B', '{U2}', 'free', '2026-10-02T00:00:00Z');
INSERT INTO public.sensors VALUES
  ('{S1}', '{WS_A}', 'temp', '2026-10-01T00:00:00Z'),
  ('{S2}', '{WS_B}', 'power', '2026-10-02T00:00:00Z');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{S1}', 20.0, '2026-10-05T00:00:00Z'), ('{S1}', 21.0, '2026-10-05T01:00:00Z');
INSERT INTO public.alarms VALUES ('{A_PROD}', '{S1}', '2026-10-05T00:10:00Z', NULL, 'ACTIVE');
"""
WAL_ONLY_DATA = f"""
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{S1}', 22.0, '2026-10-05T02:00:00Z'), ('{S2}', 1.5, '2026-10-05T02:00:00Z');
"""


def _run(cmd: list[str], env: dict[str, str], stdin: str | None = None) -> str:
    r = subprocess.run(cmd, env=env, input=stdin, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, f"{cmd[:2]} failed: {r.stderr[-800:]}"
    return r.stdout


@pytest.fixture(scope="module")
def walg_repo(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    """元の本番に見立てた PostgreSQL を作り、ベースと WAL を置き場に送って、置き場を返す。"""
    tmp = tmp_path_factory.mktemp("walg")
    repo, data = tmp / "repo", tmp / "src"
    repo.mkdir()
    sock = Path(tempfile.mkdtemp(prefix="srcpg-"))
    env = {
        "PATH": os.environ["PATH"], "LANG": "C.UTF-8", "WALG_FILE_PREFIX": str(repo),
        "PGHOST": str(sock), "PGPORT": "54330", "PGUSER": "factoreye",
    }
    _run(["initdb", "-D", str(data), "-U", "factoreye", "--auth=trust", "-E", "UTF8",
          "--locale=C.UTF-8"], env)
    with (data / "postgresql.conf").open("a") as f:
        f.write(
            "\narchive_mode = on\narchive_command = 'wal-g wal-push %p'\nlisten_addresses = ''\n"
            f"unix_socket_directories = '{sock}'\nport = 54330\narchive_timeout = 5\n"
        )
    _run(["pg_ctl", "-D", str(data), "-w", "-l", str(tmp / "src.log"), "start"], env)
    try:
        _run(["psql", "-d", "postgres", "-c", "CREATE ROLE fe_test_owner NOLOGIN",
              "-c", "CREATE DATABASE factoreye"], env)
        _run(["psql", "-d", "factoreye", "-v", "ON_ERROR_STOP=1", "-q"], env, _SCHEMA + BASE_DATA)
        _run(["wal-g", "backup-push", str(data)], env)
        _run(["psql", "-d", "factoreye", "-v", "ON_ERROR_STOP=1", "-q"], env, WAL_ONLY_DATA)
        _run(["psql", "-d", "factoreye", "-Atc", "select pg_switch_wal()"], env)
        deadline = time.time() + 60
        while time.time() < deadline:  # 最後の WAL が置き場に届くまで待つ
            out = _run(["psql", "-d", "factoreye", "-Atc",
                        "select last_archived_wal is not null and "
                        "last_archived_wal >= pg_walfile_name(pg_current_wal_lsn() - 1) "
                        "from pg_stat_archiver"], env)
            if out.strip() == "t":
                break
            time.sleep(1)
    finally:
        _run(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"], env)
    yield repo
    shutil.rmtree(sock, ignore_errors=True)


def _target_sql(data: str) -> str:
    return _SCHEMA + f"INSERT INTO public.alembic_version VALUES ('{ALEMBIC}');\n" + data


@pytest.fixture
async def stack(
    tmp_path: Path, walg_repo: Path
) -> AsyncIterator[tuple[Scratch, R2Restore, Path]]:
    s = Scratch(SCRATCH_DSN)
    job = R2Restore({"WALG_FILE_PREFIX": str(walg_repo)}, tmp_path / "r2work")
    yield s, job, tmp_path
    await job.reset()


async def _client(
    tmp_path: Path, s: Scratch, job: R2Restore, target: str, sql: str | None,
    handoff_dir: Path | None = None,
) -> httpx.AsyncClient:
    if sql is not None:
        await s.load(target, write_dump(tmp_path, target, sql))
    settings = Settings(
        backup_source=str(tmp_path), scratch_dsn=SCRATCH_DSN, target_dsn=s.dsn_for(target),
        target_write_dsn=s.dsn_for(target), target_mode="saas", cache_dir=tmp_path,
        username="admin", password="correct-horse-battery", s3_endpoint_url=None,
        snapshot_dir=tmp_path / "snapshots",
    )
    handoff = HandoffSource(LocalSource(handoff_dir)) if handoff_dir else None
    app = create_app(
        settings,
        CompositeSource([LocalSource(tmp_path)], optional=[LocalSource(settings.snapshot_dir)]),
        s, handoff, job,
    )
    token = base64.b64encode(b"admin:correct-horse-battery").decode()
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Basic {token}"}, timeout=120,
    )


async def _ready(c: httpx.AsyncClient) -> dict[str, object]:
    assert (await c.post("/api/r2restore/start")).status_code == 200
    seen = set()
    for _ in range(240):
        st = (await c.get("/api/r2restore")).json()
        seen.add(st["state"])
        if st["state"] in ("ready", "failed"):
            assert st["state"] == "ready", st["message"]
            return st  # type: ignore[no-any-return]
        await asyncio.sleep(1)
    raise AssertionError(f"時間内に終わりません: {seen}")


async def _count(s: Scratch, db: str, sql: str) -> int:
    conn = await asyncpg.connect(s.dsn_for(db))
    try:
        return int(await conn.fetchval(sql))
    finally:
        await conn.close()


def _name() -> str:
    return f"prod-{os.urandom(4).hex()}.sql.gz"


def _totals(body: dict[str, Any]) -> dict[str, int]:
    return {t["table"]: t["inserted"] for t in body["tables"]}


def test_parse_env_file_reads_the_walg_env_format() -> None:
    text = "# 注釈\nAWS_ENDPOINT=https://x.r2.cloudflarestorage.com\n\nWALG_S3_PREFIX=s3://factoreye-db\n"
    env = parse_env_file(text)
    assert env == {"AWS_ENDPOINT": "https://x.r2.cloudflarestorage.com",
                   "WALG_S3_PREFIX": "s3://factoreye-db"}


async def test_empty_production_gets_everything_from_r2(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    try:
        async with await _client(tmp, s, job, target, _target_sql("")) as c:
            st = await _ready(c)
            info = st["info"]
            assert info["alembic"] == ALEMBIC and info["base_name"]  # type: ignore[index]
            dry = (await c.post("/api/r2restore/failback", json={})).json()
            assert dry["applied"] is False
            # ベースにあった行と、WAL にだけあった行の、両方が入る
            t = _totals(dry)
            assert (t["users"], t["workspaces"], t["sensors"], t["readings"], t["alarms"]) == (
                2, 2, 2, 4, 1
            )
            assert await _count(s, target, "SELECT count(*) FROM readings") == 0  # 試算は書かない
            planned = sum(_totals(dry).values())
            done = await c.post(
                "/api/r2restore/failback", json={"apply": True, "expected_inserted": planned}
            )
            assert done.status_code == 200, done.text
            assert done.json()["snapshot"].startswith("before-merge-")
            assert await _count(s, target, "SELECT count(*) FROM readings") == 4
            assert await _count(s, target, "SELECT count(*) FROM users") == 2
            # 2 回目は 0 件
            again = (await c.post("/api/r2restore/failback", json={})).json()
            assert sum(_totals(again).values()) == 0
    finally:
        await s.drop(target)


async def test_partial_production_gets_only_missing_rows(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    partial = _target_sql(f"""
INSERT INTO public.users VALUES ('{U1}', 'a@example.com', 'prod-hash', '2026-10-01T00:00:00Z');
INSERT INTO public.workspaces VALUES
  ('{WS_A}', 'Factory A', '{U1}', 'free', '2026-10-01T00:00:00Z');
INSERT INTO public.sensors VALUES ('{S1}', '{WS_A}', 'temp-prod', '2026-10-01T00:00:00Z');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{S1}', 20.0, '2026-10-05T00:00:00Z');
""")
    try:
        async with await _client(tmp, s, job, target, partial) as c:
            await _ready(c)
            dry = (await c.post("/api/r2restore/failback", json={})).json()
            t = _totals(dry)
            assert (t["users"], t["workspaces"], t["sensors"], t["readings"]) == (1, 1, 1, 3)
            planned = sum(t.values())
            r = await c.post(
                "/api/r2restore/failback", json={"apply": True, "expected_inserted": planned}
            )
            assert r.status_code == 200, r.text
            # 今ある行は変わらない
            conn = await asyncpg.connect(s.dsn_for(target))
            try:
                assert await conn.fetchval(f"SELECT password_hash FROM users WHERE id='{U1}'") == (
                    "prod-hash"
                )
                assert await conn.fetchval(f"SELECT name FROM sensors WHERE id='{S1}'") == (
                    "temp-prod"
                )
            finally:
                await conn.close()
            assert await _count(s, target, "SELECT count(*) FROM readings") == 4
            again = (await c.post("/api/r2restore/failback", json={})).json()
            assert sum(_totals(again).values()) == 0
    finally:
        await s.drop(target)


async def test_schema_version_difference_is_refused_with_both_versions(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    try:
        async with await _client(
            tmp, s, job, target, _target_sql("").replace(ALEMBIC, "zzz")
        ) as c:
            await _ready(c)
            r = await c.post("/api/r2restore/failback", json={})
            assert r.status_code == 409
            d = r.json()["detail"]
            assert d["code"] == "schema_mismatch"
            assert (d["handoff_alembic"], d["current_alembic"]) == (ALEMBIC, "zzz")
    finally:
        await s.drop(target)


async def test_production_without_schema_says_to_start_the_stack(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    try:
        async with await _client(tmp, s, job, target, "SET client_encoding = 'UTF8';") as c:
            await _ready(c)
            r = await c.post("/api/r2restore/failback", json={})
            assert r.status_code == 409 and "スキーマがありません" in r.json()["detail"]["message"]
    finally:
        await s.drop(target)


async def test_r2_and_handoff_are_merged_together_in_one_transaction(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    inc = tmp / "inc"
    inc.mkdir()
    # 引き継ぎには、R2 に無い読み取り（S1 の 10/5 04:00）がある
    name = _put_handoff(
        inc, "20261028-103000",
        HANDOFF_SQL.replace("2026-10-05T03:00:00Z", "2026-10-05T04:00:00Z"),
    )
    try:
        async with await _client(tmp, s, job, target, _target_sql(""), inc) as c:
            await _ready(c)
            body = {"handoff": name}
            dry = (await c.post("/api/r2restore/failback", json=body)).json()
            assert len(dry["parts"]) == 2
            # 引き継ぎの 02:00 の 2 件は、先に足した R2 の分と重なるので数えない。04:00 だけ増える
            assert _totals(dry)["readings"] == 5
            planned = sum(_totals(dry).values())
            r = await c.post("/api/r2restore/failback",
                             json={**body, "apply": True, "expected_inserted": planned})
            assert r.status_code == 200, r.text
            assert await _count(s, target, "SELECT count(*) FROM readings") == 5
            again = (await c.post("/api/r2restore/failback", json=body)).json()
            assert sum(_totals(again).values()) == 0
    finally:
        await s.drop(target)


async def test_reset_removes_the_work_area_and_blocks_failback(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    try:
        async with await _client(tmp, s, job, target, _target_sql("")) as c:
            assert (await c.post("/api/r2restore/failback", json={})).status_code == 409
            await _ready(c)
            assert (tmp / "r2work").exists()
            assert (await c.delete("/api/r2restore")).json()["state"] == "idle"
            assert not (tmp / "r2work").exists()
            assert (await c.post("/api/r2restore/failback", json={})).status_code == 409
    finally:
        await s.drop(target)


async def test_missing_backup_fails_with_a_message(tmp_path: Path) -> None:
    s = Scratch(SCRATCH_DSN)
    job = R2Restore({"WALG_FILE_PREFIX": str(tmp_path / "empty-repo")}, tmp_path / "w")
    target = _name()
    try:
        async with await _client(tmp_path, s, job, target, _target_sql("")) as c:
            assert (await c.post("/api/r2restore/start")).status_code == 200
            for _ in range(60):
                st = (await c.get("/api/r2restore")).json()
                if st["state"] == "failed":
                    break
                await asyncio.sleep(1)
            assert st["state"] == "failed" and st["message"]
    finally:
        await job.reset()
        await s.drop(target)
