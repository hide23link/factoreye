"""1ワークスペース（SaaS）、または self-hosted の全データを、別の self-hosted DB へ移す。

使い方:
    # 1a. SaaS 側で、1ワークスペースを書き出す（読み取りのみ。REPEATABLE READ で一貫した時点を取る）
    python -m app.migrate_saas_to_oss export \
        --source-url URL --workspace-id UUID --out FILE.jsonl.gz
    # 1b. self-hosted 側で、全データを書き出す（バックアップ・別サーバーへの移行用）
    python -m app.migrate_saas_to_oss export \
        --source-url URL --out FILE.jsonl.gz
    # 2. 移行先（空の self-hosted DB。同じ alembic 版まで migrate 済み）へ取り込む
    python -m app.migrate_saas_to_oss import \
        --target-url URL --in FILE.jsonl.gz [--dry-run] [--with-notifications]

書き出しの対象は、SaaS は指定したワークスペースのデータ、self-hosted は
workspace_id が NULL の全データ（self-hosted には複数ワークスペースという概念が無いため）。

移すもの: センサー・測定値・アラーム・ダッシュボード（削除済みを除く）・ウィジェット・
ウィジェット設定・Webhook 購読。
通知設定は --with-notifications を付けたときだけ移す（移行先の id=1 を上書き）。
移さないもの: ユーザー・リフレッシュトークン・ワークスペース（self-hosted は認証なし）。

ID（UUID）と取り込みキー（ingest_key）はそのまま保つ。測定値の ID は移行先で振り直す。
取り込みキーは移るが、self-hosted の取り込みは X-API-Key ヘッダー（INGEST_API_KEY）が必要
（INGEST_AUTH=off のときは不要）。
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
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlmodel import SQLModel

# テーブル定義（SQLModel.metadata）を登録するため。CLI は単独で起動されるので、ここで読み込む
import app.db.models  # noqa: F401

# 書き出しファイルの識別子と版。取り込み側は、この2つが一致しないファイルを拒否する。
# 形式を変えたら VERSION を上げる（版 1 は未リリースのため、互換性は持たない）
FORMAT = "factoreye-workspace-export"
VERSION = 3  # 3: 機器ごとのキーの表（ingest_devices）を追加
# 書き出し・取り込みの順序。外部キーの参照先が先に来る（取り込みはこの順で流す）
TABLES = [
    "ingest_devices",  # sensors.device_id の参照先。センサーより先に入れる
    "sensors",
    "dashboards",
    "widgets",
    "readings",
    "alarms",
    "webhook_subscriptions",
    "notification_settings",
]
# 一度に読み書きする件数。DB へのまとめ書き込みや、書き出しの読み出しの単位
BATCH_SIZE = 5000
# 測定値は1行に最大この件数まで（1行 = 1センサー・1塊）
READINGS_PER_LINE = 5000
# 測定値の時刻は、この日時からの経過マイクロ秒（整数）で書く
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# SaaS 側の workspace_id を持つが、移行先では NULL（self-hosted）にする列を持つテーブル
_WORKSPACE_SCOPED = {"sensors", "dashboards", "webhook_subscriptions", "notification_settings"}


class MigrationError(Exception):
    """利用者が直せる理由で移行を止めるときの例外（CLI・Web API の両方で扱う）。"""


class _DryRunDone(Exception):
    """--dry-run で取り込みを最後まで流したあと、わざとロールバックするための例外。"""


# ──────────────────────────────────────────────────────────────
# 型の変換: JSON で書ける形（文字列・数値）と、DB の型（UUID・日時）を行き来させる
# ──────────────────────────────────────────────────────────────
def _encode(value: Any) -> Any:
    """書き出し時: DB の値を、JSON に書ける形にする。

    UUID は文字列、日時は ISO 形式の文字列にする。
    """
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _decode(table: sa.Table, name: str, value: Any) -> Any:
    """取り込み時: JSON の文字列を、列の型（UUID・日時）に戻す。

    列の型は、テーブル定義（table.c[name]）から判定する。型が合わない文字列は ValueError になり、
    呼び出し側（_import_lines）で MigrationError に変換される。
    """
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


def integrity_message(error: IntegrityError) -> str:
    """制約違反の理由（どの ID・どの制約が重複したか）を、ドライバ固有の包み物を外して返す。"""
    orig = error.orig
    cause = getattr(orig, "__cause__", None)
    return str(cause if cause is not None else orig)


def _masked(url: str) -> str:
    """表示用に、接続先 URL のパスワードを *** に置き換える（ログや画面に出しても安全なように）。"""
    return make_url(url).render_as_string(hide_password=True)


async def _alembic_version(conn: AsyncConnection) -> str | None:
    """移行先・移行元のスキーマ版（alembic_version の値）を返す。テーブルが無ければ None。"""
    exists = await conn.scalar(sa.text("SELECT to_regclass('public.alembic_version') IS NOT NULL"))
    if not exists:
        return None
    version = await conn.scalar(sa.text("SELECT version_num FROM alembic_version"))
    return None if version is None else str(version)


def _tables() -> dict[str, sa.Table]:
    """移行対象のテーブル定義を、TABLES の順に辞書で返す（モデルの定義から取り出す）。"""
    return {name: SQLModel.metadata.tables[name] for name in TABLES}


def _ws_eq(column: sa.ColumnElement[Any], workspace_id: UUID | None) -> sa.ColumnElement[bool]:
    """workspace_id の等価条件。None（self-hosted）のときは IS NULL で比較する。"""
    return column.is_(None) if workspace_id is None else column == workspace_id


async def export_workspace(
    engine: AsyncEngine, workspace_id: UUID | None, out_path: Path
) -> dict[str, int]:
    """データを gzip JSONL に書き出し、テーブルごとの件数を返す。

    workspace_id を指定すれば SaaS の1ワークスペース分、None なら self-hosted の全データ
    （workspace_id が NULL の行）を対象にする。
    """
    t = _tables()
    sensors, dashboards, widgets = t["sensors"], t["dashboards"], t["widgets"]
    alarms, devices = t["alarms"], t["ingest_devices"]
    webhooks, notifications = t["webhook_subscriptions"], t["notification_settings"]

    sensor_ids = sa.select(sensors.c.id).where(_ws_eq(sensors.c.workspace_id, workspace_id))
    dashboard_ids = sa.select(dashboards.c.id).where(
        _ws_eq(dashboards.c.workspace_id, workspace_id), dashboards.c.deleted_at.is_(None)
    )

    # 移すものの判断:
    # - ダッシュボードは「削除済み（deleted_at あり）」を除く。
    #   ウィジェットも、移すダッシュボードのものだけ
    # - 測定値（readings）は _export_readings で別に書く（件数が多く、形式を圧縮するため）
    # - ユーザーやリフレッシュトークンは、OSS には不要なので対象外
    queries: dict[str, sa.Select[Any]] = {
        # 機器ごとのキー（self-hosted だけ）。名前とキーのハッシュを移す（元のキーには戻せない）。
        # ワークスペース単位の書き出し（SaaS）には機器が無いので、何も出さない
        "ingest_devices": sa.select(devices)
        if workspace_id is None
        else sa.select(devices).where(sa.false()),
        "sensors": sa.select(sensors).where(_ws_eq(sensors.c.workspace_id, workspace_id)),
        "dashboards": sa.select(dashboards).where(
            _ws_eq(dashboards.c.workspace_id, workspace_id), dashboards.c.deleted_at.is_(None)
        ),
        "widgets": sa.select(widgets).where(widgets.c.dashboard_id.in_(dashboard_ids)),
        "alarms": sa.select(alarms).where(alarms.c.sensor_id.in_(sensor_ids)),
        "webhook_subscriptions": sa.select(webhooks).where(
            _ws_eq(webhooks.c.workspace_id, workspace_id)
        ),
        "notification_settings": sa.select(notifications).where(
            _ws_eq(notifications.c.workspace_id, workspace_id)
        ),
    }

    counts = {name: 0 for name in TABLES}
    async with engine.connect() as conn, conn.begin():
        await conn.execute(sa.text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        if workspace_id is not None:
            workspace_exists = await conn.scalar(
                sa.text("SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = :id)"),
                {"id": workspace_id},
            )
            if not workspace_exists:
                raise MigrationError(f"ワークスペースが見つかりません: {workspace_id}")

        header = {
            "format": FORMAT,
            "version": VERSION,
            "workspace_id": str(workspace_id) if workspace_id is not None else None,
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
    """_to_us の逆。マイクロ秒の整数から、UTC の日時に戻す。"""
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
    """取り込む1行を、移行先に入れられる形に整える。

    - 型を戻す（_decode）
    - SaaS のワークスペース列（workspace_id）は NULL にする
      （OSS には、ワークスペースの概念がないため）
    - 通知設定は、--with-notifications のときだけ id=1 の行として入れる
      （それ以外は None を返し、読み飛ばす）
    """
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
    """1行を JSON として読む。壊れていれば、利用者向けの MigrationError にする。"""
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
    """ファイルの行を順に読み、テーブルごとにまとめて DB に入れる。

    行は TABLES の順に並んでいる前提（外部キーの参照先が先に入るように）。
    順序が逆になっていたら、壊れたファイルとして止める。
    同じテーブルの行は BATCH_SIZE 件ずつまとめて書く。テーブルが変わったら、それまでの分を先に書く。
    """
    current: str | None = None
    pending: list[dict[str, Any]] = []
    last_index = -1

    async def flush() -> None:
        if current is not None and pending:
            try:
                await _insert_batch(conn, tables[current], pending)
            except IntegrityError:
                raise  # 制約違反（同じ ID など）は呼び出し側で 409 として扱う
            except DBAPIError as error:
                # 型が合わない値（例: 数値の列に文字列）などは、利用者が直せる理由として返す
                raise MigrationError(
                    f"書き出しファイルの値が移行先の形式と合いません（{current}）: "
                    f"{getattr(error, 'orig', error)}"
                ) from None
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
            try:
                row = _prepare_row(name, tables[name], entry["r"], with_notifications)
            except (ValueError, TypeError):
                raise MigrationError(f"書き出しファイルの値の形式が違います（{name}）") from None
            if row is not None:
                pending.append(row)
        if len(pending) >= BATCH_SIZE:
            await flush()
    await flush()


async def _run_export(args: argparse.Namespace) -> int:
    """CLI の export: SaaS の DB に接続してワークスペースを書き出し、件数を表示する。"""
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
    """CLI の import: 移行先の DB に接続して取り込む。

    制約違反は、何も残さず終了コード 1 で止める。
    """
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
    except IntegrityError as error:
        print(
            f"取り込みを中止しました（何も残していません）: {integrity_message(error)}",
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
    """CLI の入口（python -m app.migrate_saas_to_oss）。

    export と import の2つの副コマンドを持つ。
    """
    parser = argparse.ArgumentParser(prog="python -m app.migrate_saas_to_oss", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    exp = sub.add_parser(
        "export",
        help="SaaS の1ワークスペース、または self-hosted の全データを書き出す（読み取りのみ）",
    )
    exp.add_argument("--source-url", required=True, help="書き出し元の DATABASE_URL")
    exp.add_argument(
        "--workspace-id",
        type=UUID,
        default=None,
        help="SaaS の1ワークスペースを書き出す場合に指定する（省略時は self-hosted の全データ）",
    )
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
    except MigrationError as error:
        print(f"移行を中止しました: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
