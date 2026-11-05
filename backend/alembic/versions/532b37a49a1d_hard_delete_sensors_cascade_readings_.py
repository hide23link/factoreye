"""hard delete sensors, cascade readings/alarms, null widget refs

Revision ID: 532b37a49a1d
Revises: 6b7a78fbdec9
Create Date: 2026-10-02 08:58:45.643668

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '532b37a49a1d'
down_revision: Union[str, None] = '6b7a78fbdec9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # センサー削除（DELETE FROM sensors）を物理削除に変更するため、関連テーブルのFKに
    # ondeleteを設定する。readings/alarmsはCASCADE（センサーと運命を共にする）、
    # widgetsはSET NULL（ウィジェット自体は残し、センサーの紐付けだけ外す）
    op.drop_constraint('alarms_sensor_id_fkey', 'alarms', type_='foreignkey')
    op.create_foreign_key(
        'alarms_sensor_id_fkey', 'alarms', 'sensors', ['sensor_id'], ['id'], ondelete='CASCADE'
    )
    op.drop_constraint('readings_sensor_id_fkey', 'readings', type_='foreignkey')
    op.create_foreign_key(
        'readings_sensor_id_fkey', 'readings', 'sensors', ['sensor_id'], ['id'], ondelete='CASCADE'
    )
    op.drop_constraint('widgets_sensor_id_fkey', 'widgets', type_='foreignkey')
    op.create_foreign_key(
        'widgets_sensor_id_fkey', 'widgets', 'sensors', ['sensor_id'], ['id'], ondelete='SET NULL'
    )

    # soft-delete廃止（旧deleted_atカラムはもう使わない）
    op.drop_index(op.f('ix_sensors_deleted_at'), table_name='sensors')
    op.drop_column('sensors', 'deleted_at')


def downgrade() -> None:
    op.add_column(
        'sensors',
        sa.Column('deleted_at', postgresql.TIMESTAMP(timezone=True), autoincrement=False, nullable=True),
    )
    op.create_index(op.f('ix_sensors_deleted_at'), 'sensors', ['deleted_at'], unique=False)

    op.drop_constraint('widgets_sensor_id_fkey', 'widgets', type_='foreignkey')
    op.create_foreign_key('widgets_sensor_id_fkey', 'widgets', 'sensors', ['sensor_id'], ['id'])
    op.drop_constraint('readings_sensor_id_fkey', 'readings', type_='foreignkey')
    op.create_foreign_key('readings_sensor_id_fkey', 'readings', 'sensors', ['sensor_id'], ['id'])
    op.drop_constraint('alarms_sensor_id_fkey', 'alarms', type_='foreignkey')
    op.create_foreign_key('alarms_sensor_id_fkey', 'alarms', 'sensors', ['sensor_id'], ['id'])
