"""画面の明るさの、全員の初期値（display_settings）を足す

設定 › 画面の明るさ で「全員の初期値にする」を選んだときの保存先。新しい表を作るだけで、既存の表は変えない
（行は、初めて読んだときに作る。表が無い間は、画面は端末の選択か「暗い」で動く）。
self-hosted は id=1 の 1 行（workspace_id NULL）、SaaS はワークスペースごとに 1 行まで。

Revision ID: k1f2a3b4c5d6
Revises: j0e1f2a3b4c5
Create Date: 2026-11-18 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'k1f2a3b4c5d6'
down_revision: Union[str, None] = 'j0e1f2a3b4c5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'display_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('workspace_id', sa.Uuid(), nullable=True),
        sa.Column('default_theme', sqlmodel.sql.sqltypes.AutoString(length=10), nullable=False),
        sa.Column('updated_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_display_settings_workspace_id'), 'display_settings', ['workspace_id'], unique=False)
    op.create_index(
        'uq_display_settings_workspace',
        'display_settings',
        ['workspace_id'],
        unique=True,
        postgresql_where=sa.text('workspace_id IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index('uq_display_settings_workspace', table_name='display_settings', postgresql_where=sa.text('workspace_id IS NOT NULL'))
    op.drop_index(op.f('ix_display_settings_workspace_id'), table_name='display_settings')
    op.drop_table('display_settings')
