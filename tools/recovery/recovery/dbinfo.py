"""DB（今の DB・展開したバックアップ）の中身を調べる。読むだけで書き込まない。

FactorEye の backend のコードには依存しない（backend が壊れていても使えるように）。
テーブルの構成は Alembic の版ごとに違いうるため、実在するテーブルと列を DB から調べて使う。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

import asyncpg

# 画面・CSV に出さない列（復旧に要らず、漏れると困るもの）
MASKED_COLUMNS = frozenset({"password_hash", "token_hash"})
MASK = "***"

# ワークスペースで絞り込むときの条件（$1 = ワークスペースの ID）。ここに無いテーブルは絞り込めない
_SENSORS_IN_WS = "SELECT id FROM sensors WHERE workspace_id = $1"
WORKSPACE_FILTERS: dict[str, str] = {
    "workspaces": "id = $1",
    "users": "id IN (SELECT owner_id FROM workspaces WHERE id = $1)",
    "sensors": "workspace_id = $1",
    "dashboards": "workspace_id = $1",
    "webhook_subscriptions": "workspace_id = $1",
    "notification_settings": "workspace_id = $1",
    "refresh_tokens": "workspace_id = $1",
    "readings": f"sensor_id IN ({_SENSORS_IN_WS})",
    "alarms": f"sensor_id IN ({_SENSORS_IN_WS})",
    "widgets": "dashboard_id IN (SELECT id FROM dashboards WHERE workspace_id = $1)",
    "widget_configs": (
        "widget_id IN (SELECT w.id FROM widgets w JOIN dashboards d ON d.id = w.dashboard_id"
        " WHERE d.workspace_id = $1)"
    ),
}
# 件数を数える上限。本番の大きなテーブルで、1 ページごとに全件を数えないように
COUNT_CAP = 100_000
# これより多い（統計上の推定値が）テーブルは、件数を推定値で返す（全件を数えると本番が重くなる）
EXACT_COUNT_LIMIT = 1_000_000
# 1 つの SQL の上限。画面を閉じても本番で重いクエリが走り続けないように
DEFAULT_STATEMENT_TIMEOUT_MS = 30_000

# 期間で絞り込めるテーブルと、その時刻の列
TIME_COLUMNS: dict[str, str] = {"readings": "recorded_at", "alarms": "triggered_at"}


class TableNotFound(Exception):
    pass


@dataclass(frozen=True)
class DbSummary:
    server_version: str
    alembic_version: str | None
    table_counts: dict[str, int]
    latest_reading_at: datetime | None
    # 件数が推定値のテーブル
    estimated_tables: list[str]


@dataclass(frozen=True)
class WorkspaceRow:
    id: str
    name: str
    owner_email: str | None
    plan: str | None
    created_at: datetime | None
    sensors: int
    readings: int
    latest_reading_at: datetime | None


@dataclass(frozen=True)
class RowFilter:
    workspace_id: UUID | None = None
    time_from: datetime | None = None
    time_to: datetime | None = None


@asynccontextmanager
async def read_only(
    dsn: str, statement_timeout_ms: int = DEFAULT_STATEMENT_TIMEOUT_MS
) -> AsyncIterator[asyncpg.Connection]:
    """読み取り専用で接続する。今の DB（本番）にも使うため、書き込みは DB 側でも拒ませる。"""
    conn = await asyncpg.connect(
        dsn,
        server_settings={
            "default_transaction_read_only": "on",
            "statement_timeout": str(statement_timeout_ms),
        },
        timeout=10,
    )
    try:
        yield conn
    finally:
        await conn.close()


async def list_tables(conn: asyncpg.Connection) -> list[str]:
    rows = await conn.fetch(
        "SELECT table_name FROM information_schema.tables"
        " WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    )
    return [r["table_name"] for r in rows]


async def _columns(conn: asyncpg.Connection, table: str) -> list[str]:
    rows = await conn.fetch(
        "SELECT column_name FROM information_schema.columns"
        " WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
        table,
    )
    return [r["column_name"] for r in rows]


def ident(name: str) -> str:
    # 名前は list_tables / _columns で実在を確かめたものだけが来るが、
    # 念のため引用符を二重にして埋め込む
    return '"' + name.replace('"', '""') + '"'


async def summarize(conn: asyncpg.Connection) -> DbSummary:
    tables = await list_tables(conn)
    # reltuples は統計の推定値（ANALYZE 前は -1）。大きいテーブルだけ推定値を使う
    estimates = {
        r["relname"]: int(r["reltuples"])
        for r in await conn.fetch(
            "SELECT c.relname, c.reltuples FROM pg_class c"
            " JOIN pg_namespace n ON n.oid = c.relnamespace"
            " WHERE n.nspname = 'public' AND c.relkind = 'r'"
        )
    }
    counts, estimated = {}, []
    for t in tables:
        if estimates.get(t, -1) > EXACT_COUNT_LIMIT:
            counts[t] = estimates[t]
            estimated.append(t)
        else:
            counts[t] = int(await conn.fetchval(f"SELECT count(*) FROM {ident(t)}"))
    alembic = None
    if "alembic_version" in tables:
        alembic = await conn.fetchval("SELECT version_num FROM alembic_version LIMIT 1")
    latest = None
    if "readings" in tables:
        latest = await conn.fetchval("SELECT max(recorded_at) FROM readings")
    version = str(await conn.fetchval("SHOW server_version"))
    return DbSummary(version, alembic, counts, latest, estimated)


async def workspaces(conn: asyncpg.Connection) -> list[WorkspaceRow]:
    """ワークスペースごとの件数。

    self-hosted（workspace_id が NULL）のセンサーは、id を空にした行で返す。
    """
    tables = set(await list_tables(conn))
    if not {"sensors", "readings"} <= tables:
        return []
    per_ws = await conn.fetch(
        "SELECT s.workspace_id, count(DISTINCT s.id) AS sensors, count(r.id) AS readings,"
        " max(r.recorded_at) AS latest"
        " FROM sensors s LEFT JOIN readings r ON r.sensor_id = s.id GROUP BY s.workspace_id"
    )
    stats = {row["workspace_id"]: row for row in per_ws}
    result = []
    if "workspaces" in tables and "users" in tables:
        rows = await conn.fetch(
            "SELECT w.id, w.name, w.plan, w.created_at, u.email FROM workspaces w"
            " LEFT JOIN users u ON u.id = w.owner_id ORDER BY w.created_at"
        )
        for w in rows:
            s = stats.pop(w["id"], None)
            result.append(
                WorkspaceRow(
                    str(w["id"]), w["name"], w["email"], w["plan"], w["created_at"],
                    s["sensors"] if s else 0, s["readings"] if s else 0,
                    s["latest"] if s else None,
                )
            )
    # ワークスペースの行が無いセンサー（self-hosted、またはワークスペースだけ消えたもの）
    for ws_id, s in stats.items():
        name = "（self-hosted）" if ws_id is None else "（ワークスペースの行なし）"
        result.append(
            WorkspaceRow(
                "" if ws_id is None else str(ws_id), name, None, None, None,
                s["sensors"], s["readings"], s["latest"],
            )
        )
    return result


def _where(table: str, columns: list[str], f: RowFilter) -> tuple[str, list[object]]:
    clauses: list[str] = []
    args: list[object] = []
    if f.workspace_id is not None:
        cond = WORKSPACE_FILTERS.get(table)
        if cond is None:
            raise TableNotFound(f"{table} はワークスペースで絞り込めません")
        args.append(f.workspace_id)
        clauses.append(cond.replace("$1", f"${len(args)}"))
    time_col = TIME_COLUMNS.get(table)
    if time_col and time_col in columns:
        if f.time_from is not None:
            args.append(f.time_from)
            clauses.append(f"{ident(time_col)} >= ${len(args)}")
        if f.time_to is not None:
            args.append(f.time_to)
            clauses.append(f"{ident(time_col)} < ${len(args)}")
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    return where, args


def _order_by(table: str, columns: list[str]) -> str:
    time_col = TIME_COLUMNS.get(table)
    if time_col and time_col in columns:
        return f" ORDER BY {ident(time_col)} DESC"
    if "created_at" in columns:
        return ' ORDER BY "created_at"'
    return " ORDER BY 1"


async def _prepare(
    conn: asyncpg.Connection, table: str, f: RowFilter
) -> tuple[list[str], str, str, list[object]]:
    """列名、行を取る SQL、数える SQL（並べ替えなし・上限あり）、引数を返す。"""
    if table not in await list_tables(conn):
        raise TableNotFound(f"テーブルがありません: {table}")
    columns = await _columns(conn, table)
    where, args = _where(table, columns, f)
    select = ", ".join(ident(c) for c in columns)
    rows_sql = f"SELECT {select} FROM {ident(table)}{where}{_order_by(table, columns)}"
    count_sql = (
        f"SELECT count(*) FROM (SELECT 1 FROM {ident(table)}{where} LIMIT {COUNT_CAP + 1}) t"
    )
    return columns, rows_sql, count_sql, args


def to_jsonable(column: str, value: object) -> object:
    if column in MASKED_COLUMNS and value is not None:
        return MASK
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, UUID | Decimal):
        return str(value)
    return value


@dataclass(frozen=True)
class RowPage:
    columns: list[str]
    rows: list[list[object]]
    # COUNT_CAP を超えたら COUNT_CAP + 1 で止め、total_capped を立てる
    total: int
    total_capped: bool


async def fetch_rows(
    conn: asyncpg.Connection, table: str, f: RowFilter, limit: int, offset: int
) -> RowPage:
    columns, sql, count_sql, args = await _prepare(conn, table, f)
    total = int(await conn.fetchval(count_sql, *args))
    n = len(args)
    rows = await conn.fetch(f"{sql} LIMIT ${n + 1} OFFSET ${n + 2}", *args, limit, offset)
    data = [[to_jsonable(c, r[c]) for c in columns] for r in rows]
    capped = total > COUNT_CAP
    return RowPage(columns, data, COUNT_CAP if capped else total, capped)


# Excel などが式として解釈する先頭の文字（CSV インジェクション）
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def to_csv_cell(column: str, value: object) -> str:
    v = to_jsonable(column, value)
    if v is None:
        return ""
    if isinstance(v, dict | list):
        return json.dumps(v, ensure_ascii=False)
    # 文字列の値（センサー名・メールなど）だけを対象にする。数値の負の値は式ではないので変えない
    if isinstance(value, str) and isinstance(v, str) and v.startswith(_FORMULA_PREFIXES):
        return "'" + v
    return str(v)


async def iter_rows(
    conn: asyncpg.Connection, table: str, f: RowFilter
) -> AsyncIterator[list[str]]:
    """CSV 用。最初に列名の行を返す。大きなテーブル（readings）でもメモリに載せきらないよう、
    カーソルで少しずつ読む。"""
    columns, sql, _, args = await _prepare(conn, table, f)
    yield columns
    async with conn.transaction():
        async for r in conn.cursor(sql, *args, prefetch=1000):
            yield [to_csv_cell(c, r[c]) for c in columns]
