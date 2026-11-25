"""
FactorEye データモデル

仕様: docs/architecture.md §3 データモデル 参照

Phase 0:  Sensor / Reading / Alarm / Dashboard / Widget
Phase 0.5: User / Workspace / RefreshToken（AUTH_MODE=multi_tenant 時に使用）
Phase 1: WebhookSubscription（Pluginシステムを廃止し、拡張はWebhookに統一。Phase 2参照）

【このファイルは何か】DB のテーブルの設計図。関数を呼ぶファイルではなく、他のファイルが
`from app.db.models import Sensor` のように読み込んで使う。1つの class ＝ 1つのテーブル、
class の中の1行 ＝ 1つの列。テーブルを変えたら、alembic のマイグレーション
（backend/alembic/）も作る。

【テーブルのつながり】
- Sensor ─┬─ Reading（測定値）   ─ センサーを消すと、一緒に消える
          ├─ Alarm（アラーム）   ─ 同上
          └─ Widget（画面の部品） ─ 消えても残る（sensor_id が空になる）
- Dashboard ─ Widget
- User ─ Workspace（SaaS のみ）。workspace_id が NULL の行は、self-hosted のデータ
"""
from datetime import UTC, date, datetime
from enum import StrEnum  # 決まった文字列だけを選べる型（AlarmStatus など）
from typing import Any
from uuid import UUID, uuid4  # id に使う、重ならない長い番号

# Index = 検索を速くする索引、JSONB = PostgreSQL の JSON 型（設定を柔軟に保存する）
from sqlalchemy import Column, Enum, Index, LargeBinary, column, func, text
from sqlalchemy.dialects.postgresql import JSONB

# Field = 列の細かい指定、Relationship = テーブル同士の関係
from sqlmodel import Field, Relationship, SQLModel


def _utcnow() -> datetime:
    """今の時刻（UTC＝世界標準時）。created_at などの、初期値に使う。"""
    return datetime.now(UTC)


class AlarmStatus(StrEnum):
    """アラームの状態。発生中（active）→ 確認済み（acknowledged）→ 解除（resolved）と進む。"""

    ACTIVE = "active"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class MinMax(StrEnum):
    """どちら側のしきい値を超えたか。下限（min）か上限（max）。（旧名 ThresholdBreached）"""

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
# 機器のキーの目印として保存する、先頭の文字数
KEY_HINT_LENGTH = 6


class IngestDevice(SQLModel, table=True):
    """取り込みの機器（現場の 1 台）。機器ごとのキーで、自分のセンサーだけに送れる（自前ホスト）。

    キーそのものは保存しない。SHA-256 のハッシュだけを保存する（発行の時に 1 回だけ画面に出す）。
    """

    __tablename__ = "ingest_devices"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(max_length=100, unique=True)
    key_hash: str = Field(max_length=64, unique=True)
    created_at: datetime = Field(default_factory=_utcnow)
    revoked_at: datetime | None = None
    # キーの目印（先頭 6 文字）。どの機器のキーかを見分けるためだけに出す。残りは保存しない。
    # 目印を付ける前に作った機器は None
    key_hint: str | None = Field(default=None, max_length=KEY_HINT_LENGTH)
    # 系統（ライン・設備の区分。例: 第1ライン）。センサー棚が「系統 › 機器」に分けるために使う。任意
    line: str | None = Field(default=None, max_length=40)


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
    # 機器ごとのキーで送る機器（NULL = 機器のキーに紐づかない。従来どおり）
    device_id: UUID | None = Field(
        default=None, foreign_key="ingest_devices.id", index=True, ondelete="SET NULL"
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
    # 主キーは (sensor_id, recorded_at)。測定値は「どのセンサーの、いつの値か」で決まるので、
    # 連番の id と、時系列範囲検索 `WHERE sensor_id = ? AND recorded_at BETWEEN ? AND ?` 用の索引を
    # 別々に持たず、主キーの索引 1 本で兼ねる（容量が約 4 割減り、書き込みも速い。
    # 2026-10 の実測による。TimescaleDB は使わない）。
    # 同じセンサーで同じ時刻の値は持てない。取り込みは、1 回の送信内の値の時刻を
    # マイクロ秒ずつずらして一意にする（app/api/ingest.py）。

    # センサー削除時に測定値も一緒に物理削除する（2026-10-02、運用者の判断。
    # 旧soft-delete方式は削除済みセンサーと同名・同ingestKeyで再登録できない問題があったため撤廃）
    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE", primary_key=True)
    value: float
    # ingest時刻を採用（デバイス時刻は信頼しない、Phase 0の簡潔さ重視）
    recorded_at: datetime = Field(default_factory=_utcnow, primary_key=True)

    sensor: Sensor = Relationship(back_populates="readings")


class ReadingRollup(SQLModel, table=True):
    """古い測定値を 1 分ごとにまとめた行（OSS 版。設定 READINGS_ROLLUP_DAYS で有効になる）。

    1 秒ごとの測定値は 1 日 8.6 万行/センサーずつ増えて重くなるので、設定した日数より古い分は、
    1 分ごとの「件数・合計・最小・最大・最後の値」にまとめて、元の行を消す（app/rollup.py）。
    平均は 合計 ÷ 件数 で求める（重みづけ平均。まとめた行どうし、生の行とも正しく合わせられる）。
    グラフ・集計の API は、生の行（readings）とこの表を合わせて答える（app/readings_query.py）。

    1 つの分（bucket_start）の測定値は、生の行かこの行のどちらか（遅れて届いた値は、次の実行で
    この行に足し込む）。同じ値を両方に持たないので、合わせても二重に数えない。
    """

    __tablename__ = "readings_rollup"

    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE", primary_key=True)
    # 1 分の開始時刻（UTC。秒は 0）
    bucket_start: datetime = Field(primary_key=True)
    count: int
    sum: float
    min: float
    max: float
    # その分でいちばん新しい値と、その時刻（最新の値・「その時刻以前の値」を、
    # まとめた後も答えるため）
    last_value: float
    last_at: datetime


class ReadingMinute(SQLModel, table=True):
    """直近の測定値（まだ生の行が残っている分）の、1 分ごとの集計。

    OSS 版で READINGS_ROLLUP_DAYS が 1 以上のときに使う。

    readings_rollup は「生の行が消えた古い分」の集計だが、この表は「生の行がまだある分」の集計で、
    生の行から作り直せる（作り直しは上書き。足し算ではない）。グラフ・集計が、直近 7 日分の生の行
    （1 秒ごとなら 60 万行）を読まずに済むようにするための控え。app/minute_cache.py が作り、
    app/readings_query.py が読む。生の行が消える夜のまとめ（app/rollup.py）のとき、同じ分の行は
    ここから消えて、readings_rollup に移る（二重に数えない）。
    列の意味は ReadingRollup と同じ。
    """

    __tablename__ = "readings_minute"

    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE", primary_key=True)
    # 1 分の開始時刻（UTC。秒は 0）
    bucket_start: datetime = Field(primary_key=True)
    count: int
    sum: float
    min: float
    max: float
    last_value: float
    last_at: datetime


class ReadingMinuteState(SQLModel, table=True):
    """センサーごとの、1 分の集計（readings_minute）の「どこからどこまで作ったか」の印。

    - finalized_until: この時刻より前の分は、生の行が消えて readings_rollup にまとめられている
      （このあとに届いた古い生の行は、次の夜のまとめで足される）。
    - built_until: この時刻より前（finalized_until 以後）の分は、readings_minute に作ってある。
      この時刻以後の分は、生の行を直接読む。
    印が無いセンサーは、読み出しが従来の方法（生の行＋まとめた行）で答える。
    """

    __tablename__ = "readings_minute_state"

    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE", primary_key=True)
    finalized_until: datetime
    built_until: datetime


class ReadingDirtyMinute(SQLModel, table=True):
    """遅れて届いた測定値の、(センサー・分) の記録（readings_minute を作り直す対象）。

    1 秒ごとの通常の取り込みでは何も足さず、「今の分より 2 分以上前の時刻」の行が入ったときだけ
    記録する（機器が時刻をつけて、あとから送り直したときなど）。常駐処理と読み出しが、その分の
    集計を生の行から作り直して、この行を消す。
    """

    __tablename__ = "readings_dirty_minutes"

    sensor_id: UUID = Field(foreign_key="sensors.id", ondelete="CASCADE", primary_key=True)
    bucket_start: datetime = Field(primary_key=True)


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
    # DB 上の型の名前は、旧クラス名の "thresholdbreached" のまま（変えると既存 DB と合わない）
    threshold_breached: MinMax = Field(
        sa_column=Column(Enum(MinMax, name="thresholdbreached"), nullable=False)
    )
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

    ログインはパスキー（Passkey）で行い、パスワードは持たない。password_hash は、パスキー導入前に
    パスワードで作った利用者の古い値で、管理者の「リセット」で NULL にする
    （新しい利用者は最初から NULL）。
    """

    __tablename__ = "users"
    # lower(email) の一意インデックス（マイグレーション a7b8c9d0e1f2 と同じ）。
    # `lower(email) = ...` の検索を速くし、大文字小文字だけが違う重複を DB 側でも防ぐ
    __table_args__ = (Index("ix_users_email_lower", func.lower(column("email")), unique=True),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    email: str = Field(unique=True, max_length=254, index=True)
    password_hash: str | None = Field(default=None, max_length=200)
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
    # 期限。NULL は「期限なし」（キオスク用の永久ログイン。利用者が選んだ端末だけ。
    # ローテーションしても、新しいトークンも期限なし。失効は、ログアウト・管理者のリセット）
    expires_at: datetime | None = Field(default=None)
    revoked: bool = Field(default=False)
    created_at: datetime = Field(default_factory=_utcnow)
    # ログインの方法: "passkey" | "email"（メールのログインリンク）| "recover"（再登録リンク）。
    # ローテーションで引き継ぐ。端末（パスキー）の管理は、passkey と recover のときだけ許す。
    # NULL は、パスキー導入前のログイン（管理はできない。ログインし直すと変わる）
    login_method: str | None = Field(default=None, max_length=20)
    # 永久ログインの端末の情報（通常のログインは、すべて NULL）。
    # series_id は、ローテーションで行が替わっても変わらない（一覧・終了の指定に使う）
    series_id: UUID | None = Field(default=None, index=True)
    device_name: str | None = Field(default=None, max_length=50)
    started_at: datetime | None = Field(default=None)
    last_used_at: datetime | None = Field(default=None)

    user: User = Relationship(back_populates="refresh_tokens")


class Passkey(SQLModel, table=True):
    """利用者のパスキー（SaaS 版のみ）。

    1 つのパスキー = 1 つの端末（または、パスワードマネージャーの 1 項目）。

    保存するのは公開鍵だけ。秘密鍵は端末の中にあり、サーバーには届かない。
    1 人の利用者が複数持てる。1 台の端末に、アカウントごとのパスキーを別々に持てる
    （WebAuthn の user.id を利用者 ID にしてあるため、同じ端末・同じドメインでも上書きされない）。
    """

    __tablename__ = "passkeys"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    # 端末が決める credential ID（base64url の文字列）。ログイン時に、どの鍵かを探す鍵になる
    credential_id: str = Field(max_length=1400, unique=True)
    # 公開鍵（COSE 形式のバイト列）
    public_key: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    # 端末が数える署名の回数。巻き戻ったら、鍵が複製された疑いがあるので拒否する
    # （0 のままの端末もある）
    sign_count: int = Field(default=0)
    # 利用者が付ける端末の名前（例: Mac の Chrome）
    name: str = Field(max_length=50)
    created_at: datetime = Field(default_factory=_utcnow)
    last_used_at: datetime | None = Field(default=None)


class EmailToken(SQLModel, table=True):
    """メールで送るリンクのトークン（SaaS 版のみ）。登録の確認と、端末の再登録に使う。

    生のトークンは保存せず、SHA-256 のハッシュだけを保存する（リフレッシュトークンと同じ）。
    1 回だけ使える（used_at が入る）。登録（register）は、アカウントをまだ作らない
    ので、user_id には「これから作る利用者の ID」を先に決めて入れる（WebAuthn の user.id に使う）。
    """

    __tablename__ = "email_tokens"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    # "register"（新規登録）| "recover"（端末の再登録。管理者のリセットも同じ）
    purpose: str = Field(max_length=20)
    email: str = Field(max_length=254, index=True)
    user_id: UUID
    token_hash: str = Field(max_length=64, index=True)
    expires_at: datetime
    used_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=_utcnow)
    # 管理者のリセットが作ったリンク。同じアドレスへの 3 通/時の数え方に入れない
    # （第三者が 3 回依頼して、管理者のリセットを止められないように）
    by_admin: bool = Field(default=False)
    # 実際にメールの送信を依頼した時刻。登録されていないアドレスに残す「送らないダミー行」は NULL。
    # 1 日の送信数の上限（一般の依頼だけ）は、これを数える。
    # 既存の行は NULL（送ったものとして扱わない）
    mail_sent_at: datetime | None = Field(default=None)


class OpsNoticeMark(SQLModel, table=True):
    """運用者への通知を、その日にもう送ったという印（1 日 1 回に抑える）。

    （日付, 種類）が主キー。先に行を入れられた 1 回だけが、通知を送る。
    再起動・複数ワーカーでも 1 回になる。
    日付は UTC の日付（1 日の送信数の数え方と同じ）。
    """

    __tablename__ = "ops_notice_marks"

    day: date = Field(primary_key=True)
    # "email_warn"（上限の割合に達した）| "email_limit"（上限に達した）
    kind: str = Field(primary_key=True, max_length=30)
    created_at: datetime = Field(default_factory=_utcnow)


class AuthChallenge(SQLModel, table=True):
    """パスキーの登録・ログインで、サーバーが出した使い捨ての乱数（チャレンジ）。

    端末が署名した相手が、この乱数であることを確かめる。有効期限は 5 分、1 回使ったら消す。
    画面には challenge_id（この行の ID）だけを渡し、乱数そのものはサーバーに残す。
    """

    __tablename__ = "auth_challenges"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    challenge: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    # "register"（メールのリンクから）| "add"（ログイン中に端末を足す）| "login"
    purpose: str = Field(max_length=20)
    # register / add のとき: パスキーを持つことになる利用者の ID（login は無し）
    user_id: UUID | None = Field(default=None)
    # register のとき: 使うメールのトークン（finish で使用済みにする）
    email_token_id: UUID | None = Field(default=None)
    expires_at: datetime
    created_at: datetime = Field(default_factory=_utcnow)


# ──────────────────────────────────────────────────────────────
# WebhookSubscription（Phase 1: ノーコード連携。Zapier/Make/n8n等が
# 受け口を用意するだけで、利用者はコードを一切書かずに外部連携できる）
# ──────────────────────────────────────────────────────────────
class WebhookEventType(StrEnum):
    """Webhook で送るイベントの種類。"""

    READING_RECEIVED = "reading.received"
    ALARM_TRIGGERED = "alarm.triggered"


class WebhookSubscription(SQLModel, table=True):
    """Webhook の購読（どのイベントを、どの URL に送るか）。1イベント×1URL で1行。"""

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
# DisplaySettings（画面の明るさの全員の初期値。self-hosted は id=1 の 1 行、SaaS は 1 つに 1 行）
# ──────────────────────────────────────────────────────────────
class DisplaySettings(SQLModel, table=True):
    """画面の明るさの、全員の初期値（設定 › 画面の明るさ で「全員の初期値にする」を選んだとき）。

    各利用者の端末に自分の選択があれば、それが優先される。無い端末だけ、この値で始まる。
    """

    __tablename__ = "display_settings"
    # ワークスペースごとに1行まで（NULL = self-hosted の行は id=1 の1行）
    __table_args__ = (
        Index(
            "uq_display_settings_workspace",
            "workspace_id",
            unique=True,
            postgresql_where=text("workspace_id IS NOT NULL"),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    workspace_id: UUID | None = Field(default=None, index=True)
    # "dark"（暗い）・"light"（明るい）・"system"（端末の設定に合わせる）。初期値は暗い
    default_theme: str = Field(default="dark", max_length=10)
    updated_at: datetime = Field(default_factory=_utcnow)


# ──────────────────────────────────────────────────────────────
# NotificationSettings（self-hosted は id=1 の1行、SaaS はワークスペースごとに1行）
# ──────────────────────────────────────────────────────────────
class NotificationSettings(SQLModel, table=True):
    """Discord 通知の設定。アラーム発生時に、どの URL に送るか・再通知するか。"""

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
