"""古い測定値を 1 分ごとにまとめる表（readings_rollup）を足す

OSS 版で、設定 READINGS_ROLLUP_DAYS より古い 1 秒ごとの測定値を、1 分ごとの件数・合計・最小・最大・
最後の値にまとめて持つ表。新しい表を作るだけで、既存の表（readings など）は変えない
（Pi・本番の DB に無停止で当たる。設定が 0 のままなら、表は空のまま使われない）。

【downgrade の注意】downgrade は readings_rollup を表ごと消す。ロールアップを実行したあとは、
設定の日数より古い履歴（生の行は消えていて、この表にしか無い）が失われる。戻す前に必ず
DB のバックアップ（pg_dump・WAL-G）を取ること。ロールアップを一度も実行していなければ、
失われるものは無い。

Revision ID: l2a3b4c5d6e7
Revises: k1f2a3b4c5d6
Create Date: 2026-11-19 10:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'l2a3b4c5d6e7'
down_revision: Union[str, None] = 'k1f2a3b4c5d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'readings_rollup',
        sa.Column('sensor_id', sa.Uuid(), nullable=False),
        sa.Column('bucket_start', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column('count', sa.Integer(), nullable=False),
        sa.Column('sum', sa.Float(), nullable=False),
        sa.Column('min', sa.Float(), nullable=False),
        sa.Column('max', sa.Float(), nullable=False),
        sa.Column('last_value', sa.Float(), nullable=False),
        sa.Column('last_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(['sensor_id'], ['sensors.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('sensor_id', 'bucket_start'),
    )


def downgrade() -> None:
    # 注意: ロールアップ後は、7 日より古い履歴（この表にしか無い）がここで消える。先にバックアップ
    op.drop_table('readings_rollup')
