"""測定値のまとめ（ロールアップ）の運用コマンド。

使い方（Pi など、docker compose で動かしている場合）:
    docker compose exec backend python -m app.rollup_cli status
        → 生の行・まとめた行の件数、いちばん古い生の行、表のサイズを出す（何も変えない）
    docker compose exec backend python -m app.rollup_cli run [--days 7]
        → 今すぐ、--days 日より古い生の行を 1 分にまとめる（省略は設定 READINGS_ROLLUP_DAYS）
    docker compose exec backend python -m app.rollup_cli vacuum-full --yes
        → readings の領域を OS に返す（VACUUM FULL）。終わるまで readings の読み書きが止まる
          （数分。取り込みはその間待たされる）。まとめたあと、ディスクを空けたいときに 1 回だけ使う

【注意】vacuum-full は、表を作り直す間、readings 全体をロックする。ディスクに、表の大きさ分の
空きが要る（作り直した新しい表ができるまで、古い表を消せないため）。--yes が無いと実行しない。
"""
import argparse
import asyncio
import sys

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.config import settings
from app.db.session import engine
from app.rollup import rollup_old_readings

_STATUS_SQL = text(
    """
    SELECT
        (SELECT count(*) FROM readings) AS raw_rows,
        (SELECT min(recorded_at) FROM readings) AS oldest_raw,
        (SELECT count(*) FROM readings_rollup) AS rollup_rows,
        (SELECT min(bucket_start) FROM readings_rollup) AS oldest_rollup,
        pg_size_pretty(pg_total_relation_size('readings')) AS raw_size,
        pg_size_pretty(pg_total_relation_size('readings_rollup')) AS rollup_size,
        pg_size_pretty(pg_database_size(current_database())) AS db_size
    """
)


async def _status() -> None:
    """件数・いちばん古い行・サイズを出す（読むだけ）。"""
    async with engine.connect() as conn:
        row = (await conn.execute(_STATUS_SQL)).one()
    print(f"設定 READINGS_ROLLUP_DAYS = {settings.readings_rollup_days}（0 は、まとめない）")
    print(f"生の行      : {row.raw_rows:,} 件（いちばん古い: {row.oldest_raw}）  {row.raw_size}")
    print(
        f"1 分の行    : {row.rollup_rows:,} 件（いちばん古い: {row.oldest_rollup}）  "
        f"{row.rollup_size}"
    )
    print(f"DB 全体     : {row.db_size}")


async def _run(days: int | None) -> None:
    """今すぐまとめる。"""
    result = await rollup_old_readings(days)
    print(
        f"センサー {result.sensors} 件、生の行 {result.deleted_rows:,} 件を、"
        f"1 分の行 {result.buckets:,} 件にまとめました"
    )


# readings のロックを待つ上限。取れなければ（長い問い合わせや取り込みが続いているとき）中止する
_VACUUM_LOCK_TIMEOUT = "30s"


async def _vacuum_full() -> int:
    """readings を作り直して、領域を OS に返す。終わるまで readings が止まる。終了コードを返す。"""
    # VACUUM はトランザクションの中では実行できないので、自動コミットの接続で実行する
    async with engine.connect() as conn:
        autocommit = await conn.execution_options(isolation_level="AUTOCOMMIT")
        await autocommit.execute(text(f"SET lock_timeout = '{_VACUUM_LOCK_TIMEOUT}'"))
        print("VACUUM FULL readings を実行します（終わるまで数分かかります）...")
        try:
            await autocommit.execute(text("VACUUM (FULL, ANALYZE) readings"))
        except DBAPIError as error:
            if "lock timeout" not in str(error.orig):
                raise
            print(
                f"readings のロックを {_VACUUM_LOCK_TIMEOUT} 以内に取れませんでした"
                "（長い問い合わせや取り込みが続いています）。何も変えていません。"
                "しばらくして、もう一度実行してください"
            )
            return 1
        await autocommit.execute(text("VACUUM (ANALYZE) readings_rollup"))
    print("完了しました")
    await _status()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="測定値のまとめ（ロールアップ）の運用コマンド")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="件数・サイズを出す（何も変えない）")
    run_parser = sub.add_parser("run", help="今すぐ、古い生の行を 1 分にまとめる")
    run_parser.add_argument("--days", type=int, default=None, help="残す日数（省略は設定の値）")
    vacuum_parser = sub.add_parser("vacuum-full", help="readings の領域を返す（読み書きが止まる）")
    vacuum_parser.add_argument("--yes", action="store_true", help="止まることを理解して実行する")
    args = parser.parse_args(argv)

    if args.command == "status":
        asyncio.run(_status())
    elif args.command == "run":
        asyncio.run(_run(args.days))
    else:
        if not args.yes:
            print(
                "vacuum-full は、終わるまで readings の読み書きが止まります。"
                "--yes を付けて実行してください"
            )
            return 2
        return asyncio.run(_vacuum_full())
    return 0


if __name__ == "__main__":
    sys.exit(main())
