"""
FactorEye データモデル

仕様: docs/factoreye-architecture.md の Data Model セクション参照
(ecopower command-centerリポジトリ: https://github.com/ecopower/ecopower)

Phase 0:  Sensor / Reading / Alarm / Dashboard / Widget / WidgetConfig / Plugin / PluginConfig
Phase 0.5: User / Workspace / RefreshToken（AUTH_MODE=multi_tenant 時に使用）
"""
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Column, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Relationship, SQLModel


def _utcnow() -> datetime:
    return datetime.now(UTC)


class AlarmStatus(StrEnum):
    ACTIVE = "active"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class ThresholdBreached(StrEnum):
    MIN = "min"
    MAX = "max"


class AlarmSeverity(StrEnum):
    # 軽故障: Discordではサイレント送信（通知音・プッシュ無し、チャンネルには表示）
    WARNING = "warning"
    # 重故障: Discordで通常送信（通知音・プッシュあり）
    CRITICAL = "critical"


# ──────────────────────────────────────────────────────────────
# Sensor
# ──────────────────────────────────────────────────────────────
class Sensor(SQLModel, table=True):
    __tablename__ = "sensors"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    # Phase 0.5: NULL = self-hosted（ワークスペースなし）、UUID = multi-tenant のワークスペース
    workspace_id: UUID | None = Field(
        default=None, foreign_key="workspaces.id", index=True, ondelete="CASCADE"
    )
    name: str = Field(unique=True, max_length=100)
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
    # （TimescaleDB代替、docs/factoreye-architecture.md §TimescaleDB参照）
    __table_args__ = (Index("ix_reading_sensor_recorded", "sensor_id", "recorded_at"),)

    # BigSerial: 時系列データの大量蓄積を想定しBIGINT必須
    id: int | None = Field(default=None, primary_key=True)
    # センサー削除時に測定値も一緒に物理削除する（2026-10-02、社長の明示的な判断。
    # 旧soft-delete方式は削除済みセンサーと同名・同ingestKeyで再登録できない問題があったため撤廃）
    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE")
    value: float
    # ingest時刻を採用（デバイス時刻は信頼しない、Phase 0の簡潔さ重視）
    recorded_at: datetime = Field(default_factory=_utcnow)

    sensor: Sensor = Relationship(back_populates="readings")


# ──────────────────────────────────────────────────────────────
# Alarm（基本は追記専用の監査ログだが、センサー削除時はCASCADEで追従削除される。
# 2026-10-02、社長の明示的な判断: センサー削除＝関連データ全削除を優先）
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
# Dashboard / Widget / WidgetConfig
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
    # soft-delete（Sensorと同じ方針、§Data Model参照）
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
    widget_configs: list["WidgetConfig"] = Relationship(back_populates="widget")


class WidgetConfig(SQLModel, table=True):
    __tablename__ = "widget_configs"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    widget_id: UUID = Field(foreign_key="widgets.id", index=True)
    settings: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB))

    widget: Widget = Relationship(back_populates="widget_configs")


# ──────────────────────────────────────────────────────────────
# Plugin / PluginConfig
# ──────────────────────────────────────────────────────────────
class Plugin(SQLModel, table=True):
    __tablename__ = "plugins"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    # フォルダ名と一致（例: "slack-notifier"）
    name: str = Field(unique=True, max_length=100)
    version: str = Field(max_length=20)
    enabled: bool = Field(default=False)
    installed_at: datetime = Field(default_factory=_utcnow)
    config: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB))

    plugin_configs: list["PluginConfig"] = Relationship(back_populates="plugin")


class PluginConfig(SQLModel, table=True):
    __tablename__ = "plugin_configs"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    plugin_id: UUID = Field(foreign_key="plugins.id", index=True)
    data: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB))

    plugin: Plugin = Relationship(back_populates="plugin_configs")


# ──────────────────────────────────────────────────────────────
# Phase 0.5: User / Workspace / RefreshToken（AUTH_MODE=multi_tenant 時に使用）
# ──────────────────────────────────────────────────────────────
class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    email: str = Field(unique=True, max_length=254, index=True)
    password_hash: str = Field(max_length=200)
    created_at: datetime = Field(default_factory=_utcnow)

    workspaces: list["Workspace"] = Relationship(back_populates="owner")
    refresh_tokens: list["RefreshToken"] = Relationship(back_populates="user")


class Workspace(SQLModel, table=True):
    __tablename__ = "workspaces"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(max_length=100)
    owner_id: UUID = Field(foreign_key="users.id", index=True)
    # "free" | "pro"
    plan: str = Field(default="free", max_length=20)
    created_at: datetime = Field(default_factory=_utcnow)

    owner: User = Relationship(back_populates="workspaces")


class RefreshToken(SQLModel, table=True):
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
# NotificationSettings（シングルトン、常にid=1の1行のみ）
# ──────────────────────────────────────────────────────────────
class NotificationSettings(SQLModel, table=True):
    __tablename__ = "notification_settings"

    # Phase 0.5: id=1（NULL workspace）が self-hosted 用のシングルトン行
    # multi-tenant では workspace ごとに新規行（マイグレーションで SERIAL 付与済み）
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
