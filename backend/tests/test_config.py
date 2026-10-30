"""設定の検査: 本番で既定の秘密値のまま起動させない。"""
import pytest
from pydantic import ValidationError

from app.config import DEFAULT_SECRET, AuthMode, IngestAuth, Settings


def _make(
    environment: str,
    auth_mode: AuthMode = AuthMode.DISABLED,
    ingest_api_key: str = DEFAULT_SECRET,
    ingest_auth: str | IngestAuth = IngestAuth.KEY,
) -> Settings:
    # 開発者の .env を読まないよう、_env_file=None にする
    return Settings(
        _env_file=None,
        environment=environment,
        auth_mode=auth_mode,
        ingest_api_key=ingest_api_key,
        ingest_auth=ingest_auth,
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


@pytest.mark.parametrize(
    "placeholder",
    ["CHANGE_ME_STRONG_RANDOM_KEY", "change_me_x", "Change-This-Please", "", "  "],
)
def test_production_rejects_placeholder_ingest_key(placeholder: str) -> None:
    with pytest.raises(ValidationError, match="INGEST_API_KEY"):
        _make(environment="production", ingest_api_key=placeholder)


def test_production_multi_tenant_rejects_placeholder_jwt_secret() -> None:
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        Settings(
            _env_file=None,
            environment="production",
            auth_mode=AuthMode.MULTI_TENANT,
            ingest_api_key="x" * 32,
            jwt_secret="CHANGE_ME_STRONG_RANDOM_SECRET",
        )


# ---- INGEST_AUTH ----


def test_ingest_auth_defaults_to_key() -> None:
    s = _make(environment="development")
    assert s.ingest_auth == IngestAuth.KEY
    assert s.ingest_requires_key


def test_ingest_auth_off_skips_key_check_in_production() -> None:
    """キーなしにしたときは、INGEST_API_KEY が既定値でも本番で起動できる（キーを使わないため）。"""
    s = _make(environment="production", ingest_auth=IngestAuth.OFF)
    assert not s.ingest_requires_key


def test_production_still_rejects_default_key_when_auth_is_key() -> None:
    with pytest.raises(ValidationError, match="INGEST_API_KEY"):
        _make(environment="production", ingest_auth=IngestAuth.KEY)


def test_ingest_auth_is_case_insensitive() -> None:
    assert _make(environment="development", ingest_auth=" OFF ").ingest_auth == IngestAuth.OFF


def test_ingest_auth_rejects_typos() -> None:
    """"of" などの誤字は、黙ってキーなし（または既定）にせず、起動時にエラーにする。"""
    with pytest.raises(ValidationError):
        _make(environment="development", ingest_auth="of")


def test_multi_tenant_never_requires_key_header() -> None:
    s = _make(
        environment="development", auth_mode=AuthMode.MULTI_TENANT, ingest_auth=IngestAuth.KEY
    )
    assert not s.ingest_requires_key


def test_multi_tenant_production_still_checks_jwt_secret_with_ingest_auth_off() -> None:
    """INGEST_AUTH=off は SaaS の JWT_SECRET の検査を弱めない。"""
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        _make(
            environment="production",
            auth_mode=AuthMode.MULTI_TENANT,
            ingest_auth=IngestAuth.OFF,
        )


def test_ingest_auth_is_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """環境変数 INGEST_AUTH から読める（docker-compose の environment はこの経路）。"""
    monkeypatch.setenv("INGEST_AUTH", "off")
    assert Settings(_env_file=None).ingest_auth == IngestAuth.OFF


def test_empty_ingest_auth_is_an_error_not_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """空の値を黙って off（または既定）にしない（docker-compose の既定 key は別経路）。"""
    monkeypatch.setenv("INGEST_AUTH", "")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


# ---- INGEST_AUTO_CREATE ----


def test_auto_create_is_off_by_default() -> None:
    s = _make(environment="development")
    assert not s.ingest_auto_create and not s.ingest_auto_create_active
    assert s.ingest_auto_create_max_sensors == 100


def test_auto_create_is_active_only_for_self_hosted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INGEST_AUTO_CREATE", "true")
    assert Settings(_env_file=None).ingest_auto_create_active
    monkeypatch.setenv("AUTH_MODE", "multi_tenant")
    assert not Settings(_env_file=None).ingest_auto_create_active  # SaaS では使えない


@pytest.mark.parametrize("bad", ["0", "-1", "10001", "abc"])
def test_auto_create_max_sensors_must_be_in_range(
    monkeypatch: pytest.MonkeyPatch, bad: str
) -> None:
    monkeypatch.setenv("INGEST_AUTO_CREATE_MAX_SENSORS", bad)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


# ---- INGEST_DEVICE_TIME ----


def test_device_time_is_off_by_default() -> None:
    s = _make(environment="development")
    assert not s.ingest_device_time and not s.ingest_device_time_active


def test_device_time_is_active_only_for_self_hosted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INGEST_DEVICE_TIME", "true")
    assert Settings(_env_file=None).ingest_device_time_active
    monkeypatch.setenv("AUTH_MODE", "multi_tenant")
    assert not Settings(_env_file=None).ingest_device_time_active  # SaaS では使えない
