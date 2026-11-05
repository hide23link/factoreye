"""drop plugin system (Phase 2: extensibility moved to webhooks)

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-10-04 06:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # plugin_configsがplugins.idを参照しているため、子テーブルから先に削除する
    op.drop_index(op.f("ix_plugin_configs_plugin_id"), table_name="plugin_configs")
    op.drop_table("plugin_configs")
    op.drop_table("plugins")


def downgrade() -> None:
    op.create_table(
        "plugins",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=100), nullable=False),
        sa.Column("version", sqlmodel.sql.sqltypes.AutoString(length=20), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("installed_at", sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "plugin_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("plugin_id", sa.Uuid(), nullable=False),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(["plugin_id"], ["plugins.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_plugin_configs_plugin_id"), "plugin_configs", ["plugin_id"], unique=False
    )
