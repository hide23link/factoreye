"""add alarm severity and two-tier thresholds, notification settings

Revision ID: 9755456bc184
Revises: 532b37a49a1d
Create Date: 2026-10-02 11:20:49.466019

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = '9755456bc184'
down_revision: Union[str, None] = '532b37a49a1d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('notification_settings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('discord_webhook_url_critical', sqlmodel.sql.sqltypes.AutoString(length=500), nullable=False),
    sa.Column('discord_webhook_url_warning', sqlmodel.sql.sqltypes.AutoString(length=500), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('critical_repeat_enabled', sa.Boolean(), nullable=False),
    sa.Column('critical_repeat_interval_minutes', sa.Integer(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    # シングルトン行（id=1固定）を1件だけ投入。Webhook URLは旧.envの値を知らないため
    # 空文字で開始（Settings画面から設定し直す運用、2026-10-02にEmail→Discordへ変更した際の
    # 環境変数はこの移行で廃止）。重故障・軽故障で別チャンネルに送り分けられるようURLを2つ持つ。
    # 重故障の再通知はデフォルト無効（間隔30分、UIから変更可能）
    op.execute(
        "INSERT INTO notification_settings "
        "(id, discord_webhook_url_critical, discord_webhook_url_warning, enabled, "
        "critical_repeat_enabled, critical_repeat_interval_minutes) "
        "VALUES (1, '', '', true, false, 30)"
    )

    # op.add_columnはcreate_tableと違ってEnum型を自動作成しないため、先に明示的に作成する
    alarm_severity = sa.Enum('WARNING', 'CRITICAL', name='alarmseverity')
    alarm_severity.create(op.get_bind(), checkfirst=True)

    # severityはbackfillが必要なためserver_defaultを付けて追加し、既存行に値を入れた後に外す
    # （旧仕様は単一閾値=重故障相当の挙動だったため、既存アラームは全て'CRITICAL'とする）
    op.add_column(
        'alarms',
        sa.Column(
            'severity',
            alarm_severity,
            nullable=False,
            server_default='CRITICAL',
        ),
    )
    op.alter_column('alarms', 'severity', server_default=None)
    op.add_column('alarms', sa.Column('last_notified_at', sqlmodel.sql.sqltypes.UTCDateTime(), nullable=True))

    op.add_column('sensors', sa.Column('threshold_min_warning', sa.Float(), nullable=True))
    op.add_column('sensors', sa.Column('threshold_min_critical', sa.Float(), nullable=True))
    op.add_column('sensors', sa.Column('threshold_max_warning', sa.Float(), nullable=True))
    op.add_column('sensors', sa.Column('threshold_max_critical', sa.Float(), nullable=True))
    # 旧threshold_min/threshold_maxは単一閾値（重故障相当）として運用されていたため、
    # 値を失わないようcriticalカラムへコピーしてから旧カラムを削除する
    op.execute(
        "UPDATE sensors SET threshold_min_critical = threshold_min, "
        "threshold_max_critical = threshold_max"
    )
    op.add_column(
        'sensors', sa.Column('threshold_dead_band', sa.Float(), nullable=False, server_default='0')
    )
    op.alter_column('sensors', 'threshold_dead_band', server_default=None)
    op.drop_column('sensors', 'threshold_min')
    op.drop_column('sensors', 'threshold_max')


def downgrade() -> None:
    op.add_column('sensors', sa.Column('threshold_max', sa.DOUBLE_PRECISION(precision=53), autoincrement=False, nullable=True))
    op.add_column('sensors', sa.Column('threshold_min', sa.DOUBLE_PRECISION(precision=53), autoincrement=False, nullable=True))
    op.execute(
        "UPDATE sensors SET threshold_min = threshold_min_critical, "
        "threshold_max = threshold_max_critical"
    )
    op.drop_column('sensors', 'threshold_dead_band')
    op.drop_column('sensors', 'threshold_max_critical')
    op.drop_column('sensors', 'threshold_max_warning')
    op.drop_column('sensors', 'threshold_min_critical')
    op.drop_column('sensors', 'threshold_min_warning')
    op.drop_column('alarms', 'last_notified_at')
    op.drop_column('alarms', 'severity')
    op.execute('DROP TYPE alarmseverity')
    op.drop_table('notification_settings')
