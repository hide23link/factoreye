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
    # 管理者トークンはリフレッシュ不可（期限切れ後は再ログイン）。通常ユーザーより短く保つ
    admin_access_expire_minutes: int = 60
    # 管理者アカウントのテキストファイル（ID:bcryptハッシュ）。
    # 本番は docker-compose の volumes でホストの ./admin を差し込む
    admin_credentials_file: str = "admin/admins.txt"
    # 取り込み API のIP別レート制限。負荷テスト（1台から多数センサーを送る）でのみ緩める
    ingest_rate_limit: str = "100/minute"

    @property
    def debug(self) -> bool:
        return self.environment != "production"


settings = Settings()
