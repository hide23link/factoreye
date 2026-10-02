"""アラーム評価エンジン: batch flush内でReading INSERT直後に閾値比較・dedupe・解除判定。

docs/factoreye-architecture.md §アラーム評価 & デデュープ 参照。
"""
from datetime import timedelta
from typing import TYPE_CHECKING

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import (
    Alarm,
    AlarmSeverity,
    AlarmStatus,
    NotificationSettings,
    Sensor,
    ThresholdBreached,
)
from app.notifications import AlarmNotification

if TYPE_CHECKING:
    # 実行時のimportはapp.ingest_buffer側で行う（循環import回避のため型チェック専用）
    from app.ingest_buffer import PendingReading


def _check_threshold(
    sensor: Sensor, value: float
) -> tuple[ThresholdBreached, AlarmSeverity] | None:
    """重故障（より極端な値）を優先して判定し、無ければ軽故障を判定する。"""
    if sensor.threshold_max_critical is not None and value > sensor.threshold_max_critical:
        return ThresholdBreached.MAX, AlarmSeverity.CRITICAL
    if sensor.threshold_min_critical is not None and value < sensor.threshold_min_critical:
        return ThresholdBreached.MIN, AlarmSeverity.CRITICAL
    if sensor.threshold_max_warning is not None and value > sensor.threshold_max_warning:
        return ThresholdBreached.MAX, AlarmSeverity.WARNING
    if sensor.threshold_min_warning is not None and value < sensor.threshold_min_warning:
        return ThresholdBreached.MIN, AlarmSeverity.WARNING
    return None


def _threshold_value(
    sensor: Sensor, breached: ThresholdBreached, severity: AlarmSeverity
) -> float | None:
    if breached == ThresholdBreached.MAX:
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
    sensor: Sensor, value: float, breached: ThresholdBreached, severity: AlarmSeverity
) -> bool:
    """不感帯を考慮した解除判定。発生時に使った閾値まで戻っただけでは解除しない
    （閾値 ∓ 不感帯を超えて戻るまで「まだ発生中」とみなし、チラつきを防ぐ）。"""
    threshold = _threshold_value(sensor, breached, severity)
    if threshold is None:
        return False
    band = sensor.threshold_dead_band
    if breached == ThresholdBreached.MAX:
        return value > threshold - band
    return value < threshold + band


async def evaluate_alarms(
    session: AsyncSession,
    pending: "list[PendingReading]",
    notif_settings: NotificationSettings | None,
) -> list[AlarmNotification]:
    """新規に発火したAlarmの通知用データを返す（ORMオブジェクトはセッション終了後に参照できないため）。"""
    sensor_ids = {p.sensor_id for p in pending}
    if not sensor_ids:
        return []

    sensors_result = await session.exec(
        select(Sensor).where(Sensor.id.in_(sensor_ids))  # type: ignore[attr-defined]
    )
    sensors_by_id = {s.id: s for s in sensors_result.all()}

    open_result = await session.exec(
        select(Alarm).where(
            Alarm.sensor_id.in_(sensor_ids),  # type: ignore[attr-defined]
            Alarm.status != AlarmStatus.RESOLVED,
        )
    )
    open_alarms = {a.sensor_id: a for a in open_result.all()}

    notifications: list[AlarmNotification] = []

    for p in pending:
        sensor = sensors_by_id.get(p.sensor_id)
        if sensor is None:
            continue

        breach = _check_threshold(sensor, p.value)
        existing = open_alarms.get(p.sensor_id)

        if breach is not None:
            breached, severity = breach
            if existing is None:
                alarm = Alarm(
                    sensor_id=p.sensor_id,
                    value=p.value,
                    threshold_breached=breached,
                    severity=severity,
                    triggered_at=p.recorded_at,
                    last_notified_at=p.recorded_at,
                )
                session.add(alarm)
                open_alarms[p.sensor_id] = alarm
                # sensor.name/unitはセッションがまだ開いている今のうちにプレーン値へ退避する
                notifications.append(
                    AlarmNotification(
                        sensor_name=sensor.name,
                        sensor_unit=sensor.unit,
                        value=p.value,
                        threshold_breached=breached,
                        severity=severity,
                        triggered_at=p.recorded_at,
                    )
                )
            elif existing.severity != severity:
                # 同じ発生中アラームのまま重要度が変化（軽故障→重故障 or 逆）。
                # 新規アラームは作らず重要度を更新し、重要度が変わったこと自体を再通知する
                existing.value = p.value
                existing.severity = severity
                existing.threshold_breached = breached
                existing.last_notified_at = p.recorded_at
                session.add(existing)
                notifications.append(
                    AlarmNotification(
                        sensor_name=sensor.name,
                        sensor_unit=sensor.unit,
                        value=p.value,
                        threshold_breached=breached,
                        severity=severity,
                        triggered_at=p.recorded_at,
                    )
                )
            elif (
                severity == AlarmSeverity.CRITICAL
                and notif_settings is not None
                and notif_settings.critical_repeat_enabled
                and existing.last_notified_at is not None
                and p.recorded_at - existing.last_notified_at
                >= timedelta(minutes=notif_settings.critical_repeat_interval_minutes)
            ):
                # 重故障が未解決のまま設定時間を超えて継続している。再通知する
                # （元のtriggered_atは変えず、いつ最初に発生したかが分かるようにする）
                existing.value = p.value
                existing.last_notified_at = p.recorded_at
                session.add(existing)
                notifications.append(
                    AlarmNotification(
                        sensor_name=sensor.name,
                        sensor_unit=sensor.unit,
                        value=p.value,
                        threshold_breached=breached,
                        severity=severity,
                        triggered_at=existing.triggered_at,
                        is_repeat=True,
                    )
                )
            # それ以外（重要度不変・再通知条件も満たさない）は何もしない（dedupe）
        elif existing is not None:
            if _still_breached_with_dead_band(
                sensor, p.value, existing.threshold_breached, existing.severity
            ):
                # 不感帯の範囲内（閾値付近で値が揺れている）。まだ解除しない
                continue
            existing.resolved_at = p.recorded_at
            existing.status = AlarmStatus.RESOLVED
            session.add(existing)
            del open_alarms[p.sensor_id]

    return notifications
