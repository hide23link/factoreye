"""FactorEye バックエンド設定。環境変数または .env から読み込む（.env.example 参照）。

使い方: 各項目は、同じ名前の環境変数（大文字、例: database_url → DATABASE_URL）で上書きできる。
値は起動時に1回だけ読まれ、`settings` という1つのオブジェクトとして全体で共有される。

【誰が使うか】他のファイルが `from app.config import settings` と書いて、`settings.database_url`
のように読む。設定を変えるには、環境変数（docker-compose.yml の environment や .env）を変える。
"""
from enum import StrEnum

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 配布物に書かれている既定の秘密値（本番では使えない）
DEFAULT_SECRET = "change-this-in-production"


def is_placeholder_secret(value: str) -> bool:
    """配布物のひな形の値（change-this-... や CHANGE_ME_...）か空かどうか。大小文字は区別しない。"""
    text = value.strip().lower()
    return text == "" or text.startswith(("change-this", "change_me", "change-me"))


class AuthMode(StrEnum):
    """認証の動作モード。環境変数 AUTH_MODE で切り替える。

    self-hosted（disabled）と SaaS（multi_tenant）で、API の公開範囲や、データの分け方が変わる。
    """

    # self-hosted デフォルト: 認証なし（Phase 0 互換）
    DISABLED = "disabled"
    # クラウド版: JWT 必須、ワークスペース別データ分離
    MULTI_TENANT = "multi_tenant"


class IngestAuth(StrEnum):
    """self-hosted（AUTH_MODE=disabled）の取り込みの認証。環境変数 INGEST_AUTH で切り替える。

    SaaS（multi_tenant）では使わない（もともとヘッダー認証がなく、本文の ingestKey で識別する）。
    """

    # 既定: X-API-Key ヘッダーを INGEST_API_KEY と比べる（違えば 401）
    KEY = "key"
    # キーなしで受け付ける。誰でも、センサーの ingestKey を知っていれば値を書ける。
    # 取り込みの口を LAN などに限定した上で使う（機器にキーを入れない運用向け）
    OFF = "off"


class Settings(BaseSettings):
    """設定の一覧。型が違う値（例: 数値の項目に文字列）は、起動時にエラーになる。"""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # 実行環境。"production" 以外（既定は development）では、
    # API の仕様書（/docs）と SQL のログを出す
    environment: str = "development"
    # PostgreSQL の接続先。形式: postgresql+asyncpg://ユーザー:パスワード@ホスト:ポート/DB名
    database_url: str = "postgresql+asyncpg://factoreye:password@localhost:5432/factoreye"
    # self-hosted の取り込み用の共有キー（X-API-Key ヘッダーと比べる）。本番では必ず変える
    ingest_api_key: str = DEFAULT_SECRET
    # 取り込みの認証（IngestAuth を参照）。"off" にするとキーなしで受け付ける。既定は "key"
    ingest_auth: IngestAuth = IngestAuth.KEY
    # JWT（ログインのトークン）の署名に使う秘密の値。SaaS 版では必ず長い乱数に変える
    jwt_secret: str = DEFAULT_SECRET
    # 画面のアドレス。CORS で、この1つだけを許可する（ほかのサイトからの API 呼び出しを防ぐ）
    frontend_url: str = "http://localhost:3001"

    # 認証モード（AuthMode を参照）。既定は self-hosted（認証なし）
    auth_mode: AuthMode = AuthMode.DISABLED
    # アクセストークンの有効期限（分）。短いほど安全だが、再ログインが増える
    jwt_access_expire_minutes: int = 15
    # リフレッシュトークンの有効期限（日）。これを過ぎると、再ログインが必要になる
    jwt_refresh_expire_days: int = 30
    # 管理者トークンはリフレッシュ不可（期限切れ後は再ログイン）。通常ユーザーより短く保つ
    admin_access_expire_minutes: int = 60
    # 管理者が利用者として閲覧するときのトークンの有効期限（分）。リフレッシュ不可。短く保つ
    impersonation_expire_minutes: int = 15
    # 管理者アカウントのテキストファイル（ID:bcryptハッシュ）。
    # 本番は docker-compose の volumes でホストの ./admin を差し込む
    admin_credentials_file: str = "admin/admins.txt"
    # 管理画面の「書き戻し」（控えが稼いだデータを本番に足す）が呼ぶ、復旧ツール（tools/recovery）の
    # 内部アドレスと Basic 認証。復旧ツールの RECOVERY_USERNAME / RECOVERY_PASSWORD と同じ値にする。
    # パスワードは .env にだけ置き、ログ・画面に出さない。url か password が空なら、機能は使えない
    failback_recovery_url: str = "http://recovery:8090"
    failback_recovery_username: str = "admin"
    failback_recovery_password: SecretStr = SecretStr("")
    # 復旧ツールの応答を待つ秒数（引き継ぎの取得・展開・試算を含むため長めにする）
    failback_timeout_seconds: float = Field(default=600, gt=0, le=900)
    # 取り込みのIP別レート制限（例: 100/minute）。"off" で解除（実機・負荷テスト用）
    ingest_rate_limit: str = "100/minute"
    # 未登録の ingestKey が来たとき、センサーを自動で作る（self-hosted だけ。SaaS では使えない）。
    # 既定は off（打ち間違いの ID が、黙ってゴミのセンサーを作らないため）。on にすると、
    # 機器がセンサーを画面で登録しなくても、送り始められる
    ingest_auto_create: bool = False
    # 自動で作ってよいセンサーの上限（センサー全体の数）。
    # LAN の誰かに大量に作られて、一覧が埋まるのを防ぐ
    ingest_auto_create_max_sensors: int = Field(default=100, ge=1, le=10000)
    # 機器が本文に付けた測定時刻（timestamp）を、測定値の時刻にする（self-hosted だけ）。
    # 既定は off（従来どおり、サーバーの受信時刻を使い、timestamp は無視する）。
    # on にすると、timestamp を付けた値は、その時刻で保存する（付けない値は、受信時刻のまま）。
    # 機器の時計が NTP などで合っていることが前提。1 秒サンプリングを溜めてまとめ送りする使い方向け
    ingest_device_time: bool = False
    # Webhook送信先に社内ネットワーク（プライベートIP・http）を許可する。既定は禁止（SSRF対策）。
    # 社内LANの自動化基盤（n8n等）へ送る自己ホスト利用者だけ true にする
    webhook_allow_private_networks: bool = False

    @field_validator("environment")
    @classmethod
    def _normalize_environment(cls, value: str) -> str:
        """"Production" や前後の空白で、本番の判定をすり抜けないよう、小文字にそろえる。"""
        return value.strip().lower()

    @field_validator("ingest_auth", mode="before")
    @classmethod
    def _normalize_ingest_auth(cls, value: object) -> object:
        """"OFF" や前後の空白でも設定が通るよう、小文字にそろえる（誤字は起動時にエラー）。"""
        return value.strip().lower() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _reject_default_secrets_in_production(self) -> "Settings":
        """本番（ENVIRONMENT=production）で、公開されている既定の秘密値のまま起動させない。

        INGEST_API_KEY は self-hosted（disabled）で、JWT_SECRET は SaaS（multi_tenant）で使う。
        使わない側の値は検査しない（片方だけ変えた既存の構成を壊さないため）。
        INGEST_AUTH=off のときは、INGEST_API_KEY を使わないので検査しない。
        """
        if self.environment != "production":
            return self
        if self.auth_mode == AuthMode.MULTI_TENANT:
            used, name = self.jwt_secret, "JWT_SECRET"
        elif self.ingest_auth == IngestAuth.OFF:
            return self
        else:
            used, name = self.ingest_api_key, "INGEST_API_KEY"
        if is_placeholder_secret(used):
            raise ValueError(
                f"{name} が既定値（または CHANGE_ME などのひな形の値）のままです。"
                "ENVIRONMENT=production では必ず変更してください"
            )
        return self

    @property
    def ingest_auto_create_active(self) -> bool:
        """未登録の ingestKey のセンサーを、自動で作るか。
        self-hosted で INGEST_AUTO_CREATE=on のときだけ True。

        SaaS では、ingestKey だけでは、どのワークスペースに作るかが決まらないので、
        使えない（常に False）。
        """
        return self.ingest_auto_create and self.auth_mode != AuthMode.MULTI_TENANT

    @property
    def ingest_device_time_active(self) -> bool:
        """測定時刻を機器のものにするか。self-hosted で INGEST_DEVICE_TIME=on のときだけ True。

        SaaS では、他の利用者の機器の時計を信用できないので、使えない（常に False）。
        """
        return self.ingest_device_time and self.auth_mode != AuthMode.MULTI_TENANT

    @property
    def ingest_requires_key(self) -> bool:
        """取り込みで X-API-Key を確かめるか。self-hosted で INGEST_AUTH=key のときだけ True。"""
        return self.auth_mode != AuthMode.MULTI_TENANT and self.ingest_auth == IngestAuth.KEY

    @property
    def debug(self) -> bool:
        """開発用の表示（API の仕様書、SQL のログ）を出すかどうか。production 以外で True。"""
        return self.environment != "production"


# アプリ全体で使う設定の実体。import するだけで、環境変数（と .env）から読み込まれる
settings = Settings()
