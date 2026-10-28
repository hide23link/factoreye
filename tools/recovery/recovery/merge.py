"""バックアップから今の DB へ、選んだワークスペースのデータを書き戻す（追記）。

- 今の DB に無い行だけを足す。今ある行は変えない・消さない（上書きはしない）
- 試行（dry run）と実行は同じ処理で、試行は最後に取り消す（ROLLBACK）。
  件数も、外部キー・一意制約の違反も、実行したときとまったく同じ結果が試行で分かる
- 全テーブルを 1 つのトランザクションで行う。途中で失敗したら何も書かない

【誰が使うか】app.py が読み込む。
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
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


class SchemaMismatch(MergeError):
    """スキーマの版（Alembic）が違う。列の意味が違いうるので、書き戻さない。"""

    def __init__(self, backup: str | None, current: str | None) -> None:
        super().__init__(
            f"スキーマの版が違います（バックアップ {backup} / 今 {current}）。"
            "同じ版のバックアップを使ってください"
        )
        self.backup = backup
        self.current = current


@dataclass(frozen=True)
class MergeSelection:
    workspace_ids: list[UUID]
    # OSS 版のセンサーなど、ワークスペースに属さない（workspace_id が NULL）データも含める
    include_self_hosted: bool = False
    # 測定値・アラームだけを、この期間に絞る（「この日の不足分だけ戻す」ため）
    time_from: datetime | None = None
    time_to: datetime | None = None
    # 書き戻し先。どちらも指定しなければ、元と同じ所属のまま入れる。
    # into_workspace_id: OSS 版のデータを SaaS 版のこのワークスペースに入れる（まとめる）
    # into_self_hosted: SaaS 版のワークスペースのデータを、OSS 版のデータとして入れる
    into_workspace_id: UUID | None = None
    into_self_hosted: bool = False

    @property
    def remaps(self) -> bool:
        return self.into_workspace_id is not None or self.into_self_hosted


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
    # id をそのまま入れるので、連番を表の最大の id まで進める（次の採番と重ならないように）
    fix_sequence: bool = False
    # 発生中のアラームが今の DB の同じセンサーにもある場合、戻すほうを解除済みにする。
    # 「発生中はセンサーごとに 1 つ」が前提のため（両方が発生中だと、片方が解除されずに残る）
    close_duplicate_open: bool = False
    # 書き戻し先に合わせて workspace_id を付け替える（所属を変えて書き戻すとき）
    remap_workspace: bool = False
    # 書き戻し先で 1 行だけにする（通知設定は、ワークスペースごと・OSS 版で 1 行）
    single_row: bool = False
    # id をこの値にして入れる（OSS 版の通知設定は、backend が id=1 を読むため）
    force_id: int | None = None


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
    TableSpec("alarms", _SENSORS, ("id",), time_column="triggered_at", close_duplicate_open=True),
    TableSpec("dashboards", _ws(), ("id",)),
    TableSpec(
        "widgets", f"dashboard_id IN (SELECT id FROM dashboards WHERE {_ws()})", ("id",)
    ),
    TableSpec("webhook_subscriptions", _ws(), ("id",)),
    # ワークスペースの通知設定: 連番の id は持ち込まず、ワークスペースごとに 1 行
    TableSpec(
        "notification_settings", "workspace_id = ANY(:ids)", ("workspace_id",), drop_id=True
    ),
    # self-hosted の通知設定: backend は id=1 の行を固定で読むため、id を保ったまま入れる。
    # NULL の行が既にあれば（id に関係なく）飛ばす（NULL の行が 2 つになると、
    # どちらが使われるかが決まらない）
    TableSpec(
        "notification_settings", ":self_hosted AND workspace_id IS NULL", ("workspace_id",),
        nullable_key=True, fix_sequence=True,
    ),
)
# refresh_tokens（ログインの状態）は戻さない。戻すと、失効させたはずのログインが復活しうるため

# 所属を変えて書き戻すとき（OSS 版 ⇄ SaaS 版）。ユーザー・ワークスペースの行は入れない
# （書き戻し先のワークスペース、または OSS 版に入れるため、元の所属の情報は使わない）
_REMAP_SPECS: tuple[TableSpec, ...] = (
    TableSpec("sensors", _ws(), ("id",), remap_workspace=True),
    TableSpec(
        "readings", _SENSORS, ("sensor_id", "recorded_at"), drop_id=True,
        time_column="recorded_at",
    ),
    TableSpec("alarms", _SENSORS, ("id",), time_column="triggered_at", close_duplicate_open=True),
    TableSpec("dashboards", _ws(), ("id",), remap_workspace=True),
    TableSpec(
        "widgets", f"dashboard_id IN (SELECT id FROM dashboards WHERE {_ws()})", ("id",)
    ),
    TableSpec("webhook_subscriptions", _ws(), ("id",), remap_workspace=True),
    # 書き戻し先に通知設定が既にあれば入れない。無ければ、元の 1 行目を書き戻し先のものとして入れる
    TableSpec(
        "notification_settings", _ws(), ("workspace_id",), nullable_key=True,
        remap_workspace=True, single_row=True,
    ),
)


def specs_for(sel: MergeSelection) -> tuple[TableSpec, ...]:
    if not sel.remaps:
        return SPECS
    specs = []
    for spec in _REMAP_SPECS:
        if spec.table == "notification_settings":
            spec = (
                replace(spec, force_id=1, fix_sequence=True)
                if sel.into_self_hosted
                else replace(spec, drop_id=True)
            )
        specs.append(spec)
    return tuple(specs)


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
    # 戻すときに解除済みにしたアラームの数（close_duplicate_open）
    closed: int = 0


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
    src: asyncpg.Connection,
    dst: asyncpg.Connection,
    spec: TableSpec,
    sel: MergeSelection,
    tmp: str,
    apply: bool,
) -> TableResult:
    src_cols = await _columns(src, spec.table)
    dst_cols = await _columns(dst, spec.table)
    cols = [c for c in dst_cols if c in src_cols]
    missing_key = [k for k in spec.key if k not in cols]
    if missing_key:
        raise MergeError(f"{spec.table}: 判定に使う列がありません: {missing_key}")
    insert_cols = [c for c in cols if not (spec.drop_id and c == "id")]

    # 今の DB に一時テーブルを作り、バックアップの対象の行を流し込む。
    # 今の DB に既にある行を一時テーブルから消し、残り（＝足す行）をすべて入れる
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

    t, s_ = f"public.{_ident(spec.table)}", _ident(tmp)
    if spec.remap_workspace and sel.remaps:
        # OSS 版として入れるときは NULL（into_workspace_id が None）
        await dst.execute(f"UPDATE {s_} SET workspace_id = $1::uuid", sel.into_workspace_id)
    if spec.single_row and source > 1:
        await dst.execute(f"DELETE FROM {s_} WHERE ctid NOT IN (SELECT ctid FROM {s_} LIMIT 1)")
        source = 1
    if spec.force_id is not None:
        await dst.execute(f"UPDATE {s_} SET id = $1", spec.force_id)
    op = "IS NOT DISTINCT FROM" if spec.nullable_key else "="
    match = " AND ".join(f"x.{_ident(k)} {op} s.{_ident(k)}" for k in spec.key)
    existing = _rowcount(
        await dst.execute(f"DELETE FROM {s_} s WHERE EXISTS (SELECT 1 FROM {t} x WHERE {match})")
    )
    ins = ", ".join(_ident(c) for c in insert_cols)
    inserted = _rowcount(
        await dst.execute(
            f"INSERT INTO {t} ({ins}) SELECT {', '.join('s.' + _ident(c) for c in insert_cols)}"
            f" FROM {s_} s"
        )
    )
    closed = 0
    if spec.close_duplicate_open and inserted:
        closed = _rowcount(
            await dst.execute(
                f"UPDATE {t} a SET status = 'RESOLVED', resolved_at = now()"
                f" WHERE a.id IN (SELECT id FROM {s_}) AND a.status <> 'RESOLVED'"
                f" AND EXISTS (SELECT 1 FROM {t} b WHERE b.sensor_id = a.sensor_id"
                f" AND b.status <> 'RESOLVED' AND b.id NOT IN (SELECT id FROM {s_}))"
            )
        )
    # 連番（sequence）は取り消しても戻らないため、実行のときだけ進める
    if spec.fix_sequence and inserted and apply:
        await _advance_sequence(dst, spec.table)
    note = f"発生中のアラーム {closed} 件を解除済みにして戻します" if closed else None
    return TableResult(spec.table, source, inserted, existing, note, closed)


async def _advance_sequence(dst: asyncpg.Connection, table: str) -> None:
    """連番を、表の最大の id まで進める（戻すことはしない）。"""
    seq = await dst.fetchval("SELECT pg_get_serial_sequence($1, 'id')", f"public.{table}")
    if seq is None:
        return
    max_id = await dst.fetchval(f"SELECT max(id) FROM public.{_ident(table)}")
    # seq は pg_get_serial_sequence が返す、引用符付きの正しい名前
    row = await dst.fetchrow(f"SELECT last_value, is_called FROM {seq}")
    if row is None:
        return
    used = row["last_value"] if row["is_called"] else row["last_value"] - 1
    if max_id is not None and max_id > used:
        await dst.execute("SELECT setval($1::regclass, $2, true)", seq, max_id)


def _rowcount(status: str) -> int:
    return int(status.rsplit(" ", 1)[-1])


def check_mode(sel: MergeSelection, target_mode: str | None) -> None:
    """書き戻し先が、今の DB（SaaS 版・OSS 版）で使える形かを確かめる。

    - SaaS 版: OSS 版のデータ（ワークスペースに属さない）は、どの利用者の画面にも出ないため、
      書き戻し先のワークスペースを選んでもらう
    - OSS 版: SaaS 版のワークスペースのデータは、OSS 版のデータとして入れる
    """
    if sel.into_workspace_id is not None and sel.into_self_hosted:
        raise MergeError("書き戻し先は 1 つだけ選んでください")
    if target_mode == "saas":
        if sel.into_self_hosted:
            raise MergeError("今の DB は SaaS 版のため、OSS 版のデータとしては入れられません")
        if sel.include_self_hosted and sel.into_workspace_id is None:
            raise MergeError(
                "OSS 版のデータを SaaS 版に入れるには、書き戻し先のワークスペースを選んでください"
            )
    if target_mode == "oss":
        if sel.into_workspace_id is not None:
            raise MergeError("今の DB は OSS 版のため、ワークスペースには入れられません")
        if sel.workspace_ids and not sel.into_self_hosted:
            raise MergeError(
                "SaaS 版のワークスペースを OSS 版に入れるには、書き戻し先を OSS 版にしてください"
            )


async def merge(
    src: asyncpg.Connection,
    dst: asyncpg.Connection,
    sel: MergeSelection,
    apply: bool,
    target_mode: str | None = None,
) -> MergeResult:
    """src（展開したバックアップ）から dst（今の DB）へ。apply=False なら最後に取り消す。"""
    if not sel.workspace_ids and not sel.include_self_hosted:
        raise MergeError("書き戻すワークスペースを選んでください")
    check_mode(sel, target_mode)
    if sel.into_workspace_id is not None and not await dst.fetchval(
        "SELECT 1 FROM workspaces WHERE id = $1", sel.into_workspace_id
    ):
        raise MergeError("書き戻し先のワークスペースが、今の DB にありません")
    src_ver, dst_ver = await _alembic(src), await _alembic(dst)
    if src_ver != dst_ver:
        # 列の意味が版で変わっている可能性があるため、同じ版どうしに限る
        raise SchemaMismatch(src_ver, dst_ver)
    src_tables = set(await list_tables(src))
    dst_tables = set(await list_tables(dst))

    results: list[TableResult] = []
    tr = dst.transaction()
    await tr.start()
    try:
        for i, spec in enumerate(specs_for(sel)):
            if spec.table not in src_tables or spec.table not in dst_tables:
                results.append(TableResult(spec.table, 0, 0, 0, "テーブルが無いため飛ばしました"))
                continue
            if (
                not sel.remaps
                and spec.table == "notification_settings"
                and spec.nullable_key
                and not sel.include_self_hosted
            ):
                continue
            try:
                results.append(
                    await _merge_table(src, dst, spec, sel, f"_merge_{i}_{spec.table}", apply)
                )
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
