"""readings の主キーを (sensor_id, recorded_at) に統合し、id 列を廃止する

測定値は「どのセンサーの、いつの値か」で決まる。連番の id と、時系列範囲検索用の索引
（ix_reading_sensor_recorded）を別々に持つのをやめ、主キーの索引 1 本で兼ねる。
実測（10 センサー・5 秒間隔・200 万行）で、1 行あたり 161 B が 101 B（約 4 割減）、
500 万行の書き込みは 8.3 秒が 5.6 秒、検索の速さは同等だった。

データは新しいテーブルへ写す。同じ (sensor_id, recorded_at) の行が複数あれば、id が小さい
1 行だけを残す（これまでは、1 回の送信内の複数の値が同じ時刻で入っていた。以後は取り込みが
マイクロ秒ずつずらして一意にする）。

downgrade は id 列と旧索引を戻す。id は、時刻順に振り直す。

【実行するときの注意】
- 稼働中のアプリがあるときは実行しない（アプリを止めてから行う）。旧テーブルをコピーして
  置き換えるため、コピー中に旧アプリが書いた行は残らない。先頭で書き込みを止める
  （SHARE モードのロック）ので、書き込もうとしたアプリは終わるまで待たされる。
- 一時的に、旧テーブルと新テーブルの両方が要る。目安は、readings の約 1.6 倍の空きと、
  その分の WAL（実測: 500 万行・10 センサーで 13 秒、766 MB → 481 MB。1 億行などは未測定）。
- 終わったら ANALYZE を実行する（新しいテーブルには統計が無いため）。

Revision ID: g7b8c9d0e1f2
Revises: a7b8c9d0e1f2
Create Date: 2026-10-25 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "g7b8c9d0e1f2"
down_revision: Union[str, None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # コピー中に旧アプリが書いた行が、置き換えで消えないよう、読み取りだけを許してロックする
    op.execute("LOCK TABLE readings IN SHARE MODE")
    op.create_table(
        "readings_new",
        sa.Column("sensor_id", sa.Uuid(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.ForeignKeyConstraint(["sensor_id"], ["sensors.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("sensor_id", "recorded_at"),
    )
    # 古い順に写す（主キーの索引が、ほぼ末尾への追加になり、速い）
    op.execute(
        "INSERT INTO readings_new (sensor_id, recorded_at, value) "
        "SELECT DISTINCT ON (sensor_id, recorded_at) sensor_id, recorded_at, value "
        "FROM readings ORDER BY sensor_id, recorded_at, id"
    )
    op.drop_table("readings")  # 索引 ix_reading_sensor_recorded と id の連番も一緒に消える
    op.rename_table("readings_new", "readings")
    # テーブルの名前を変えても、制約の名前は readings_new_* のまま残るので、付け替える
    op.execute("ALTER TABLE readings RENAME CONSTRAINT readings_new_pkey TO readings_pkey")
    op.execute(
        "ALTER TABLE readings RENAME CONSTRAINT readings_new_sensor_id_fkey "
        "TO readings_sensor_id_fkey"
    )
    op.execute("ANALYZE readings")


def downgrade() -> None:
    op.execute("LOCK TABLE readings IN SHARE MODE")
    op.create_table(
        "readings_old",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("sensor_id", sa.Uuid(), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["sensor_id"], ["sensors.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(
        "INSERT INTO readings_old (sensor_id, value, recorded_at) "
        "SELECT sensor_id, value, recorded_at FROM readings ORDER BY recorded_at, sensor_id"
    )
    op.drop_table("readings")
    op.rename_table("readings_old", "readings")
    op.execute("ALTER TABLE readings RENAME CONSTRAINT readings_old_pkey TO readings_pkey")
    op.execute(
        "ALTER TABLE readings RENAME CONSTRAINT readings_old_sensor_id_fkey "
        "TO readings_sensor_id_fkey"
    )
    op.create_index(
        "ix_reading_sensor_recorded", "readings", ["sensor_id", "recorded_at"], unique=False
    )
