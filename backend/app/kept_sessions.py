"""キオスク用の永久ログイン（期限のないリフレッシュトークン）の、DB を使う部分。

壁掛けの画面など、ログインし直す人がいない端末のために、利用者が選んだ端末だけ、ログインを
期限なしにできる。ローテーション（使うたびにトークンを替える）は、通常どおり行い、新しいトークン
も期限なしで引き継ぐ（auth.py の refresh）。止めるのは、利用者の「ログインを終了」と、
管理者のリセット（全部失効）、ログアウト。

【リスク】期限のないトークンを持つ端末を盗まれると、その人は、利用者の全権限でログインし続けられる
（利用者が気づいて「ログインを終了」するまで）。端末の盗難・紛失に気をつけ、選ぶ画面にも書く。
承認: ユーザー（2026-11-23）。判断の経緯は docs/decisions.md。

【誰が使うか】api/passkeys.py（キオスク用ログインの一覧・設定・終了）。
"""
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import update
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app.db.models import RefreshToken


class KeptSessionError(Exception):
    """永久ログインにできない・見つからない（reason は API の detail に使う短い英語）。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


async def keep_signed_in(
    session: AsyncSession, user_id: UUID, raw_refresh_token: str, device_name: str
) -> RefreshToken:
    """この端末のログイン（リフレッシュトークン）を、期限なしにする。コミットは呼び出し側。

    渡されたリフレッシュトークンが、この利用者のもので、有効（失効していない・期限内）なときだけ。
    すでに期限なしなら、名前だけ変える。
    """
    stored = (
        await session.exec(
            select(RefreshToken).where(
                col(RefreshToken.token_hash) == auth_utils.hash_refresh_token(raw_refresh_token),
                col(RefreshToken.user_id) == user_id,
                col(RefreshToken.revoked).is_(False),
            )
        )
    ).first()
    now = datetime.now(UTC)
    if stored is None or (
        stored.expires_at is not None and stored.expires_at.replace(tzinfo=UTC) < now
    ):
        raise KeptSessionError("invalid or expired refresh token")
    stored.device_name = device_name
    if stored.expires_at is not None or stored.series_id is None:
        stored.expires_at = None
        stored.series_id = uuid4()
        stored.started_at = now
        stored.last_used_at = now
    session.add(stored)
    return stored


async def list_kept(session: AsyncSession, user_id: UUID) -> list[RefreshToken]:
    """この利用者の、永久ログインの端末（有効なもの）。1 端末につき 1 行（今のトークン）。"""
    rows = await session.exec(
        select(RefreshToken)
        .where(
            col(RefreshToken.user_id) == user_id,
            col(RefreshToken.revoked).is_(False),
            col(RefreshToken.expires_at).is_(None),
            col(RefreshToken.series_id).is_not(None),
        )
        .order_by(col(RefreshToken.started_at))
    )
    return list(rows.all())


async def end_kept(session: AsyncSession, user_id: UUID, series_id: UUID) -> None:
    """永久ログインの端末を終了する（その端末のトークンを失効）。無ければ失敗。コミットは呼び出し側。"""
    result = await session.execute(
        update(RefreshToken)
        .where(
            col(RefreshToken.user_id) == user_id,
            col(RefreshToken.series_id) == series_id,
            col(RefreshToken.revoked).is_(False),
            col(RefreshToken.expires_at).is_(None),
        )
        .values(revoked=True)
        .returning(col(RefreshToken.id))
    )
    if result.first() is None:
        raise KeptSessionError("kept session not found")
