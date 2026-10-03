"""JWT + パスワードユーティリティ（AUTH_MODE=multi_tenant 時に使用）。"""
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import bcrypt as _bcrypt
import jwt

from app.config import settings


def hash_password(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode("utf-8"), _bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))


def create_access_token(user_id: UUID, workspace_id: UUID) -> str:
    expire = datetime.now(UTC) + timedelta(minutes=settings.jwt_access_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "wid": str(workspace_id), "exp": expire},
        settings.jwt_secret,
        algorithm="HS256",
    )


def decode_access_token(token: str) -> dict[str, str]:
    """デコードして payload を返す。無効/期限切れは jwt.PyJWTError を送出。"""
    payload: dict[str, str] = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    return payload


ADMIN_ROLE = "admin"


def create_admin_access_token(admin_id: str) -> str:
    """管理者用トークン。wid を持たないので通常APIでは使えず、role=admin で管理者APIだけ通す。
    sub は管理者ID（admin_accounts のファイル上のID）。DB のユーザーではない。"""
    expire = datetime.now(UTC) + timedelta(minutes=settings.admin_access_expire_minutes)
    return jwt.encode(
        {"sub": admin_id, "role": ADMIN_ROLE, "exp": expire},
        settings.jwt_secret,
        algorithm="HS256",
    )


def create_refresh_token() -> tuple[str, str]:
    """(raw_token, sha256_hex) を返す。DBにはハッシュのみ保存。"""
    raw = secrets.token_urlsafe(64)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, token_hash


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def refresh_token_expiry() -> datetime:
    return datetime.now(UTC) + timedelta(days=settings.jwt_refresh_expire_days)
