"""直近の測定値の 1 分ごとの集計の表（readings_minute ほか）を足す

OSS 版で、グラフ・集計が、直近 7 日分の生の行（1 秒ごとなら 60 万行）を読まずに済むようにする控え。
新しい表を 3 つ作るだけで、既存の表（readings・readings_rollup など）は変えない
（Pi・本番の DB に無停止で当たる。設定 READINGS_ROLLUP_DAYS が 0 のままなら、表は空のまま使われない）。
 - readings_minute: 生の行が残っている分の、1 分ごとの集計（生から作り直せる）
 - readings_minute_state: センサーごとの「どこまで作ったか」の印
 - readings_dirty_minutes: 遅れて届いた行の (センサー・分) の記録

【downgrade】3 つの表を消す。どれも生の行から作り直せる控えなので、データは失われない
（readings_rollup のように、消えた履歴を持つ表ではない）。

Revision ID: m3b4c5d6e7f8
Revises: l2a3b4c5d6e7
Create Date: 2026-11-19 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'm3b4c5d6e7f8'
down_revision: Union[str, None] = 'l2a3b4c5d6e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'readings_minute',
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
    op.create_table(
        'readings_minute_state',
        sa.Column('sensor_id', sa.Uuid(), nullable=False),
        sa.Column('finalized_until', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column('built_until', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(['sensor_id'], ['sensors.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('sensor_id'),
    )
    op.create_table(
        'readings_dirty_minutes',
        sa.Column('sensor_id', sa.Uuid(), nullable=False),
        sa.Column('bucket_start', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(['sensor_id'], ['sensors.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('sensor_id', 'bucket_start'),
    )


def downgrade() -> None:
    # 3 つとも、生の行から作り直せる控え（履歴は失われない）
    op.drop_table('readings_dirty_minutes')
    op.drop_table('readings_minute_state')
    op.drop_table('readings_minute')
