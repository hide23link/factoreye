"""機器（ingest_devices）に、キーの目印（key_hint）を足す

どの機器のキーかを画面で見分けるための、キーの先頭 6 文字。NULL 可・既定なしの列を足すだけ
（PostgreSQL では、表を書き直さない即時の変更。ingest_devices は数百行以下で、ロックは一瞬）。
キーそのものは保存していない（ハッシュだけ）ので、既存の機器の目印は作れず、NULL のまま。

Revision ID: j0e1f2a3b4c5
Revises: i9d0e1f2a3b4
Create Date: 2026-11-05 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'j0e1f2a3b4c5'
down_revision: Union[str, None] = 'i9d0e1f2a3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'ingest_devices',
        sa.Column('key_hint', sqlmodel.sql.sqltypes.AutoString(length=6), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('ingest_devices', 'key_hint')
