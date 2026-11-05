"""設定ファイル（.env）の読み書きと検査（app/env_file.py）。"""
from pathlib import Path

import pytest

from app import env_file

SAMPLE = """# コメントは残る
INGEST_API_KEY=aaaaaaaaaaaaaaaaaaaa
INGEST_AUTH=key

ADMIN_PASSWORD_HASH='$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'
ENVIRONMENT=production
POSTGRES_PASSWORD=dbpass
"""


def test_apply_updates_changes_only_target_lines() -> None:
    result = env_file.apply_updates(SAMPLE, {"INGEST_AUTH": "off"})
    assert "INGEST_AUTH=off\n" in result
    assert result.startswith("# コメントは残る\n")
    assert "ADMIN_PASSWORD_HASH='$2b$12$" in result
    assert "POSTGRES_PASSWORD=dbpass" in result


def test_apply_updates_appends_missing_key() -> None:
    result = env_file.apply_updates(SAMPLE, {"INGEST_RATE_LIMIT": "50/minute"})
    assert result.rstrip().endswith("INGEST_RATE_LIMIT=50/minute")


def test_apply_updates_ignores_commented_key() -> None:
    result = env_file.apply_updates("#INGEST_AUTH=key\n", {"INGEST_AUTH": "off"})
    assert result == "#INGEST_AUTH=key\nINGEST_AUTH=off\n"


def test_values_in_strips_quotes_and_keeps_dollar() -> None:
    values = env_file.values_in(SAMPLE)
    assert values["ADMIN_PASSWORD_HASH"].startswith("$2b$12$")
    assert values["INGEST_AUTH"] == "key"


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("INGEST_AUTH", "of"),
        ("INGEST_API_KEY", "short"),
        ("INGEST_API_KEY", "a" * 20 + "$HOME"),
        ("INGEST_RATE_LIMIT", "100 per min"),
        ("INGEST_AUTO_CREATE", "yes"),
        ("FRONTEND_URL", "http://x y"),
        ("FRONTEND_URL", "javascript:alert(1)"),
        ("JWT_SECRET", "a" * 32),  # 画面から変えられない項目
        ("DATABASE_URL", "postgresql://x"),
    ],
)
def test_invalid_edits_rejects(key: str, value: str) -> None:
    assert env_file.invalid_edits({key: value})


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("INGEST_AUTH", "off"),
        ("INGEST_API_KEY", "a" * 32),
        ("INGEST_RATE_LIMIT", "off"),
        ("INGEST_RATE_LIMIT", "100/minute"),
        ("INGEST_CACHE_SECONDS", "2.5"),
        ("FRONTEND_URL", "http://192.168.0.20:3001"),
        ("WEBHOOK_ALLOW_PRIVATE_NETWORKS", "true"),
    ],
)
def test_invalid_edits_accepts(key: str, value: str) -> None:
    assert env_file.invalid_edits({key: value}) == []


def test_problems_in_accepts_valid_file() -> None:
    assert env_file.problems_in(SAMPLE) == []


def test_problems_in_reports_item_without_value() -> None:
    problems = env_file.problems_in(SAMPLE.replace("INGEST_AUTH=key", "INGEST_AUTH=of"))
    assert len(problems) == 1
    assert problems[0].startswith("INGEST_AUTH:")


def test_problems_in_rejects_default_key_in_production() -> None:
    text = SAMPLE.replace("aaaaaaaaaaaaaaaaaaaa", "change-this-in-production")
    problems = env_file.problems_in(text)
    assert any("INGEST_API_KEY" in line for line in problems)


def test_problems_in_ignores_compose_only_items() -> None:
    assert env_file.problems_in(SAMPLE + "FACTOREYE_PORT=3001\nPOSTGRES_PASSWORD=x\n") == []


def test_write_in_place_keeps_inode_and_makes_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = tmp_path / ".env"
    bak = tmp_path / ".env.bak"
    env.write_text("OLD=1\n")
    inode = env.stat().st_ino
    monkeypatch.setattr(env_file, "ENV_PATH", env)
    monkeypatch.setattr(env_file, "BACKUP_PATH", bak)

    env_file.write_in_place("NEW=2\n")

    assert env.read_text() == "NEW=2\n"
    assert bak.read_text() == "OLD=1\n"
    assert env.stat().st_ino == inode
