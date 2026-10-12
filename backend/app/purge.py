"""定期削除バッチ（Free Tier の 90日データ、期限切れのリフレッシュトークン）。

毎日 UTC 03:00 に実行し、90日以上前の Reading と、有効期限が切れたリフレッシュトークンを削除する。
Reading は self-hosted（workspace_id IS NULL のセンサー）を対象外とする。

なぜ SaaS だけか: OSS（self-hosted）の利用者は、測定値を無期限に残すかどうかを自分で決める。
SaaS の無料枠では、保存量を一定に保つため、古い測定値を消す。
"""
import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import delete, select
from sqlalchemy.engine import CursorResult
from sqlmodel import col
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Reading, RefreshToken, Sensor
from app.db.session import engine

# 測定値を残す日数（SaaS の無料枠の上限）
_RETENTION_DAYS = 90
# 有効期限が切れてから、リフレッシュトークンを残す日数。
# 期限切れのトークンは更新に使えない（auth.refresh が拒否する）ので、削除しても挙動は変わらない。
# 時計のずれや、障害調査で直近の行を見たい場合に備えて、少しだけ残す
_REFRESH_TOKEN_GRACE_DAYS = 7
# 1 回の DELETE で消す最大件数。大量にあっても、長いロックを取らないための区切り
_PURGE_BATCH_SIZE = 1000
_logger = logging.getLogger(__name__)


async def purge_old_readings() -> int:
    """90日以上前の Reading を削除し、削除件数を返す。"""
    cutoff = datetime.now(UTC) - timedelta(days=_RETENTION_DAYS)

    # 対象は、ワークスペースに属するセンサー（workspace_id が NULL でないもの）の測定値だけ。
    # self-hosted のセンサーは、この条件に入らないので消えない
    multi_tenant_sensor_ids = select(col(Sensor.id)).where(col(Sensor.workspace_id).is_not(None))

    stmt = (
        delete(Reading)
        .where(
            col(Reading.recorded_at) < cutoff,
            col(Reading.sensor_id).in_(multi_tenant_sensor_ids),
        )
        .execution_options(synchronize_session=False)
    )

    # 削除は1回の SQL で行う（件数が多くても、1件ずつ消さない）
    async with AsyncSession(engine) as session:
        result = cast(CursorResult[Any], await session.execute(stmt))
        await session.commit()

    deleted = result.rowcount
    _logger.info("purge_old_readings: deleted %d rows (cutoff=%s)", deleted, cutoff.date())
    return deleted


async def purge_expired_refresh_tokens() -> int:
    """有効期限（expires_at）が切れて猶予を過ぎたリフレッシュトークンを削除し、削除件数を返す。

    消すのは「期限が過ぎたもの」だけ。失効済み（revoked）でも期限内の行は消さない
    （ローテーション・ログアウトの後も、期限までは行が残る）。失効済みかどうかは条件に入れない:
    期限切れなら、失効していてもしていなくても更新には使えないため。
    ユーザーやワークスペースは見ないので、self-hosted（テーブルが空）でも副作用はない。
    件数が多い場合は、_PURGE_BATCH_SIZE 件ずつ別のトランザクションで消す。
    """
    cutoff = datetime.now(UTC) - timedelta(days=_REFRESH_TOKEN_GRACE_DAYS)
    expired_ids = (
        select(col(RefreshToken.id))
        .where(col(RefreshToken.expires_at) < cutoff)
        .limit(_PURGE_BATCH_SIZE)
    )
    stmt = (
        delete(RefreshToken)
        .where(col(RefreshToken.id).in_(expired_ids))
        .execution_options(synchronize_session=False)
    )

    deleted = 0
    while True:
        async with AsyncSession(engine) as session:
            result = cast(CursorResult[Any], await session.execute(stmt))
            await session.commit()
        batch = result.rowcount
        deleted += batch
        if batch < _PURGE_BATCH_SIZE:
            break

    _logger.info(
        "purge_expired_refresh_tokens: deleted %d rows (cutoff=%s)", deleted, cutoff.date()
    )
    return deleted


async def purge_loop() -> None:
    """毎日 UTC 03:00 に、測定値とリフレッシュトークンの削除を実行するループ（常駐タスク）。

    次の実行時刻を計算して眠り、起きたら削除する。失敗しても、ループは止めずに次の日を待つ。
    片方が失敗しても、もう片方は実行する。
    """
    while True:
        now = datetime.now(UTC)
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        wait_seconds = (next_run - now).total_seconds()
        _logger.info("purge_loop: next run at %s (%.0fs)", next_run.isoformat(), wait_seconds)
        await asyncio.sleep(wait_seconds)
        for job in (purge_old_readings, purge_expired_refresh_tokens):
            try:
                await job()
            except Exception:
                _logger.exception("purge_loop: error during %s", job.__name__)
