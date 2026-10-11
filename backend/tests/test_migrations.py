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
