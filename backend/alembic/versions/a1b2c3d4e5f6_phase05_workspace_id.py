"""Phase 0.5: users/workspaces/refresh_tokens + workspace_id on sensors/dashboards/notification_settings

Revision ID: a1b2c3d4e5f6
Revises: 9755456bc184
Create Date: 2026-10-03 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "9755456bc184"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Phase 0.5 新規テーブル ──────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sqlmodel.sql.sqltypes.AutoString(length=254), nullable=False),
        sa.Column("password_hash", sqlmodel.sql.sqltypes.AutoString(length=200), nullable=False),
        sa.Column("created_at", sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_index("ix_users_email", "users", ["email"])

    op.create_table(
        "workspaces",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(length=100), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("plan", sqlmodel.sql.sqltypes.AutoString(length=20), nullable=False),
        sa.Column("created_at", sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workspaces_owner_id", "workspaces", ["owner_id"])

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column("expires_at", sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column("created_at", sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])
    op.create_index("ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"])

    # ── workspace_id を既存テーブルに追加 ──────────────────────
    op.add_column(
        "sensors",
        sa.Column("workspace_id", postgresql.UUID(), nullable=True),
    )
    op.create_index("ix_sensors_workspace_id", "sensors", ["workspace_id"])
    op.create_foreign_key(
        "fk_sensors_workspace_id",
        "sensors", "workspaces",
        ["workspace_id"], ["id"],
        ondelete="CASCADE",
    )

    op.add_column(
        "dashboards",
        sa.Column("workspace_id", postgresql.UUID(), nullable=True),
    )
    op.create_index("ix_dashboards_workspace_id", "dashboards", ["workspace_id"])
    op.create_foreign_key(
        "fk_dashboards_workspace_id",
        "dashboards", "workspaces",
        ["workspace_id"], ["id"],
        ondelete="CASCADE",
    )

    op.add_column(
        "notification_settings",
        sa.Column("workspace_id", postgresql.UUID(), nullable=True),
    )
    op.create_index("ix_notification_settings_workspace_id", "notification_settings", ["workspace_id"])

    # notification_settings.id に SERIAL を付与（既存の id=1 行を保持しつつ新規行を自動採番）
    # IF NOT EXISTS: テーブル作成時に PostgreSQL が自動生成済みの場合はスキップ
    op.execute(sa.text(
        "CREATE SEQUENCE IF NOT EXISTS notification_settings_id_seq START WITH 2 OWNED BY notification_settings.id"
    ))
    op.execute(sa.text(
        "ALTER TABLE notification_settings ALTER COLUMN id SET DEFAULT nextval('notification_settings_id_seq')"
    ))


def downgrade() -> None:
    op.execute(sa.text(
        "ALTER TABLE notification_settings ALTER COLUMN id DROP DEFAULT"
    ))
    op.execute(sa.text("DROP SEQUENCE IF EXISTS notification_settings_id_seq"))
    op.drop_index("ix_notification_settings_workspace_id", "notification_settings")
    op.drop_column("notification_settings", "workspace_id")

    op.drop_constraint("fk_dashboards_workspace_id", "dashboards", type_="foreignkey")
    op.drop_index("ix_dashboards_workspace_id", "dashboards")
    op.drop_column("dashboards", "workspace_id")

    op.drop_constraint("fk_sensors_workspace_id", "sensors", type_="foreignkey")
    op.drop_index("ix_sensors_workspace_id", "sensors")
    op.drop_column("sensors", "workspace_id")

    op.drop_index("ix_refresh_tokens_token_hash", "refresh_tokens")
    op.drop_index("ix_refresh_tokens_user_id", "refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_index("ix_workspaces_owner_id", "workspaces")
    op.drop_table("workspaces")
    op.drop_index("ix_users_email", "users")
    op.drop_table("users")
