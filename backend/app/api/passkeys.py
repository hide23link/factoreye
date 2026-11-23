"""パスキーでの登録・ログインと、端末（パスキー）の管理 API（AUTH_MODE=multi_tenant 時のみ）。

パスワードは使わない。登録とログインは、端末のパスキー（指紋・顔・PIN）で行う。

 公開（ログイン前）:
  POST /api/auth/email/request          → 登録・端末の再登録のメールを送る（どのアドレスも同じ応答）
  POST /api/auth/email/login-request     → メールのログインリンクを送る（パスキーが使えない端末用）
  POST /api/auth/email/login             → ログインリンクでログインする（パスキー登録は求めない）
  POST /api/auth/passkey/register/begin  → メールのリンクのトークンから、登録のオプションを作る
  POST /api/auth/passkey/register/finish → パスキーを検証して、利用者を作る（または端末を足す）。
                                           トークンを返す
  POST /api/auth/passkey/login/begin     → ログインのオプションを作る（アドレスは聞かない）
  POST /api/auth/passkey/login/finish    → 署名を検証して、トークンを返す
 ログイン中:
  GET    /api/passkeys                    → 自分の端末の一覧
  POST   /api/passkeys/register/begin|finish → 端末を足す
  PATCH  /api/passkeys/{id}               → 端末の名前を変える
  DELETE /api/passkeys/{id}               → 端末を消す（最後の 1 台は消せない）
  （端末の管理は、パスキーか再登録リンクでログインした状態だけ。ログインリンクだけでは 403）
  GET    /api/sessions/kept               → 永久ログイン（キオスク用）の端末の一覧
  POST   /api/sessions/kept               → この端末を、ログインしたままにする（期限なしにする）
  DELETE /api/sessions/kept/{id}          → 永久ログインの端末を終了する

【呼ばれ方】画面の登録・ログイン・設定の「端末」が呼ぶ。本文は JSON（camelCase）。
管理者が利用者として閲覧中のトークンでは、端末の管理はできない
（管理者が、利用者の鍵を足せないように）。
"""
import logging
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import EmailStr, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import auth as auth_utils
from app import kept_sessions, mailer, webauthn_utils
from app import passkey_service as service
from app.api.auth import TokenResponse, require_multi_tenant
from app.db.models import EmailToken, Passkey, RefreshToken, User
from app.db.session import get_session
from app.rate_limit import limiter
from app.schemas import CamelModel

router = APIRouter(prefix="/api", tags=["passkeys"])
_logger = logging.getLogger(__name__)
_bearer = HTTPBearer()

# 端末の名前の長さ（モデルの max_length と同じ）
DEVICE_NAME_MAX = 50


# ── スキーマ ──────────────────────────────────────────────────


class EmailRequest(CamelModel):
    """メールを送ってほしいアドレス（登録も、端末の再登録も、同じ入力）。"""

    email: EmailStr

    _normalize = field_validator("email", mode="before")(
        lambda value: auth_utils.normalize_email(value) if isinstance(value, str) else value
    )


class EmailRequestResult(CamelModel):
    """登録されているかどうかに関わらず、いつも同じ内容を返す。"""

    status: str = "sent"


class LoginLinkRequest(CamelModel):
    """メールのログインリンクで、ログインするためのトークン（メールのリンクにあった生の値）。"""

    token: str = Field(min_length=10, max_length=200)


class KeepRequest(CamelModel):
    """この端末を、ログインしたままにする（キオスク用）。今のリフレッシュトークンと端末の名前。"""

    refresh_token: str = Field(min_length=10, max_length=500)
    device_name: str = Field(default="", max_length=200)

    @field_validator("device_name")
    @classmethod
    def _trim(cls, value: str) -> str:
        return value.strip()


class KeptSessionItem(CamelModel):
    """永久ログインの端末の一覧の 1 行。id は端末ごとに変わらない（トークンが替わっても同じ）。"""

    id: UUID
    name: str
    started_at: str
    last_used_at: str | None


class RegisterBeginRequest(CamelModel):
    """メールのリンクにあった、生のトークン。"""

    token: str = Field(min_length=10, max_length=200)


class BeginResponse(CamelModel):
    """端末に渡すオプションと、あとで finish に返してもらうチャレンジの ID。"""

    challenge_id: UUID
    options: dict[str, object]


class RegisterBeginResponse(BeginResponse):
    """メールのリンクからの登録の begin。画面に、どのアドレスか・新規か再登録かを見せる。"""

    email: str
    purpose: str


class FinishRequest(CamelModel):
    """端末の応答（navigator.credentials の結果を JSON にしたもの）。"""

    challenge_id: UUID
    credential: dict[str, object]
    device_name: str = Field(default="", max_length=200)

    @field_validator("device_name")
    @classmethod
    def _trim(cls, value: str) -> str:
        return value.strip()


class LoginFinishRequest(CamelModel):
    challenge_id: UUID
    credential: dict[str, object]


class PasskeyItem(CamelModel):
    """端末（パスキー）の一覧の 1 行。credential_id は、画面が「今の端末」を見分けるのに使う。"""

    id: UUID
    name: str
    credential_id: str
    created_at: str
    last_used_at: str | None


class RenameRequest(CamelModel):
    name: str = Field(min_length=1, max_length=DEVICE_NAME_MAX)

    @field_validator("name")
    @classmethod
    def _trim(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value


# ── 内部ヘルパー ──────────────────────────────────────────────


def _fail(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


# 1 日の送信数の上限に達したときの 503 の理由。画面は、この文字で「混み合っています」を出し分ける
MAIL_BUSY_DETAIL = "mail is busy"


def _mail_busy() -> HTTPException:
    """1 日のメール送信数の上限に達した。登録の有無で、応答（状態・文言・時間）を変えない。

    Retry-After は付けない。
    """
    return _fail(status.HTTP_503_SERVICE_UNAVAILABLE, MAIL_BUSY_DETAIL)


def _device_name(requested: str) -> str:
    """端末の名前。空なら既定の名前にする（あとから設定で変えられる）。"""
    return (requested or "この端末")[:DEVICE_NAME_MAX]


async def _current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> tuple[User, str | None]:
    """アクセストークンから利用者とログインの方法を取り出す。

    無効は 401、管理者が利用者として閲覧中のトークンは 403。
    """
    require_multi_tenant()
    try:
        payload = auth_utils.decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "invalid or expired token") from None
    if "imp" in payload:
        raise _fail(status.HTTP_403_FORBIDDEN, "not available while viewing as a user")
    sub = payload.get("sub")
    try:
        user = await session.get(User, UUID(sub)) if sub else None
    except ValueError:
        user = None
    if user is None:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "invalid or expired token")
    return user, payload.get("via")


async def _current_user_only(
    current: Annotated[tuple[User, str | None], Depends(_current_user)],
) -> User:
    """利用者だけが要る API 用（ログインの方法は問わない）。"""
    return current[0]


async def _passkey_manager(
    current: Annotated[tuple[User, str | None], Depends(_current_user)],
) -> User:
    """端末（パスキー）の管理用。パスキーまたは再登録リンクでログインした状態だけ許す。

    メールのログインリンクだけで入った状態（と、古い形のログイン）では 403。
    メール 1 本で、端末の追加・削除（入れ替え）まで奪われないようにするため。
    """
    user, via = current
    if via not in service.PASSKEY_MANAGEMENT_METHODS:
        raise _fail(
            status.HTTP_403_FORBIDDEN,
            "passkey management requires signing in with a passkey",
        )
    return user


def _item(passkey: Passkey) -> PasskeyItem:
    return PasskeyItem(
        id=passkey.id,
        name=passkey.name,
        credential_id=passkey.credential_id,
        created_at=passkey.created_at.isoformat(),
        last_used_at=passkey.last_used_at.isoformat() if passkey.last_used_at else None,
    )


# ── 公開: メールのリンク ──────────────────────────────────────


@router.post("/auth/email/request", response_model=EmailRequestResult, status_code=202)
@limiter.limit("10/minute")
@limiter.limit("3/hour")
async def request_email(
    request: Request,  # slowapi がレート制限キーの取得に使う
    body: EmailRequest,
    background: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> EmailRequestResult:
    """登録・端末の再登録のメールを送る。

    アドレスが登録済みかどうかで中身（登録 / 再登録）は変わるが、応答はいつも同じ。
    依頼は、接続元ごとに 1 時間に 3 回まで（login-request と同じ）、
    同じアドレスへは 1 時間に 3 通まで（超えたら送らないが、応答は同じ）。
    メールの送信は応答のあとに行う（応答時間でも、登録の有無を推測させない）。送信に失敗しても、
    登録の有無を区別させないため、利用者には成功と同じ応答を返す（失敗は運用のログに残す）。
    """
    require_multi_tenant()
    if not mailer.is_mail_configured():
        raise _fail(status.HTTP_503_SERVICE_UNAVAILABLE, "mail is not configured")
    try:
        issued = await service.request_email_link(session, body.email)
    except service.EmailCapReachedError:
        raise _mail_busy() from None
    if issued is not None:
        raw, purpose = issued
        background.add_task(service.deliver_link_mail, body.email, raw, purpose)
        background.add_task(service.notify_email_usage)
    return EmailRequestResult()


# ── 公開: メールのログインリンク（パスキーが使えない端末のための代わりのログイン） ──


@router.post("/auth/email/login-request", response_model=EmailRequestResult, status_code=202)
@limiter.limit("3/hour")
async def request_login_link(
    request: Request,  # slowapi がレート制限キーの取得に使う
    body: EmailRequest,
    background: BackgroundTasks,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> EmailRequestResult:
    """ログインリンク（15 分・1 回だけ）を、登録済みのアドレスへ送る。

    登録済みかどうかは、応答・処理の流れ・時間で区別させない（どのアドレスも同じ 202）。
    依頼は、接続元ごとに 1 時間に 3 回、同じアドレスへは 1 時間に 3 通まで。
    """
    require_multi_tenant()
    if not mailer.is_mail_configured():
        raise _fail(status.HTTP_503_SERVICE_UNAVAILABLE, "mail is not configured")
    try:
        raw = await service.request_login_link(session, body.email)
    except service.EmailCapReachedError:
        raise _mail_busy() from None
    if raw is not None:
        background.add_task(service.deliver_link_mail, body.email, raw, service.PURPOSE_LOGIN)
        background.add_task(service.notify_email_usage)
    return EmailRequestResult()


@router.post("/auth/email/login", response_model=TokenResponse)
@limiter.limit("20/minute")
async def login_with_link(
    request: Request,
    body: LoginLinkRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    """ログインリンクのトークンでログインする。パスキーの登録は求めない（できない）。

    このログインでは、端末（パスキー）の追加・削除はできない（login_method=email）。
    """
    require_multi_tenant()
    gone = _fail(status.HTTP_410_GONE, "link is invalid, expired or already used")
    token = await service.find_valid_email_token(
        session, body.token, frozenset({service.PURPOSE_LOGIN})
    )
    if token is None:
        raise gone
    token_id, user_id = token.id, token.user_id
    # 同時に同じリンクを開いても、片方だけが通る
    if not await service.mark_email_token_used(session, token_id):
        await session.rollback()
        raise gone
    user = await session.get(User, user_id)
    if user is None:
        await session.rollback()
        raise gone
    try:
        workspace = await service.workspace_of(session, user_id)
    except service.PasskeyServiceError:
        await session.rollback()
        raise gone from None
    access, refresh = service.issue_tokens(session, user_id, workspace.id, service.LOGIN_EMAIL)
    await session.commit()
    return TokenResponse(access_token=access, refresh_token=refresh)


# ── 公開: メールのリンクからの登録 ────────────────────────────


@router.post("/auth/passkey/register/begin", response_model=RegisterBeginResponse)
@limiter.limit("20/minute")
async def register_begin(
    request: Request,
    body: RegisterBeginRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> RegisterBeginResponse:
    """メールのリンクのトークンを確かめて、端末に渡す登録のオプションを作る。"""
    require_multi_tenant()
    # パスキーの登録に進めるのは、登録（register）と再登録（recover）のリンクだけ。
    # ログインリンク（login）では、進めない
    token = await service.find_valid_email_token(
        session, body.token, frozenset({service.PURPOSE_REGISTER, service.PURPOSE_RECOVER})
    )
    if token is None:
        raise _fail(status.HTTP_410_GONE, "link is invalid, expired or already used")
    # commit のあとは ORM の値が読めなくなるので、先に取り出しておく
    token_id, user_id, email, purpose = token.id, token.user_id, token.email, token.purpose
    existing = (
        []
        if purpose == service.PURPOSE_REGISTER
        else await service.credential_ids_of(session, user_id)
    )
    options, challenge = webauthn_utils.registration_options(
        user_id=user_id, email=email, existing_credential_ids=existing
    )
    challenge_id = await service.create_challenge(
        session, challenge, service.CHALLENGE_REGISTER, email_token_id=token_id
    )
    return RegisterBeginResponse(
        challenge_id=challenge_id, options=options, email=email, purpose=purpose
    )


@router.post("/auth/passkey/register/finish", response_model=TokenResponse)
@limiter.limit("20/minute")
async def register_finish(
    request: Request,
    body: FinishRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    """端末の応答を検証し、利用者を作る（または端末を足す）。成功したらログイン状態にする。"""
    require_multi_tenant()
    try:
        challenge = await service.take_challenge(
            session, body.challenge_id, service.CHALLENGE_REGISTER
        )
    except service.PasskeyServiceError:
        raise _fail(status.HTTP_400_BAD_REQUEST, "challenge expired or already used") from None
    if challenge.email_token_id is None:
        raise _fail(status.HTTP_400_BAD_REQUEST, "challenge expired or already used")
    token = await session.get(EmailToken, challenge.email_token_id)
    if (
        token is None
        or token.used_at is not None
        or token.expires_at < datetime.now(UTC)  # begin のあとに、期限を過ぎていた
        or token.purpose not in (service.PURPOSE_REGISTER, service.PURPOSE_RECOVER)
    ):
        raise _fail(status.HTTP_410_GONE, "link is invalid, expired or already used")
    try:
        verified = webauthn_utils.verify_registration(
            body.credential, challenge=challenge.challenge
        )
    except webauthn_utils.PasskeyVerificationError:
        raise _fail(status.HTTP_400_BAD_REQUEST, "passkey could not be verified") from None

    # 同時に同じリンクで 2 回登録しようとしても、片方だけが通る
    if not await service.mark_email_token_used(session, token.id):
        await session.rollback()
        raise _fail(status.HTTP_410_GONE, "link is invalid, expired or already used")
    name = _device_name(body.device_name)
    try:
        if token.purpose == service.PURPOSE_REGISTER:
            created_user, workspace = await service.create_account(session, token, verified, name)
            user_id = created_user.id
        else:
            existing_user = await session.get(User, token.user_id)
            # リンクのメールアドレスと、利用者のメールアドレスが同じことも確かめる
            owner_email = auth_utils.normalize_email(existing_user.email) if existing_user else None
            if existing_user is None or owner_email != token.email:
                raise service.PasskeyServiceError("user not found")
            user_id = existing_user.id
            await service.add_passkey(session, user_id, verified, name)
            workspace = await service.workspace_of(session, user_id)
        workspace_id = workspace.id
        # 再登録リンクでログインした状態は、端末の管理を許す（メールの所有を確かめたため）
        is_new_account = token.purpose == service.PURPOSE_REGISTER
        method = service.LOGIN_PASSKEY if is_new_account else service.LOGIN_RECOVER
        access, refresh = service.issue_tokens(session, user_id, workspace_id, method)
        await session.commit()
    except service.PasskeyServiceError as exc:
        await session.rollback()
        code = status.HTTP_409_CONFLICT if exc.reason != "user not found" else status.HTTP_410_GONE
        raise _fail(code, exc.reason) from None
    except IntegrityError:
        # すでに登録済みの鍵、または同時に同じアドレスが登録された
        await session.rollback()
        raise _fail(status.HTTP_409_CONFLICT, "passkey or email already registered") from None
    return TokenResponse(access_token=access, refresh_token=refresh)


# ── 公開: ログイン ────────────────────────────────────────────


@router.post("/auth/passkey/login/begin", response_model=BeginResponse)
@limiter.limit("30/minute")
async def login_begin(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BeginResponse:
    """ログインのオプションを作る。アドレスは聞かない（端末の選択画面でアカウントを選ぶ）。"""
    require_multi_tenant()
    options, challenge = webauthn_utils.authentication_options()
    challenge_id = await service.create_challenge(session, challenge, service.CHALLENGE_LOGIN)
    return BeginResponse(challenge_id=challenge_id, options=options)


@router.post("/auth/passkey/login/finish", response_model=TokenResponse)
@limiter.limit("30/minute")
async def login_finish(
    request: Request,
    body: LoginFinishRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TokenResponse:
    """署名を検証して、トークンを返す。失敗の理由は区別せず、同じ 401 にする。"""
    require_multi_tenant()
    invalid = _fail(status.HTTP_401_UNAUTHORIZED, "passkey could not be verified")
    try:
        challenge = await service.take_challenge(
            session, body.challenge_id, service.CHALLENGE_LOGIN
        )
        credential_id = webauthn_utils.credential_id_of(body.credential)
    except (service.PasskeyServiceError, webauthn_utils.PasskeyVerificationError):
        raise invalid from None
    passkey = (
        await session.exec(select(Passkey).where(col(Passkey.credential_id) == credential_id))
    ).first()
    if passkey is None:
        raise invalid
    # 端末が持つ user.id（userHandle）が、この鍵の持ち主の ID と同じことも確かめる
    if webauthn_utils.user_handle_of(body.credential) != passkey.user_id.bytes:
        raise invalid
    try:
        new_count = webauthn_utils.verify_authentication(
            body.credential,
            challenge=challenge.challenge,
            public_key=passkey.public_key,
            current_sign_count=passkey.sign_count,
        )
        workspace = await service.workspace_of(session, passkey.user_id)
    except (webauthn_utils.PasskeyVerificationError, service.PasskeyServiceError):
        raise invalid from None
    passkey.sign_count = new_count
    passkey.last_used_at = datetime.now(UTC)
    session.add(passkey)
    access, refresh = service.issue_tokens(
        session, passkey.user_id, workspace.id, service.LOGIN_PASSKEY
    )
    await session.commit()
    return TokenResponse(access_token=access, refresh_token=refresh)


# ── ログイン中: 端末（パスキー）の管理 ────────────────────────


@router.get("/passkeys", response_model=list[PasskeyItem])
async def list_passkeys(
    user: Annotated[User, Depends(_passkey_manager)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[PasskeyItem]:
    rows = await session.exec(
        select(Passkey).where(col(Passkey.user_id) == user.id).order_by(col(Passkey.created_at))
    )
    return [_item(p) for p in rows.all()]


@router.post("/passkeys/register/begin", response_model=BeginResponse)
@limiter.limit("20/minute")
async def add_passkey_begin(
    request: Request,
    user: Annotated[User, Depends(_passkey_manager)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BeginResponse:
    """ログイン中に、この端末を足すためのオプションを作る（持っている鍵は、端末が拒否する）。"""
    options, challenge = webauthn_utils.registration_options(
        user_id=user.id,
        email=user.email,
        existing_credential_ids=await service.credential_ids_of(session, user.id),
    )
    challenge_id = await service.create_challenge(
        session, challenge, service.CHALLENGE_ADD, user_id=user.id
    )
    return BeginResponse(challenge_id=challenge_id, options=options)


@router.post("/passkeys/register/finish", response_model=PasskeyItem, status_code=201)
@limiter.limit("20/minute")
async def add_passkey_finish(
    request: Request,
    body: FinishRequest,
    user: Annotated[User, Depends(_passkey_manager)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PasskeyItem:
    user_id = user.id  # take_challenge が commit するので、ORM の値は先に取り出しておく
    try:
        challenge = await service.take_challenge(session, body.challenge_id, service.CHALLENGE_ADD)
    except service.PasskeyServiceError:
        raise _fail(status.HTTP_400_BAD_REQUEST, "challenge expired or already used") from None
    if challenge.user_id != user_id:
        raise _fail(status.HTTP_400_BAD_REQUEST, "challenge expired or already used")
    try:
        verified = webauthn_utils.verify_registration(
            body.credential, challenge=challenge.challenge
        )
    except webauthn_utils.PasskeyVerificationError:
        raise _fail(status.HTTP_400_BAD_REQUEST, "passkey could not be verified") from None
    try:
        passkey = await service.add_passkey(
            session, user_id, verified, _device_name(body.device_name)
        )
        item = _item(passkey)  # commit のあとは ORM の値が読めなくなるので、先に作る
        await session.commit()
    except service.PasskeyServiceError as exc:
        await session.rollback()
        raise _fail(status.HTTP_409_CONFLICT, exc.reason) from None
    except IntegrityError:
        await session.rollback()
        raise _fail(status.HTTP_409_CONFLICT, "passkey already registered") from None
    return item


async def _own_passkey(session: AsyncSession, user: User, passkey_id: UUID) -> Passkey:
    """自分のパスキーを 1 件取り出す。他人のものは、無いのと同じ 404 にする。"""
    passkey = await session.get(Passkey, passkey_id)
    if passkey is None or passkey.user_id != user.id:
        raise _fail(status.HTTP_404_NOT_FOUND, "passkey not found")
    return passkey


@router.patch("/passkeys/{passkey_id}", response_model=PasskeyItem)
async def rename_passkey(
    passkey_id: UUID,
    body: RenameRequest,
    user: Annotated[User, Depends(_passkey_manager)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PasskeyItem:
    passkey = await _own_passkey(session, user, passkey_id)
    passkey.name = body.name
    session.add(passkey)
    item = _item(passkey)  # commit のあとは ORM の値が読めなくなるので、先に作る
    await session.commit()
    return item


@router.delete("/passkeys/{passkey_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_passkey(
    passkey_id: UUID,
    user: Annotated[User, Depends(_passkey_manager)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """端末を消す。最後の 1 台は消せない（ログインできなくなるため）。数えるのはアカウントごと。"""
    user_id = user.id
    passkey = await _own_passkey(session, user, passkey_id)
    if await service.count_passkeys(session, user_id) <= 1:
        raise _fail(status.HTTP_409_CONFLICT, "cannot delete the last passkey")
    await session.delete(passkey)
    await session.commit()
    _logger.info("user %s deleted passkey %s", user_id, passkey_id)


# ── ログイン中: 永久ログイン（キオスク用） ────────────────────


def _kept_item(row: RefreshToken) -> KeptSessionItem:
    started = row.started_at or row.created_at
    return KeptSessionItem(
        id=row.series_id if row.series_id is not None else row.id,
        name=row.device_name or "",
        started_at=started.isoformat(),
        last_used_at=row.last_used_at.isoformat() if row.last_used_at else None,
    )


@router.get("/sessions/kept", response_model=list[KeptSessionItem])
async def list_kept_sessions(
    user: Annotated[User, Depends(_current_user_only)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[KeptSessionItem]:
    """ログインしたままにしている端末（キオスク用）の一覧。"""
    return [_kept_item(row) for row in await kept_sessions.list_kept(session, user.id)]


@router.post("/sessions/kept", response_model=KeptSessionItem, status_code=201)
async def keep_signed_in(
    body: KeepRequest,
    user: Annotated[User, Depends(_current_user_only)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> KeptSessionItem:
    """この端末を、ログインしたままにする（リフレッシュトークンを期限なしにする）。

    パスキーでも、メールのログインリンクでも選べる。端末を盗まれると、その人が全権限で使い続けられる
    ので、利用者が選んだ端末だけに使う（選ぶ画面に、そのリスクを書く）。
    """
    try:
        row = await kept_sessions.keep_signed_in(
            session, user.id, body.refresh_token, _device_name(body.device_name)
        )
        item = _kept_item(row)  # commit のあとは ORM の値が読めなくなるので、先に作る
        await session.commit()
    except kept_sessions.KeptSessionError as exc:
        await session.rollback()
        raise _fail(status.HTTP_400_BAD_REQUEST, exc.reason) from None
    _logger.info("user %s kept a device signed in", item.id)
    return item


@router.delete("/sessions/kept/{series_id}", status_code=status.HTTP_204_NO_CONTENT)
async def end_kept_session(
    series_id: UUID,
    user: Annotated[User, Depends(_current_user_only)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """永久ログインの端末を終了する（その端末は、次の更新で、ログイン画面に戻る）。"""
    try:
        await kept_sessions.end_kept(session, user.id, series_id)
        await session.commit()
    except kept_sessions.KeptSessionError as exc:
        await session.rollback()
        raise _fail(status.HTTP_404_NOT_FOUND, exc.reason) from None
