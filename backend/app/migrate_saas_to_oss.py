"""SaaS（マルチテナント）の1ワークスペースを、OSS（self-hosted）の DB へ移す。

使い方:
    # 1. SaaS 側で書き出す（読み取りのみ。REPEATABLE READ で一貫した時点を取る）
    python -m app.migrate_saas_to_oss export \
        --source-url URL --workspace-id UUID --out FILE.jsonl.gz
    # 2. 移行先（空の self-hosted DB。同じ alembic 版まで migrate 済み）へ取り込む
    python -m app.migrate_saas_to_oss import \
        --target-url URL --in FILE.jsonl.gz [--dry-run] [--with-notifications]

移すもの: センサー・測定値・アラーム・ダッシュボード（削除済みを除く）・ウィジェット・
ウィジェット設定・Webhook 購読。
通知設定は --with-notifications を付けたときだけ移す（移行先の id=1 を上書き）。
移さないもの: ユーザー・リフレッシュトークン・ワークスペース（self-hosted は認証なし）。

ID（UUID）と取り込みキー（ingest_key）はそのまま保つ。測定値の ID は移行先で振り直す。
取り込みキーは移るが、self-hosted の取り込みは X-API-Key ヘッダー（INGEST_API_KEY）が必要。
デバイス側の送信設定は別途変える必要がある。

取り込みは1トランザクション。制約違反（同名センサー・同じ ID など）があれば
全体をロールバックして止まる。
"""

import argparse
import asyncio
import gzip
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, TextIO
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlmodel import SQLModel

# テーブル定義（SQLModel.metadata）を登録するため。CLI は単独で起動されるので、ここで読み込む
import app.db.models  # noqa: F401

FORMAT = "factoreye-workspace-export"
VERSION = 2
# 書き出し・取り込みの順序。外部キーの参照先が先に来る（取り込みはこの順で流す）
TABLES = [
    "sensors",
    "dashboards",
    "widgets",
    "widget_configs",
    "readings",
    "alarms",
    "webhook_subscriptions",
    "notification_settings",
]
BATCH_SIZE = 5000
# 測定値は1行に最大この件数まで（1行 = 1センサー・1塊）
READINGS_PER_LINE = 5000
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# SaaS 側の workspace_id を持つが、移行先では NULL（self-hosted）にする列を持つテーブル
_WORKSPACE_SCOPED = {"sensors", "dashboards", "webhook_subscriptions", "notification_settings"}


class MigrationError(Exception):
    """利用者が直せる理由で移行を止めるときの例外（CLI・Web API の両方で扱う）。"""


class _DryRunDone(Exception):
    """--dry-run で取り込みを最後まで流したあと、わざとロールバックするための例外。"""


def _encode(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _decode(table: sa.Table, name: str, value: Any) -> Any:
    if value is None:
        return None
    column_type = table.c[name].type
    # sqlmodel の UTCDateTime 等は TypeDecorator で包まれているので、中身の型で判定する
    base_type = column_type.impl if isinstance(column_type, sa.TypeDecorator) else column_type
    if isinstance(base_type, sa.DateTime):
        return datetime.fromisoformat(value)
    if isinstance(base_type, sa.Uuid):
        return UUID(value)
    return value


def integrity_message(exc: IntegrityError) -> str:
    """制約違反の理由（どの ID・どの制約が重複したか）を、ドライバ固有の包み物を外して返す。"""
    orig = exc.orig
    cause = getattr(orig, "__cause__", None)
    return str(cause if cause is not None else orig)


def _masked(url: str) -> str:
    return make_url(url).render_as_string(hide_password=True)


async def _alembic_version(conn: AsyncConnection) -> str | None:
    exists = await conn.scalar(sa.text("SELECT to_regclass('public.alembic_version') IS NOT NULL"))
    if not exists:
        return None
    version = await conn.scalar(sa.text("SELECT version_num FROM alembic_version"))
    return None if version is None else str(version)


def _tables() -> dict[str, sa.Table]:
    return {name: SQLModel.metadata.tables[name] for name in TABLES}


async def export_workspace(
    engine: AsyncEngine, workspace_id: UUID, out_path: Path
) -> dict[str, int]:
    """ワークスペース1つ分を gzip JSONL に書き出し、テーブルごとの件数を返す。"""
    t = _tables()
    sensors, dashboards, widgets = t["sensors"], t["dashboards"], t["widgets"]
    widget_configs, alarms = t["widget_configs"], t["alarms"]
    webhooks, notifications = t["webhook_subscriptions"], t["notification_settings"]

    sensor_ids = sa.select(sensors.c.id).where(sensors.c.workspace_id == workspace_id)
    dashboard_ids = sa.select(dashboards.c.id).where(
        dashboards.c.workspace_id == workspace_id, dashboards.c.deleted_at.is_(None)
    )
    widget_ids = sa.select(widgets.c.id).where(widgets.c.dashboard_id.in_(dashboard_ids))

    queries: dict[str, sa.Select[Any]] = {
        "sensors": sa.select(sensors).where(sensors.c.workspace_id == workspace_id),
        "dashboards": sa.select(dashboards).where(
            dashboards.c.workspace_id == workspace_id, dashboards.c.deleted_at.is_(None)
        ),
        "widgets": sa.select(widgets).where(widgets.c.dashboard_id.in_(dashboard_ids)),
        "widget_configs": sa.select(widget_configs).where(
            widget_configs.c.widget_id.in_(widget_ids)
        ),
        "alarms": sa.select(alarms).where(alarms.c.sensor_id.in_(sensor_ids)),
        "webhook_subscriptions": sa.select(webhooks).where(webhooks.c.workspace_id == workspace_id),
        "notification_settings": sa.select(notifications).where(
            notifications.c.workspace_id == workspace_id
        ),
    }

    counts = {name: 0 for name in TABLES}
    async with engine.connect() as conn, conn.begin():
        await conn.execute(sa.text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        workspace_exists = await conn.scalar(
            sa.text("SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = :id)"),
            {"id": workspace_id},
        )
        if not workspace_exists:
            raise MigrationError(f"ワークスペースが見つかりません: {workspace_id}")

        header = {
            "format": FORMAT,
            "version": VERSION,
            "workspace_id": str(workspace_id),
            "exported_at": datetime.now(UTC).isoformat(),
            "alembic_version": await _alembic_version(conn),
        }
        with gzip.open(out_path, "wt", encoding="utf-8") as f:
            f.write(json.dumps(header, ensure_ascii=False) + "\n")
            for name in TABLES:
                if name == "readings":
                    await _export_readings(conn, f, sensor_ids, counts)
                    continue
                result = await conn.stream(queries[name].execution_options(yield_per=BATCH_SIZE))
                async for row in result.mappings():
                    line = {"t": name, "r": {k: _encode(v) for k, v in row.items()}}
                    f.write(json.dumps(line, ensure_ascii=False) + "\n")
                    counts[name] += 1
    return counts


def _to_us(at: datetime) -> int:
    """時刻を、エポックからのマイクロ秒（整数）にする。丸めないので往復しても元に戻る。"""
    return (at - EPOCH) // timedelta(microseconds=1)


def _from_us(us: int) -> datetime:
    return EPOCH + timedelta(microseconds=us)


async def _export_readings(
    conn: AsyncConnection,
    f: TextIO,
    sensor_ids: sa.Select[Any],
    counts: dict[str, int],
) -> None:
    """測定値を、センサーごとに「値と時刻の差分」の配列にして書き出す。

    1行の形: {"t":"readings","sensor_id":..,"t0":<最初の時刻 µs>,"rows":[[値, 差分 µs], ...]}
    差分は1行の中で前の行からの差（最初は 0）。ID と sensor_id の繰り返しを省くため小さくなる。
    """
    readings = _tables()["readings"]
    stmt = (
        sa.select(readings.c.sensor_id, readings.c.value, readings.c.recorded_at)
        .where(readings.c.sensor_id.in_(sensor_ids))
        .order_by(readings.c.sensor_id, readings.c.recorded_at)
    )
    result = await conn.stream(stmt.execution_options(yield_per=BATCH_SIZE))

    sensor: UUID | None = None
    t0 = 0
    prev = 0
    rows: list[list[float | int]] = []

    def write_chunk() -> None:
        if not rows:
            return
        line = {"t": "readings", "sensor_id": str(sensor), "t0": t0, "rows": rows}
        f.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")
        counts["readings"] += len(rows)
        rows.clear()

    async for sid, value, at in result:
        us = _to_us(at)
        if sid != sensor or len(rows) >= READINGS_PER_LINE:
            write_chunk()
            sensor = sid
            t0 = us
            prev = us
        rows.append([value, us - prev])
        prev = us
    write_chunk()


def _expand_readings(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """_export_readings が書いた1行を、測定値の行（辞書）に戻す。"""
    try:
        sensor_id = UUID(entry["sensor_id"])
        cur = int(entry["t0"])
        out: list[dict[str, Any]] = []
        for value, delta in entry["rows"]:
            cur += int(delta)
            out.append(
                {
                    "sensor_id": sensor_id,
                    "value": float(value),
                    "recorded_at": _from_us(cur),
                }
            )
    except (KeyError, TypeError, ValueError, OverflowError):
        raise MigrationError("書き出しファイルの測定値の行が壊れています") from None
    return out


def _prepare_row(
    name: str, table: sa.Table, raw: dict[str, Any], with_notifications: bool
) -> dict[str, Any] | None:
    row = {k: _decode(table, k, v) for k, v in raw.items()}
    if name in _WORKSPACE_SCOPED and "workspace_id" in row:
        row["workspace_id"] = None
    if name == "notification_settings":
        if not with_notifications:
            return None
        # self-hosted の通知設定は id=1 の1行（workspace_id NULL）
        row["id"] = 1
        row["workspace_id"] = None
    return row


async def _insert_batch(conn: AsyncConnection, table: sa.Table, rows: list[dict[str, Any]]) -> None:
    if table.name == "notification_settings":
        # id=1 は移行先に既に行があり得るので、上書きする（--with-notifications の明示指定時のみ）
        for row in rows:
            stmt = pg_insert(table).values(row)
            stmt = stmt.on_conflict_do_update(
                index_elements=[table.c.id],
                set_={k: stmt.excluded[k] for k in row if k != "id"},
            )
            await conn.execute(stmt)
        return
    await conn.execute(table.insert(), rows)


async def import_bundle(
    engine: AsyncEngine,
    in_path: Path,
    *,
    dry_run: bool = False,
    with_notifications: bool = False,
) -> dict[str, int]:
    """書き出しファイルを移行先に取り込み、テーブルごとの取り込み件数を返す。

    dry_run のときは最後までロールバックする（件数だけ確認できる）。
    制約違反などは IntegrityError のまま送出し、何も残さない。
    """
    t = _tables()
    counts = {name: 0 for name in TABLES}
    if not in_path.is_file():
        raise MigrationError(f"書き出しファイルが見つかりません: {in_path}")
    with gzip.open(in_path, "rt", encoding="utf-8") as f:
        header = _parse_line(_read_line(f))
        if (
            not isinstance(header, dict)
            or header.get("format") != FORMAT
            or header.get("version") != VERSION
        ):
            raise MigrationError("書き出しファイルの形式が違います")

        try:
            async with engine.begin() as conn:
                target_version = await _alembic_version(conn)
                if target_version is None:
                    raise MigrationError(
                        "移行先に alembic_version がありません。先に migrate してください"
                    )
                if header.get("alembic_version") != target_version:
                    raise MigrationError(
                        f"スキーマ版が違います（書き出し: {header.get('alembic_version')}、"
                        f"移行先: {target_version}）。両方を同じ版にそろえてください"
                    )
                await _import_lines(conn, f, t, counts, with_notifications)
                if dry_run:
                    raise _DryRunDone
        except _DryRunDone:
            pass
    return counts


def _read_line(f: TextIO) -> str:
    """次の1行を読む（空文字なら終わり）。gzip が壊れていれば利用者向けのエラーにする。"""
    try:
        return f.readline()
    except (OSError, EOFError):
        raise MigrationError(
            "書き出しファイルを読めません（gzip が壊れている可能性があります）"
        ) from None


def _parse_line(line: str) -> Any:
    try:
        return json.loads(line)
    except ValueError:
        raise MigrationError("書き出しファイルの中身を読めません（JSON が壊れています）") from None


async def _import_lines(
    conn: AsyncConnection,
    f: TextIO,
    tables: dict[str, sa.Table],
    counts: dict[str, int],
    with_notifications: bool,
) -> None:
    current: str | None = None
    pending: list[dict[str, Any]] = []
    last_index = -1

    async def flush() -> None:
        if current is not None and pending:
            await _insert_batch(conn, tables[current], pending)
            counts[current] += len(pending)
            pending.clear()

    while line := _read_line(f):
        entry = _parse_line(line)
        if not isinstance(entry, dict) or not isinstance(entry.get("t"), str):
            raise MigrationError("書き出しファイルの行の形式が違います")
        name = entry["t"]
        if name not in TABLES:
            raise MigrationError(f"未知のテーブルです: {name}")
        index = TABLES.index(name)
        if index < last_index:
            raise MigrationError(f"テーブルの順序が不正です: {name}")
        if name != current:
            await flush()
            current = name
            last_index = index
        if name == "readings":
            pending.extend(_expand_readings(entry))
        else:
            if not isinstance(entry.get("r"), dict):
                raise MigrationError("書き出しファイルの行の形式が違います")
            unknown = set(entry["r"]) - set(tables[name].c.keys())
            if unknown:
                raise MigrationError(f"未知の列です（{name}）: {', '.join(sorted(unknown))}")
            row = _prepare_row(name, tables[name], entry["r"], with_notifications)
            if row is not None:
                pending.append(row)
        if len(pending) >= BATCH_SIZE:
            await flush()
    await flush()


async def _run_export(args: argparse.Namespace) -> int:
    engine = create_async_engine(args.source_url)
    try:
        print(f"読み取り元: {_masked(args.source_url)}")
        counts = await export_workspace(engine, args.workspace_id, args.out)
    finally:
        await engine.dispose()
    print(f"書き出しました: {args.out}")
    for name, count in counts.items():
        print(f"  {name}: {count}")
    return 0


async def _run_import(args: argparse.Namespace) -> int:
    engine = create_async_engine(args.target_url)
    print(f"取り込み先: {_masked(args.target_url)}")
    if args.dry_run:
        print("（dry-run: 最後にロールバックします）")
    try:
        counts = await import_bundle(
            engine,
            args.in_path,
            dry_run=args.dry_run,
            with_notifications=args.with_notifications,
        )
    except IntegrityError as exc:
        print(
            f"取り込みを中止しました（何も残していません）: {integrity_message(exc)}",
            file=sys.stderr,
        )
        return 1
    finally:
        await engine.dispose()
    print("取り込み件数:" if not args.dry_run else "取り込めるはずの件数:")
    for name, count in counts.items():
        print(f"  {name}: {count}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.migrate_saas_to_oss", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    exp = sub.add_parser("export", help="SaaS の1ワークスペースを書き出す（読み取りのみ）")
    exp.add_argument("--source-url", required=True, help="SaaS 側の DATABASE_URL")
    exp.add_argument("--workspace-id", required=True, type=UUID)
    exp.add_argument("--out", required=True, type=Path)

    imp = sub.add_parser("import", help="書き出したファイルを移行先（self-hosted）へ取り込む")
    imp.add_argument("--target-url", required=True, help="移行先の DATABASE_URL")
    imp.add_argument("--in", dest="in_path", required=True, type=Path)
    imp.add_argument(
        "--dry-run", action="store_true", help="件数を確認して、最後にロールバックする"
    )
    imp.add_argument(
        "--with-notifications",
        action="store_true",
        help="通知設定を移す（移行先の通知設定 id=1 を上書きする）",
    )

    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            return asyncio.run(_run_export(args))
        return asyncio.run(_run_import(args))
    except MigrationError as exc:
        print(f"移行を中止しました: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
