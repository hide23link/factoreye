import pytest

from recovery.config import ConfigError, load_settings

BASE = {
    "RECOVERY_PASSWORD": "x" * 12,
    "SCRATCH_DSN": "postgresql://recovery@/postgres?host=/tmp/s",
    "BACKUP_SOURCE": "/backups",
}


def test_load_minimal() -> None:
    s = load_settings(BASE)
    assert s.target_dsn is None
    assert s.username == "admin"


def test_target_accepts_backend_style_url() -> None:
    s = load_settings({**BASE, "TARGET_DATABASE_URL": "postgresql+asyncpg://u:p@postgres/db"})
    assert s.target_dsn == "postgresql://u:p@postgres/db"


@pytest.mark.parametrize("missing", ["RECOVERY_PASSWORD", "SCRATCH_DSN", "BACKUP_SOURCE"])
def test_required(missing: str) -> None:
    env = {k: v for k, v in BASE.items() if k != missing}
    with pytest.raises(ConfigError):
        load_settings(env)


def test_short_password_rejected() -> None:
    with pytest.raises(ConfigError):
        load_settings({**BASE, "RECOVERY_PASSWORD": "short"})


def test_write_requires_mode() -> None:
    env = {**BASE, "TARGET_DATABASE_URL": "postgresql://u@h/db",
           "TARGET_WRITE_DATABASE_URL": "postgresql://u@h/db"}
    with pytest.raises(ConfigError, match="TARGET_MODE"):
        load_settings(env)
    assert load_settings({**env, "TARGET_MODE": "SaaS"}).target_mode == "saas"
    with pytest.raises(ConfigError):
        load_settings({**env, "TARGET_MODE": "cloud"})


def test_handoff_source_is_optional() -> None:
    assert load_settings(BASE).handoff_source is None
    s = load_settings({**BASE, "HANDOFF_SOURCE": "s3://factoreye-backup/handoff-inc"})
    assert s.handoff_source == "s3://factoreye-backup/handoff-inc"
