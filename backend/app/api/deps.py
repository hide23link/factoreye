"""共通API依存関係。"""
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app.config import AuthMode, settings
from app.db.session import get_session

_bearer = HTTPBearer(auto_error=False)


async def verify_ingest_api_key(x_api_key: str = Header(...)) -> None:
    """Self-hosted: .env の共有シークレット（INGEST_API_KEY）と比較。

    SaaS向けのワークスペース別write鍵（Phase 0.5）は対象外。
    """
    if x_api_key != settings.ingest_api_key:
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
