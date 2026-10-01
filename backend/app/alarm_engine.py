"""アラーム評価エンジン: batch flush内でReading INSERT直後に閾値比較・dedupe・解除判定。

docs/factoreye-architecture.md §アラーム評価 & デデュープ 参照。
"""
from typing import TYPE_CHECKING

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Alarm, AlarmStatus, Sensor, ThresholdBreached
from app.notifications import AlarmNotification

if TYPE_CHECKING:
    # 実行時のimportはapp.ingest_buffer側で行う（循環import回避のため型チェック専用）
    from app.ingest_buffer import PendingReading


def _check_threshold(sensor: Sensor, value: float) -> ThresholdBreached | None:
    if sensor.threshold_max is not None and value > sensor.threshold_max:
        return ThresholdBreached.MAX
    if sensor.threshold_min is not None and value < sensor.threshold_min:
        return ThresholdBreached.MIN
    return None


async def evaluate_alarms(
    session: AsyncSession, pending: "list[PendingReading]"
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

        breached = _check_threshold(sensor, p.value)
        existing = open_alarms.get(p.sensor_id)

        if breached is not None:
            if existing is None:
                alarm = Alarm(
                    sensor_id=p.sensor_id,
                    value=p.value,
                    threshold_breached=breached,
                    triggered_at=p.recorded_at,
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
                        triggered_at=p.recorded_at,
                    )
                )
            # 既存のactive/acknowledgedアラームがある場合は新規作成しない（dedupe）
        elif existing is not None:
            existing.resolved_at = p.recorded_at
            existing.status = AlarmStatus.RESOLVED
            session.add(existing)
            del open_alarms[p.sensor_id]

    return notifications
