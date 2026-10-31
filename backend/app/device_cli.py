"""機器ごとのキーの発行・所属・失効（自前ホスト用）。

使い方（backend コンテナの中で実行する）:
    python -m app.device_cli create <機器名> [--line <系統>]
        → キーを 1 回だけ表示する（控えてから閉じる。DB にはハッシュしか残らない）
        　系統（例: 第1ライン。40 文字まで）を付けると、センサー棚が「系統 › 機器」に分けて見せる
    python -m app.device_cli set-line <機器名> [<系統>]
        → 機器の系統を付ける・変える。系統を省く（または空）と外す
    python -m app.device_cli attach <機器名> <ingestKey> [<ingestKey> ...]
        → センサーをその機器に所属させる（この機器のキーでしか送れなくなる）
    python -m app.device_cli revoke <機器名>
        → 機器のキーを失効させる
    python -m app.device_cli list
        → 機器の一覧（キーは表示しない）
"""

import argparse
import asyncio
import sys
from datetime import datetime

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import device_keys
from app.config import AuthMode, settings
from app.db.models import IngestDevice, Sensor
from app.db.session import engine


async def run_command(args: argparse.Namespace) -> int:
    """コマンドを実行する。テストからも呼べるよう、引数を受け取る（終了コードを返す）。"""
    async with AsyncSession(engine) as session:
        if args.command == "create":
            if await device_keys.get_device_by_name(session, args.name) is not None:
                print(f"同じ名前の機器があります: {args.name}", file=sys.stderr)
                return 1
            try:
                key = await device_keys.create_device(session, args.name, args.line)
            except ValueError as error:
                print(error, file=sys.stderr)
                return 1
            print(f"機器 {args.name} を作りました。キー（この 1 回だけ表示します）:")
            print(key)
            return 0

        if args.command == "list":
            devices = (await session.exec(select(IngestDevice).order_by(IngestDevice.name))).all()
            for item in devices:
                count = (
                    await session.exec(
                        select(func.count())
                        .select_from(Sensor)
                        .where(col(Sensor.device_id) == item.id)
                    )
                ).one()
                state = "失効" if item.revoked_at else "有効"
                print(
                    f"{item.name}\t{state}\tセンサー {count}\t系統 {item.line or '-'}"
                    f"\t作成 {_fmt(item.created_at)}"
                )
            return 0

        device = await device_keys.get_device_by_name(session, args.name)
        if device is None:
            print(f"機器が見つかりません: {args.name}", file=sys.stderr)
            return 1
        if args.command == "attach":
            missing = await device_keys.attach_sensors(session, device, args.ingest_keys)
            print(f"所属させました: {len(args.ingest_keys) - len(missing)} 件")
            if missing:
                print(f"見つからない ingestKey: {', '.join(missing)}", file=sys.stderr)
                return 1
            return 0
        if args.command == "set-line":
            try:
                saved = await device_keys.set_device_line(session, device, args.line)
            except ValueError as error:
                print(error, file=sys.stderr)
                return 1
            print(f"系統を {saved or '（なし）'} にしました: {args.name}")
            return 0
        if args.command == "revoke":
            await device_keys.revoke_device(session, device)
            print(f"キーを失効させました: {args.name}")
            return 0
    return 2


def _fmt(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d %H:%M")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m app.device_cli", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create_p = sub.add_parser("create", help="機器を作り、キーを発行する")
    create_p.add_argument("name")
    create_p.add_argument("--line", default=None, help="系統（例: 第1ライン）")
    line_p = sub.add_parser("set-line", help="機器の系統を付ける・変える（省くと外す）")
    line_p.add_argument("name")
    line_p.add_argument("line", nargs="?", default=None)
    attach_p = sub.add_parser("attach", help="センサーを機器に所属させる")
    attach_p.add_argument("name")
    attach_p.add_argument("ingest_keys", nargs="+")
    revoke_p = sub.add_parser("revoke", help="機器のキーを失効させる")
    revoke_p.add_argument("name")
    sub.add_parser("list", help="機器の一覧")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if settings.auth_mode == AuthMode.MULTI_TENANT:
        print("機器のキーは、自前ホスト（AUTH_MODE=disabled）専用です", file=sys.stderr)
        return 1
    return asyncio.run(run_command(parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
