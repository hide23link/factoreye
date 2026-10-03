"""FactorEye バックエンド設定。環境変数または .env から読み込む（.env.example 参照）。"""
from enum import StrEnum

from pydantic_settings import BaseSettings, SettingsConfigDict


class AuthMode(StrEnum):
    # self-hosted デフォルト: 認証なし（Phase 0 互換）
    DISABLED = "disabled"
    # クラウド版: JWT 必須、ワークスペース別データ分離
    MULTI_TENANT = "multi_tenant"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    environment: str = "development"
    database_url: str = "postgresql+asyncpg://factoreye:password@localhost:5432/factoreye"
    ingest_api_key: str = "change-this-in-production"
    jwt_secret: str = "change-this-in-production"
    frontend_url: str = "http://localhost:3001"

    auth_mode: AuthMode = AuthMode.DISABLED
    jwt_access_expire_minutes: int = 15
    jwt_refresh_expire_days: int = 30

    @property
    def debug(self) -> bool:
        return self.environment != "production"


settings = Settings()
