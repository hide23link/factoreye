"""機器（ingest_devices）に、任意の「系統」（line）を足す

画面のセンサー棚が、機器を「系統 › 機器」に分けて見せるための項目。NULL 可・既定なしの列を足すだけ
（PostgreSQL では、表を書き直さない即時の変更。ingest_devices は数百行以下で、ロックは一瞬）。
既存の機器は NULL のまま（系統なし）。

Revision ID: i9d0e1f2a3b4
Revises: h8c9d0e1f2a3
Create Date: 2026-10-31 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'i9d0e1f2a3b4'
down_revision: Union[str, None] = 'h8c9d0e1f2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'ingest_devices',
        sa.Column('line', sqlmodel.sql.sqltypes.AutoString(length=40), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('ingest_devices', 'line')
