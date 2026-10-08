"""作業用の Postgres を使うテスト（展開・閲覧・比較・CSV・画面の認証）。"""

import base64
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import httpx
import pytest

from recovery import dbinfo
from recovery.app import create_app
from recovery.config import Settings
from recovery.scratch import LoadError, Scratch, db_name_for, scan_owner_roles
from recovery.sources import LocalSource
from tests.conftest import DUMP_SQL, SCRATCH_DSN, WS_A, WS_B, needs_db, write_dump

pytestmark = needs_db

PASSWORD = "correct-horse-battery"


@pytest.fixture
async def scratch() -> AsyncIterator[Scratch]:
    s = Scratch(SCRATCH_DSN)
    yield s
    # テストで作った bk_* の DB を残さない
    conn = await asyncpg.connect(SCRATCH_DSN)
    try:
        for db in await s.loaded_databases():
            await conn.execute(f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)')
    finally:
        await conn.close()


def _unique(prefix: str = "factoreye") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}.sql.gz"


def test_scan_owner_roles(tmp_path: Path) -> None:
    path = write_dump(tmp_path, "x.sql.gz")
    assert scan_owner_roles(path) == {"fe_test_owner"}


async def test_load_and_summarize(tmp_path: Path, scratch: Scratch) -> None:
    name = _unique()
    path = write_dump(tmp_path, name)

    await scratch.load(name, path)
    await scratch.load(name, path)  # 2 回目は何もしない

    assert await scratch.is_loaded(name)
    async with dbinfo.read_only(scratch.dsn_for(name)) as conn:
        s = await dbinfo.summarize(conn)
        ws = await dbinfo.workspaces(conn)
    assert s.alembic_version == "d4e5f6a7b8c9"
    assert s.table_counts["readings"] == 3
    assert s.latest_reading_at is not None and s.latest_reading_at.day == 7
    a = next(w for w in ws if w.id == WS_A)
    assert (a.name, a.owner_email, a.sensors, a.readings) == ("Factory A", "a@example.com", 1, 2)

    await scratch.drop(name)
    assert not await scratch.is_loaded(name)


async def test_failed_load_leaves_no_database(tmp_path: Path, scratch: Scratch) -> None:
    name = _unique()
    path = write_dump(tmp_path, name, DUMP_SQL + "\nTHIS IS NOT SQL;\n")

    with pytest.raises(LoadError):
        await scratch.load(name, path)

    assert not await scratch.is_loaded(name)


async def test_read_only_connection_rejects_writes(tmp_path: Path, scratch: Scratch) -> None:
    name = _unique()
    await scratch.load(name, write_dump(tmp_path, name))

    async with dbinfo.read_only(scratch.dsn_for(name)) as conn:
        with pytest.raises(asyncpg.ReadOnlySQLTransactionError):
            await conn.execute("DELETE FROM readings")


async def test_fetch_rows_filters_and_masks(tmp_path: Path, scratch: Scratch) -> None:
    name = _unique()
    await scratch.load(name, write_dump(tmp_path, name))
    ws = uuid.UUID(WS_A)

    async with dbinfo.read_only(scratch.dsn_for(name)) as conn:
        cols, rows, total = await dbinfo.fetch_rows(
            conn, "readings", dbinfo.RowFilter(workspace_id=ws), limit=1, offset=0
        )
        _, users, _ = await dbinfo.fetch_rows(
            conn, "users", dbinfo.RowFilter(workspace_id=ws), limit=10, offset=0
        )
        with pytest.raises(dbinfo.TableNotFound):
            await dbinfo.fetch_rows(conn, "nope", dbinfo.RowFilter(), 10, 0)

    assert total == 2 and len(rows) == 1
    # 新しい順
    assert str(rows[0][cols.index("recorded_at")]).startswith("2026-10-06")
    assert len(users) == 1
    assert users[0][1] == "a@example.com" and users[0][2] == dbinfo.MASK


@pytest.fixture
async def client(tmp_path: Path, scratch: Scratch) -> AsyncIterator[httpx.AsyncClient]:
    settings = Settings(
        backup_source=str(tmp_path), scratch_dsn=SCRATCH_DSN, target_dsn=None,
        cache_dir=tmp_path / "cache", username="admin", password=PASSWORD, s3_endpoint_url=None,
    )
    app = create_app(settings, LocalSource(tmp_path), scratch)
    token = base64.b64encode(f"admin:{PASSWORD}".encode()).decode()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Basic {token}"},
    ) as c:
        yield c


async def test_api_requires_auth(client: httpx.AsyncClient) -> None:
    wrong = "Basic " + base64.b64encode(b"admin:wrong").decode()
    r = await client.get("/api/backups", headers={"Authorization": wrong})
    assert r.status_code == 401
    del client.headers["Authorization"]
    assert (await client.get("/")).status_code == 401


async def test_api_load_browse_export(tmp_path: Path, client: httpx.AsyncClient) -> None:
    name = _unique()
    write_dump(tmp_path, name)

    listed = (await client.get("/api/backups")).json()
    assert [b["loaded"] for b in listed if b["name"] == name] == [False]
    assert (await client.get(f"/api/db/{name}/summary")).status_code == 409

    r = await client.post(f"/api/backups/{name}/load")
    assert r.status_code == 200, r.text
    assert r.json()["verify"]["checksum"] == "missing"

    summary = (await client.get(f"/api/db/{name}/summary")).json()
    assert summary["table_counts"]["readings"] == 3

    page = (await client.get(f"/api/db/{name}/tables/readings", params={
        "workspace_id": WS_A, "from": "2026-10-06T00:00:00Z", "limit": 10,
    })).json()
    assert page["total"] == 1

    csv_resp = await client.get(f"/api/db/{name}/export/users.csv")
    text = csv_resp.text.lstrip("﻿")
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert text.splitlines()[0] == "id,email,password_hash,created_at"
    assert "secret-hash" not in text and "a@example.com" in text

    assert (await client.get(f"/api/db/{name}/export/nope.csv")).status_code == 404
    assert (await client.get("/api/db/current/summary")).status_code == 404


async def test_api_refuses_checksum_mismatch_without_force(
    tmp_path: Path, client: httpx.AsyncClient
) -> None:
    name = _unique()
    path = write_dump(tmp_path, name)
    path.with_name(name + ".sha256").write_text("0" * 64 + f"  {name}\n")

    r = await client.post(f"/api/backups/{name}/load")
    assert r.status_code == 422
    assert r.json()["detail"]["verify"]["checksum"] == "mismatch"

    forced = await client.post(f"/api/backups/{name}/load", params={"force": "true"})
    assert forced.status_code == 200


async def test_api_rejects_bad_names(client: httpx.AsyncClient) -> None:
    assert (await client.post("/api/backups/..%2Fx.sql.gz/load")).status_code in (404, 405)
    assert (await client.get("/api/db/evil.txt/summary")).status_code == 404


async def test_api_compare_with_current(tmp_path: Path, scratch: Scratch) -> None:
    # 「今の DB」として、別のバックアップを展開したものを使う（本番の DB には触らない）
    current_name, backup_name = _unique("current"), _unique()
    # 今の DB では B が失われ、代わりに C ができた（センサーも C に属する）
    current_sql = DUMP_SQL.replace(WS_B, "33333333-3333-3333-3333-333333333333").replace(
        "Factory B", "Factory C"
    )
    await scratch.load(current_name, write_dump(tmp_path, current_name, current_sql))
    write_dump(tmp_path, backup_name)
    settings = Settings(
        backup_source=str(tmp_path), scratch_dsn=SCRATCH_DSN,
        target_dsn=scratch.dsn_for(current_name), cache_dir=tmp_path,
        username="admin", password=PASSWORD, s3_endpoint_url=None,
    )
    app = create_app(settings, LocalSource(tmp_path), scratch)
    token = base64.b64encode(f"admin:{PASSWORD}".encode()).decode()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Basic {token}"},
    ) as c:
        assert (await c.post(f"/api/backups/{backup_name}/load")).status_code == 200
        r = (await c.get(f"/api/backups/{backup_name}/compare")).json()

    statuses = {w["name"]: w["status"] for w in r["workspaces"]}
    assert statuses["Factory A"] == "both"
    assert statuses["Factory B"] == "backup_only"
    assert statuses["Factory C"] == "current_only"
    assert r["workspaces"][0]["status"] == "backup_only"
    assert {t["table"]: t["diff"] for t in r["tables"]}["readings"] == 0
    assert db_name_for(backup_name) != db_name_for(current_name)
