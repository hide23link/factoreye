"""パスキー（WebAuthn）の、登録・ログインの検証。py_webauthn（webauthn パッケージ）の薄い包み。

署名の検証・origin と rp_id の確認・チャレンジの照合は、すべてライブラリに任せる（自作しない）。
ここでは、FactorEye の方針だけを決めている:
 - 端末に保存される鍵（discoverable credential）を必須にする → ログインでアドレスを入力しない
 - 端末での本人確認（指紋・顔・PIN）を必須にする
 - user.id は「利用者 ID（UUID）のバイト列」にする。アカウントごとに違う値なので、
   同じ端末・同じドメインで、2 つ目のアカウントのパスキーが 1 つ目を上書きしない
 - user.name はメールアドレス。端末の選択画面で、どのアカウントか分かる

【誰が使うか】passkey_service.py。検証に失敗したら PasskeyVerificationError にそろえる。
"""
import json
from uuid import UUID

import webauthn
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.exceptions import (
    InvalidAuthenticationResponse,
    InvalidRegistrationResponse,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.config import settings


class PasskeyVerificationError(Exception):
    """端末から届いた登録・ログインの応答を、検証できなかった。"""


class VerifiedPasskey:
    """登録の検証に成功した、パスキー 1 つ分の保存用の値。"""

    def __init__(self, credential_id: str, public_key: bytes, sign_count: int) -> None:
        self.credential_id = credential_id
        self.public_key = public_key
        self.sign_count = sign_count


def encode_credential_id(raw: bytes) -> str:
    """credential ID（バイト列）を、DB に保存する文字列（base64url）にする。"""
    return bytes_to_base64url(raw)


def registration_options(
    *, user_id: UUID, email: str, existing_credential_ids: list[str]
) -> tuple[dict[str, object], bytes]:
    """登録用のオプション（画面が navigator.credentials.create に渡す）と、チャレンジを作る。

    existing_credential_ids には、その利用者がすでに持つ credential ID を渡す。
    同じ端末の同じ鍵を、もう一度登録させないため（端末側が拒否する）。
    """
    options = webauthn.generate_registration_options(
        rp_id=settings.passkey_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_id=user_id.bytes,
        user_name=email,
        user_display_name=f"{settings.webauthn_rp_name} ({email})",
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(cid))
            for cid in existing_credential_ids
        ],
    )
    return json.loads(webauthn.options_to_json(options)), options.challenge


def verify_registration(credential: dict[str, object], *, challenge: bytes) -> VerifiedPasskey:
    """端末の登録の応答を検証して、保存する値を返す。失敗は PasskeyVerificationError。"""
    try:
        verified = webauthn.verify_registration_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=settings.passkey_rp_id,
            expected_origin=settings.passkey_origin,
            require_user_verification=True,
        )
    except (InvalidRegistrationResponse, ValueError, KeyError, TypeError) as exc:
        raise PasskeyVerificationError("registration could not be verified") from exc
    return VerifiedPasskey(
        credential_id=encode_credential_id(verified.credential_id),
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
    )


def authentication_options() -> tuple[dict[str, object], bytes]:
    """ログイン用のオプションとチャレンジを作る。

    allow_credentials は空にする（アドレスを聞かず、端末の選択画面からアカウントを選んでもらう）。
    """
    options = webauthn.generate_authentication_options(
        rp_id=settings.passkey_rp_id,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    return json.loads(webauthn.options_to_json(options)), options.challenge


def credential_id_of(credential: dict[str, object]) -> str:
    """ログインの応答から、使われた credential ID（保存と同じ base64url の文字列）を取り出す。"""
    raw_id = credential.get("rawId")
    if not isinstance(raw_id, str):
        raise PasskeyVerificationError("credential has no rawId")
    try:
        return encode_credential_id(base64url_to_bytes(raw_id))
    except ValueError as exc:
        raise PasskeyVerificationError("credential id is not valid base64url") from exc


def user_handle_of(credential: dict[str, object]) -> bytes | None:
    """ログインの応答の userHandle（端末が持つ user.id）。無ければ None。"""
    response = credential.get("response")
    if not isinstance(response, dict):
        return None
    handle = response.get("userHandle")
    if not isinstance(handle, str) or not handle:
        return None
    try:
        return base64url_to_bytes(handle)
    except ValueError:
        return None


def verify_authentication(
    credential: dict[str, object],
    *,
    challenge: bytes,
    public_key: bytes,
    current_sign_count: int,
) -> int:
    """ログインの応答（署名）を検証して、新しい署名回数を返す。失敗は PasskeyVerificationError。

    署名回数が巻き戻っていたら（鍵が複製された疑い）、ライブラリが拒否する。
    """
    try:
        verified = webauthn.verify_authentication_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=settings.passkey_rp_id,
            expected_origin=settings.passkey_origin,
            credential_public_key=public_key,
            credential_current_sign_count=current_sign_count,
            require_user_verification=True,
        )
    except (InvalidAuthenticationResponse, ValueError, KeyError, TypeError) as exc:
        raise PasskeyVerificationError("authentication could not be verified") from exc
    return verified.new_sign_count
