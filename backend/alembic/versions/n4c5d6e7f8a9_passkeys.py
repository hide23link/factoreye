"""パスキー（WebAuthn）でのログインに必要な表を足す（SaaS 版）

パスワードをやめ、端末のパスキーでログインする方式にするための変更。
 - passkeys: 利用者の端末ごとのパスキー（公開鍵だけ。秘密鍵は端末の中）
 - email_tokens: 登録の確認・端末の再登録に使う、メールのリンクのトークン（ハッシュだけ保存）
 - auth_challenges: 登録・ログインで出す使い捨ての乱数（5 分・1 回だけ）
 - users.password_hash を NULL 可にする（パスキーだけの利用者はパスワードを持たない）
 - refresh_tokens: expires_at を NULL 可にする（キオスク用の永久ログイン。NULL = 期限なし）、
   ログイン方法（login_method）・永久ログインの端末の情報（series_id・device_name・started_at・
   last_used_at）を足す。既存の行は、すべて NULL のまま（期限のある通常のログイン）

既存の利用者の password_hash はそのまま残る。管理者の「リセット」で NULL にして、パスキーへ移す。
OSS 版（AUTH_MODE=disabled）では使わない表だが、DB の形は同じにしておく（表が空のまま残る）。

【downgrade】3 つの表を消し、refresh_tokens の足した列を消して、password_hash・expires_at を
NOT NULL に戻す。パスワードの無い利用者・期限なしのログインがあると NOT NULL に戻せないので、
その場合は失敗する（偽の値で埋めない。戻すなら、先に利用者・ログインを整理する）。
パスキー・メールのトークンは消える。

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

    op.alter_column(
        'refresh_tokens', 'expires_at',
        existing_type=sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True,
    )
    op.add_column(
        'refresh_tokens',
        sa.Column('login_method', sqlmodel.sql.sqltypes.AutoString(length=20), nullable=True),
    )
    op.add_column('refresh_tokens', sa.Column('series_id', sa.Uuid(), nullable=True))
    op.add_column(
        'refresh_tokens',
        sa.Column('device_name', sqlmodel.sql.sqltypes.AutoString(length=50), nullable=True),
    )
    op.add_column(
        'refresh_tokens',
        sa.Column('started_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True),
    )
    op.add_column(
        'refresh_tokens',
        sa.Column('last_used_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True),
    )
    op.create_index('ix_refresh_tokens_series_id', 'refresh_tokens', ['series_id'])

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
    op.drop_index('ix_refresh_tokens_series_id', table_name='refresh_tokens')
    op.drop_column('refresh_tokens', 'last_used_at')
    op.drop_column('refresh_tokens', 'started_at')
    op.drop_column('refresh_tokens', 'device_name')
    op.drop_column('refresh_tokens', 'series_id')
    op.drop_column('refresh_tokens', 'login_method')
    op.alter_column(
        'refresh_tokens', 'expires_at',
        existing_type=sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False,
    )
    op.drop_table('auth_challenges')
    op.drop_index('ix_email_tokens_token_hash', table_name='email_tokens')
    op.drop_index('ix_email_tokens_email', table_name='email_tokens')
    op.drop_table('email_tokens')
    op.drop_index('ix_passkeys_user_id', table_name='passkeys')
    op.drop_table('passkeys')
    op.alter_column('users', 'password_hash', existing_type=sa.String(length=200), nullable=False)
