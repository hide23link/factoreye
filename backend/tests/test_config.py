"""設定の検査: 本番で既定の秘密値のまま起動させない。"""
import pytest
from pydantic import ValidationError

from app.config import DEFAULT_SECRET, AuthMode, Settings


def _make(
    environment: str,
    auth_mode: AuthMode = AuthMode.DISABLED,
    ingest_api_key: str = DEFAULT_SECRET,
) -> Settings:
    # 開発者の .env を読まないよう、_env_file=None にする
    return Settings(
        _env_file=None,
        environment=environment,
        auth_mode=auth_mode,
        ingest_api_key=ingest_api_key,
    )


def test_production_rejects_default_ingest_key() -> None:
    with pytest.raises(ValidationError, match="INGEST_API_KEY"):
        _make(environment="production")


def test_production_multi_tenant_rejects_default_jwt_secret() -> None:
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        _make(
            environment="production",
            auth_mode=AuthMode.MULTI_TENANT,
            ingest_api_key="x" * 32,
        )


def test_production_allows_changed_secrets() -> None:
    s = _make(environment="production", ingest_api_key="x" * 32)
    assert s.ingest_api_key != DEFAULT_SECRET


def test_development_allows_default_secrets() -> None:
    assert _make(environment="development").environment == "development"


def test_environment_is_case_insensitive() -> None:
    with pytest.raises(ValidationError, match="INGEST_API_KEY"):
        _make(environment=" Production ")
