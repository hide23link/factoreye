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
import math
import secrets
from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import col, delete, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app import mailer, notifications
from app.config import settings
from app.db.models import (
    AuthChallenge,
    EmailToken,
    OpsNoticeMark,
    Passkey,
    RefreshToken,
    User,
    Workspace,
)
from app.db.session import engine
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


class EmailCapReachedError(Exception):
    """1 日のメール送信数の上限に達した（API は 503。登録の有無によらず、同じ応答にする）。"""


# 1 日の送信数の確認と、スロットの確保（送信の印の書き込み）を、同時に 2 つ以上行わないための
# 排他の鍵（PostgreSQL の advisory lock。トランザクションの終わりで外れる）。
# 同時の依頼で、上限を超えて送ってしまうのを防ぐ（数える→確保が 1 つずつになる）
_MAIL_CAP_LOCK_KEY = 7_302_611

# 運用者への通知の種類（ops_notice_marks.kind）
NOTICE_EMAIL_WARN = "email_warn"
NOTICE_EMAIL_LIMIT = "email_limit"


def _utc_day_start(moment: datetime) -> datetime:
    """UTC の日付の始まり（その日の 0:00 UTC。日本時間の 9:00）。

    Resend の 1 日の数え方に合わせる想定。
    """
    return moment.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


async def count_general_mail_sent_today(session: AsyncSession) -> int:
    """今日（UTC）に送った、一般の依頼のメールの数。

    数えるのは、実際に送りを依頼した行（mail_sent_at がある）だけ。登録されていないアドレスの
    ダミー行（NULL）と、管理者のリセット（by_admin。上限の対象外）は数えない。
    """
    day_start = _utc_day_start(_now())
    return (
        await session.exec(
            select(func.count())
            .select_from(EmailToken)
            .where(
                col(EmailToken.mail_sent_at) >= day_start,
                col(EmailToken.mail_sent_at) < day_start + timedelta(days=1),
                col(EmailToken.by_admin).is_(False),
            )
        )
    ).one()


async def reserve_mail_cap(session: AsyncSession) -> None:
    """1 日の上限に達していたら、EmailCapReachedError を投げる（上限が 0 以下なら、何もしない）。

    advisory lock を取ってから数えるので、同時の依頼でも、この確認と、あとに続く送信の印の書き込み
    （同じトランザクション）が 1 つずつ進み、上限を超えない。
    ロックは、コミット（またはロールバック）で外れる。
    """
    if settings.email_daily_limit <= 0:
        return
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _MAIL_CAP_LOCK_KEY})
    if await count_general_mail_sent_today(session) >= settings.email_daily_limit:
        await session.rollback()
        raise EmailCapReachedError


def _notice_text(kind: str, sent: int, limit: int) -> str:
    """運用者への知らせの文面（時刻は日本時間）。"""
    stamp = notifications.format_jst_stamp(_now())
    if kind == NOTICE_EMAIL_LIMIT:
        return (
            f"FactorEye: 今日のメール送信が上限（{sent} / {limit} 通）に達しました。"
            "登録・ログインのメールは、日本時間の 9:00（UTC の日付が変わる時刻）まで"
            f"送れません（{stamp}）"
        )
    return f"FactorEye: 今日のメール送信が {sent} / {limit} 通です（{stamp}）"


async def notify_email_usage() -> None:
    """1 日のメール送信数が、上限の割合・上限に達したら、運用者用の Discord へ知らせる。

    それぞれ 1 日 1 回。

    バックグラウンドで呼ぶ（応答を待たせない）。URL が空・上限なしなら、何もしない。
    「その日に送った」印を DB（ops_notice_marks）に持つので、
    再起動・複数ワーカーでも 1 日 1 回になる
    （印を先に入れられた 1 つだけが送る）。通知の送信に失敗しても、メールの送信は止めない。
    失敗したときは印を戻し、次の依頼のときに、もう一度試す。
    """
    limit = settings.email_daily_limit
    url = settings.ops_discord_webhook_url.get_secret_value()
    if limit <= 0 or not url:
        return
    warn_at = max(1, math.ceil(limit * settings.email_daily_warn_percent / 100))
    try:
        async with AsyncSession(engine) as session:
            sent = await count_general_mail_sent_today(session)
            day = _utc_day_start(_now()).date()
            # 割合の通知は、上限と同じ数なら出さない（上限の通知だけにする）
            thresholds = ((NOTICE_EMAIL_WARN, warn_at), (NOTICE_EMAIL_LIMIT, limit))
            for kind, threshold in thresholds:
                if kind == NOTICE_EMAIL_WARN and warn_at >= limit:
                    continue
                if sent < threshold or not await _claim_notice(session, day, kind):
                    continue
                if not await notifications.send_ops_discord(url, _notice_text(kind, sent, limit)):
                    await _release_notice(session, day, kind)
    except Exception:
        # 通知の失敗（DB を含む）で、メールの送信を止めない
        _logger.warning("email usage notice failed", exc_info=False)


async def _claim_notice(session: AsyncSession, day: date, kind: str) -> bool:
    """その日の通知の印を入れる。入れられたら True（送ってよい）、すでにあれば False。"""
    result = await session.execute(
        pg_insert(OpsNoticeMark)
        .values(day=day, kind=kind, created_at=_now())
        .on_conflict_do_nothing()
        .returning(col(OpsNoticeMark.kind))
    )
    claimed = result.first() is not None
    await session.commit()
    return claimed


async def _release_notice(session: AsyncSession, day: date, kind: str) -> None:
    """通知を送れなかったとき、印を戻す（次の依頼のときに、もう一度試せるようにする）。"""
    await session.execute(
        delete(OpsNoticeMark).where(col(OpsNoticeMark.day) == day, col(OpsNoticeMark.kind) == kind)
    )
    await session.commit()


async def request_email_link(session: AsyncSession, email: str) -> tuple[str, str] | None:
    """メールのリンクを作る。戻り値は（生のトークン, 種類）。送る回数の上限なら None。

    アドレスが未登録なら、これから作る利用者の ID を先に決め（WebAuthn の user.id に使う）、
    登録のリンクにする。登録済みなら、端末の再登録のリンクにする。
    1 日の送信数の上限に達していたら、アドレスの登録の有無によらず、EmailCapReachedError
    送る行には、送信の依頼の印（mail_sent_at）を付ける。確認と印の書き込みは、同じトランザクション。
    """
    await purge_expired(session)
    await reserve_mail_cap(session)
    since = _now() - timedelta(hours=1)
    recent = (
        await session.exec(
            select(func.count())
            .select_from(EmailToken)
            .where(
                col(EmailToken.email) == email,
                col(EmailToken.created_at) > since,
                col(EmailToken.by_admin).is_(False),
            )
        )
    ).one()
    if recent >= EMAIL_LINKS_PER_HOUR:
        await session.commit()
        return None

    existing = (await session.exec(select(User).where(func.lower(User.email) == email))).first()
    user_id: UUID | None = existing.id if existing is not None else None

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
            mail_sent_at=_now(),
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
    # 上限に達していたら、登録済みかどうかに関わらず、同じ失敗にする（登録の有無を推測させない）
    await reserve_mail_cap(session)
    since = _now() - timedelta(hours=1)
    recent = (
        await session.exec(
            select(func.count())
            .select_from(EmailToken)
            .where(
                col(EmailToken.email) == email,
                col(EmailToken.created_at) > since,
                col(EmailToken.by_admin).is_(False),
            )
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
            # 送らないダミー行（登録されていないアドレス）は、送信数に数えない
            mail_sent_at=_now() if user is not None else None,
        )
    )
    await session.commit()
    return raw if user is not None else None


async def send_link_mail(email: str, raw_token: str, purpose: str) -> None:
    """リンクのメールを送る。失敗したら、mailer の例外（未設定・送信失敗）を投げる。

    管理者のリセットは、これを待って、失敗を管理者に見せる。
    """
    link = build_link(purpose, raw_token)
    builders = {
        PURPOSE_REGISTER: mailer.build_register_mail,
        PURPOSE_RECOVER: mailer.build_recover_mail,
        PURPOSE_LOGIN: mailer.build_login_mail,
    }
    subject, text, html = builders[purpose](link)
    await mailer.send_mail(to=email, subject=subject, text=text, html=html)


async def deliver_link_mail(email: str, raw_token: str, purpose: str) -> None:
    """リンクのメールを送る（利用者向けの依頼で、バックグラウンドで呼ぶ）。失敗は、ログに残すだけ。

    登録の有無を区別させないため、送信に失敗しても、利用者には成功と同じ応答を返す
    （失敗は運用のログに残す）。応答を待たせないのも、同じ理由（応答時間でも推測させない）。
    """
    try:
        await send_link_mail(email, raw_token, purpose)
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
    """メールのトークンを使用済みにする。使用済み・期限切れなら False（同時の二重使用も防ぐ）。"""
    result = await session.execute(
        update(EmailToken)
        .where(
            col(EmailToken.id) == token_id,
            col(EmailToken.used_at).is_(None),
            col(EmailToken.expires_at) > _now(),  # 期限を過ぎていたら、使えない
        )
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


async def invalidate_pending_links(session: AsyncSession, user_id: UUID, email: str) -> None:
    """その利用者（ID またはメールアドレス）の、使っていないリンクとチャレンジを、すべて無効にする。

    管理者のリセットで、リセット前に発行したリンク（登録・ログイン・再登録のすべて）や、
    途中の登録のチャレンジが、リセット後に使われないようにする（コミットは呼び出し側）。
    """
    now = _now()
    stale = await session.execute(
        update(EmailToken)
        .where(
            col(EmailToken.used_at).is_(None),
            (col(EmailToken.user_id) == user_id) | (col(EmailToken.email) == email),
        )
        .values(used_at=now)
        .returning(col(EmailToken.id))
    )
    token_ids = [row[0] for row in stale.all()]
    condition = col(AuthChallenge.user_id) == user_id
    if token_ids:
        condition = condition | col(AuthChallenge.email_token_id).in_(token_ids)
    await session.execute(delete(AuthChallenge).where(condition))


async def prepare_reset(
    session: AsyncSession, user: User, *, delete_passkeys: bool
) -> str:
    """管理者のリセットの変更を、すべて同じトランザクションに積む。戻り値は、新しい再登録リンクの生のトークン。

    コミットは呼び出し側（メールを送れたときだけ確定する。送れなければ、何も変えない）:
     - 古い未使用のリンク・チャレンジを無効にする（リセット前のリンクを、リセット後に使えなくする）
     - 新しい再登録リンク（1 時間）を作る。同じアドレスへの 3 通/時の数え方に入れない（by_admin）
     - 全端末のログイン（永久ログインを含む）を失効させる
     - 登録済みのパスキーを消す（delete_passkeys のとき）。古いパスワードのハッシュを NULL にする
    """
    user_id, email = user.id, user.email
    await invalidate_pending_links(session, user_id, email)
    raw = secrets.token_urlsafe(32)
    session.add(
        EmailToken(
            purpose=PURPOSE_RECOVER,
            email=email,
            user_id=user_id,
            token_hash=_hash_link_token(raw),
            expires_at=_now() + RECOVER_LINK_TTL,
            by_admin=True,
            mail_sent_at=_now(),  # 印は付けるが、by_admin なので、1 日の上限・通知の数には入らない
        )
    )
    await revoke_all_sessions(session, user_id)
    if delete_passkeys:
        await session.execute(delete(Passkey).where(col(Passkey.user_id) == user_id))
    user.password_hash = None
    session.add(user)
    return raw
