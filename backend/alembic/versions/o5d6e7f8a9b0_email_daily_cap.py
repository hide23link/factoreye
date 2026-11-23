"""メールの 1 日の送信数の上限と、運用者への通知の印を足す（SaaS 版）

 - email_tokens.mail_sent_at: 実際にメールの送信を依頼した時刻（登録されていないアドレスへの
   「送らないダミー行」は NULL）。1 日の送信数（一般の依頼だけ）を数える。既存の行は NULL のまま
   （送ったものとして数えない。反映の直後は、その日の数が 0 から始まる）
 - ops_notice_marks: 運用者への通知（上限の割合に達した・上限に達した）を、その日にもう送った印。
   （日付, 種類）が主キーで、1 日 1 回に抑える

【downgrade】2 つを消す。上限の数え方・通知の印は失われる（メール自体のデータは変わらない）。

Revision ID: o5d6e7f8a9b0
Revises: n4c5d6e7f8a9
Create Date: 2026-11-23 20:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'o5d6e7f8a9b0'
down_revision: Union[str, None] = 'n4c5d6e7f8a9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'email_tokens',
        sa.Column('mail_sent_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True),
    )
    op.create_table(
        'ops_notice_marks',
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('kind', sqlmodel.sql.sqltypes.AutoString(length=30), nullable=False),
        sa.Column('created_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=False),
        sa.PrimaryKeyConstraint('day', 'kind'),
    )


def downgrade() -> None:
    op.drop_table('ops_notice_marks')
    op.drop_column('email_tokens', 'mail_sent_at')
