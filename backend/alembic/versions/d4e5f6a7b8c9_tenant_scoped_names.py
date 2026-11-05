"""センサー名・通知設定をワークスペース単位にする（マルチテナントの不具合修正）

- sensors.name: DB全体でユニーク → ワークスペース内でユニーク（self-hosted は NULL 用の部分インデックス）
- notification_settings: ワークスペースごとに1行まで（部分ユニークインデックス）
- sensors.ingest_key は取り込みAPIがキーだけでセンサーを特定するため、グローバルユニークのまま

downgrade: ワークスペースをまたいで同名のセンサーがあると、元の全体ユニーク制約を作り直せず失敗する。

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-10-04 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("sensors_name_key", "sensors", type_="unique")
    op.create_index(
        "uq_sensors_name_self_hosted",
        "sensors",
        ["name"],
        unique=True,
        postgresql_where=sa.text("workspace_id IS NULL"),
    )
    op.create_index(
        "uq_sensors_workspace_name",
        "sensors",
        ["workspace_id", "name"],
        unique=True,
        postgresql_where=sa.text("workspace_id IS NOT NULL"),
    )
    op.create_index(
        "uq_notification_settings_workspace",
        "notification_settings",
        ["workspace_id"],
        unique=True,
        postgresql_where=sa.text("workspace_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_notification_settings_workspace", table_name="notification_settings")
    op.drop_index("uq_sensors_workspace_name", table_name="sensors")
    op.drop_index("uq_sensors_name_self_hosted", table_name="sensors")
    op.create_unique_constraint("sensors_name_key", "sensors", ["name"])
