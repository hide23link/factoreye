"""アラーム評価エンジン: 測定値がしきい値を超えたかを見て、アラームを発生・解除する。

docs/architecture.md §6 アラーム評価 参照。

【誰が・いつ呼ぶか】evaluate_alarms は、ingest_buffer.py の flush_once が、1秒ごとに1回呼ぶ。
渡すもの: DB との会話（session）、この回に書く測定値（pending）、センサーの一覧（sensors_by_id）、
          通知の設定（notice_settings_by_workspace）。
返すもの: 通知を送るべきアラームのリスト（送るのは呼んだ側。ここでは送らない）。

【流れ】1回の flush で、受信した測定値を1件ずつ見る:
1. 測定値がしきい値を超えたか（_check_threshold）
2. 超えていて、まだ発生中のアラームがなければ、新規に作る（通知もする）
3. 超えていて、発生中のアラームがあれば、重要度の変化や再通知の条件だけを見る
   （同じ状態が続くだけなら何もしない。通知を重ねないため）
4. 超えていなくても、不感帯の範囲内なら解除しない（_still_breached_with_dead_band）
5. それ以外は、発生中のアラームを解除する
"""
from collections.abc import Mapping
from datetime import timedelta
from typing import TYPE_CHECKING
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import (
    Alarm,
    AlarmSeverity,
    AlarmStatus,
    MinMax,
    NotificationSettings,
    Sensor,
)
from app.notifications import AlarmNotification

if TYPE_CHECKING:
    # 実行時のimportはapp.ingest_buffer側で行う（循環import回避のため型チェック専用）
    from app.ingest_buffer import PendingReading


# ──────────────────────────────────────────────────────────────
# しきい値の判定（純粋な関数。DB を使わない）
# ──────────────────────────────────────────────────────────────


def _check_threshold(
    sensor: Sensor, value: float
) -> tuple[MinMax, AlarmSeverity] | None:
    """重故障（より極端な値）を優先して判定し、無ければ軽故障を判定する。"""
    if sensor.threshold_max_critical is not None and value > sensor.threshold_max_critical:
        return MinMax.MAX, AlarmSeverity.CRITICAL
    if sensor.threshold_min_critical is not None and value < sensor.threshold_min_critical:
        return MinMax.MIN, AlarmSeverity.CRITICAL
    if sensor.threshold_max_warning is not None and value > sensor.threshold_max_warning:
        return MinMax.MAX, AlarmSeverity.WARNING
    if sensor.threshold_min_warning is not None and value < sensor.threshold_min_warning:
        return MinMax.MIN, AlarmSeverity.WARNING
    return None


def _threshold_value(
    sensor: Sensor, breached: MinMax, severity: AlarmSeverity
) -> float | None:
    """発生時に超えたしきい値の数値を返す（解除の判定に使う）。設定が無ければ None。"""
    if breached == MinMax.MAX:
        return (
            sensor.threshold_max_critical
            if severity == AlarmSeverity.CRITICAL
            else sensor.threshold_max_warning
        )
    return (
        sensor.threshold_min_critical
        if severity == AlarmSeverity.CRITICAL
        else sensor.threshold_min_warning
    )


def _still_breached_with_dead_band(
    sensor: Sensor, value: float, breached: MinMax, severity: AlarmSeverity
) -> bool:
    """不感帯を考慮した解除判定。発生時に使った閾値まで戻っただけでは解除しない
    （閾値 ∓ 不感帯を超えて戻るまで「まだ発生中」とみなし、チラつきを防ぐ）。"""
    threshold = _threshold_value(sensor, breached, severity)
    if threshold is None:
        return False
    band = sensor.threshold_dead_band
    if breached == MinMax.MAX:
        return value > threshold - band
    return value < threshold + band


# ──────────────────────────────────────────────────────────────
# 評価の本体（DB を使う。ingest_buffer の flush から呼ばれる）
# ──────────────────────────────────────────────────────────────


async def evaluate_alarms(
    session: AsyncSession,
    pending: "list[PendingReading]",
    sensors_by_id: Mapping[UUID, Sensor],
    notice_settings_by_workspace: Mapping[UUID | None, NotificationSettings],
) -> list[AlarmNotification]:
    """新規に発火したAlarmの通知用データを返す（ORMオブジェクトはセッション終了後に参照できないため）。

    再通知の間隔は、センサーのワークスペースの通知設定に従う（設定が無いワークスペースは再通知しない）。
    センサーは、呼び出し側（flush）が1回だけ読んだものを受け取る（ここでは読み直さない。
    sensors_by_id に無いセンサーの測定値は、削除済みとして何もしない）。
    発生中のアラームは、最初にまとめて読む。1件ずつ DB を読みに行かないようにして、
    受信の多い時もまとめて処理できるようにする。
    """
    sensor_ids = {reading.sensor_id for reading in pending}
    if not sensor_ids:
        return []

    # 発生中（解決していない）のアラームを、センサーごとに1件だけ持つ辞書にする。
    # 同じセンサーに発生中のアラームは同時に1件だけ、という前提で扱う
    open_result = await session.exec(
        select(Alarm).where(
            Alarm.sensor_id.in_(sensor_ids),  # type: ignore[attr-defined]
            Alarm.status != AlarmStatus.RESOLVED,
        )
    )
    open_alarms = {a.sensor_id: a for a in open_result.all()}

    notifications: list[AlarmNotification] = []

    # 測定時刻の順に判定する。受信時刻のときは到着順と同じ。
    # 機器の時刻（INGEST_DEVICE_TIME=on）では、送信の中で時刻が前後することがあり、
    # そのまま処理すると、解決の時刻が発生より前になる
    for reading in sorted(pending, key=lambda r: r.recorded_at):
        # センサーが削除されていれば、何もしない
        sensor = sensors_by_id.get(reading.sensor_id)
        if sensor is None:
            continue
        notice_settings = notice_settings_by_workspace.get(sensor.workspace_id)

        breach = _check_threshold(sensor, reading.value)
        existing = open_alarms.get(reading.sensor_id)
        if existing is not None and reading.recorded_at < existing.triggered_at:
            # 発生中のアラームより古い測定値（溜めて後から送られた分）。
            # 解決も再通知もしない（時刻が逆転するため）
            continue

        if breach is not None:
            breached, severity = breach
            if existing is None:
                alarm = Alarm(
                    sensor_id=reading.sensor_id,
                    value=reading.value,
                    threshold_breached=breached,
                    severity=severity,
                    triggered_at=reading.recorded_at,
                    last_notified_at=reading.recorded_at,
                )
                session.add(alarm)
                open_alarms[reading.sensor_id] = alarm
                # sensor.name/unitはセッションがまだ開いている今のうちにプレーン値へ退避する
                notifications.append(
                    AlarmNotification(
                        sensor_name=sensor.name,
                        sensor_unit=sensor.unit,
                        value=reading.value,
                        threshold_breached=breached,
                        severity=severity,
                        triggered_at=reading.recorded_at,
                        sensor_id=sensor.id,
                        workspace_id=sensor.workspace_id,
                    )
                )
            elif existing.severity != severity:
                # 同じ発生中アラームのまま重要度が変化（軽故障→重故障 or 逆）。
                # 新規アラームは作らず重要度を更新し、重要度が変わったこと自体を再通知する
                existing.value = reading.value
                existing.severity = severity
                existing.threshold_breached = breached
                existing.last_notified_at = reading.recorded_at
                session.add(existing)
                notifications.append(
                    AlarmNotification(
                        sensor_name=sensor.name,
                        sensor_unit=sensor.unit,
                        value=reading.value,
                        threshold_breached=breached,
                        severity=severity,
                        triggered_at=reading.recorded_at,
                        sensor_id=sensor.id,
                        workspace_id=sensor.workspace_id,
                    )
                )
            elif (
                severity == AlarmSeverity.CRITICAL
                and notice_settings is not None
                and notice_settings.critical_repeat_enabled
                and existing.last_notified_at is not None
                and reading.recorded_at - existing.last_notified_at
                >= timedelta(minutes=notice_settings.critical_repeat_interval_minutes)
            ):
                # 重故障が未解決のまま設定時間を超えて継続している。再通知する
                # （元のtriggered_atは変えず、いつ最初に発生したかが分かるようにする）
                existing.value = reading.value
                existing.last_notified_at = reading.recorded_at
                session.add(existing)
                notifications.append(
                    AlarmNotification(
                        sensor_name=sensor.name,
                        sensor_unit=sensor.unit,
                        value=reading.value,
                        threshold_breached=breached,
                        severity=severity,
                        triggered_at=existing.triggered_at,
                        is_repeat=True,
                        sensor_id=sensor.id,
                        workspace_id=sensor.workspace_id,
                    )
                )
            # それ以外（重要度不変・再通知条件も満たさない）は何もしない（dedupe）
        elif existing is not None:
            if _still_breached_with_dead_band(
                sensor, reading.value, existing.threshold_breached, existing.severity
            ):
                # 不感帯の範囲内（閾値付近で値が揺れている）。まだ解除しない
                continue
            existing.resolved_at = reading.recorded_at
            existing.status = AlarmStatus.RESOLVED
            session.add(existing)
            del open_alarms[reading.sensor_id]

    return notifications
