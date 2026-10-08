"""バックアップから今の DB へ、選んだワークスペースのデータを書き戻す（追記）。

- 今の DB に無い行だけを足す。今ある行は変えない・消さない（上書きはしない）
- 試行（dry run）と実行は同じ処理で、試行は最後に取り消す（ROLLBACK）。
  件数も、外部キー・一意制約の違反も、実行したときとまったく同じ結果が試行で分かる
- 全テーブルを 1 つのトランザクションで行う。途中で失敗したら何も書かない
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

import asyncpg

from recovery.dbinfo import ident as _ident
from recovery.dbinfo import list_tables

_BATCH = 5000
# 書き戻しの 1 つの SQL の上限（測定値が多いワークスペースでも終わるように、閲覧より長くする）
MERGE_STATEMENT_TIMEOUT_MS = 600_000


class MergeError(Exception):
    pass


@dataclass(frozen=True)
class MergeSelection:
    workspace_ids: list[UUID]
    # OSS 版のセンサーなど、ワークスペースに属さない（workspace_id が NULL）データも含める
    include_self_hosted: bool = False
    # 測定値・アラームだけを、この期間に絞る（「この日の不足分だけ戻す」ため）
    time_from: datetime | None = None
    time_to: datetime | None = None


@dataclass(frozen=True)
class TableSpec:
    table: str
    # 対象の行の条件。:ids / :self_hosted を引数に置き換える。{a} は別名（無ければ空）
    where: str
    # 「今の DB に既にある」の判定に使う列
    key: tuple[str, ...]
    # 連番の id を持ち込まない（今の DB の連番と重なるため。key で重複を判定する）
    drop_id: bool = False
    time_column: str | None = None
    # key に NULL がありうる（self-hosted の通知設定は workspace_id が NULL）。
    # NULL どうしも同じとみなす（IS NOT DISTINCT FROM。索引が効かないので、行の少ない表だけに使う）
    nullable_key: bool = False


def _ws(alias: str = "") -> str:
    a = f"{alias}." if alias else ""
    return f"({a}workspace_id = ANY(:ids) OR (:self_hosted AND {a}workspace_id IS NULL))"


_SENSORS = f"sensor_id IN (SELECT id FROM sensors WHERE {_ws()})"

# 外部キーの親から順に入れる
SPECS: tuple[TableSpec, ...] = (
    TableSpec("users", "id IN (SELECT owner_id FROM workspaces WHERE id = ANY(:ids))", ("id",)),
    TableSpec("workspaces", "id = ANY(:ids)", ("id",)),
    TableSpec("sensors", _ws(), ("id",)),
    TableSpec(
        "readings", _SENSORS, ("sensor_id", "recorded_at"), drop_id=True,
        time_column="recorded_at",
    ),
    TableSpec("alarms", _SENSORS, ("id",), time_column="triggered_at"),
    TableSpec("dashboards", _ws(), ("id",)),
    TableSpec(
        "widgets", f"dashboard_id IN (SELECT id FROM dashboards WHERE {_ws()})", ("id",)
    ),
    TableSpec(
        "widget_configs",
        "widget_id IN (SELECT w.id FROM widgets w JOIN dashboards d ON d.id = w.dashboard_id"
        f" WHERE {_ws('d')})",
        ("id",),
    ),
    TableSpec("webhook_subscriptions", _ws(), ("id",)),
    TableSpec(
        "notification_settings", _ws(), ("workspace_id",), drop_id=True, nullable_key=True
    ),
)
# refresh_tokens（ログインの状態）は戻さない。戻すと、失効させたはずのログインが復活しうるため


@dataclass(frozen=True)
class TableResult:
    table: str
    # バックアップ側の対象の行数
    source: int
    # 今の DB に足した（足す）行数
    inserted: int
    # 今の DB に既にあったため飛ばした行数
    existing: int
    note: str | None = None


@dataclass(frozen=True)
class MergeResult:
    applied: bool
    tables: list[TableResult]


def bind(sql: str, sel: MergeSelection, time_column: str | None) -> tuple[str, list[object]]:
    """:ids などを、使われている分だけ $n に置き換える。

    使わない引数を渡すと、Postgres が型を決められずに失敗するため。
    """
    values: dict[str, object] = {
        "ids": sel.workspace_ids,
        "self_hosted": sel.include_self_hosted,
        "from": sel.time_from,
        "to": sel.time_to,
    }
    if time_column:
        if sel.time_from is not None:
            sql += f" AND {_ident(time_column)} >= :from"
        if sel.time_to is not None:
            sql += f" AND {_ident(time_column)} < :to"
    args: list[object] = []
    order: dict[str, int] = {}

    def repl(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in order:
            args.append(values[name])
            order[name] = len(args)
        n = order[name]
        cast = {"ids": "::uuid[]", "self_hosted": "::boolean"}.get(name, "::timestamptz")
        return f"${n}{cast}"

    return re.sub(r":(ids|self_hosted|from|to)\b", repl, sql), args


async def _columns(conn: asyncpg.Connection, table: str) -> list[str]:
    rows = await conn.fetch(
        "SELECT column_name FROM information_schema.columns"
        " WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
        table,
    )
    return [r["column_name"] for r in rows]


async def _alembic(conn: asyncpg.Connection) -> str | None:
    if "alembic_version" not in await list_tables(conn):
        return None
    v = await conn.fetchval("SELECT version_num FROM alembic_version LIMIT 1")
    return str(v) if v is not None else None


@asynccontextmanager
async def connect_target(dsn: str) -> AsyncIterator[asyncpg.Connection]:
    conn = await asyncpg.connect(
        dsn, server_settings={"statement_timeout": str(MERGE_STATEMENT_TIMEOUT_MS)}, timeout=10
    )
    try:
        yield conn
    finally:
        await conn.close()


async def _merge_table(
    src: asyncpg.Connection, dst: asyncpg.Connection, spec: TableSpec, sel: MergeSelection
) -> TableResult:
    src_cols = await _columns(src, spec.table)
    dst_cols = await _columns(dst, spec.table)
    cols = [c for c in dst_cols if c in src_cols]
    missing_key = [k for k in spec.key if k not in cols]
    if missing_key:
        raise MergeError(f"{spec.table}: 判定に使う列がありません: {missing_key}")
    insert_cols = [c for c in cols if not (spec.drop_id and c == "id")]

    # 今の DB に一時テーブルを作り、バックアップの対象の行を流し込んでから、無い行だけを足す
    tmp = f"_merge_{spec.table}"
    await dst.execute(
        f"CREATE TEMP TABLE {_ident(tmp)} (LIKE public.{_ident(spec.table)}) ON COMMIT DROP"
    )
    where, args = bind(spec.where, sel, spec.time_column)
    select = ", ".join(_ident(c) for c in cols)
    source = 0
    batch: list[tuple[object, ...]] = []
    async with src.transaction():
        query = f"SELECT {select} FROM public.{_ident(spec.table)} WHERE {where}"
        async for r in src.cursor(query, *args, prefetch=_BATCH):
            batch.append(tuple(r[c] for c in cols))
            if len(batch) >= _BATCH:
                await dst.copy_records_to_table(tmp, records=batch, columns=cols)
                source += len(batch)
                batch = []
    if batch:
        await dst.copy_records_to_table(tmp, records=batch, columns=cols)
        source += len(batch)

    ins = ", ".join(_ident(c) for c in insert_cols)
    op = "IS NOT DISTINCT FROM" if spec.nullable_key else "="
    match = " AND ".join(f"x.{_ident(k)} {op} s.{_ident(k)}" for k in spec.key)
    status = await dst.execute(
        f"INSERT INTO public.{_ident(spec.table)} ({ins})"
        f" SELECT {', '.join('s.' + _ident(c) for c in insert_cols)} FROM {_ident(tmp)} s"
        f" WHERE NOT EXISTS (SELECT 1 FROM public.{_ident(spec.table)} x WHERE {match})"
    )
    inserted = int(status.rsplit(" ", 1)[-1])
    return TableResult(spec.table, source, inserted, source - inserted)


async def merge(
    src: asyncpg.Connection, dst: asyncpg.Connection, sel: MergeSelection, apply: bool
) -> MergeResult:
    """src（展開したバックアップ）から dst（今の DB）へ。apply=False なら最後に取り消す。"""
    if not sel.workspace_ids and not sel.include_self_hosted:
        raise MergeError("書き戻すワークスペースを選んでください")
    src_ver, dst_ver = await _alembic(src), await _alembic(dst)
    if src_ver != dst_ver:
        # 列の意味が版で変わっている可能性があるため、同じ版どうしに限る
        raise MergeError(
            f"スキーマの版が違います（バックアップ {src_ver} / 今 {dst_ver}）。"
            "同じ版のバックアップを使ってください"
        )
    src_tables = set(await list_tables(src))
    dst_tables = set(await list_tables(dst))

    results: list[TableResult] = []
    tr = dst.transaction()
    await tr.start()
    try:
        for spec in SPECS:
            if spec.table not in src_tables or spec.table not in dst_tables:
                results.append(TableResult(spec.table, 0, 0, 0, "テーブルが無いため飛ばしました"))
                continue
            try:
                results.append(await _merge_table(src, dst, spec, sel))
            except asyncpg.PostgresError as e:
                # 外部キー・一意制約の違反（例: 同じメールの別のユーザーが今の DB にいる）
                raise MergeError(f"{spec.table}: {e}") from e
    except BaseException:
        await tr.rollback()
        raise
    if apply:
        await tr.commit()
    else:
        await tr.rollback()
    return MergeResult(apply, results)
