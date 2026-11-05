"""users に lower(email) の一意インデックスを追加する

PR #60 でメールを小文字に正規化し、DB との比較を `lower(email) = ...` にした。このため素の列の
インデックス（ix_users_email）が使われず、ログイン・登録のたびに全件走査になっていた。また、
一意制約は大文字小文字を区別したままで、大文字を含む既存アカウントと小文字の新規登録は、DB 側
では重複として防がれなかった。式インデックス ix_users_email_lower で、検索を速くし、重複も防ぐ。
既存の ix_users_email（素の列の一意インデックス）は残す。

既存データに、大文字小文字だけが違うメールの重複があると作成できない。その場合は、重複している
メールを示して失敗させる（黙って消さない）。解消してから、もう一度実行する。

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-10-11 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT lower(email) AS e, array_agg(email ORDER BY email) AS variants "
            "FROM users GROUP BY lower(email) HAVING count(*) > 1 ORDER BY lower(email)"
        )
    ).all()
    if rows:
        detail = "; ".join(f"{', '.join(variants)}" for _, variants in rows)
        raise RuntimeError(
            "users.email に、大文字小文字だけが違う重複があるため、lower(email) の一意インデックスを"
            f"作成できません。重複しているメール: {detail}。"
            "どちらかのアカウントのメールを変更または削除してから、もう一度実行してください。"
        )
    # users は小さいので、CONCURRENTLY（alembic のトランザクション内では使えない）は使わない
    op.create_index("ix_users_email_lower", "users", [sa.text("lower(email)")], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_email_lower", table_name="users")
