"""
FactorEye データモデル

仕様: docs/architecture.md §3 データモデル 参照
(ecopower command-centerリポジトリ: https://github.com/ecopower/ecopower)

Phase 0:  Sensor / Reading / Alarm / Dashboard / Widget
Phase 0.5: User / Workspace / RefreshToken（AUTH_MODE=multi_tenant 時に使用）
Phase 1: WebhookSubscription（Pluginシステムを廃止し、拡張はWebhookに統一。Phase 2参照）
"""
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Column, Index, column, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Relationship, SQLModel


def _utcnow() -> datetime:
    return datetime.now(UTC)


class AlarmStatus(StrEnum):
    """アラームの状態。発生中（active）→ 確認済み（acknowledged）→ 解除（resolved）と進む。"""

    ACTIVE = "active"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class ThresholdBreached(StrEnum):
    """どちら側のしきい値を超えたか。下限（min）か上限（max）。"""

    MIN = "min"
    MAX = "max"


class AlarmSeverity(StrEnum):
    """アラームの重要度（2段階）。通知の送り先や通知音を分けるために使う。"""

    # 軽故障: Discordではサイレント送信（通知音・プッシュ無し、チャンネルには表示）
    WARNING = "warning"
    # 重故障: Discordで通常送信（通知音・プッシュあり）
    CRITICAL = "critical"


# ──────────────────────────────────────────────────────────────
# Sensor
# ──────────────────────────────────────────────────────────────
class Sensor(SQLModel, table=True):
    __tablename__ = "sensors"
    # センサー名はワークスペース内で一意（別のワークスペースには同じ名前を許す）。
    # NULL（self-hosted）は部分インデックスで扱う（PostgreSQL は NULL 同士を別物として扱うため）
    __table_args__ = (
        Index(
            "uq_sensors_name_self_hosted",
            "name",
            unique=True,
            postgresql_where=text("workspace_id IS NULL"),
        ),
        Index(
            "uq_sensors_workspace_name",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("workspace_id IS NOT NULL"),
        ),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    # Phase 0.5: NULL = self-hosted（ワークスペースなし）、UUID = multi-tenant のワークスペース
    workspace_id: UUID | None = Field(
        default=None, foreign_key="workspaces.id", index=True, ondelete="CASCADE"
    )
    name: str = Field(max_length=100)
    # ingest_key は取り込みAPIがキーだけでセンサーを特定するため、ワークスペースをまたいでも一意
    # REST ingest 識別子（旧 mqttTopic）
    # デバイス側は POST /api/ingest/readings にこの値を含めて送信する
    ingest_key: str = Field(unique=True, max_length=100, index=True)
    unit: str = Field(max_length=20)
    # 2段階のしきい値（軽故障/重故障）。各方向・各段階は独立してnull許容（例: 軽故障だけ設定し
    # 重故障は無しも可。重故障のほうが外側＝より極端な値になる想定だが強制はしない）
    threshold_min_warning: float | None = None
    threshold_min_critical: float | None = None
    threshold_max_warning: float | None = None
    threshold_max_critical: float | None = None
    # 不感帯（ヒステリシス）: 閾値ぎりぎりで値が揺れた際に発生/解除を繰り返す「アラームのチラつき」
    # を防ぐ。発生はしきい値を超えた瞬間（不感帯なし）、解除は「しきい値 ∓ 不感帯」を
    # 超えて戻るまで待つ、という非対称な扱いにする（検知の即時性は落とさない）
    threshold_dead_band: float = Field(default=0.0)
    enabled: bool = Field(default=True)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    # passive_deletes=True: センサー削除時にSQLAlchemy ORMがこれらの子をわざわざロードして
    # FKをNULL化する既定動作をやめさせ、DB側のON DELETE CASCADE/SET NULLに任せる
    # （無いとAlarm.sensor_idのような非NULL許容カラムでも黙ってNULL化されてしまう）
    readings: list["Reading"] = Relationship(
        back_populates="sensor", sa_relationship_kwargs={"passive_deletes": True}
    )
    alarms: list["Alarm"] = Relationship(
        back_populates="sensor", sa_relationship_kwargs={"passive_deletes": True}
    )
    widgets: list["Widget"] = Relationship(
        back_populates="sensor", sa_relationship_kwargs={"passive_deletes": True}
    )


# ──────────────────────────────────────────────────────────────
# Reading
# ──────────────────────────────────────────────────────────────
class Reading(SQLModel, table=True):
    __tablename__ = "readings"
    # 複合インデックス: 時系列範囲検索 `WHERE sensor_id = ? AND recorded_at BETWEEN ? AND ?` 用
    # （TimescaleDB代替、docs/decisions.md（TimescaleDB は見送り）参照）
    __table_args__ = (Index("ix_reading_sensor_recorded", "sensor_id", "recorded_at"),)

    # BigSerial: 時系列データの大量蓄積を想定しBIGINT必須
    id: int | None = Field(default=None, primary_key=True)
    # センサー削除時に測定値も一緒に物理削除する（2026-10-02、運用者の判断。
    # 旧soft-delete方式は削除済みセンサーと同名・同ingestKeyで再登録できない問題があったため撤廃）
    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE")
    value: float
    # ingest時刻を採用（デバイス時刻は信頼しない、Phase 0の簡潔さ重視）
    recorded_at: datetime = Field(default_factory=_utcnow)

    sensor: Sensor = Relationship(back_populates="readings")


# ──────────────────────────────────────────────────────────────
# Alarm（基本は追記専用の監査ログだが、センサー削除時はCASCADEで追従削除される。
# 2026-10-02、運用者の判断: センサー削除＝関連データ全削除を優先）
# ──────────────────────────────────────────────────────────────
class Alarm(SQLModel, table=True):
    __tablename__ = "alarms"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE", index=True)
    triggered_at: datetime = Field(default_factory=_utcnow)
    resolved_at: datetime | None = None
    acknowledged_at: datetime | None = None
    # Phase 0はUserテーブルがないため文字列固定（例: "admin"）
    acknowledged_by: str | None = Field(default=None, max_length=100)
    value: float
    status: AlarmStatus = Field(default=AlarmStatus.ACTIVE)
    threshold_breached: ThresholdBreached
    severity: AlarmSeverity = Field(default=AlarmSeverity.CRITICAL)
    # 重故障の再通知（NotificationSettings.critical_repeat_enabled）の間隔判定に使う。
    # 通知を送るたび（初回発火・重要度変化・再通知）に更新する
    last_notified_at: datetime | None = None

    sensor: Sensor = Relationship(back_populates="alarms")


# ──────────────────────────────────────────────────────────────
# Dashboard / Widget
# ──────────────────────────────────────────────────────────────
class Dashboard(SQLModel, table=True):
    __tablename__ = "dashboards"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    workspace_id: UUID | None = Field(
        default=None, foreign_key="workspaces.id", index=True, ondelete="CASCADE"
    )
    name: str = Field(max_length=100)
    description: str | None = Field(default=None, max_length=500)
    # グリッドレイアウト設定（3列 x N行）
    layout_config: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB))
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    # soft-delete（Sensorと同じ方針、docs/architecture.md §3 データモデル参照）
    deleted_at: datetime | None = Field(default=None, index=True)

    widgets: list["Widget"] = Relationship(back_populates="dashboard")


class Widget(SQLModel, table=True):
    __tablename__ = "widgets"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    dashboard_id: UUID = Field(foreign_key="dashboards.id", index=True)
    # 複数センサー対象のウィジェットではnullable。センサー削除時はウィジェットごと消さず
    # 紐付けだけ外す（NULL化）
    sensor_id: UUID | None = Field(default=None, foreign_key="sensors.id", ondelete="SET NULL")
    # 例: "temperature-graph", "power-graph", "production-status"
    type: str = Field(max_length=50)
    # 12列グリッド（react-grid-layoutのドラッグ&ドロップ配置・マウスリサイズに対応、
    # frontend/src/components/DashboardView.tsx の GRID_COLS と一致させる）
    grid_column: int = Field(ge=1, le=12)
    grid_row: int = Field(ge=1)
    grid_width: int = Field(ge=1, le=12)
    grid_height: int = Field(ge=1)
    # グラフ色・Y軸範囲など
    config: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB))
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    dashboard: Dashboard = Relationship(back_populates="widgets")
    sensor: Sensor | None = Relationship(back_populates="widgets")


# ──────────────────────────────────────────────────────────────
# Phase 0.5: User / Workspace / RefreshToken（AUTH_MODE=multi_tenant 時に使用）
# ──────────────────────────────────────────────────────────────
class User(SQLModel, table=True):
    """利用者（SaaS 版のみ）。

    パスワードは、bcrypt のハッシュだけを保存する（平文は保存しない）。
    """

    __tablename__ = "users"
    # lower(email) の一意インデックス（マイグレーション a7b8c9d0e1f2 と同じ）。
    # `lower(email) = ...` の検索を速くし、大文字小文字だけが違う重複を DB 側でも防ぐ
    __table_args__ = (Index("ix_users_email_lower", func.lower(column("email")), unique=True),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    email: str = Field(unique=True, max_length=254, index=True)
    password_hash: str = Field(max_length=200)
    created_at: datetime = Field(default_factory=_utcnow)

    workspaces: list["Workspace"] = Relationship(back_populates="owner")
    refresh_tokens: list["RefreshToken"] = Relationship(back_populates="user")


class Workspace(SQLModel, table=True):
    """ワークスペース（SaaS 版のテナント）。データの分け方の単位で、利用者が所有する。"""

    __tablename__ = "workspaces"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(max_length=100)
    owner_id: UUID = Field(foreign_key="users.id", index=True)
    # "free" | "pro"
    plan: str = Field(default="free", max_length=20)
    created_at: datetime = Field(default_factory=_utcnow)

    owner: User = Relationship(back_populates="workspaces")


class RefreshToken(SQLModel, table=True):
    """リフレッシュトークン（SaaS 版のみ）。アクセストークンを再発行するための長期のトークン。

    生のトークンは保存せず、SHA-256 のハッシュだけを保存する。
    使うたびに新しいものに替える（ローテーション）。
    """

    __tablename__ = "refresh_tokens"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    workspace_id: UUID
    # 生トークンは返さずSHA-256ハッシュのみ保存
    token_hash: str = Field(max_length=64, index=True)
    expires_at: datetime
    revoked: bool = Field(default=False)
    created_at: datetime = Field(default_factory=_utcnow)

    user: User = Relationship(back_populates="refresh_tokens")


# ──────────────────────────────────────────────────────────────
# WebhookSubscription（Phase 1: ノーコード連携。Zapier/Make/n8n等が
# 受け口を用意するだけで、利用者はコードを一切書かずに外部連携できる）
# ──────────────────────────────────────────────────────────────
class WebhookEventType(StrEnum):
    """Webhook で送るイベントの種類。"""

    READING_RECEIVED = "reading.received"
    ALARM_TRIGGERED = "alarm.triggered"


class WebhookSubscription(SQLModel, table=True):
    __tablename__ = "webhook_subscriptions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    # Sensor/Dashboardと同じ規約: NULL = self-hosted、UUID = multi-tenantのワークスペース
    workspace_id: UUID | None = Field(
        default=None, foreign_key="workspaces.id", index=True, ondelete="CASCADE"
    )
    event_type: WebhookEventType
    url: str = Field(max_length=500)
    enabled: bool = Field(default=True)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


# ──────────────────────────────────────────────────────────────
# NotificationSettings（self-hosted は id=1 の1行、SaaS はワークスペースごとに1行）
# ──────────────────────────────────────────────────────────────
class NotificationSettings(SQLModel, table=True):
    __tablename__ = "notification_settings"
    # ワークスペースごとに1行まで（NULL = self-hosted の行は id=1 の1行）
    __table_args__ = (
        Index(
            "uq_notification_settings_workspace",
            "workspace_id",
            unique=True,
            postgresql_where=text("workspace_id IS NOT NULL"),
        ),
    )

    # self-hosted は id=1（workspace_id NULL）の1行。SaaS はワークスペースごとに1行
    id: int | None = Field(default=None, primary_key=True)
    workspace_id: UUID | None = Field(default=None, index=True)
    # 重故障・軽故障で別々のDiscord Webhookに送り分けられるよう、それぞれ専用のURLを持つ
    # （例: 重故障は緊急対応チャンネル、軽故障はログ用チャンネルに分ける運用を想定）
    discord_webhook_url_critical: str = Field(default="", max_length=500)
    discord_webhook_url_warning: str = Field(default="", max_length=500)
    enabled: bool = Field(default=True)
    # 重故障のみ: 未解決のまま一定時間経過したら同じアラームを再通知する（チェックを外せば初回のみ）
    critical_repeat_enabled: bool = Field(default=False)
    critical_repeat_interval_minutes: int = Field(default=30)
