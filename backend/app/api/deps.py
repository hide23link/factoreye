"""共通API依存関係。"""
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel.ext.asyncio.session import AsyncSession

from app import admin_accounts
from app import auth as auth_utils
from app.config import AuthMode, settings
from app.db.session import get_session

_bearer = HTTPBearer(auto_error=False)


async def verify_ingest_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Ingest エンドポイント認証。
    - AUTH_MODE=disabled (self-hosted): X-API-Key ヘッダーと .env の共有シークレットを比較
    - AUTH_MODE=multi_tenant (SaaS): センサーの ingest_key が body にあるのでヘッダー認証は不要
    """
    if settings.auth_mode == AuthMode.MULTI_TENANT:
        return  # multi-tenant: body の ingest_key がセンサー単位の認証になる
    if x_api_key is None or x_api_key != settings.ingest_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid API key")


async def get_current_workspace_id(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UUID | None:
    """AUTH_MODE=multi_tenant 時: JWTを検証しworkspace_idを返す。
    AUTH_MODE=disabled 時: None を返す（Sprint 2でAPIのスコープフィルタに使用）。
    """
    if settings.auth_mode != AuthMode.MULTI_TENANT:
        return None

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = auth_utils.decode_access_token(credentials.credentials)
        wid = payload.get("wid")
        if not wid:
            raise ValueError("missing wid")
        return UUID(wid)
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None


async def require_admin(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> str:
    """管理者APIの認可。管理者トークン（role=admin）で、かつ管理者ファイルにそのIDが
    まだ存在する場合だけ通す。ファイルから削除された管理者は、トークンが有効期限内でも即座に拒否される。
    戻り値は管理者ID。"""
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="admin authentication required",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None:
        raise unauthorized
    try:
        payload = auth_utils.decode_access_token(credentials.credentials)
        if payload.get("role") != auth_utils.ADMIN_ROLE:
            raise unauthorized
        admin_id = payload["sub"]
    except (jwt.PyJWTError, KeyError):
        raise unauthorized from None

    if not admin_accounts.admin_exists(admin_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="not an administrator")
    return admin_id
