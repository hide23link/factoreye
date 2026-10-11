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
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import EmailStr, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app.config import AuthMode, settings
from app.db.models import RefreshToken, User, Workspace
from app.db.session import get_session
from app.rate_limit import limiter
from app.schemas import CamelModel

router = APIRouter(prefix="/api", tags=["auth"])

# Authorization: Bearer の読み取り。
# 無ければ自動で 403 になる（ここでは利用者のトークンを必須にする）
_bearer = HTTPBearer()


# ── スキーマ ──────────────────────────────────────────────────


def _normalize_email_input(value: object) -> object:
    """メールの入力を、形式の検証より前に正規化する（前後の空白・大文字小文字）。"""
    return auth_utils.normalize_email(value) if isinstance(value, str) else value


class RegisterRequest(CamelModel):
    """新規登録の入力。メール・パスワード（8 文字以上）・ワークスペースの名前。"""

    email: EmailStr
    password: str = Field(min_length=8, max_length=100)
    workspace_name: str = Field(min_length=1, max_length=100)

    _normalize_email = field_validator("email", mode="before")(_normalize_email_input)


class LoginRequest(CamelModel):
    """ログインの入力。"""

    email: EmailStr
    password: str

    _normalize_email = field_validator("email", mode="before")(_normalize_email_input)


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


def _require_multi_tenant() -> None:
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


# 登録・ログインは、接続元ごとに 1 分あたりの回数を制限する（総当たり・大量登録の防止）
@router.post("/auth/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
async def register(
    request: Request,  # slowapi がレート制限キーの取得に使う
    body: RegisterRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    """新規登録: 利用者とワークスペースを作り、トークンを返す（1つのトランザクションで）。"""
    _require_multi_tenant()

    # 重複チェック
    # 正規化導入前から DB にある、大文字を含むメールとも突き合わせるため lower() で比べる
    existing = await session.exec(select(User).where(func.lower(User.email) == body.email))
    if existing.first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already registered")

    try:
        user = User(email=body.email, password_hash=auth_utils.hash_password(body.password))
        session.add(user)
        await session.flush()  # user.id を確定させてから workspace に使う

        workspace = Workspace(name=body.workspace_name, owner_id=user.id)
        session.add(workspace)
        await session.flush()

        # commit() 後は ORM 属性が expire するためコミット前にローカル変数へ保存
        user_id, workspace_id = user.id, workspace.id
        raw, token_hash = auth_utils.create_refresh_token()
        session.add(
            RefreshToken(
                user_id=user_id,
                workspace_id=workspace_id,
                token_hash=token_hash,
                expires_at=auth_utils.refresh_token_expiry(),
            )
        )
        await session.commit()
    except IntegrityError:
        # 同時登録で、上の事前確認をすり抜けて users.email の一意制約に当たった場合
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="email already registered"
        ) from None

    return TokenResponse(
        access_token=auth_utils.create_access_token(user_id, workspace_id),
        refresh_token=raw,
    )


@router.post("/auth/login", response_model=TokenResponse)
@limiter.limit("20/minute")
async def login(
    request: Request,  # slowapi がレート制限キーの取得に使う
    body: LoginRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    """ログイン: メールとパスワードを確かめて、トークンを返す。

    メールが無い場合と、パスワードが違う場合は、同じ文言（同じ 401）で返す。
    利用者の存在を推測させないため。
    """
    _require_multi_tenant()

    result = await session.exec(select(User).where(func.lower(User.email) == body.email))
    user = result.first()
    if user is None:
        # 未登録でも bcrypt の照合を走らせ、応答時間で登録の有無を推測させない
        auth_utils.verify_password(body.password, auth_utils.DUMMY_PASSWORD_HASH)
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

    # commit() 後は ORM 属性が expire するためコミット前にローカル変数へ保存
    user_id, workspace_id = user.id, workspace.id
    raw, token_hash = auth_utils.create_refresh_token()
    session.add(
        RefreshToken(
            user_id=user_id,
            workspace_id=workspace_id,
            token_hash=token_hash,
            expires_at=auth_utils.refresh_token_expiry(),
        )
    )
    await session.commit()

    return TokenResponse(
        access_token=auth_utils.create_access_token(user_id, workspace_id),
        refresh_token=raw,
    )


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    """リフレッシュトークンで、新しいアクセストークンと、新しいリフレッシュトークンを返す。

    使ったリフレッシュトークンは、その場で無効にする（ローテーション。盗まれても一度きり）。
    """
    _require_multi_tenant()

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
