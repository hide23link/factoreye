"""
FactorEye データモデル（Phase 0 MVP）

仕様: docs/factoreye-architecture.md の Data Model セクション参照
(ecopower command-centerリポジトリ: https://github.com/ecopower/ecopower)

エンティティ: Sensor / Reading / Alarm / Dashboard / Widget / WidgetConfig / Plugin / PluginConfig
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


# ──────────────────────────────────────────────────────────────
# Sensor
# ──────────────────────────────────────────────────────────────
class Sensor(SQLModel, table=True):
    __tablename__ = "sensors"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(unique=True, max_length=100)
    # REST ingest 識別子（旧 mqttTopic）
    # デバイス側は POST /api/ingest/readings にこの値を含めて送信する
    ingest_key: str = Field(unique=True, max_length=100, index=True)
    unit: str = Field(max_length=20)
    threshold_min: float | None = None
    threshold_max: float | None = None
    enabled: bool = Field(default=True)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    # soft-delete（Reading/Alarmを保持するためDELETE文は使わない）
    # 制約: name/ingest_keyのunique制約はdeleted_at済み行にも及ぶため、
    # 削除済みセンサーと同名・同ingestKeyは再登録できない（Phase 0は許容）
    deleted_at: datetime | None = Field(default=None, index=True)

    readings: list["Reading"] = Relationship(back_populates="sensor")
    alarms: list["Alarm"] = Relationship(back_populates="sensor")
    widgets: list["Widget"] = Relationship(back_populates="sensor")


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
    sensor_id: UUID = Field(foreign_key="sensors.id")
    value: float
    # ingest時刻を採用（デバイス時刻は信頼しない、Phase 0の簡潔さ重視）
    recorded_at: datetime = Field(default_factory=_utcnow)

    sensor: Sensor = Relationship(back_populates="readings")


# ──────────────────────────────────────────────────────────────
# Alarm（監査ログとして追記専用。DELETE禁止）
# ──────────────────────────────────────────────────────────────
class Alarm(SQLModel, table=True):
    __tablename__ = "alarms"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    sensor_id: UUID = Field(foreign_key="sensors.id", index=True)
    triggered_at: datetime = Field(default_factory=_utcnow)
    resolved_at: datetime | None = None
    acknowledged_at: datetime | None = None
    # Phase 0はUserテーブルがないため文字列固定（例: "admin"）
    acknowledged_by: str | None = Field(default=None, max_length=100)
    value: float
    status: AlarmStatus = Field(default=AlarmStatus.ACTIVE)
    threshold_breached: ThresholdBreached

    sensor: Sensor = Relationship(back_populates="alarms")


# ──────────────────────────────────────────────────────────────
# Dashboard / Widget / WidgetConfig
# ──────────────────────────────────────────────────────────────
class Dashboard(SQLModel, table=True):
    __tablename__ = "dashboards"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
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
    # 複数センサー対象のウィジェットではnullable
    sensor_id: UUID | None = Field(default=None, foreign_key="sensors.id")
    # 例: "temperature-graph", "power-graph", "production-status"
    type: str = Field(max_length=50)
    grid_column: int = Field(ge=1, le=3)
    grid_row: int
    grid_width: int = Field(ge=1, le=3)
    grid_height: int
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
