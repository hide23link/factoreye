"""管理者アカウントの作成・パスワード変更・削除（テキストファイル admin/admins.txt を編集する）。

使い方（本番は backend コンテナ内で実行）:
    docker compose -f docker-compose.cloud.yml exec backend python -m app.admin_cli set-admin <ID>
    docker compose -f docker-compose.cloud.yml exec backend \
        python -m app.admin_cli remove-admin <ID>
    docker compose -f docker-compose.cloud.yml exec backend python -m app.admin_cli list-admins

パスワードは対話入力（画面に表示しない）。ファイルには bcrypt ハッシュだけが書かれる。
"""

import argparse
import getpass
import sys

from app import admin_accounts


def _prompt_new_password() -> str:
    first = getpass.getpass("新しいパスワード（8文字以上）: ")
    second = getpass.getpass("もう一度入力: ")
    if first != second:
        raise SystemExit("パスワードが一致しません")
    if len(first) < 8:
        raise SystemExit("パスワードは8文字以上にしてください")
    return first


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.admin_cli", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    set_p = sub.add_parser("set-admin", help="管理者を追加、またはパスワードを変更")
    set_p.add_argument("admin_id")

    rm_p = sub.add_parser("remove-admin", help="管理者を削除")
    rm_p.add_argument("admin_id")

    sub.add_parser("list-admins", help="管理者IDの一覧（パスワードは表示しない）")

    args = parser.parse_args(argv)

    if args.command == "set-admin":
        if not admin_accounts.is_valid_admin_id(args.admin_id):
            print("ID は英数字と . _ - のみ（1〜50文字）", file=sys.stderr)
            return 2
        password = _prompt_new_password()
        existed = admin_accounts.admin_exists(args.admin_id)
        admin_accounts.set_admin(args.admin_id, password)
        print(f"{'パスワードを変更' if existed else '管理者を追加'}しました: {args.admin_id}")
        return 0

    if args.command == "remove-admin":
        if admin_accounts.remove_admin(args.admin_id):
            print(f"削除しました: {args.admin_id}")
            return 0
        print(f"見つかりません: {args.admin_id}", file=sys.stderr)
        return 1

    for admin_id in admin_accounts.list_admin_ids():
        print(admin_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
