"""引き継ぎ（控え＝AWS が置く縮小ダンプ）からの書き戻しのテスト。

縮小ダンプは、小さい表は全体、readings・alarms は起点（watermark）以降の行だけを持つ。
それを `merge` が、今の DB に無い行だけを足す形で正しく扱えることを確かめる。
"""

import base64
import hashlib
import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import httpx
import pytest

from recovery import dbinfo, merge
from recovery.app import _handoff_selection, create_app
from recovery.config import Settings
from recovery.scratch import Scratch
from recovery.sources import (
    CompositeSource,
    HandoffSource,
    LocalSource,
    SourceError,
    validate_handoff_name,
)
from tests.conftest import DUMP_SQL, SCRATCH_DSN, WS_A, WS_B, needs_db, write_dump

U1 = "aaaaaaaa-0000-0000-0000-000000000001"
U2 = "aaaaaaaa-0000-0000-0000-000000000002"
S1 = "bbbbbbbb-0000-0000-0000-000000000001"
S2 = "bbbbbbbb-0000-0000-0000-000000000002"
S_ORPHAN = "bbbbbbbb-0000-0000-0000-000000000099"
A_PROD = "dddddddd-0000-0000-0000-000000000001"
A_DUP = "dddddddd-0000-0000-0000-000000000002"
A_NEW = "dddddddd-0000-0000-0000-000000000003"

# スキーマ（alembic_version の行より前）は、conftest のダンプと同じ
_SCHEMA = DUMP_SQL.split("INSERT INTO public.alembic_version")[0]

# 本番（復帰した今の DB）: 停止の前までのデータ
PROD_SQL = _SCHEMA + f"""
INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');
INSERT INTO public.users VALUES
  ('{U1}', 'a@example.com', 'prod-hash', '2026-10-01T00:00:00Z');
INSERT INTO public.workspaces VALUES
  ('{WS_A}', 'Factory A', '{U1}', 'free', '2026-10-01T00:00:00Z');
INSERT INTO public.sensors VALUES ('{S1}', '{WS_A}', 'temp-prod', '2026-10-01T00:00:00Z');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{S1}', 20.0, '2026-10-05T00:00:00Z'),
  ('{S1}', 21.0, '2026-10-05T01:00:00Z');
INSERT INTO public.alarms VALUES ('{A_PROD}', '{S1}', '2026-10-05T00:10:00Z', NULL, 'ACTIVE');
"""

# 縮小ダンプ（起点 2026-10-05 00:30）: 控えが稼働していた間に増えた分を含む。
# 本番と食い違う値（パスワードのハッシュ・センサー名）は、本番側を残すことを確かめる
HANDOFF_SQL = _SCHEMA + f"""
INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');
INSERT INTO public.users VALUES
  ('{U1}', 'a@example.com', 'standby-hash', '2026-10-01T00:00:00Z'),
  ('{U2}', 'b@example.com', 'new-hash', '2026-10-05T02:00:00Z');
INSERT INTO public.workspaces VALUES
  ('{WS_A}', 'Factory A', '{U1}', 'free', '2026-10-01T00:00:00Z'),
  ('{WS_B}', 'Factory B', '{U2}', 'free', '2026-10-05T02:00:00Z');
INSERT INTO public.sensors VALUES
  ('{S1}', '{WS_A}', 'temp-standby', '2026-10-01T00:00:00Z'),
  ('{S2}', '{WS_B}', 'power', '2026-10-05T02:00:00Z');
-- 起点以降の測定値。1 件目は本番にもある。最後は、親のセンサーが縮小ダンプに無い行
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{S1}', 21.0, '2026-10-05T01:00:00Z'),
  ('{S1}', 22.0, '2026-10-05T02:00:00Z'),
  ('{S1}', 23.0, '2026-10-05T03:00:00Z'),
  ('{S2}', 1.5, '2026-10-05T02:00:00Z'),
  ('{S_ORPHAN}', 9.9, '2026-10-05T02:00:00Z');
INSERT INTO public.alarms VALUES
  ('{A_PROD}', '{S1}', '2026-10-05T00:10:00Z', NULL, 'ACTIVE'),
  ('{A_DUP}', '{S1}', '2026-10-05T02:00:00Z', NULL, 'ACTIVE'),
  ('{A_NEW}', '{S2}', '2026-10-05T02:30:00Z', NULL, 'ACTIVE');
INSERT INTO public.notification_settings (id, workspace_id, enabled) VALUES (5, '{WS_B}', true);
"""


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}.sql.gz"


@pytest.fixture
async def dbs(tmp_path: Path) -> AsyncIterator[tuple[Scratch, str, str]]:
    """(scratch, 縮小ダンプの名前, 本番の名前)。"""
    s = Scratch(SCRATCH_DSN)
    handoff, prod = _name("handoff"), _name("prod")
    await s.load(handoff, write_dump(tmp_path, handoff, HANDOFF_SQL))
    await s.load(prod, write_dump(tmp_path, prod, PROD_SQL))
    yield s, handoff, prod
    await s.drop(handoff)
    await s.drop(prod)


async def _failback(
    s: Scratch, handoff: str, prod: str, apply: bool, mode: str = "saas"
) -> merge.MergeResult:
    sel = await _handoff_selection(s.dsn_for(handoff), mode)
    async with dbinfo.read_only(s.dsn_for(handoff)) as src, merge.connect_target(
        s.dsn_for(prod)
    ) as dst:
        return await merge.merge(src, dst, sel, apply, target_mode=mode)


async def _fetch(dsn: str, sql: str) -> list[asyncpg.Record]:
    conn = await asyncpg.connect(dsn)
    try:
        return await conn.fetch(sql)
    finally:
        await conn.close()


def _by_table(r: merge.MergeResult) -> dict[str, tuple[int, int, int]]:
    return {t.table: (t.source, t.inserted, t.existing) for t in r.tables}


@needs_db
async def test_dry_run_counts_only_missing_rows_and_writes_nothing(
    dbs: tuple[Scratch, str, str],
) -> None:
    s, handoff, prod = dbs
    r = await _failback(s, handoff, prod, apply=False)

    t = _by_table(r)
    assert t["users"] == (2, 1, 1) and t["workspaces"] == (2, 1, 1)
    assert t["sensors"] == (2, 1, 1)
    # 本番にもある 1 件は飛ばし、新しい 3 件を足す。親のセンサーが無い行は対象外
    assert t["readings"] == (4, 3, 1)
    assert t["alarms"] == (3, 2, 1)
    assert t["notification_settings"][1] == 1
    rows = await _fetch(s.dsn_for(prod), "SELECT count(*) AS n FROM readings")
    assert rows[0]["n"] == 2


@needs_db
async def test_apply_adds_only_missing_rows_and_keeps_existing_ones(
    dbs: tuple[Scratch, str, str],
) -> None:
    s, handoff, prod = dbs
    await _failback(s, handoff, prod, apply=True)
    dsn = s.dsn_for(prod)

    # 今ある行は変わらない（パスワードのハッシュ・センサー名は本番のまま）
    assert (await _fetch(dsn, f"SELECT password_hash FROM users WHERE id = '{U1}'"))[0][0] == (
        "prod-hash"
    )
    assert (await _fetch(dsn, f"SELECT name FROM sensors WHERE id = '{S1}'"))[0][0] == "temp-prod"
    assert (await _fetch(dsn, f"SELECT status::text FROM alarms WHERE id = '{A_PROD}'"))[0][0] == (
        "ACTIVE"
    )
    # 新しい行が入る
    assert (await _fetch(dsn, "SELECT count(*) FROM users"))[0][0] == 2
    assert (await _fetch(dsn, "SELECT count(*) FROM workspaces"))[0][0] == 2
    assert (await _fetch(dsn, "SELECT count(*) FROM sensors"))[0][0] == 2
    assert (await _fetch(dsn, "SELECT count(*) FROM readings"))[0][0] == 5
    # 親が縮小ダンプにも無い測定値は入らない
    assert (await _fetch(dsn, f"SELECT count(*) FROM readings WHERE sensor_id = '{S_ORPHAN}'"))[
        0
    ][0] == 0


@needs_db
async def test_apply_twice_adds_nothing_the_second_time(dbs: tuple[Scratch, str, str]) -> None:
    s, handoff, prod = dbs
    await _failback(s, handoff, prod, apply=True)
    again = await _failback(s, handoff, prod, apply=True)

    assert all(t.inserted == 0 for t in again.tables)
    assert (await _fetch(s.dsn_for(prod), "SELECT count(*) FROM readings"))[0][0] == 5


@needs_db
async def test_open_alarm_is_closed_when_the_sensor_already_has_one(
    dbs: tuple[Scratch, str, str],
) -> None:
    s, handoff, prod = dbs
    r = await _failback(s, handoff, prod, apply=True)

    alarms = next(t for t in r.tables if t.table == "alarms")
    assert alarms.closed == 1
    dsn = s.dsn_for(prod)
    # 本番に発生中のアラームがあるセンサーの分は、解除済みにして入る
    assert (await _fetch(dsn, f"SELECT status::text FROM alarms WHERE id = '{A_DUP}'"))[0][0] == (
        "RESOLVED"
    )
    # 発生中が無かったセンサーの分は、そのまま発生中
    assert (await _fetch(dsn, f"SELECT status::text FROM alarms WHERE id = '{A_NEW}'"))[0][0] == (
        "ACTIVE"
    )


@needs_db
async def test_oss_target_adds_self_hosted_rows_and_advances_the_int_sequence(
    tmp_path: Path,
) -> None:
    # OSS 版: ワークスペースに属さないデータ。通知設定は id をそのまま入れるので、採番を進める
    oss_handoff = _SCHEMA + f"""
INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');
INSERT INTO public.sensors VALUES ('{S1}', NULL, 'temp', '2026-10-01T00:00:00Z');
INSERT INTO public.readings (sensor_id, value, recorded_at) VALUES
  ('{S1}', 1.0, '2026-10-05T01:00:00Z');
INSERT INTO public.notification_settings (id, workspace_id, enabled) VALUES (7, NULL, true);
"""
    oss_prod = _SCHEMA + f"""
INSERT INTO public.alembic_version VALUES ('d4e5f6a7b8c9');
INSERT INTO public.sensors VALUES ('{S1}', NULL, 'temp', '2026-10-01T00:00:00Z');
"""
    s = Scratch(SCRATCH_DSN)
    handoff, prod = _name("handoff"), _name("prod")
    await s.load(handoff, write_dump(tmp_path, handoff, oss_handoff))
    await s.load(prod, write_dump(tmp_path, prod, oss_prod))
    try:
        r = await _failback(s, handoff, prod, apply=True, mode="oss")
        assert _by_table(r)["readings"] == (1, 1, 0)
        assert _by_table(r)["notification_settings"][1] == 1
        # 次に作る行の id が、入れた id と重ならない
        nxt = (
            await _fetch(
                s.dsn_for(prod),
                "SELECT nextval(pg_get_serial_sequence('notification_settings','id'))",
            )
        )[0][0]
        assert nxt > 7
    finally:
        await s.drop(handoff)
        await s.drop(prod)


@needs_db
async def test_schema_version_mismatch_is_rejected_with_both_versions(
    tmp_path: Path,
) -> None:
    s = Scratch(SCRATCH_DSN)
    handoff, prod = _name("handoff"), _name("prod")
    await s.load(handoff, write_dump(tmp_path, handoff, HANDOFF_SQL))
    await s.load(prod, write_dump(tmp_path, prod, PROD_SQL.replace("d4e5f6a7b8c9", "zzz")))
    try:
        with pytest.raises(merge.SchemaMismatch) as e:
            await _failback(s, handoff, prod, apply=False)
        assert (e.value.backup, e.value.current) == ("d4e5f6a7b8c9", "zzz")
    finally:
        await s.drop(handoff)
        await s.drop(prod)


# ── 読み込み元（handoff-inc/） ───────────────────────────────────────────


def _put_handoff(directory: Path, stamp: str, sql: str, *, bad_sha: bool = False) -> str:
    """handoff.sh が置く形（ダンプ・.sha256・latest.json）を作る。画面での名前を返す。"""
    name = f"factoreye-{stamp}.sql.gz"
    path = write_dump(directory, name, sql)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if bad_sha:
        digest = "0" * 64
    (directory / f"{name}.sha256").write_text(f"{digest}  {name}\n")
    (directory / "latest.json").write_text(json.dumps({
        "kind": "reduced", "name": name, "createdAt": "2026-10-28T10:30:00Z",
        "watermark": "2026-10-05 00:30:00+00", "alembic": "d4e5f6a7b8c9",
        "instance": "i-0abc", "region": "ap-northeast-3", "bytes": path.stat().st_size,
    }))
    return f"handoff-{name}"


def test_handoff_source_lists_with_prefix_and_attaches_the_latest_record(tmp_path: Path) -> None:
    older = _put_handoff(tmp_path, "20261028-090000", HANDOFF_SQL)
    newest = _put_handoff(tmp_path, "20261028-103000", HANDOFF_SQL)
    (tmp_path / "factoreye-manual.sql.gz").write_bytes(b"x")  # 規則に合わない名前は出さない
    h = HandoffSource(LocalSource(tmp_path))

    assert {e.name for e in h.list()} == {older, newest}
    name, info = h.latest() or ("", None)
    assert name == newest
    assert info is not None and info.kind == "reduced" and info.region == "ap-northeast-3"
    assert h.fetch(newest).expected_sha256 is not None


def test_handoff_source_without_latest_json_has_no_record(tmp_path: Path) -> None:
    write_dump(tmp_path, "factoreye-20261028-090000.sql.gz", HANDOFF_SQL)
    assert HandoffSource(LocalSource(tmp_path)).latest() is None


def test_handoff_name_must_match_the_rule() -> None:
    validate_handoff_name("handoff-factoreye-20261028-103000.sql.gz")
    for bad in ("factoreye-20261028-103000.sql.gz", "handoff-../x.sql.gz", "handoff-x.sql.gz"):
        with pytest.raises(SourceError):
            validate_handoff_name(bad)


# ── API ────────────────────────────────────────────────────────────────


def _settings(tmp_path: Path, s: Scratch, prod: str, **over: object) -> Settings:
    base: dict[str, object] = dict(
        backup_source=str(tmp_path), scratch_dsn=SCRATCH_DSN, target_dsn=s.dsn_for(prod),
        target_write_dsn=s.dsn_for(prod), target_mode="saas", cache_dir=tmp_path,
        username="admin", password="correct-horse-battery", s3_endpoint_url=None,
        snapshot_dir=tmp_path / "snapshots", handoff_source=str(tmp_path / "inc"),
    )
    return Settings(**{**base, **over})  # type: ignore[arg-type]


def _client(settings: Settings, s: Scratch, handoff: HandoffSource | None) -> httpx.AsyncClient:
    app = create_app(
        settings,
        CompositeSource(
            [LocalSource(settings.cache_dir)], optional=[LocalSource(settings.snapshot_dir)]
        ),
        s,
        handoff,
    )
    token = base64.b64encode(b"admin:correct-horse-battery").decode()
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
        headers={"Authorization": f"Basic {token}"},
    )


@needs_db
async def test_api_list_preview_and_apply(tmp_path: Path, dbs: tuple[Scratch, str, str]) -> None:
    s, _, prod = dbs
    inc = tmp_path / "inc"
    inc.mkdir()
    name = _put_handoff(inc, "20261028-103000", HANDOFF_SQL)
    settings = _settings(tmp_path, s, prod)
    async with _client(settings, s, HandoffSource(LocalSource(inc))) as c:
        listed = (await c.get("/api/handoffs")).json()
        assert [i["name"] for i in listed["items"]] == [name]
        assert listed["items"][0]["kind"] == "reduced"
        assert listed["items"][0]["watermark"] == "2026-10-05 00:30:00+00"

        url = f"/api/handoffs/{name}/failback"
        dry = (await c.post(url, json={})).json()
        assert dry["applied"] is False and dry["snapshot"] is None
        planned = sum(t["inserted"] for t in dry["tables"])
        assert planned == 1 + 1 + 1 + 3 + 2 + 1
        # 展開は使い終わったら消える
        assert not await s.is_loaded(name)

        # 試算をせずに実行・試算と違う件数で実行は、どちらも拒否する
        assert (await c.post(url, json={"apply": True})).status_code == 422
        stale = await c.post(url, json={"apply": True, "expected_inserted": planned + 1})
        assert stale.status_code == 409
        assert (await _fetch(s.dsn_for(prod), "SELECT count(*) FROM readings"))[0][0] == 2

        done = await c.post(url, json={"apply": True, "expected_inserted": planned})
        assert done.status_code == 200, done.text
        body = done.json()
        assert body["applied"] is True and body["snapshot"].startswith("before-merge-")
        # 2 回目は何も足さない
        again = (await c.post(url, json={"apply": False})).json()
        assert sum(t["inserted"] for t in again["tables"]) == 0
    assert (await _fetch(s.dsn_for(prod), "SELECT count(*) FROM readings"))[0][0] == 5


@needs_db
async def test_api_refuses_a_corrupted_handoff_and_a_schema_mismatch(
    tmp_path: Path, dbs: tuple[Scratch, str, str]
) -> None:
    s, _, prod = dbs
    inc = tmp_path / "inc"
    inc.mkdir()
    bad = _put_handoff(inc, "20261028-103000", HANDOFF_SQL, bad_sha=True)
    other = _put_handoff(inc, "20261028-113000", HANDOFF_SQL.replace("d4e5f6a7b8c9", "zzz"))
    settings = _settings(tmp_path, s, prod)
    async with _client(settings, s, HandoffSource(LocalSource(inc))) as c:
        r = await c.post(f"/api/handoffs/{bad}/failback", json={})
        assert r.status_code == 422 and "壊れています" in r.json()["detail"]
        assert not await s.is_loaded(bad)

        r = await c.post(f"/api/handoffs/{other}/failback", json={})
        assert r.status_code == 409
        detail = r.json()["detail"]
        assert detail["code"] == "schema_mismatch"
        assert (detail["handoff_alembic"], detail["current_alembic"]) == ("zzz", "d4e5f6a7b8c9")
        assert not await s.is_loaded(other)


@needs_db
async def test_api_is_disabled_without_handoff_source_or_write_dsn(
    tmp_path: Path, dbs: tuple[Scratch, str, str]
) -> None:
    s, _, prod = dbs
    name = "handoff-factoreye-20261028-103000.sql.gz"
    async with _client(_settings(tmp_path, s, prod, handoff_source=None), s, None) as c:
        assert (await c.get("/api/handoffs")).status_code == 404
        assert (await c.post(f"/api/handoffs/{name}/failback", json={})).status_code == 404
        assert (await c.get("/api/info")).json()["handoff_configured"] is False
    inc = tmp_path / "inc"
    inc.mkdir()
    async with _client(
        _settings(tmp_path, s, prod, target_write_dsn=None), s, HandoffSource(LocalSource(inc))
    ) as c:
        assert (await c.post(f"/api/handoffs/{name}/failback", json={})).status_code == 403
