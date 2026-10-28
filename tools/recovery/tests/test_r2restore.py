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
            assert (tmp / "r2work" / "work").exists()
            assert (await c.delete("/api/r2restore")).json()["state"] == "idle"
            assert not (tmp / "r2work" / "work").exists()
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


# ── 2 回目の QA で足した試験 ─────────────────────────────────────────────

SECRET = "SUPERSECRETVALUE123"


def _fake_walg(tmp: Path, body: str) -> Path:
    """PATH の先頭に置く、偽の wal-g。"""
    bin_dir = tmp / "fakebin"
    bin_dir.mkdir(exist_ok=True)
    script = bin_dir / "wal-g"
    script.write_text("#!/bin/sh\n" + body)
    script.chmod(0o755)
    return bin_dir


async def test_restore_survives_tampered_config_and_keeps_keys_out_of_postgres_env(
    stack: tuple[Scratch, R2Restore, Path], walg_repo: Path
) -> None:
    s, _, tmp = stack

    class Tampered(R2Restore):
        async def _fetch_base(self, pgdata: Path) -> None:
            await super()._fetch_base(pgdata)
            # 改ざんされたバックアップ: 任意のライブラリの読み込みと、外からの接続の許可
            with (pgdata / "postgresql.conf").open("a") as f:
                f.write("\nshared_preload_libraries = '/nonexistent/evil.so'\n")
                f.write("listen_addresses = '*'\narchive_command = 'touch /tmp/evil-ran'\n")
            with (pgdata / "postgresql.auto.conf").open("a") as f:
                f.write("\nlocal_preload_libraries = '/nonexistent/evil2.so'\n")
            with (pgdata / "pg_hba.conf").open("a") as f:
                f.write("\nhost all all 0.0.0.0/0 trust\n")

    job = Tampered({"WALG_FILE_PREFIX": str(walg_repo), "AWS_SECRET_ACCESS_KEY": SECRET},
                   tmp / "r2work")
    try:
        job.start()
        for _ in range(240):
            if job.state in ("ready", "failed"):
                break
            await asyncio.sleep(1)
        assert job.state == "ready", job.message
        pgdata = tmp / "r2work" / "work" / "pgdata"
        # 設定は自前の最小のものに置き換わっている
        assert (pgdata / "pg_hba.conf").read_text() == "local all all trust\n"
        conf = (pgdata / "postgresql.conf").read_text()
        assert "evil" not in conf and "listen_addresses = ''" in conf
        assert (pgdata / "postgresql.auto.conf").read_text() == ""
        assert not Path("/tmp/evil-ran").exists()
        # 一時 PostgreSQL のプロセスの環境に、鍵が残っていない
        pid = int((pgdata / "postmaster.pid").read_text().splitlines()[0])
        environ = Path(f"/proc/{pid}/environ").read_bytes()
        assert SECRET.encode() not in environ
        # 鍵のファイルは自分だけが読める
        assert ((tmp / "r2work" / "work" / "walg-secrets.sh").stat().st_mode & 0o777) == 0o600
    finally:
        await job.reset()


def test_fetch_script_reads_keys_from_file_and_maps_exit_codes(tmp_path: Path) -> None:
    from recovery.walg import _FETCH_SCRIPT

    secrets = tmp_path / "secrets.sh"
    secrets.write_text(f"AWS_SECRET_ACCESS_KEY={SECRET}\nexport AWS_SECRET_ACCESS_KEY\n")
    seen = tmp_path / "seen"
    script = tmp_path / "fetch.sh"
    script.write_text(_FETCH_SCRIPT.format(secrets=secrets))
    script.chmod(0o755)

    def run(code: int) -> int:
        bin_dir = _fake_walg(tmp_path, f'echo "$AWS_SECRET_ACCESS_KEY" > {seen}\nexit {code}\n')
        env = {"PATH": f"{bin_dir}:/usr/bin:/bin"}  # 鍵は環境に無い
        return subprocess.run([str(script), "f", "p"], env=env).returncode

    assert run(0) == 0
    assert seen.read_text().strip() == SECRET  # ファイルから読んだ
    assert run(74) == 74  # 「WAL が無い」は正常（再生の終わり）
    # それ以外の失敗は 127: PostgreSQL が異常終了して、古い時点での昇格を防ぐ
    assert run(3) == 127
    assert run(1) == 127


def test_redact_hides_secret_values_only() -> None:
    job = R2Restore(
        {"AWS_ACCESS_KEY_ID": "AKIAEXAMPLE1234", "AWS_SECRET_ACCESS_KEY": SECRET,
         "WALG_S3_PREFIX": "s3://factoreye-db"},
        Path("/nonexistent"),
    )
    text = job.redact(f"failed key=AKIAEXAMPLE1234 secret={SECRET} bucket s3://factoreye-db")
    assert "AKIAEXAMPLE1234" not in text and SECRET not in text
    assert "s3://factoreye-db" in text and text.count("***") == 2


async def test_failure_message_does_not_contain_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bin_dir = _fake_walg(tmp_path, f'echo "auth failed for {SECRET}" >&2\nexit 1\n')
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    s = Scratch(SCRATCH_DSN)
    job = R2Restore({"WALG_S3_PREFIX": "s3://x", "AWS_SECRET_ACCESS_KEY": SECRET}, tmp_path / "w")
    target = _name()
    try:
        async with await _client(tmp_path, s, job, target, _target_sql("")) as c:
            assert (await c.post("/api/r2restore/start")).status_code == 200
            for _ in range(30):
                r = await c.get("/api/r2restore")
                if r.json()["state"] == "failed":
                    break
                await asyncio.sleep(0.5)
            assert r.json()["state"] == "failed"
            assert "***" in r.json()["message"] and SECRET not in r.text
    finally:
        await job.reset()
        await s.drop(target)


async def test_reset_while_fetching_kills_the_child_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pidfile = tmp_path / "pid"
    bin_dir = _fake_walg(
        tmp_path,
        'case "$1" in backup-list) echo \'[{"backup_name":"b","time":"t"}]\';;\n'
        f'backup-fetch) mkdir -p "$2"; echo $$ > {pidfile}; exec sleep 120;; esac\n',
    )
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    job = R2Restore({"WALG_S3_PREFIX": "s3://x"}, tmp_path / "w")
    job.start()
    for _ in range(50):
        if pidfile.exists():
            break
        await asyncio.sleep(0.2)
    pid = int(pidfile.read_text())
    await job.reset()

    assert job.state == "idle" and not (tmp_path / "w" / "work").exists()
    await asyncio.sleep(0.3)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)  # 子プロセスが残っていない


async def test_start_is_refused_while_ready_or_running(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    try:
        async with await _client(tmp, s, job, target, _target_sql("")) as c:
            first, second = await asyncio.gather(
                c.post("/api/r2restore/start"), c.post("/api/r2restore/start")
            )
            assert sorted([first.status_code, second.status_code]) == [200, 409]  # 同時の start
            for _ in range(240):
                if job.state in ("ready", "failed"):
                    break
                await asyncio.sleep(1)
            assert job.state == "ready", job.message
            # 準備完了の最中は、作り直さない（進行中の書き戻しの入力が消えるため）
            r = await c.post("/api/r2restore/start")
            assert r.status_code == 409 and "作業用の復元が残っています" in r.json()["detail"]
            assert job.state == "ready"
    finally:
        await s.drop(target)


async def test_not_enough_free_disk_fails_fast_with_a_reason(
    stack: tuple[Scratch, R2Restore, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    import recovery.walg as walg_module

    s, job, tmp = stack
    monkeypatch.setattr(walg_module, "free_bytes", lambda _p: 1000)
    target = _name()
    try:
        async with await _client(tmp, s, job, target, _target_sql("")) as c:
            assert (await c.post("/api/r2restore/start")).status_code == 200
            for _ in range(60):
                st = (await c.get("/api/r2restore")).json()
                if st["state"] == "failed":
                    break
                await asyncio.sleep(0.5)
            assert st["state"] == "failed" and "空きが足りません" in st["message"]
            assert not (tmp / "r2work" / "work" / "pgdata").exists()
    finally:
        await s.drop(target)


def test_cleanup_stale_removes_only_the_work_dir_and_stale_sockets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "r2restore"
    (root / "work" / "pgdata").mkdir(parents=True)
    (root / "precious.txt").write_text("keep")  # 設定された場所にある、ほかのファイルは消さない
    sockets = tmp_path / "tmp"
    (sockets / "r2r-abc").mkdir(parents=True)
    (sockets / "other-dir").mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(sockets))
    R2Restore({"WALG_S3_PREFIX": "s3://x"}, root).cleanup_stale()
    assert not (root / "work").exists() and (root / "precious.txt").read_text() == "keep"
    assert not (sockets / "r2r-abc").exists() and (sockets / "other-dir").exists()


async def test_symlinks_planted_in_the_backup_are_not_followed(
    stack: tuple[Scratch, R2Restore, Path], walg_repo: Path
) -> None:
    s, _, tmp = stack
    victims = {n: tmp / f"victim-{n}" for n in ("conf", "auto", "hba", "ident", "signal")}
    for v in victims.values():
        v.write_text("ORIGINAL")

    class Planted(R2Restore):
        async def _fetch_base(self, pgdata: Path) -> None:
            await super()._fetch_base(pgdata)
            for name, key in (("postgresql.conf", "conf"), ("postgresql.auto.conf", "auto"),
                              ("pg_hba.conf", "hba"), ("pg_ident.conf", "ident"),
                              ("recovery.signal", "signal")):
                (pgdata / name).unlink(missing_ok=True)
                (pgdata / name).symlink_to(victims[key])

    job = Planted({"WALG_FILE_PREFIX": str(walg_repo)}, tmp / "r2work")
    try:
        job.start()
        for _ in range(240):
            if job.state in ("ready", "failed"):
                break
            await asyncio.sleep(1)
        assert job.state == "ready", job.message
        # リンク先は書き換わっていない
        assert all(v.read_text() == "ORIGINAL" for v in victims.values())
        pgdata = tmp / "r2work" / "work" / "pgdata"
        assert not (pgdata / "postgresql.conf").is_symlink()
        assert (pgdata / "pg_hba.conf").read_text() == "local all all trust\n"
    finally:
        await job.reset()


async def test_pgdata_that_is_a_symlink_is_refused(
    stack: tuple[Scratch, R2Restore, Path], walg_repo: Path
) -> None:
    _, _, tmp = stack

    class Linked(R2Restore):
        async def _fetch_base(self, pgdata: Path) -> None:
            await super()._fetch_base(pgdata)
            real = tmp / "elsewhere"
            pgdata.rename(real)
            pgdata.symlink_to(real)

    job = Linked({"WALG_FILE_PREFIX": str(walg_repo)}, tmp / "r2work")
    try:
        job.start()
        for _ in range(240):
            if job.state in ("ready", "failed"):
                break
            await asyncio.sleep(1)
        assert job.state == "failed" and "通常のディレクトリ" in (job.message or "")
    finally:
        await job.reset()


async def test_merge_source_connects_as_a_non_superuser_reader(
    stack: tuple[Scratch, R2Restore, Path],
) -> None:
    s, job, tmp = stack
    target = _name()
    try:
        async with await _client(tmp, s, job, target, _target_sql("")) as c:
            await _ready(c)
            conn = await asyncpg.connect(job.dsn)
            try:
                assert str(await conn.fetchval("SELECT current_user")).startswith("r2_reader_")
                assert not await conn.fetchval(
                    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
                )
                assert await conn.fetchval("SELECT count(*) FROM readings") == 4
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    await conn.execute("INSERT INTO readings (sensor_id, value, recorded_at)"
                                       f" VALUES ('{S1}', 1, now())")
            finally:
                await conn.close()
    finally:
        await s.drop(target)


def test_redact_replaces_longer_values_first_and_short_secrets_too() -> None:
    job = R2Restore(
        {"AWS_SECRET_ACCESS_KEY": "abcd", "AWS_ACCESS_KEY_ID": "abcdEFGHIJ", "AWS_TOKEN": "",
         "WALG_S3_PREFIX": "s3://x"},
        Path("/nonexistent"),
    )
    # 短い値（abcd）が長い値（abcdEFGHIJ）の一部でも、長い値が先に伏せられる
    assert job.redact("id=abcdEFGHIJ secret=abcd") == "id=*** secret=***"
    assert job.redact("nothing") == "nothing"  # 空の値で全部が置き換わらない


def test_log_tail_redacts_before_cutting(tmp_path: Path) -> None:
    job = R2Restore({"AWS_SECRET_ACCESS_KEY": SECRET}, tmp_path / "r2")
    job._work.mkdir(parents=True)
    # 切り出しの境界（末尾 1500 文字）に、鍵がまたがる
    (job._work / "pg.log").write_text("x" * 100 + SECRET + "y" * 1495)
    tail = job._log_tail()
    assert SECRET not in tail and SECRET[-6:] not in tail and "***" in tail


def test_env_names_that_are_not_shell_safe_are_dropped(tmp_path: Path) -> None:
    text = "GOOD=1\nBAD NAME=2\nEVIL;rm -rf /=3\n1STARTS=4\n$(x)=5\n"
    assert parse_env_file(text) == {"GOOD": "1"}
    job = R2Restore({"GOOD": "1", "BAD;X": "2"}, tmp_path)
    assert job._env == {"GOOD": "1"}
