"""JWT + パスワードユーティリティ（AUTH_MODE=multi_tenant 時に使用）。

トークンの種類:
- アクセストークン（JWT）: API の呼び出しに使う。短い期限（既定 15 分）。中に利用者 ID と
  ワークスペース ID（wid）を持つ
- リフレッシュトークン: アクセストークンを再発行するための長い期限（既定 30 日）。生の値は保存せず、
  SHA-256 のハッシュだけを DB に保存する
- 管理者トークン: 管理者 API 専用。wid を持たないので、通常の API には使えない

【誰が使うか】api/auth.py（登録・ログイン）、api/admin.py（管理者ログイン）、
api/deps.py（トークンの確認）が、`from app import auth as auth_utils` として呼ぶ。
"""
import asyncio
import hashlib
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

import bcrypt as _bcrypt
import jwt

from app.config import settings

# bcrypt が受け付けるパスワードの最大バイト数（UTF-8）。超える入力は bcrypt が ValueError を出す
MAX_PASSWORD_BYTES = 72


def hash_password(plain: str) -> str:
    """パスワードを bcrypt でハッシュ化する（ソルト付き。保存するのはこの結果だけ）。"""
    return _bcrypt.hashpw(plain.encode("utf-8"), _bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    """入力されたパスワードが、保存されたハッシュと一致するかを確かめる。

    一致しない入力は False にする。bcrypt に渡すと例外（500）になる、次の 2 つも含む。
    - 72 バイトを超える入力（登録できないので、一致しえない）
    - UTF-8 にできない文字（孤立サロゲート）を含む入力
    どちらも、先頭 72 バイト（または代用の入力）で照合を 1 回走らせて結果を捨て、
    他の失敗と時間をそろえる。
    """
    hashed_bytes = hashed.encode("ascii")
    try:
        data = plain.encode("utf-8")
    except UnicodeEncodeError:
        _bcrypt.checkpw(b"\x00", hashed_bytes)
        return False
    if len(data) > MAX_PASSWORD_BYTES:
        _bcrypt.checkpw(data[:MAX_PASSWORD_BYTES], hashed_bytes)
        return False
    return _bcrypt.checkpw(data, hashed_bytes)


# bcrypt は 1 回 200ms 前後の CPU 処理。async def の中で直接呼ぶとイベントループが止まり、
# 同じプロセスの取り込みや /health まで待たされる。別スレッドで実行する（GIL は解放される）。
# 認証の連打で、既定のスレッドプールを埋めて他の to_thread を飢えさせないよう、同時実行数を絞る
_AUTH_CONCURRENCY = 4
_auth_semaphore = asyncio.Semaphore(_AUTH_CONCURRENCY)


async def run_blocking_auth[**P, R](
    func: Callable[P, R], /, *args: P.args, **kwargs: P.kwargs
) -> R:
    """bcrypt を使う同期関数を、イベントループを止めずに実行する（同時実行数に上限あり）。"""
    async with _auth_semaphore:
        return await asyncio.to_thread(func, *args, **kwargs)


async def hash_password_async(plain: str) -> str:
    """hash_password を別スレッドで実行する。"""
    return await run_blocking_auth(hash_password, plain)


async def verify_password_async(plain: str, hashed: str) -> bool:
    """verify_password を別スレッドで実行する。"""
    return await run_blocking_auth(verify_password, plain, hashed)


def create_access_token(user_id: UUID, workspace_id: UUID) -> str:
    """利用者のアクセストークン（JWT）を作る。sub=利用者、wid=ワークスペース、exp=期限。"""
    expire = datetime.now(UTC) + timedelta(minutes=settings.jwt_access_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "wid": str(workspace_id), "exp": expire},
        settings.jwt_secret,
        algorithm="HS256",
    )


def create_impersonation_token(
    user_id: UUID, workspace_id: UUID, admin_id: str
) -> tuple[str, datetime]:
    """管理者が利用者として閲覧するためのトークン。通常の利用者のトークンと同じ形だが、
    imp（操作した管理者の ID）を持ち、有効期限は短い。リフレッシュは発行しない。
    戻り値は（トークン, 期限）。"""
    expire = datetime.now(UTC) + timedelta(minutes=settings.impersonation_expire_minutes)
    token = jwt.encode(
        {"sub": str(user_id), "wid": str(workspace_id), "imp": admin_id, "exp": expire},
        settings.jwt_secret,
        algorithm="HS256",
    )
    return token, expire


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


def normalize_email(email: str) -> str:
    """メールを、保存・照合用に正規化する（前後の空白を除き、全体を小文字にする）。

    `Foo@example.com` と `foo@example.com` を別のアカウントにしないため。
    """
    return email.strip().lower()


# bcryptの時間差を作るためのダミーハッシュ（存在しないメール・IDのログイン時に照合を走らせる）
DUMMY_PASSWORD_HASH = hash_password("dummy-password-for-timing")
