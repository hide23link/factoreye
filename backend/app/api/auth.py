"""認証 API（Phase 0.5 / AUTH_MODE=multi_tenant 時のみ main.py でマウント）。

エンドポイント:
  POST /api/auth/refresh   → リフレッシュトークンでアクセストークン更新
  POST /api/auth/logout    → リフレッシュトークン失効
  GET  /api/me             → 現在のユーザー + ワークスペース情報

登録とログインは、パスキーで行う（api/passkeys.py）。パスワードは使わない。
（以前の POST /api/auth/register と /api/auth/login は、パスキー導入で廃止した）

【呼ばれ方】画面のログイン状態の維持・ログアウトが呼ぶ。本文は JSON（例: {"refreshToken": "..."}）。
アクセストークンは短い期限（15分）、リフレッシュトークンは長い期限（180日。使うたびに延びる）。
詳細は app/auth.py。
"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app.config import AuthMode, settings
from app.db.models import RefreshToken, User, Workspace
from app.db.session import get_session
from app.schemas import CamelModel

router = APIRouter(prefix="/api", tags=["auth"])

# Authorization: Bearer の読み取り。
# 無ければ自動で 403 になる（ここでは利用者のトークンを必須にする）
_bearer = HTTPBearer()


# ── スキーマ ──────────────────────────────────────────────────


class TokenResponse(CamelModel):
    """トークンの応答。

    access_token は API に使う。refresh_token は再発行にだけ使う（保存は利用者側）。
    """

    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(CamelModel):
    """トークン再発行・ログアウトの入力（リフレッシュトークン）。"""

    refresh_token: str


class MeResponse(CamelModel):
    """ログイン中の利用者と、そのワークスペースの情報。"""

    user_id: UUID
    email: str
    workspace_id: UUID
    workspace_name: str
    plan: str


# ── 内部ヘルパー ──────────────────────────────────────────────


def require_multi_tenant() -> None:
    """SaaS モードでないなら 501。self-hosted では、認証の API は使えない。"""
    if settings.auth_mode != AuthMode.MULTI_TENANT:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="auth is disabled (AUTH_MODE=disabled)",
        )


async def _get_current_user_workspace(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> tuple[User, Workspace]:
    """アクセストークンから、利用者とワークスペースを取り出す。無効なら 401。"""
    require_multi_tenant()
    error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = auth_utils.decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise error from None

    user_id = payload.get("sub")
    workspace_id = payload.get("wid")
    if not user_id or not workspace_id:
        raise error

    user = await session.get(User, UUID(user_id))
    workspace = await session.get(Workspace, UUID(workspace_id))
    if user is None or workspace is None:
        raise error

    return user, workspace


# ── エンドポイント ────────────────────────────────────────────


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    """リフレッシュトークンで、新しいアクセストークンと、新しいリフレッシュトークンを返す。

    使ったリフレッシュトークンは、その場で無効にする（ローテーション。盗まれても一度きり）。
    """
    require_multi_tenant()

    token_hash = auth_utils.hash_refresh_token(body.refresh_token)
    result = await session.exec(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked.is_(False),  # type: ignore[attr-defined]
        )
    )
    stored = result.first()

    if stored is None or stored.expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired refresh token",
        )

    # commit() 後は ORM 属性が expire するためコミット前にローカル変数へ保存
    user_id, workspace_id = stored.user_id, stored.workspace_id

    # ローテーション: 古いトークンを失効させ新しいトークンを発行
    stored.revoked = True
    session.add(stored)

    raw, new_hash = auth_utils.create_refresh_token()
    session.add(
        RefreshToken(
            user_id=user_id,
            workspace_id=workspace_id,
            token_hash=new_hash,
            expires_at=auth_utils.refresh_token_expiry(),
        )
    )
    await session.commit()

    return TokenResponse(
        access_token=auth_utils.create_access_token(user_id, workspace_id),
        refresh_token=raw,
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: RefreshRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """ログアウト: リフレッシュトークンを無効にする。既に無効・存在しなくても、エラーにはしない。"""
    require_multi_tenant()

    token_hash = auth_utils.hash_refresh_token(body.refresh_token)
    result = await session.exec(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    )
    stored = result.first()
    if stored and not stored.revoked:
        stored.revoked = True
        session.add(stored)
        await session.commit()


@router.get("/me", response_model=MeResponse)
async def me(
    user_workspace: Annotated[tuple[User, Workspace], Depends(_get_current_user_workspace)],
) -> MeResponse:
    user, workspace = user_workspace
    return MeResponse(
        user_id=user.id,
        email=user.email,
        workspace_id=workspace.id,
        workspace_name=workspace.name,
        plan=workspace.plan,
    )
