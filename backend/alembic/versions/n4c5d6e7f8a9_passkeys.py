"""パスキー（WebAuthn）でのログインに必要な表を足す（SaaS 版）

パスワードをやめ、端末のパスキーでログインする方式にするための変更。
 - passkeys: 利用者の端末ごとのパスキー（公開鍵だけ。秘密鍵は端末の中）
 - email_tokens: 登録の確認・端末の再登録に使う、メールのリンクのトークン（ハッシュだけ保存）
 - auth_challenges: 登録・ログインで出す使い捨ての乱数（5 分・1 回だけ）
 - users.password_hash を NULL 可にする（パスキーだけの利用者はパスワードを持たない）

既存の利用者の password_hash はそのまま残る。管理者の「リセット」で NULL にして、パスキーへ移す。
OSS 版（AUTH_MODE=disabled）では使わない表だが、DB の形は同じにしておく（表が空のまま残る）。

【downgrade】3 つの表を消し、password_hash を NOT NULL に戻す。パスワードの無い利用者がいると
NOT NULL に戻せないので、その場合は失敗する（使えないパスワードのハッシュで埋めない。
戻すなら、先に利用者を整理する）。パスキー・メールのトークンは消える。

Revision ID: n4c5d6e7f8a9
Revises: m3b4c5d6e7f8
Create Date: 2026-11-23 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'n4c5d6e7f8a9'
down_revision: Union[str, None] = 'm3b4c5d6e7f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column('users', 'password_hash', existing_type=sa.String(length=200), nullable=True)

    op.create_table(
        'passkeys',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('credential_id', sqlmodel.sql.sqltypes.AutoString(length=1400), nullable=False),
        sa.Column('public_key', sa.LargeBinary(), nullable=False),
        sa.Column('sign_count', sa.Integer(), nullable=False),
        sa.Column('name', sqlmodel.sql.sqltypes.AutoString(length=50), nullable=False),
        sa.Column('created_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column('last_used_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('credential_id'),
    )
    op.create_index('ix_passkeys_user_id', 'passkeys', ['user_id'])

    op.create_table(
        'email_tokens',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('purpose', sqlmodel.sql.sqltypes.AutoString(length=20), nullable=False),
        sa.Column('email', sqlmodel.sql.sqltypes.AutoString(length=254), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('token_hash', sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column('expires_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column('used_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True),
        sa.Column('created_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_email_tokens_email', 'email_tokens', ['email'])
    op.create_index('ix_email_tokens_token_hash', 'email_tokens', ['token_hash'])

    op.create_table(
        'auth_challenges',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('challenge', sa.LargeBinary(), nullable=False),
        sa.Column('purpose', sqlmodel.sql.sqltypes.AutoString(length=20), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=True),
        sa.Column('email_token_id', sa.Uuid(), nullable=True),
        sa.Column('expires_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column('created_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('auth_challenges')
    op.drop_index('ix_email_tokens_token_hash', table_name='email_tokens')
    op.drop_index('ix_email_tokens_email', table_name='email_tokens')
    op.drop_table('email_tokens')
    op.drop_index('ix_passkeys_user_id', table_name='passkeys')
    op.drop_table('passkeys')
    op.alter_column('users', 'password_hash', existing_type=sa.String(length=200), nullable=False)
