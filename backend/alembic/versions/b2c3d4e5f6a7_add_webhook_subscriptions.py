"""add webhook_subscriptions (Phase 1: no-code webhook integration)

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-10-04 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # op.create_table自体がEnum型のテーブル作成を検知して型を自動作成するため、
    # add_columnの場合（9755456bc184参照）と異なり、ここでの事前createは不要
    # （付けると「型が既に存在する」エラーで重複作成になる）
    webhook_event_type = sa.Enum("READING_RECEIVED", "ALARM_TRIGGERED", name="webhookeventtype")

    op.create_table(
        "webhook_subscriptions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=True),
        sa.Column("event_type", webhook_event_type, nullable=False),
        sa.Column("url", sqlmodel.sql.sqltypes.AutoString(length=500), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column("updated_at", sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["workspaces.id"], name="fk_webhook_subscriptions_workspace_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_webhook_subscriptions_workspace_id", "webhook_subscriptions", ["workspace_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_webhook_subscriptions_workspace_id", "webhook_subscriptions")
    op.drop_table("webhook_subscriptions")
    op.execute(sa.text("DROP TYPE webhookeventtype"))
