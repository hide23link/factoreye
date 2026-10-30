"""API リクエスト/レスポンス用 Pydantic スキーマ（Phase 0: Sensor / Ingest / Alarm）。

JSON配線フォーマットはcamelCase（docs/architecture.md §4 REST API の例に合わせる）。
Python/DB側はsnake_case（PEP 8）のまま、alias_generatorで変換する。

命名の規則（クラス名の末尾で役割が分かる）:
- ...Create: 作成の入力。必須の項目は必須、既定値のある項目は省略可
- ...Update: 更新の入力。すべて省略可。送られた項目だけ変える（部分更新）
- ...Read: 応答（出力）。DB のモデルから作る（from_attributes=True）
- ...List / ...Response: 一覧の応答（件数の total を含む）

【誰が使うか】api/ の各ファイルが、「受け取る形（...Create / ...Update）」と
「返す形（...Read）」として使う。FastAPI が、届いた JSON を、ここの形に合うか検査して渡す。
合わなければ、api/ の処理に入る前に 422 のエラーになる。
DB のテーブルの設計図は、db/models.py（ここは API の入出力の形だけ）。
"""
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel
from pydantic_core import PydanticCustomError

from app.auth import MAX_PASSWORD_BYTES
from app.db.models import AlarmSeverity, AlarmStatus, MinMax, WebhookEventType

# 取り込み 1 リクエストあたりの測定値の最大件数
MAX_READINGS_PER_REQUEST = 1000
# 複数センサーをまとめて送る形（sensors）の、1 リクエストあたりの上限（センサー数、測定値の合計）
MAX_SENSORS_PER_REQUEST = 2000
MAX_READINGS_PER_MULTI_REQUEST = 70000  # 350 か所 × 3 要素 × 60 秒（63,000）に余裕を足した値
# samples（時刻ごとにまとめる形）の、1 リクエストあたりの時刻の数
MAX_SAMPLES_PER_REQUEST = 1000


def check_password_bytes(value: str | None) -> str | None:
    """パスワードが UTF-8 で 72 バイト以下かを確かめる（超えたら 422 になる）。

    文字数ではなくバイト数で数える（日本語は 1 文字 3 バイトなので 24 文字まで）。
    エラーに入力の値は含めない。
    """
    if value is not None and len(value.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise PydanticCustomError(
            "password_too_long",
            "パスワードは {max_bytes} バイト以内にしてください"
            "（日本語は 1 文字 3 バイトで、24 文字まで）",
            {"max_bytes": MAX_PASSWORD_BYTES},
        )
    return value


class CamelModel(BaseModel):
    """すべての API スキーマの基底。Python の snake_case を JSON の camelCase と相互に変換する。

    populate_by_name=True により、Python 側では snake_case の名前でも作れる。
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ──────────────────────────────────────────────────────────────
# Sensor
# ──────────────────────────────────────────────────────────────


class SensorCreate(CamelModel):
    """センサー登録の入力。ingest_key（取り込みキー）は、デバイスが送信時に使う識別子。

    閾値（しきい値）は、上限・下限、軽故障（warning）・重故障（critical）の4項目。省略すると無効。
    threshold_dead_band は不感帯（発生と解除の間の幅）。
    """

    name: str = Field(min_length=1, max_length=100)
    ingest_key: str = Field(min_length=1, max_length=100)
    unit: str = Field(min_length=1, max_length=20)
    threshold_min_warning: float | None = None
    threshold_min_critical: float | None = None
    threshold_max_warning: float | None = None
    threshold_max_critical: float | None = None
    threshold_dead_band: float = 0.0


class SensorUpdate(CamelModel):
    """センサーの更新の入力。送られた項目だけ変更する（省略した項目は変えない）。"""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    unit: str | None = Field(default=None, min_length=1, max_length=20)
    threshold_min_warning: float | None = None
    threshold_min_critical: float | None = None
    threshold_max_warning: float | None = None
    threshold_max_critical: float | None = None
    threshold_dead_band: float | None = None
    enabled: bool | None = None


class SensorRead(CamelModel):
    """センサーの応答。ingest_key を含むので、認証された画面にだけ返す。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: UUID
    name: str
    ingest_key: str
    unit: str
    threshold_min_warning: float | None
    threshold_min_critical: float | None
    threshold_max_warning: float | None
    threshold_max_critical: float | None
    threshold_dead_band: float
    enabled: bool
    created_at: datetime
    updated_at: datetime


# ──────────────────────────────────────────────────────────────
# Ingest
# ──────────────────────────────────────────────────────────────


# 機器の timestamp は、ここでは検査しない（INGEST_DEVICE_TIME=on のときだけ ingest.py で検査）。
# 既定（off）では、timestamp を付けられても無視する（従来の挙動を壊さないため）
DeviceTimestamp = Any


class ReadingIn(CamelModel):
    """1件の測定値。

    timestamp を省略すると、サーバーが受信した時刻を使う（デバイスの時計は信用しない）。
    """

    value: float = Field(allow_inf_nan=False)
    timestamp: DeviceTimestamp = None


def _reject_nul_in_key(value: str | None) -> str | None:
    """NUL 文字（\\x00）は、DB が受け付けず、500 になるので、ここで 400 にする。"""
    if value is not None and "\x00" in value:
        raise PydanticCustomError("invalid_ingest_key", "ingestKey must not contain NUL")
    return value


class _SensorFields(CamelModel):
    """1 つのセンサーの測定値の書き方。次の 3 通りを受け付ける（to_readings で統一する）。

    - value だけ: 1件
    - readings（配列）: まとめて複数件
    - それ以外: 空（何も取り込まない）
    """

    value: float | None = Field(default=None, allow_inf_nan=False)
    timestamp: DeviceTimestamp = None
    # センサーを自動で作るとき（INGEST_AUTO_CREATE=on）だけ使う、名前と単位。
    # 登録済みのセンサーには、使わない（上書きしない）
    # ここでは検査しない（登録済みのセンサーへの送信を、名前の不正で 400 にしないため）。
    # 自動で作るときに、ingest.py の clean_text で、整えてから使う
    name: str | None = Field(default=None, max_length=1000)
    unit: str | None = Field(default=None, max_length=1000)
    # 1 センサーの件数に上限を付ける（巨大なバッチで受信バッファを使い切られないため）
    readings: list[ReadingIn] | None = Field(default=None, max_length=MAX_READINGS_PER_REQUEST)

    def to_readings(self) -> list[ReadingIn]:
        """3通りの書き方を、ReadingIn のリストに統一して返す。"""
        if self.readings is not None:
            return self.readings
        if self.value is not None:
            return [ReadingIn(value=self.value, timestamp=self.timestamp)]
        return []


class SampleIn(CamelModel):
    """ある時刻の、複数センサーの値（samples 配列の要素）。時刻ごとにまとめる書き方。

    values は {ingestKey: 値}。timestamp を省略すると、サーバーが受信した時刻を使う。
    """

    timestamp: DeviceTimestamp = None
    values: dict[str, float] = Field(max_length=MAX_SENSORS_PER_REQUEST)

    @field_validator("values")
    @classmethod
    def _check_values(cls, values: dict[str, float]) -> dict[str, float]:
        for key, value in values.items():
            if not 1 <= len(key) <= 100:
                raise PydanticCustomError("invalid_ingest_key", "ingestKey must be 1-100 chars")
            _reject_nul_in_key(key)
            if value != value or value in (float("inf"), float("-inf")):
                raise PydanticCustomError("invalid_value", "value must be finite")
        return values


class SensorReadings(_SensorFields):
    """複数センサーをまとめて送るときの、センサー 1 つ分（sensors 配列の要素）。"""

    ingest_key: str = Field(min_length=1, max_length=100)

    @field_validator("ingest_key")
    @classmethod
    def _reject_nul(cls, value: str) -> str:
        return _reject_nul_in_key(value) or value


class IngestRequest(_SensorFields):
    """取り込みの入力。次の 2 通りの形がある。

    - 1 センサー: ingestKey ＋ value か readings（従来の形）
    - 複数センサー（センサーごと）: sensors 配列（各要素が ingestKey ＋ value か readings）
    - 複数センサー（時刻ごと）: samples 配列（各要素が timestamp ＋ values {ingestKey: 値}）
    この 3 つのうち、1 つだけを使う
    """

    ingest_key: str | None = Field(default=None, min_length=1, max_length=100)
    sensors: list[SensorReadings] | None = Field(default=None, max_length=MAX_SENSORS_PER_REQUEST)
    samples: list[SampleIn] | None = Field(default=None, max_length=MAX_SAMPLES_PER_REQUEST)

    @field_validator("ingest_key")
    @classmethod
    def _reject_nul(cls, value: str | None) -> str | None:
        return _reject_nul_in_key(value)

    @model_validator(mode="after")
    def _check_one_form(self) -> "IngestRequest":
        """ingestKey・sensors・samples のうち 1 つだけを要求する（複数・どれも無しは 400）。"""
        given = [x for x in (self.ingest_key, self.sensors, self.samples) if x is not None]
        if len(given) != 1:
            raise PydanticCustomError(
                "invalid_ingest_form", "send exactly one of ingestKey, sensors, or samples"
            )
        return self

    def to_sensor_items(self) -> list[SensorReadings] | None:
        """複数センサーの形（sensors か samples）を、センサーごとの一覧にそろえる。

        samples は、センサーごとに値を集める（順番は送られた順）。
        従来の形（ingestKey）のときは None。
        """
        if self.sensors is not None:
            return self.sensors
        if self.samples is None:
            return None
        grouped: dict[str, list[ReadingIn]] = {}
        for sample in self.samples:
            for key, value in sample.values.items():
                grouped.setdefault(key, []).append(
                    ReadingIn(value=value, timestamp=sample.timestamp)
                )
        # キーは SampleIn で検査済みなので、ここでは検査し直さない
        return [
            SensorReadings.model_construct(ingest_key=key, readings=readings)
            for key, readings in grouped.items()
        ]


class IngestRejected(CamelModel):
    """複数センサーの送信で、受け付けられなかったセンサー 1 つ分。

    status は、従来の形（ingestKey）なら返していた HTTP の状態。
    """

    ingest_key: str
    status: int
    detail: str


class IngestAccepted(CamelModel):
    """取り込みの応答。受け付けた件数（受信バッファに入った数）。"""

    accepted: int
    # 複数センサーの送信（sensors）で、受け付けられなかったセンサー。1 つ以上あっても全体は 202 で、
    # 残りは受け付ける。従来の形（ingestKey）では、問題はそのまま 4xx になり、ここは常に空
    rejected: list[IngestRejected] = Field(default_factory=list)



# ──────────────────────────────────────────────────────────────
# Reading
# ──────────────────────────────────────────────────────────────


class ReadingRead(CamelModel):
    """測定値1件の応答。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    sensor_id: UUID
    value: float
    recorded_at: datetime


class ReadingListResponse(CamelModel):
    readings: list[ReadingRead]
    total: int


class ReadingAggregate(CamelModel):
    """期間の集計（合計と件数）。ダッシュボードの「本日累計」などに使う。"""

    sum: float
    count: int


class DownsampledBucket(CamelModel):
    """間引きの 1 区間。start から bucketSeconds の間の測定値の最小・平均・最大と件数。"""

    start: datetime
    min: float
    avg: float
    max: float
    count: int


class DownsampledReadings(CamelModel):
    """グラフ用の間引き結果。測定値が無い区間は含めない。"""

    bucket_seconds: float
    buckets: list[DownsampledBucket]


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
    threshold_breached: MinMax
    severity: AlarmSeverity


class AlarmListResponse(CamelModel):
    alarms: list[AlarmRead]
    total: int


class AlarmAck(CamelModel):
    """アラームの確認（既読）の入力。誰が確認したかを記録する。"""

    # Phase 0はUserテーブルがないため文字列固定可（例: "admin"）
    acknowledged_by: str = Field(min_length=1, max_length=100)


# ──────────────────────────────────────────────────────────────
# Widget
# ──────────────────────────────────────────────────────────────


class WidgetCreate(CamelModel):
    """ウィジェットの作成の入力。grid_* は 12 列グリッドの位置とサイズ。"""

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
    """ウィジェットの更新の入力。送られた項目だけ変更する。"""

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
    """ダッシュボードの作成の入力。layout_config は、表示の全体設定（JSON のまま保存する）。"""

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
    """ダッシュボードの詳細（ウィジェットの一覧を含む）。一覧では含めない。"""

    widgets: list[WidgetRead] = Field(default_factory=list)


# ──────────────────────────────────────────────────────────────
# NotificationSettings
# ──────────────────────────────────────────────────────────────


class NotificationSettingsRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    discord_webhook_url_critical: str
    discord_webhook_url_warning: str
    enabled: bool
    critical_repeat_enabled: bool
    critical_repeat_interval_minutes: int


class NotificationSettingsUpdate(CamelModel):
    """通知設定の更新の入力。送られた項目だけ変更する。

    critical_repeat_*: 重故障が解決しないまま続いたとき、指定間隔で再通知する設定。
    """

    discord_webhook_url_critical: str | None = Field(default=None, max_length=500)
    discord_webhook_url_warning: str | None = Field(default=None, max_length=500)
    enabled: bool | None = None
    critical_repeat_enabled: bool | None = None
    critical_repeat_interval_minutes: int | None = Field(default=None, ge=1)


# ──────────────────────────────────────────────────────────────
# WebhookSubscription（Phase 1: ノーコード連携）
# ──────────────────────────────────────────────────────────────


class WebhookSubscriptionCreate(CamelModel):
    """Webhook 購読の作成の入力。event_type のときに、url へ JSON を送る。"""

    event_type: WebhookEventType
    url: str = Field(min_length=1, max_length=500)
    enabled: bool = True


class WebhookSubscriptionUpdate(CamelModel):
    url: str | None = Field(default=None, min_length=1, max_length=500)
    enabled: bool | None = None


class WebhookSubscriptionRead(CamelModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)

    id: UUID
    event_type: WebhookEventType
    url: str
    enabled: bool
    created_at: datetime
    updated_at: datetime
