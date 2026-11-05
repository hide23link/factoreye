"""notification_settings の id のシーケンスを、投入済みの行の後ろへ進める

マイグレーション 9755456bc184 は id=1 の行を明示的に INSERT するが、シーケンス
（notification_settings_id_seq）は進めていない。そのため、マイグレーションで作った DB では、
次の INSERT（id 省略）の nextval が 1 になり、主キー重複で失敗していた
（新しいワークスペースの通知設定の、最初の作成が 500 になる）。

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-10-11 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 次の nextval が、「既存の最大 id + 1」と「今のシーケンスの次の値」の大きいほうになるようにする
    # （すでに進んでいるシーケンスは戻さない）。is_called=false は、設定した値そのものを次に返す
    op.execute(
        """
        SELECT setval(
            'notification_settings_id_seq',
            GREATEST(
                COALESCE((SELECT max(id) FROM notification_settings), 0) + 1,
                (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END
                 FROM notification_settings_id_seq)
            ),
            false
        )
        """
    )


def downgrade() -> None:
    # シーケンスの位置は戻さない（戻すと、再び主キー重複を起こすため）
    pass
