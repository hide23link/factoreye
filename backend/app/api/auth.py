"""認証 API（Phase 0.5 / AUTH_MODE=multi_tenant 時のみ main.py でマウント）。

エンドポイント:
  POST /api/auth/register  → User + Workspace 作成、トークン発行
  POST /api/auth/login     → 認証、トークン発行
  POST /api/auth/refresh   → リフレッシュトークンでアクセストークン更新
  POST /api/auth/logout    → リフレッシュトークン失効
  GET  /api/me             → 現在のユーザー + ワークスペース情報
"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import EmailStr, Field
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app.config import AuthMode, settings
from app.db.models import RefreshToken, User, Workspace
from app.db.session import get_session
from app.schemas import CamelModel

router = APIRouter(prefix="/api", tags=["auth"])

_bearer = HTTPBearer()


# ── スキーマ ──────────────────────────────────────────────────


class RegisterRequest(CamelModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=100)
    workspace_name: str = Field(min_length=1, max_length=100)


class LoginRequest(CamelModel):
    email: EmailStr
    password: str


class TokenResponse(CamelModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(CamelModel):
    refresh_token: str


class MeResponse(CamelModel):
    user_id: UUID
    email: str
    workspace_id: UUID
    workspace_name: str
    plan: str


# ── 内部ヘルパー ──────────────────────────────────────────────


def _require_multi_tenant() -> None:
    if settings.auth_mode != AuthMode.MULTI_TENANT:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="auth is disabled (AUTH_MODE=disabled)",
        )


async def _get_current_user_workspace(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> tuple[User, Workspace]:
    _require_multi_tenant()
    exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = auth_utils.decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise exc from None

    user_id = payload.get("sub")
    workspace_id = payload.get("wid")
    if not user_id or not workspace_id:
        raise exc

    user = await session.get(User, UUID(user_id))
    workspace = await session.get(Workspace, UUID(workspace_id))
    if user is None or workspace is None:
        raise exc

    return user, workspace


# ── エンドポイント ────────────────────────────────────────────


@router.post("/auth/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    _require_multi_tenant()

    # 重複チェック
    existing = await session.exec(select(User).where(User.email == body.email))
    if existing.first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already registered")

    user = User(email=body.email, password_hash=auth_utils.hash_password(body.password))
    session.add(user)
    await session.flush()  # user.id を確定させてから workspace に使う

    workspace = Workspace(name=body.workspace_name, owner_id=user.id)
    session.add(workspace)
    await session.flush()

    raw, token_hash = auth_utils.create_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            workspace_id=workspace.id,
            token_hash=token_hash,
            expires_at=auth_utils.refresh_token_expiry(),
        )
    )
    await session.commit()

    return TokenResponse(
        access_token=auth_utils.create_access_token(user.id, workspace.id),
        refresh_token=raw,
    )


@router.post("/auth/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    _require_multi_tenant()

    result = await session.exec(select(User).where(User.email == body.email))
    user = result.first()
    if user is None or not auth_utils.verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid email or password",
        )

    # ユーザーの最初のワークスペースを使う（Phase 0.5: 1ユーザー=1ワークスペース前提）
    ws_result = await session.exec(select(Workspace).where(Workspace.owner_id == user.id))
    workspace = ws_result.first()
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="no workspace found"
        )

    raw, token_hash = auth_utils.create_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            workspace_id=workspace.id,
            token_hash=token_hash,
            expires_at=auth_utils.refresh_token_expiry(),
        )
    )
    await session.commit()

    return TokenResponse(
        access_token=auth_utils.create_access_token(user.id, workspace.id),
        refresh_token=raw,
    )


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    _require_multi_tenant()

    token_hash = auth_utils.hash_refresh_token(body.refresh_token)
    result = await session.exec(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked.is_(False),  # type: ignore[union-attr]
        )
    )
    stored = result.first()

    if stored is None or stored.expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired refresh token",
        )

    # ローテーション: 古いトークンを失効させ新しいトークンを発行
    stored.revoked = True
    session.add(stored)

    raw, new_hash = auth_utils.create_refresh_token()
    session.add(
        RefreshToken(
            user_id=stored.user_id,
            workspace_id=stored.workspace_id,
            token_hash=new_hash,
            expires_at=auth_utils.refresh_token_expiry(),
        )
    )
    await session.commit()

    return TokenResponse(
        access_token=auth_utils.create_access_token(stored.user_id, stored.workspace_id),
        refresh_token=raw,
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: RefreshRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    _require_multi_tenant()

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
