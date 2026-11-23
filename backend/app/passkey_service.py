"""パスキー認証の、DB を使う部分（メールのリンク・チャレンジ・アカウントの作成・トークンの発行）。

HTTP の入口は api/passkeys.py（利用者）と api/admin.py（管理者のリセット）。
ここは「何をどの順に DB へ書くか」だけを持ち、WebAuthn の検証は webauthn_utils.py、
メールの送信は mailer.py に任せる。

流れ（承認済みの仕様）:
 - 登録: メールのリンクを開く → パスキーを登録 → その時はじめて、利用者とワークスペースを作る
   （メールを確認する前は、利用者を作らない）
 - 端末の再登録: 登録済みのアドレスへ、1 時間のリンクを送る。開いて、新しい端末のパスキーを足す
 - 登録の依頼と再登録の依頼は、同じ入口（request_email_link）。アドレスが登録済みかどうかで
   リンクの種類を変えるが、画面への応答は同じにする（登録の有無を推測させない）

【呼ばれ方】トークンは「生の値」をメールにだけ載せ、DB には SHA-256 のハッシュだけを残す。
"""
import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import update
from sqlmodel import col, delete, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app import mailer
from app.config import settings
from app.db.models import AuthChallenge, EmailToken, Passkey, RefreshToken, User, Workspace
from app.webauthn_utils import VerifiedPasskey

_logger = logging.getLogger(__name__)

# メールのリンクの種類
PURPOSE_REGISTER = "register"
PURPOSE_RECOVER = "recover"
# パスキーが使えない端末のための、メールのログインリンク。ログインだけができ、パスキーの登録は
# できない（register・recover のリンクだけが、パスキーの登録を許す）
PURPOSE_LOGIN = "login"

# ログインの方法（リフレッシュトークン・アクセストークンの via に入れる）
LOGIN_PASSKEY = "passkey"
LOGIN_EMAIL = "email"
LOGIN_RECOVER = "recover"
# 端末（パスキー）の管理を許すログインの方法。メールのログインリンクだけで入った状態は許さない
# （メール 1 本で、端末の入れ替えまで奪われないように）
PASSKEY_MANAGEMENT_METHODS = frozenset({LOGIN_PASSKEY, LOGIN_RECOVER})

# チャレンジの種類
CHALLENGE_REGISTER = "register"  # メールのリンクから登録する
CHALLENGE_ADD = "add"  # ログイン中に、端末（パスキー）を足す
CHALLENGE_LOGIN = "login"

REGISTER_LINK_TTL = timedelta(hours=24)
RECOVER_LINK_TTL = timedelta(hours=1)
LOGIN_LINK_TTL = timedelta(minutes=15)
CHALLENGE_TTL = timedelta(minutes=5)
# 同じアドレスへ、メールを送る回数の上限（1 時間あたり。登録・再登録・ログインリンク・
# 管理者のリセットの合計）
EMAIL_LINKS_PER_HOUR = 3
# 1 人が持てるパスキーの数（端末の数）の上限
MAX_PASSKEYS_PER_USER = 10
# 使い終わったメールのトークンを残す日数（これを過ぎたら、次の依頼のときに消す）
EMAIL_TOKEN_KEEP_DAYS = 7


class PasskeyServiceError(Exception):
    """利用者に返すべき失敗（reason は API の detail にそのまま使う短い英語）。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _now() -> datetime:
    return datetime.now(UTC)


def _hash_link_token(raw: str) -> str:
    """メールのリンクのトークンを、保存・照合用にハッシュ化する（SHA-256）。"""
    return hashlib.sha256(raw.encode()).hexdigest()


def workspace_name_from_email(email: str) -> str:
    """ワークスペースの名前を、メールアドレスの @ の前から作る（あとから設定で変えられる）。"""
    name = email.split("@", 1)[0].strip()[:100]
    return name or "workspace"


def build_link(purpose: str, raw_token: str) -> str:
    """メールに載せる URL。トークンは # のあとに置く（サーバーのアクセスログに残らない）。"""
    return f"{settings.frontend_url.rstrip('/')}/#{purpose}={raw_token}"


# ── メールのリンク ────────────────────────────────────────────


async def purge_expired(session: AsyncSession) -> None:
    """期限切れのチャレンジと、古いメールのトークンを消す（依頼のたびに、ついでに行う）。"""
    now = _now()
    await session.execute(delete(AuthChallenge).where(col(AuthChallenge.expires_at) < now))
    await session.execute(
        delete(EmailToken).where(
            col(EmailToken.created_at) < now - timedelta(days=EMAIL_TOKEN_KEEP_DAYS)
        )
    )


async def request_email_link(
    session: AsyncSession, email: str, *, force_recover_for: UUID | None = None
) -> tuple[str, str] | None:
    """メールのリンクを作る。戻り値は（生のトークン, 種類）。送る回数の上限なら None。

    force_recover_for は管理者のリセット用: 指定した利用者への再登録のリンクにする。
    アドレスが未登録なら、これから作る利用者の ID を先に決め（WebAuthn の user.id に使う）、
    登録のリンクにする。登録済みなら、端末の再登録のリンクにする。
    """
    await purge_expired(session)
    since = _now() - timedelta(hours=1)
    recent = (
        await session.exec(
            select(func.count())
            .select_from(EmailToken)
            .where(col(EmailToken.email) == email, col(EmailToken.created_at) > since)
        )
    ).one()
    if recent >= EMAIL_LINKS_PER_HOUR:
        await session.commit()
        return None

    user_id: UUID | None = force_recover_for
    if user_id is None:
        existing = (
            await session.exec(select(User).where(func.lower(User.email) == email))
        ).first()
        user_id = existing.id if existing is not None else None

    if user_id is not None:
        purpose, ttl = PURPOSE_RECOVER, RECOVER_LINK_TTL
    else:
        purpose, ttl, user_id = PURPOSE_REGISTER, REGISTER_LINK_TTL, uuid4()

    raw = secrets.token_urlsafe(32)
    session.add(
        EmailToken(
            purpose=purpose,
            email=email,
            user_id=user_id,
            token_hash=_hash_link_token(raw),
            expires_at=_now() + ttl,
        )
    )
    await session.commit()
    return raw, purpose


async def request_login_link(session: AsyncSession, email: str) -> str | None:
    """メールのログインリンクを作る。戻り値は、送るべき生のトークン。送らないときは None。

    登録済みのアドレスにだけ、メールを送る。登録されていないアドレスにも、同じ形の行（送らない
    ダミー。使えない）を残し、回数の数え方・処理の流れ・応答を、登録済みと同じにする
    （応答や時間の違いで、登録の有無を推測させない）。同じアドレスへは 1 時間に 3 通まで
    （上限を超えたら、送らない。応答は同じ）。
    """
    await purge_expired(session)
    since = _now() - timedelta(hours=1)
    recent = (
        await session.exec(
            select(func.count())
            .select_from(EmailToken)
            .where(col(EmailToken.email) == email, col(EmailToken.created_at) > since)
        )
    ).one()
    if recent >= EMAIL_LINKS_PER_HOUR:
        await session.commit()
        return None

    user = (await session.exec(select(User).where(func.lower(User.email) == email))).first()
    raw = secrets.token_urlsafe(32)
    session.add(
        EmailToken(
            purpose=PURPOSE_LOGIN,
            email=email,
            user_id=user.id if user is not None else uuid4(),
            token_hash=_hash_link_token(raw),
            expires_at=_now() + LOGIN_LINK_TTL,
        )
    )
    await session.commit()
    return raw if user is not None else None


async def deliver_link_mail(email: str, raw_token: str, purpose: str) -> None:
    """リンクのメールを送る（バックグラウンドで呼ぶ）。失敗してもログだけ残す。

    応答を待たせない（送る・送らないで応答時間が変わると、登録の有無を推測されるため）。
    """
    link = build_link(purpose, raw_token)
    builders = {
        PURPOSE_REGISTER: mailer.build_register_mail,
        PURPOSE_RECOVER: mailer.build_recover_mail,
        PURPOSE_LOGIN: mailer.build_login_mail,
    }
    subject, text, html = builders[purpose](link)
    try:
        await mailer.send_mail(to=email, subject=subject, text=text, html=html)
    except (mailer.MailNotConfiguredError, mailer.MailSendError):
        _logger.warning("link mail was not sent (purpose=%s)", purpose)


async def find_valid_email_token(
    session: AsyncSession, raw_token: str, purposes: frozenset[str]
) -> EmailToken | None:
    """生のトークンから、まだ使えるメールのトークン（未使用・期限内・用途が合う）を探す。

    用途が合わないトークンは、無いのと同じ（None）。例えば、ログインリンク（login）では、
    パスキーの登録（register・recover の用途）には進めない。
    """
    token = (
        await session.exec(
            select(EmailToken).where(col(EmailToken.token_hash) == _hash_link_token(raw_token))
        )
    ).first()
    if (
        token is None
        or token.purpose not in purposes
        or token.used_at is not None
        or token.expires_at < _now()
    ):
        return None
    return token


async def mark_email_token_used(session: AsyncSession, token_id: UUID) -> bool:
    """メールのトークンを使用済みにする。すでに使われていたら False（同時の二重使用を防ぐ）。"""
    result = await session.execute(
        update(EmailToken)
        .where(col(EmailToken.id) == token_id, col(EmailToken.used_at).is_(None))
        .values(used_at=_now())
        .returning(col(EmailToken.id))
    )
    return result.first() is not None


# ── チャレンジ ────────────────────────────────────────────────


async def create_challenge(
    session: AsyncSession,
    challenge: bytes,
    purpose: str,
    *,
    user_id: UUID | None = None,
    email_token_id: UUID | None = None,
) -> UUID:
    """チャレンジを保存し、画面に渡す ID を返す（乱数そのものは画面に渡さない）。"""
    row = AuthChallenge(
        challenge=challenge,
        purpose=purpose,
        user_id=user_id,
        email_token_id=email_token_id,
        expires_at=_now() + CHALLENGE_TTL,
    )
    challenge_id = row.id  # commit のあとは ORM の値が読めなくなるので、先に取り出す
    session.add(row)
    await session.commit()
    return challenge_id


async def take_challenge(session: AsyncSession, challenge_id: UUID, purpose: str) -> AuthChallenge:
    """チャレンジを取り出して、その場で消す（1 回だけ使える）。無い・期限切れ・種類違いは失敗。

    検証に失敗しても、チャレンジは戻らない（やり直しは、新しいチャレンジから）。
    消す処理は、同時に 2 回呼ばれても、片方だけが行を受け取る（もう片方は失敗する）。
    """
    result = await session.execute(
        delete(AuthChallenge)
        .where(col(AuthChallenge.id) == challenge_id, col(AuthChallenge.purpose) == purpose)
        .returning(
            col(AuthChallenge.challenge),
            col(AuthChallenge.user_id),
            col(AuthChallenge.email_token_id),
            col(AuthChallenge.expires_at),
        )
    )
    row = result.first()
    await session.commit()
    if row is None or row.expires_at < _now():
        raise PasskeyServiceError("challenge expired or already used")
    return AuthChallenge(
        id=challenge_id,
        challenge=row.challenge,
        purpose=purpose,
        user_id=row.user_id,
        email_token_id=row.email_token_id,
        expires_at=row.expires_at,
    )


# ── アカウント・パスキー・トークン ────────────────────────────


async def credential_ids_of(session: AsyncSession, user_id: UUID) -> list[str]:
    """利用者がすでに持つ credential ID の一覧（同じ鍵を二重に登録させないため）。"""
    rows = await session.exec(select(col(Passkey.credential_id)).where(Passkey.user_id == user_id))
    return list(rows.all())


async def count_passkeys(session: AsyncSession, user_id: UUID) -> int:
    """その利用者が持つパスキーの数（アカウントごとに数える）。"""
    return (
        await session.exec(
            select(func.count()).select_from(Passkey).where(col(Passkey.user_id) == user_id)
        )
    ).one()


async def add_passkey(
    session: AsyncSession, user_id: UUID, verified: VerifiedPasskey, name: str
) -> Passkey:
    """検証済みのパスキーを、利用者に足す（コミットは呼び出し側）。上限を超えたら失敗。"""
    if await count_passkeys(session, user_id) >= MAX_PASSKEYS_PER_USER:
        raise PasskeyServiceError("too many passkeys")
    passkey = Passkey(
        user_id=user_id,
        credential_id=verified.credential_id,
        public_key=verified.public_key,
        sign_count=verified.sign_count,
        name=name,
    )
    session.add(passkey)
    await session.flush()
    return passkey


async def create_account(
    session: AsyncSession, token: EmailToken, verified: VerifiedPasskey, device_name: str
) -> tuple[User, Workspace]:
    """登録のメールを確認できた利用者を作る（利用者・ワークスペース・最初のパスキー）。

    利用者の ID は、メールのトークンに先に決めてあった値（WebAuthn の user.id と同じ）。
    コミットは呼び出し側（トークンの使用済みと同じトランザクションにする）。
    """
    taken = (
        await session.exec(select(User).where(func.lower(User.email) == token.email))
    ).first()
    if taken is not None:
        raise PasskeyServiceError("email already registered")
    user = User(id=token.user_id, email=token.email)
    session.add(user)
    await session.flush()  # 利用者の行を先に確定させてから、ワークスペースとパスキーを足す
    workspace = Workspace(name=workspace_name_from_email(token.email), owner_id=user.id)
    session.add(workspace)
    await session.flush()
    await add_passkey(session, user.id, verified, device_name)
    return user, workspace


async def workspace_of(session: AsyncSession, user_id: UUID) -> Workspace:
    """利用者の最初のワークスペース（1 利用者 = 1 ワークスペースの前提）。無ければ失敗。"""
    workspace = (
        await session.exec(select(Workspace).where(col(Workspace.owner_id) == user_id))
    ).first()
    if workspace is None:
        raise PasskeyServiceError("no workspace found")
    return workspace


def issue_tokens(
    session: AsyncSession, user_id: UUID, workspace_id: UUID, login_method: str
) -> tuple[str, str]:
    """ログイン状態を作る。戻り値は（アクセストークン, リフレッシュトークンの生の値）。

    リフレッシュトークンは、ハッシュだけを保存する（コミットは呼び出し側）。
    login_method（passkey | email | recover）は、両方のトークンに入れる（端末の管理の可否に使う）。
    """
    raw, token_hash = auth_utils.create_refresh_token()
    session.add(
        RefreshToken(
            user_id=user_id,
            workspace_id=workspace_id,
            token_hash=token_hash,
            expires_at=auth_utils.refresh_token_expiry(),
            login_method=login_method,
        )
    )
    return auth_utils.create_access_token(user_id, workspace_id, via=login_method), raw


async def revoke_all_sessions(session: AsyncSession, user_id: UUID) -> None:
    """利用者の全端末のログイン（リフレッシュトークン）を失効させる（コミットは呼び出し側）。"""
    await session.execute(
        update(RefreshToken)
        .where(col(RefreshToken.user_id) == user_id, col(RefreshToken.revoked).is_(False))
        .values(revoked=True)
    )
