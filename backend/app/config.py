"""FactorEye バックエンド設定。環境変数または .env から読み込む（.env.example 参照）。"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    environment: str = "development"
    database_url: str = "postgresql+asyncpg://factoreye:password@localhost:5432/factoreye"
    ingest_api_key: str = "change-this-in-production"
    jwt_secret: str = "change-this-in-production"
    frontend_url: str = "http://localhost:3001"

    @property
    def debug(self) -> bool:
        return self.environment != "production"


settings = Settings()
