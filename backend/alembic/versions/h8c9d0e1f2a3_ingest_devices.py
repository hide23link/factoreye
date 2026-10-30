"""機器ごとのキー（ingest_devices）と、センサーの所属の機器（sensors.device_id）を足す

機器（現場の 1 台）ごとにキーを持ち、自分のセンサーにだけ送れるようにする（自前ホスト）。
キーはハッシュで保存する。既存のセンサーは device_id が NULL のまま（従来どおり）。

Revision ID: h8c9d0e1f2a3
Revises: g7b8c9d0e1f2
Create Date: 2026-10-30 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'h8c9d0e1f2a3'
down_revision: Union[str, None] = 'g7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ingest_devices',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('name', sqlmodel.sql.sqltypes.AutoString(length=100), nullable=False),
        sa.Column('key_hash', sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column('created_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.Column('revoked_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_ingest_devices_name'), 'ingest_devices', ['name'], unique=True)
    op.create_index(op.f('ix_ingest_devices_key_hash'), 'ingest_devices', ['key_hash'], unique=True)
    op.add_column('sensors', sa.Column('device_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_sensors_device_id'), 'sensors', ['device_id'], unique=False)
    op.create_foreign_key(
        'sensors_device_id_fkey', 'sensors', 'ingest_devices', ['device_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('sensors_device_id_fkey', 'sensors', type_='foreignkey')
    op.drop_index(op.f('ix_sensors_device_id'), table_name='sensors')
    op.drop_column('sensors', 'device_id')
    op.drop_index(op.f('ix_ingest_devices_key_hash'), table_name='ingest_devices')
    op.drop_index(op.f('ix_ingest_devices_name'), table_name='ingest_devices')
    op.drop_table('ingest_devices')
