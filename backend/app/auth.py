"""JWT + パスワードユーティリティ（AUTH_MODE=multi_tenant 時に使用）。

トークンの種類:
- アクセストークン（JWT）: API の呼び出しに使う。短い期限（既定 15 分）。中に利用者 ID と
  ワークスペース ID（wid）を持つ
- リフレッシュトークン: アクセストークンを再発行するための長い期限（既定 30 日）。生の値は保存せず、
  SHA-256 のハッシュだけを DB に保存する
- 管理者トークン: 管理者 API 専用。wid を持たないので、通常の API には使えない
"""
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import bcrypt as _bcrypt
import jwt

from app.config import settings


def hash_password(plain: str) -> str:
    """パスワードを bcrypt でハッシュ化する（ソルト付き。保存するのはこの結果だけ）。"""
    return _bcrypt.hashpw(plain.encode("utf-8"), _bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    """入力されたパスワードが、保存されたハッシュと一致するかを確かめる。"""
    return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))


def create_access_token(user_id: UUID, workspace_id: UUID) -> str:
    """利用者のアクセストークン（JWT）を作る。sub=利用者、wid=ワークスペース、exp=期限。"""
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


# 管理者トークンの role の値（通常の利用者のトークンには role が無い）
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
    """(raw_token, sha256_hex) を返す。DBにはハッシュのみ保存。

    raw（生の値）は利用者に一度だけ返し、保存しない。secrets は推測されにくい乱数を作る。
    """
    raw = secrets.token_urlsafe(64)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    return raw, token_hash


def hash_refresh_token(raw: str) -> str:
    """受け取ったリフレッシュトークンを、保存と同じ方法でハッシュ化する（照合に使う）。"""
    return hashlib.sha256(raw.encode()).hexdigest()


def refresh_token_expiry() -> datetime:
    """リフレッシュトークンの期限（今から設定日数後）。"""
    return datetime.now(UTC) + timedelta(days=settings.jwt_refresh_expire_days)
