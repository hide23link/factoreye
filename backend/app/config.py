"""FactorEye バックエンド設定。環境変数または .env から読み込む（.env.example 参照）。"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    environment: str = "development"
    database_url: str = "postgresql+asyncpg://factoreye:password@localhost:5432/factoreye"
    ingest_api_key: str = "change-this-in-production"
    jwt_secret: str = "change-this-in-production"
    frontend_url: str = "http://localhost:3001"

    # アラーム通知用SMTP（self-hosted運用者が自前のSMTPを指定。未設定なら送信をスキップする）
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "factoreye@localhost"
    smtp_to: str = ""
    smtp_use_tls: bool = True

    @property
    def debug(self) -> bool:
        return self.environment != "production"


settings = Settings()
