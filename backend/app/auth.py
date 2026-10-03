"""JWT + パスワードユーティリティ（AUTH_MODE=multi_tenant 時に使用）。"""
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
from passlib.context import CryptContext

from app.config import settings

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_context.verify(plain, hashed)


def create_access_token(user_id: UUID, workspace_id: UUID) -> str:
    expire = datetime.now(UTC) + timedelta(minutes=settings.jwt_access_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "wid": str(workspace_id), "exp": expire},
        settings.jwt_secret,
        algorithm="HS256",
    )


def decode_access_token(token: str) -> dict[str, str]:
    """デコードして payload を返す。無効/期限切れは jwt.PyJWTError を送出。"""
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])  # type: ignore[no-any-return]


def create_refresh_token() -> tuple[str, str]:
    """(raw_token, sha256_hex) を返す。DBにはハッシュのみ保存。"""
    raw = secrets.token_urlsafe(64)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, token_hash


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def refresh_token_expiry() -> datetime:
    return datetime.now(UTC) + timedelta(days=settings.jwt_refresh_expire_days)
