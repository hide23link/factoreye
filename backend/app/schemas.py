"""API リクエスト/レスポンス用 Pydantic スキーマ（Phase 0: Sensor / Ingest / Alarm）。

JSON配線フォーマットはcamelCase（docs/factoreye-architecture.md のAPI例に合わせる）。
Python/DB側はsnake_case（PEP 8）のまま、alias_generatorで変換する。
"""
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.db.models import AlarmStatus, ThresholdBreached


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ──────────────────────────────────────────────────────────────
# Sensor
# ──────────────────────────────────────────────────────────────


class SensorCreate(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    ingest_key: str = Field(min_length=1, max_length=100)
    unit: str = Field(min_length=1, max_length=20)
    threshold_min: float | None = None
    threshold_max: float | None = None


class SensorUpdate(CamelModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    unit: str | None = Field(default=None, min_length=1, max_length=20)
    threshold_min: float | None = None
    threshold_max: float | None = None
    enabled: bool | None = None


class SensorRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: UUID
    name: str
    ingest_key: str
    unit: str
    threshold_min: float | None
    threshold_max: float | None
    enabled: bool
    created_at: datetime
    updated_at: datetime


# ──────────────────────────────────────────────────────────────
# Ingest
# ──────────────────────────────────────────────────────────────


class ReadingIn(CamelModel):
    value: float
    timestamp: datetime | None = None


class IngestRequest(CamelModel):
    ingest_key: str = Field(min_length=1, max_length=100)
    value: float | None = None
    timestamp: datetime | None = None
    readings: list[ReadingIn] | None = None

    def to_readings(self) -> list[ReadingIn]:
        if self.readings is not None:
            return self.readings
        if self.value is not None:
            return [ReadingIn(value=self.value, timestamp=self.timestamp)]
        return []


class IngestAccepted(CamelModel):
    accepted: int


# ──────────────────────────────────────────────────────────────
# Reading
# ──────────────────────────────────────────────────────────────


class ReadingRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: int
    sensor_id: UUID
    value: float
    recorded_at: datetime


class ReadingListResponse(CamelModel):
    readings: list[ReadingRead]
    total: int


class ReadingAggregate(CamelModel):
    sum: float
    count: int


# ──────────────────────────────────────────────────────────────
# Alarm
# ──────────────────────────────────────────────────────────────


class AlarmRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: UUID
    sensor_id: UUID
    triggered_at: datetime
    resolved_at: datetime | None
    acknowledged_at: datetime | None
    acknowledged_by: str | None
    value: float
    status: AlarmStatus
    threshold_breached: ThresholdBreached


class AlarmListResponse(CamelModel):
    alarms: list[AlarmRead]
    total: int


class AlarmAck(CamelModel):
    # Phase 0はUserテーブルがないため文字列固定可（例: "admin"）
    acknowledged_by: str = Field(min_length=1, max_length=100)


# ──────────────────────────────────────────────────────────────
# Widget
# ──────────────────────────────────────────────────────────────


class WidgetCreate(CamelModel):
    # "SensorGraph" | "ProductionStatus" | "AlarmAlert" | "MultiSensorComparison" | プラグイン定義
    type: str = Field(min_length=1, max_length=50)
    sensor_id: UUID | None = None
    # 12列グリッド（frontend の react-grid-layout GRID_COLS と一致）
    grid_column: int = Field(ge=1, le=12)
    grid_row: int = Field(ge=1)
    grid_width: int = Field(ge=1, le=12)
    grid_height: int = Field(ge=1)
    config: dict[str, Any] = Field(default_factory=dict)


class WidgetUpdate(CamelModel):
    sensor_id: UUID | None = None
    grid_column: int | None = Field(default=None, ge=1, le=12)
    grid_row: int | None = Field(default=None, ge=1)
    grid_width: int | None = Field(default=None, ge=1, le=12)
    grid_height: int | None = Field(default=None, ge=1)
    config: dict[str, Any] | None = None


class WidgetRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: UUID
    dashboard_id: UUID
    sensor_id: UUID | None
    type: str
    grid_column: int
    grid_row: int
    grid_width: int
    grid_height: int
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime


# ──────────────────────────────────────────────────────────────
# Dashboard
# ──────────────────────────────────────────────────────────────


class DashboardCreate(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    layout_config: dict[str, Any] = Field(default_factory=dict)


class DashboardUpdate(CamelModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    layout_config: dict[str, Any] | None = None


class DashboardRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: UUID
    name: str
    description: str | None
    layout_config: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class DashboardDetail(DashboardRead):
    widgets: list[WidgetRead] = Field(default_factory=list)


# ──────────────────────────────────────────────────────────────
# Plugin
# ──────────────────────────────────────────────────────────────


class PluginRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: UUID
    name: str
    version: str
    enabled: bool
    installed_at: datetime
    config: dict[str, Any]


class PluginConfigUpdate(CamelModel):
    config: dict[str, Any]
