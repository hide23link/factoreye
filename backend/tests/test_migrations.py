"""alembic のマイグレーションそのもののテスト。

他のテストは SQLModel.metadata.create_all でスキーマを作るため、マイグレーションの不具合
（シード行の投入とシーケンスの食い違いなど）を検出できない。ここでは、使い捨ての空の
データベースに実際に `alembic upgrade head` をかけて確かめる。
"""
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from sqlalchemy.engine import make_url

from app.config import settings

_BACKEND_DIR = Path(__file__).resolve().parent.parent


def _alembic(url: str, *args: str) -> None:
    env = {**os.environ, "DATABASE_URL": url}
    subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=_BACKEND_DIR,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def migrated_db() -> Iterator[tuple[str, str]]:
    """空の DB を作り、head まで migrate して (asyncpg 形式の URL, psycopg 形式の URL) を返す。"""
    base = make_url(settings.database_url)
    name = f"fe_migration_test_{uuid4().hex[:12]}"
    admin_dsn = base.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(admin_dsn, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        async_url = base.set(database=name).render_as_string(hide_password=False)
        sync_url = base.set(drivername="postgresql", database=name).render_as_string(
            hide_password=False
        )
        _alembic(async_url, "upgrade", "head")
        yield async_url, sync_url
    finally:
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def _insert_settings_without_id(sync_url: str) -> int:
    """アプリ（ORM）が新しい行を作るときと同じく、id を省略して INSERT する。"""
    with psycopg.connect(sync_url, autocommit=True) as conn:
        row = conn.execute(
            "INSERT INTO notification_settings (discord_webhook_url_critical, "
            "discord_webhook_url_warning, enabled, critical_repeat_enabled, "
            "critical_repeat_interval_minutes) VALUES ('', '', true, false, 30) RETURNING id"
        ).fetchone()
    assert row is not None
    return int(row[0])


def test_notification_settings_sequence_is_past_seed_row(migrated_db: tuple[str, str]) -> None:
    # 回帰: シードの id=1 の後ろにシーケンスが進んでいないと、最初の INSERT が主キー重複になる
    _, sync_url = migrated_db
    assert _insert_settings_without_id(sync_url) == 2


def test_migrations_downgrade_and_upgrade_again(migrated_db: tuple[str, str]) -> None:
    async_url, sync_url = migrated_db
    _alembic(async_url, "downgrade", "-1")
    _alembic(async_url, "upgrade", "head")
    assert _insert_settings_without_id(sync_url) == 2


# ── lower(email) の一意インデックス（a7b8c9d0e1f2） ──────────────

_BEFORE_EMAIL_LOWER = "f6a7b8c9d0e1"


def _alembic_fail(url: str, *args: str) -> str:
    env = {**os.environ, "DATABASE_URL": url}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=_BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    return result.stderr


def _insert_user(sync_url: str, email: str) -> None:
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute("INSERT INTO users (id, email, password_hash, created_at) "
                     "VALUES (gen_random_uuid(), %s, 'x', now())", (email,))


def _index_names(sync_url: str) -> set[str]:
    with psycopg.connect(sync_url, autocommit=True) as conn:
        rows = conn.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'users'").fetchall()
    return {r[0] for r in rows}


def test_email_lower_index_upgrade_fails_on_case_duplicates(
    migrated_db: tuple[str, str],
) -> None:
    async_url, sync_url = migrated_db
    _alembic(async_url, "downgrade", _BEFORE_EMAIL_LOWER)
    assert "ix_users_email_lower" not in _index_names(sync_url)
    _insert_user(sync_url, "Dup@Example.com")
    _insert_user(sync_url, "dup@example.com")
    _insert_user(sync_url, "unique@example.com")

    stderr = _alembic_fail(async_url, "upgrade", "head")
    # どのメールが重複かが分かる。重複していないメールは出さない
    assert "Dup@Example.com" in stderr and "dup@example.com" in stderr
    assert "unique@example.com" not in stderr
    assert "ix_users_email_lower" not in _index_names(sync_url)  # 何も作られていない

    # 重複を解消すれば成功し、DB 側で大文字小文字違いの重複が拒否される
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute("DELETE FROM users WHERE email = 'Dup@Example.com'")
    _alembic(async_url, "upgrade", "head")
    assert {"ix_users_email_lower", "ix_users_email"} <= _index_names(sync_url)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _insert_user(sync_url, "DUP@example.com")


def test_email_lower_index_downgrade_drops_only_lower_index(
    migrated_db: tuple[str, str],
) -> None:
    async_url, sync_url = migrated_db
    assert {"ix_users_email_lower", "ix_users_email"} <= _index_names(sync_url)
    _alembic(async_url, "downgrade", _BEFORE_EMAIL_LOWER)
    names = _index_names(sync_url)
    assert "ix_users_email_lower" not in names
    assert "ix_users_email" in names


# ── readings の主キーを (sensor_id, recorded_at) に統合（g7b8c9d0e1f2） ──────────────


def _insert_sensor(sync_url: str) -> str:
    sensor_id = str(uuid4())
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO sensors (id, name, ingest_key, unit, enabled, created_at, updated_at, "
            "threshold_dead_band) VALUES (%s, 'テスト', %s, '℃', true, now(), now(), 0)",
            (sensor_id, uuid4().hex),
        )
    return sensor_id


def test_readings_pk_migration_keeps_all_rows_including_same_time_duplicates(
    migrated_db: tuple[str, str],
) -> None:
    async_url, sync_url = migrated_db
    # 旧スキーマ（id 主キー）へ。h8c9d0e1f2a3（機器のキー）と g7b8c9d0e1f2 を戻す
    _alembic(async_url, "downgrade", "a7b8c9d0e1f2")
    sensor_id = _insert_sensor(sync_url)
    with psycopg.connect(sync_url, autocommit=True) as conn:
        # 旧スキーマでは、同じ時刻の値を複数入れられた。id が小さい 1 行（値 1.0）は元の時刻、
        # 残り（値 2.0・4.0）は空いている時刻へずらして、すべて残る。
        # 00:00:00.000001 は別の行（値 5.0）が使っているので、飛ばして .000002・.000003 に入る
        conn.execute(
            "INSERT INTO readings (sensor_id, value, recorded_at) VALUES "
            "(%s, 1.0, '2026-10-25 00:00:00+00'), (%s, 2.0, '2026-10-25 00:00:00+00'), "
            "(%s, 3.0, '2026-10-25 00:00:01+00'), (%s, 4.0, '2026-10-25 00:00:00+00'), "
            "(%s, 5.0, '2026-10-25 00:00:00.000001+00')",
            (sensor_id, sensor_id, sensor_id, sensor_id, sensor_id),
        )

    _alembic(async_url, "upgrade", "head")
    with psycopg.connect(sync_url, autocommit=True) as conn:
        columns = [
            r[0]
            for r in conn.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'readings' ORDER BY ordinal_position"
            )
        ]
        rows = conn.execute(
            "SELECT value, to_char(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') "
            "FROM readings ORDER BY recorded_at"
        ).fetchall()
        pk = conn.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = 'readings'::regclass AND contype = 'p'"
        ).fetchone()
        index_rows = conn.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'readings'")
        indexes = [r[0] for r in index_rows]
        # 外部キーの CASCADE が残っている（センサーを消すと、測定値も消える）
        conn.execute("DELETE FROM sensors WHERE id = %s", (sensor_id,))
        remaining = conn.execute("SELECT count(*) FROM readings").fetchone()

    assert columns == ["sensor_id", "recorded_at", "value"]
    assert rows == [
        (1.0, "00:00:00.000000"),
        (5.0, "00:00:00.000001"),
        (2.0, "00:00:00.000002"),
        (4.0, "00:00:00.000003"),
        (3.0, "00:00:01.000000"),
    ]
    assert pk == ("PRIMARY KEY (sensor_id, recorded_at)",)
    assert indexes == ["readings_pkey"]  # 索引は主キーの 1 本だけ
    assert remaining == (0,)


def test_readings_pk_migration_downgrade_restores_id_and_rows(
    migrated_db: tuple[str, str],
) -> None:
    async_url, sync_url = migrated_db
    sensor_id = _insert_sensor(sync_url)
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO readings (sensor_id, value, recorded_at) VALUES "
            "(%s, 1.0, '2026-10-25 00:00:00+00'), (%s, 2.0, '2026-10-25 00:00:01+00')",
            (sensor_id, sensor_id),
        )

    _alembic(async_url, "downgrade", "a7b8c9d0e1f2")  # 旧スキーマ（id 主キー）へ
    with psycopg.connect(sync_url, autocommit=True) as conn:
        rows = conn.execute("SELECT id, value FROM readings ORDER BY id").fetchall()
        # アプリ（旧版）と同じく、id を省略して INSERT できる
        new_id = conn.execute(
            "INSERT INTO readings (sensor_id, value, recorded_at) "
            "VALUES (%s, 9.0, '2026-10-25 00:00:02+00') RETURNING id",
            (sensor_id,),
        ).fetchone()
    assert [r[1] for r in rows] == [1.0, 2.0]
    assert new_id is not None and new_id[0] > rows[-1][0]


# ── 機器の系統（i9d0e1f2a3b4）: NULL 可の列を足すだけ ─────────────

_BEFORE_DEVICE_LINE = "h8c9d0e1f2a3"


def test_device_line_migration_adds_a_nullable_column_and_keeps_existing_devices(
    migrated_db: tuple[str, str],
) -> None:
    async_url, sync_url = migrated_db
    _alembic(async_url, "downgrade", _BEFORE_DEVICE_LINE)
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO ingest_devices (id, name, key_hash, created_at) "
            "VALUES (gen_random_uuid(), 'old-device', repeat('a', 64), now())"
        )

    _alembic(async_url, "upgrade", "head")

    with psycopg.connect(sync_url, autocommit=True) as conn:
        column = conn.execute(
            "SELECT is_nullable, character_maximum_length, column_default "
            "FROM information_schema.columns "
            "WHERE table_name = 'ingest_devices' AND column_name = 'line'"
        ).fetchone()
        # NULL 可・既定なし・40 文字。既存の機器は表を書き直さずに残り、系統は NULL（系統なし）
        assert column == ("YES", 40, None)
        old = conn.execute("SELECT line FROM ingest_devices WHERE name = 'old-device'").fetchone()
        assert old == (None,)


# ── 機器のキーの目印（j0e1f2a3b4c5）: NULL 可の列を足すだけ ─────────────

_BEFORE_KEY_HINT = "i9d0e1f2a3b4"


def test_key_hint_migration_adds_a_nullable_column_and_keeps_existing_devices(
    migrated_db: tuple[str, str],
) -> None:
    async_url, sync_url = migrated_db
    _alembic(async_url, "downgrade", _BEFORE_KEY_HINT)
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO ingest_devices (id, name, key_hash, created_at) "
            "VALUES (gen_random_uuid(), 'old-device', repeat('b', 64), now())"
        )

    _alembic(async_url, "upgrade", "head")

    with psycopg.connect(sync_url, autocommit=True) as conn:
        column = conn.execute(
            "SELECT is_nullable, character_maximum_length, column_default "
            "FROM information_schema.columns "
            "WHERE table_name = 'ingest_devices' AND column_name = 'key_hint'"
        ).fetchone()
        # NULL 可・既定なし・6 文字。既存の機器は残り、目印は NULL（目印なし）
        assert column == ("YES", 6, None)
        old = conn.execute(
            "SELECT key_hint FROM ingest_devices WHERE name = 'old-device'"
        ).fetchone()
        assert old == (None,)
