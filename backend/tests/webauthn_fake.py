"""テスト用の「ソフトウェアの端末（認証器）」。本物の署名を作り、サーバーの検証を通す。

本物の端末（Touch ID・Windows Hello など）と同じ形の登録・ログインの応答を作る:
 - 登録: attestation なし（"none"）の証明書。ES256（ECDSA P-256）の鍵を作る
 - ログイン: authenticatorData ＋ clientDataJSON のハッシュに、秘密鍵で署名する
サーバーの検証（py_webauthn）は、モックにせず、そのまま動かして試す。

端末の保存の規則も、本物と同じにしている: 鍵は（rp_id, user.id）ごとに 1 つだけ。
同じ user.id で 2 つ目を登録すると、1 つ目を上書きする。FactorEye が、アカウントごとに違う
user.id（利用者 ID）を渡しているかを、この上書きで確かめられる。
"""
import hashlib
import json
import os
import struct
from dataclasses import dataclass, field

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url

TEST_ORIGIN = "http://localhost:3001"
TEST_RP_ID = "localhost"

_FLAG_USER_PRESENT = 0x01
_FLAG_USER_VERIFIED = 0x04
_FLAG_ATTESTED_CREDENTIAL_DATA = 0x40


@dataclass
class StoredCredential:
    """端末が持つ鍵 1 つ分。"""

    credential_id: bytes
    private_key: ec.EllipticCurvePrivateKey
    user_handle: bytes
    user_name: str
    sign_count: int = 0


@dataclass
class FakeAuthenticator:
    """1 台の端末。複数のアカウントのパスキーを持てる。"""

    rp_id: str = TEST_RP_ID
    origin: str = TEST_ORIGIN
    # （rp_id, user.id）→ 鍵。同じ組に 2 回登録すると上書きされる
    store: dict[tuple[str, bytes], StoredCredential] = field(default_factory=dict)

    def create(
        self, options: dict[str, object], *, user_verified: bool = True
    ) -> dict[str, object]:
        """サーバーの登録オプションから、登録の応答を作る（credentials.create の結果）。"""
        rp = options["rp"]
        user = options["user"]
        assert isinstance(rp, dict) and isinstance(user, dict)
        rp_id = str(rp["id"])
        user_handle = base64url_to_bytes(str(user["id"]))
        challenge = str(options["challenge"])

        credential_id = os.urandom(32)  # 端末ごとに、重ならない値
        private_key = ec.generate_private_key(ec.SECP256R1())
        numbers = private_key.public_key().public_numbers()
        cose_key = cbor2.dumps(
            {
                1: 2,  # kty: EC2
                3: -7,  # alg: ES256
                -1: 1,  # crv: P-256
                -2: numbers.x.to_bytes(32, "big"),
                -3: numbers.y.to_bytes(32, "big"),
            }
        )
        auth_data = (
            hashlib.sha256(rp_id.encode()).digest()
            + bytes(
                [
                    _FLAG_USER_PRESENT
                    | (_FLAG_USER_VERIFIED if user_verified else 0)
                    | _FLAG_ATTESTED_CREDENTIAL_DATA
                ]
            )
            + struct.pack(">I", 0)
            + bytes(16)  # aaguid
            + struct.pack(">H", len(credential_id))
            + credential_id
            + cose_key
        )
        client_data = json.dumps(
            {"type": "webauthn.create", "challenge": challenge, "origin": self.origin}
        ).encode()
        attestation = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})

        # 同じ（rp_id, user.id）の鍵があれば、上書きされる（本物の端末と同じ）
        self.store[(rp_id, user_handle)] = StoredCredential(
            credential_id=credential_id,
            private_key=private_key,
            user_handle=user_handle,
            user_name=str(user["name"]),
        )
        encoded_id = bytes_to_base64url(credential_id)
        return {
            "id": encoded_id,
            "rawId": encoded_id,
            "type": "public-key",
            "response": {
                "clientDataJSON": bytes_to_base64url(client_data),
                "attestationObject": bytes_to_base64url(attestation),
            },
            "clientExtensionResults": {},
        }

    def accounts(self) -> list[str]:
        """端末の選択画面に並ぶアカウント名（user.name = メールアドレス）。"""
        return [c.user_name for c in self.store.values()]

    def get(
        self,
        options: dict[str, object],
        *,
        account: str,
        tamper_signature: bool = False,
        wrong_user_handle: bytes | None = None,
        sign_count: int | None = None,
        user_verified: bool = True,
        rp_id_for_hash: str | None = None,
    ) -> dict[str, object]:
        """ログインの応答を作る（navigator.credentials.get の結果）。

        account は、端末の選択画面で利用者が選ぶアカウント（メールアドレス）。
        """
        matches = [c for c in self.store.values() if c.user_name == account]
        assert len(matches) == 1, f"端末に {account} のパスキーが無い、または複数ある"
        cred = matches[0]
        cred.sign_count = sign_count if sign_count is not None else cred.sign_count + 1

        # rp_id_for_hash は、別のサイト（rp_id）向けに作った応答を真似るための指定
        rp_id = rp_id_for_hash or str(options["rpId"])
        auth_data = (
            hashlib.sha256(rp_id.encode()).digest()
            + bytes([_FLAG_USER_PRESENT | (_FLAG_USER_VERIFIED if user_verified else 0)])
            + struct.pack(">I", cred.sign_count)
        )
        client_data = json.dumps(
            {"type": "webauthn.get", "challenge": str(options["challenge"]), "origin": self.origin}
        ).encode()
        signature = cred.private_key.sign(
            auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())
        )
        if tamper_signature:
            signature = signature[:-1] + bytes([signature[-1] ^ 0xFF])
        handle = wrong_user_handle if wrong_user_handle is not None else cred.user_handle
        encoded_id = bytes_to_base64url(cred.credential_id)
        return {
            "id": encoded_id,
            "rawId": encoded_id,
            "type": "public-key",
            "response": {
                "clientDataJSON": bytes_to_base64url(client_data),
                "authenticatorData": bytes_to_base64url(auth_data),
                "signature": bytes_to_base64url(signature),
                "userHandle": bytes_to_base64url(handle),
            },
            "clientExtensionResults": {},
        }
