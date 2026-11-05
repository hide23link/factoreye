"""drop widget_configs (未使用: 設定は widgets.config に持つ)

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-10-11 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index(op.f("ix_widget_configs_widget_id"), table_name="widget_configs")
    op.drop_table("widget_configs")


def downgrade() -> None:
    # 初期スキーマ（f25e16a44003）と同じ定義で作り直す（中身は戻らない）
    op.create_table(
        "widget_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("widget_id", sa.Uuid(), nullable=False),
        sa.Column("settings", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(["widget_id"], ["widgets.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_widget_configs_widget_id"), "widget_configs", ["widget_id"], unique=False
    )
