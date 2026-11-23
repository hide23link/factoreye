"""パスキーでの登録・ログイン・端末の管理・管理者のリセットの試験（AUTH_MODE=multi_tenant）。

端末は tests/webauthn_fake.py のソフトウェアの端末で、本物の署名を作る。サーバーの検証
（py_webauthn）はモックにしない。メールの送信（Resend）だけを差し替えて、送った内容を捕まえる。
"""
import re
from collections.abc import AsyncGenerator, Generator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import jwt
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport
from pydantic import SecretStr
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession
from webauthn.helpers import base64url_to_bytes

from app import admin_accounts, mailer
from app import auth as auth_utils
from app.api import admin as admin_module
from app.api import auth as auth_routes
from app.api import passkeys as passkey_routes
from app.config import AuthMode, Settings, settings
from app.db.models import (
    AuthChallenge,
    EmailToken,
    Passkey,
    RefreshToken,
    User,
    Workspace,
)
from app.db.session import engine
from app.rate_limit import limiter
from tests.helpers import create_user
from tests.webauthn_fake import TEST_RP_ID, FakeAuthenticator

ADMIN_ID = "admin"
ADMIN_PASSWORD = "adminpass123"


@dataclass
class SentMail:
    to: str
    subject: str
    text: str


@pytest.fixture(autouse=True)
def _env(tmp_path: Path) -> Generator[None, None, None]:
    saved = (
        settings.auth_mode,
        settings.admin_credentials_file,
        settings.resend_api_key,
        limiter.enabled,
    )
    settings.auth_mode = AuthMode.MULTI_TENANT
    settings.admin_credentials_file = str(tmp_path / "admins.txt")
    settings.resend_api_key = SecretStr("re_dummy_key_for_tests")
    limiter.enabled = False
    admin_accounts.set_admin(ADMIN_ID, ADMIN_PASSWORD)
    yield
    (
        settings.auth_mode,
        settings.admin_credentials_file,
        settings.resend_api_key,
        limiter.enabled,
    ) = saved


@pytest.fixture
def mails(monkeypatch: pytest.MonkeyPatch) -> list[SentMail]:
    """送ったメールを、送らずに捕まえる（Resend は呼ばない）。"""
    sent: list[SentMail] = []

    async def fake_send(*, to: str, subject: str, text: str, html: str) -> None:
        sent.append(SentMail(to=to, subject=subject, text=text))

    monkeypatch.setattr(mailer, "send_mail", fake_send)
    return sent


@pytest_asyncio.fixture
async def api() -> AsyncGenerator[httpx.AsyncClient, None]:
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(auth_routes.router)
    app.include_router(passkey_routes.router)
    app.include_router(admin_module.router)
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# ── 操作の部品 ────────────────────────────────────────────────


def _link_of(mail: SentMail) -> tuple[str, str]:
    """メール本文のリンクから（種類, 生のトークン）を取り出す。"""
    found = re.search(r"/#(register|recover)=([A-Za-z0-9_-]+)", mail.text)
    assert found, mail.text
    return found.group(1), found.group(2)


def _auth(tokens: dict[str, str]) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['accessToken']}"}


async def _admin_headers(api: httpx.AsyncClient) -> dict[str, str]:
    resp = await api.post(
        "/api/admin/login", json={"adminId": ADMIN_ID, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['accessToken']}"}


async def _request_link(api: httpx.AsyncClient, email: str) -> httpx.Response:
    return await api.post("/api/auth/email/request", json={"email": email})


async def _register_finish(
    api: httpx.AsyncClient, token: str, device: FakeAuthenticator, name: str = "Mac の Chrome"
) -> httpx.Response:
    begin = await api.post("/api/auth/passkey/register/begin", json={"token": token})
    assert begin.status_code == 200, begin.text
    body = begin.json()
    return await api.post(
        "/api/auth/passkey/register/finish",
        json={
            "challengeId": body["challengeId"],
            "credential": device.create(body["options"]),
            "deviceName": name,
        },
    )


async def _signup(
    api: httpx.AsyncClient, mails: list[SentMail], device: FakeAuthenticator, email: str
) -> dict[str, str]:
    """メールのリンク → パスキー登録で、新しい利用者を作る。トークンを返す。"""
    assert (await _request_link(api, email)).status_code == 202
    purpose, token = _link_of(mails[-1])
    assert purpose == "register"
    resp = await _register_finish(api, token, device)
    assert resp.status_code == 200, resp.text
    tokens: dict[str, str] = resp.json()
    return tokens


async def _login(
    api: httpx.AsyncClient, device: FakeAuthenticator, account: str, **tamper: Any
) -> httpx.Response:
    begin = (await api.post("/api/auth/passkey/login/begin")).json()
    return await api.post(
        "/api/auth/passkey/login/finish",
        json={
            "challengeId": begin["challengeId"],
            "credential": device.get(begin["options"], account=account, **tamper),
        },
    )


async def _users() -> list[User]:
    async with AsyncSession(engine) as session:
        return list((await session.exec(select(User))).all())


async def _passkeys_of(email: str) -> list[Passkey]:
    async with AsyncSession(engine) as session:
        user = (await session.exec(select(User).where(User.email == email))).one()
        return list((await session.exec(select(Passkey).where(Passkey.user_id == user.id))).all())


async def _add_device(
    api: httpx.AsyncClient, tokens: dict[str, str], device: FakeAuthenticator, name: str = "iPhone"
) -> httpx.Response:
    """ログイン中に、端末（パスキー）を足す。"""
    begin = await api.post("/api/passkeys/register/begin", headers=_auth(tokens))
    assert begin.status_code == 200, begin.text
    body = begin.json()
    return await api.post(
        "/api/passkeys/register/finish",
        headers=_auth(tokens),
        json={
            "challengeId": body["challengeId"],
            "credential": device.create(body["options"]),
            "deviceName": name,
        },
    )


# ── 1. 登録: メール確認前は利用者を作らない ────────────────────


async def test_register_flow_creates_user_only_after_passkey(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    email = "tanaka@example.com"
    resp = await _request_link(api, email)
    assert resp.status_code == 202
    assert resp.json() == {"status": "sent"}
    # メールを送っただけでは、利用者もワークスペースも作らない
    assert await _users() == []
    assert len(mails) == 1
    assert mails[0].to == email
    purpose, token = _link_of(mails[0])
    assert purpose == "register"
    # 本文は、日本語と英語の併記
    assert "24 時間" in mails[0].text and "24 hours" in mails[0].text

    device = FakeAuthenticator()
    finished = await _register_finish(api, token, device)
    assert finished.status_code == 200
    tokens = finished.json()

    users = await _users()
    assert [u.email for u in users] == [email]
    assert users[0].password_hash is None  # パスワードを持たない
    async with AsyncSession(engine) as session:
        ws = (await session.exec(select(Workspace))).one()
        assert ws.name == "tanaka"  # メールの @ の前から自動
        assert ws.owner_id == users[0].id
    me = await api.get("/api/me", headers={"Authorization": f"Bearer {tokens['accessToken']}"})
    assert me.status_code == 200
    assert me.json()["email"] == email
    assert len(await _passkeys_of(email)) == 1


async def test_register_options_use_account_specific_user_id_and_email(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _request_link(api, "alice@example.com")
    _, token = _link_of(mails[-1])
    begin = (await api.post("/api/auth/passkey/register/begin", json={"token": token})).json()
    user = begin["options"]["user"]
    assert user["name"] == "alice@example.com"
    assert "alice@example.com" in user["displayName"]
    async with AsyncSession(engine) as session:
        row = (await session.exec(select(EmailToken))).one()
        # user.id は、これから作る利用者 ID の UUID のバイト列（アカウントごとに固有）
        assert base64url_to_bytes(user["id"]) == row.user_id.bytes
    selection = begin["options"]["authenticatorSelection"]
    assert selection["residentKey"] == "required"
    assert selection["userVerification"] == "required"
    assert begin["email"] == "alice@example.com"
    assert begin["purpose"] == "register"


async def test_register_link_is_single_use(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _request_link(api, "once@example.com")
    _, token = _link_of(mails[-1])
    assert (await _register_finish(api, token, FakeAuthenticator())).status_code == 200
    again = await api.post("/api/auth/passkey/register/begin", json={"token": token})
    assert again.status_code == 410


async def test_register_finish_cannot_reuse_a_begin_after_link_is_used(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    """同じリンクで begin を 2 回 → 先に finish した方だけが通る。"""
    await _request_link(api, "race@example.com")
    _, token = _link_of(mails[-1])
    begins = [
        (await api.post("/api/auth/passkey/register/begin", json={"token": token})).json()
        for _ in range(2)
    ]
    results = []
    for body in begins:
        results.append(
            await api.post(
                "/api/auth/passkey/register/finish",
                json={
                    "challengeId": body["challengeId"],
                    "credential": FakeAuthenticator().create(body["options"]),
                    "deviceName": "d",
                },
            )
        )
    assert [r.status_code for r in results] == [200, 410]
    assert len(await _users()) == 1


async def test_register_link_expires_after_24_hours(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _request_link(api, "late@example.com")
    _, token = _link_of(mails[-1])
    async with AsyncSession(engine) as session:
        row = (await session.exec(select(EmailToken))).one()
        # 有効期限は 24 時間
        lifetime = row.expires_at - row.created_at
        assert timedelta(hours=23, minutes=55) < lifetime <= timedelta(hours=24)
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        session.add(row)
        await session.commit()
    resp = await api.post("/api/auth/passkey/register/begin", json={"token": token})
    assert resp.status_code == 410
    assert await _users() == []


async def test_register_with_unknown_token_is_410(api: httpx.AsyncClient) -> None:
    resp = await api.post("/api/auth/passkey/register/begin", json={"token": "x" * 40})
    assert resp.status_code == 410


async def test_register_rejects_bad_attestation_origin(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _request_link(api, "evil@example.com")
    _, token = _link_of(mails[-1])
    evil = FakeAuthenticator(origin="https://evil.example")
    resp = await _register_finish(api, token, evil)
    assert resp.status_code == 400
    assert await _users() == []
    # 失敗してもリンクは使える（新しいチャレンジでやり直せる）
    assert (await _register_finish(api, token, FakeAuthenticator())).status_code == 200


# ── 2. メールの依頼: 登録の有無を応答に出さない・回数の制限 ────


async def test_email_request_response_is_identical_for_registered_and_unknown(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "known@example.com")
    mails.clear()
    known = await _request_link(api, "known@example.com")
    unknown = await _request_link(api, "nobody@example.com")
    assert (known.status_code, known.json()) == (unknown.status_code, unknown.json())
    purposes = {m.to: _link_of(m)[0] for m in mails}
    assert purposes == {"known@example.com": "recover", "nobody@example.com": "register"}
    assert "1 時間" in mails[0].text and "1 hour" in mails[0].text


async def test_email_request_limit_is_3_per_hour_with_same_response(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    responses = [await _request_link(api, "many@example.com") for _ in range(5)]
    assert {r.status_code for r in responses} == {202}
    assert len({r.text for r in responses}) == 1
    assert len(mails) == 3  # 4 通目以降は送らない（応答は同じ）
    # 別のアドレスは数えない
    await _request_link(api, "other@example.com")
    assert len(mails) == 4


async def test_email_request_without_mail_configuration_is_503(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    settings.resend_api_key = SecretStr("")
    resp = await _request_link(api, "a@example.com")
    assert resp.status_code == 503
    assert mails == []


async def test_email_request_normalizes_the_address(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "case@example.com")
    mails.clear()
    await _request_link(api, "  CASE@Example.com ")
    assert _link_of(mails[0])[0] == "recover"  # 大文字・空白が違っても、同じ利用者


async def test_mail_failure_does_not_change_the_response(
    api: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(**_: object) -> None:
        raise mailer.MailSendError("down")

    monkeypatch.setattr(mailer, "send_mail", boom)
    resp = await _request_link(api, "fail@example.com")
    assert resp.status_code == 202


# ── 3. ログイン ───────────────────────────────────────────────


async def test_login_with_passkey_needs_no_email_and_issues_180_day_session(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    await _signup(api, mails, device, "login@example.com")

    begin = (await api.post("/api/auth/passkey/login/begin")).json()
    options = begin["options"]
    assert options.get("allowCredentials", []) == []  # アドレスを聞かない
    assert options["userVerification"] == "required"

    resp = await _login(api, device, "login@example.com")
    assert resp.status_code == 200, resp.text
    tokens = resp.json()
    payload = jwt.decode(tokens["accessToken"], settings.jwt_secret, algorithms=["HS256"])
    assert payload["sub"] == str((await _users())[0].id)
    # リフレッシュトークンは 180 日（使うたびに延びる）
    async with AsyncSession(engine) as session:
        rows = (await session.exec(select(RefreshToken))).all()
        latest = max(rows, key=lambda r: r.created_at)
        remaining = latest.expires_at.replace(tzinfo=UTC) - datetime.now(UTC)
        assert timedelta(days=179) < remaining <= timedelta(days=180)
    refreshed = await api.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert refreshed.status_code == 200
    passkey = (await _passkeys_of("login@example.com"))[0]
    assert passkey.last_used_at is not None
    assert passkey.sign_count == 1


async def test_login_rejects_tampered_signature(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    await _signup(api, mails, device, "sig@example.com")
    resp = await _login(api, device, "sig@example.com", tamper_signature=True)
    assert resp.status_code == 401


async def test_login_rejects_unknown_credential(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "known@example.com")
    # このサービスに登録していない端末の鍵（サーバーは、この鍵を知らない）
    stranger = FakeAuthenticator()
    other_options = {
        "rp": {"id": "localhost", "name": "FactorEye"},
        "user": {"id": "AAAA", "name": "stranger@example.com", "displayName": "s"},
        "challenge": "AAAA",
    }
    stranger.create(other_options)
    resp = await _login(api, stranger, "stranger@example.com")
    assert resp.status_code == 401


async def test_login_rejects_mismatched_user_handle(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    await _signup(api, mails, device, "handle@example.com")
    resp = await _login(api, device, "handle@example.com", wrong_user_handle=b"x" * 16)
    assert resp.status_code == 401


async def test_login_challenge_is_single_use(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    await _signup(api, mails, device, "replay@example.com")
    begin = (await api.post("/api/auth/passkey/login/begin")).json()
    body = {
        "challengeId": begin["challengeId"],
        "credential": device.get(begin["options"], account="replay@example.com"),
    }
    assert (await api.post("/api/auth/passkey/login/finish", json=body)).status_code == 200
    # 同じ応答の使い回し（リプレイ）は通らない
    assert (await api.post("/api/auth/passkey/login/finish", json=body)).status_code == 401


async def test_login_challenge_expires_after_5_minutes(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    await _signup(api, mails, device, "slow@example.com")
    begin = (await api.post("/api/auth/passkey/login/begin")).json()
    async with AsyncSession(engine) as session:
        row = (await session.exec(select(AuthChallenge))).one()
        assert timedelta(minutes=4) < row.expires_at - row.created_at <= timedelta(minutes=5)
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        session.add(row)
        await session.commit()
    resp = await api.post(
        "/api/auth/passkey/login/finish",
        json={
            "challengeId": begin["challengeId"],
            "credential": device.get(begin["options"], account="slow@example.com"),
        },
    )
    assert resp.status_code == 401


async def test_login_challenge_of_another_purpose_is_rejected(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    tokens = await _signup(api, mails, device, "kind@example.com")
    begin = (await api.post("/api/passkeys/register/begin", headers=_auth(tokens))).json()
    login_like = {"rpId": TEST_RP_ID, "challenge": begin["options"]["challenge"]}
    resp = await api.post(
        "/api/auth/passkey/login/finish",
        json={
            # 「端末を足す」用のチャレンジは、ログインに使えない
            "challengeId": begin["challengeId"],
            "credential": device.get(login_like, account="kind@example.com"),
        },
    )
    assert resp.status_code == 401


async def test_login_rejects_wrong_origin(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    await _signup(api, mails, device, "origin@example.com")
    device.origin = "https://evil.example"
    assert (await _login(api, device, "origin@example.com")).status_code == 401


async def test_login_rejects_sign_count_rollback(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    await _signup(api, mails, device, "clone@example.com")
    assert (await _login(api, device, "clone@example.com", sign_count=5)).status_code == 200
    # 回数が戻った（鍵が複製された疑い）
    assert (await _login(api, device, "clone@example.com", sign_count=3)).status_code == 401


async def test_old_password_endpoints_are_gone(api: httpx.AsyncClient) -> None:
    for path in ("/api/auth/register", "/api/auth/login"):
        resp = await api.post(path, json={"email": "a@example.com", "password": "password123"})
        assert resp.status_code in (404, 405)


async def test_passkey_routes_are_absent_in_self_hosted_app() -> None:
    """OSS 版（AUTH_MODE=disabled の本体）には、パスキーの API は登録されない。"""
    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        for path in ("/api/auth/email/request", "/api/auth/passkey/login/begin", "/api/passkeys"):
            resp = await c.post(path, json={"email": "a@example.com"})
            assert resp.status_code in (404, 405), path


# ── 4. 1 つの端末に、アカウントごとのパスキーを複数 ───────────


async def test_two_accounts_on_one_device_do_not_overwrite_each_other(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()  # 同じ端末・同じ rp_id
    await _signup(api, mails, device, "alice@example.com")
    await _signup(api, mails, device, "bob@example.com")

    # 端末には、2 つのアカウントのパスキーが残っている（user.id が違うので上書きされない）
    assert sorted(device.accounts()) == ["alice@example.com", "bob@example.com"]
    alice_key = (await _passkeys_of("alice@example.com"))[0]
    bob_key = (await _passkeys_of("bob@example.com"))[0]
    assert alice_key.credential_id != bob_key.credential_id

    # 端末の選択画面で、アカウントを選んでログインできる
    alice = await _login(api, device, "alice@example.com")
    bob = await _login(api, device, "bob@example.com")
    assert alice.status_code == bob.status_code == 200
    users = {u.email: u.id for u in await _users()}
    for resp, email in ((alice, "alice@example.com"), (bob, "bob@example.com")):
        claims = jwt.decode(resp.json()["accessToken"], settings.jwt_secret, algorithms=["HS256"])
        assert UUID(claims["sub"]) == users[email]


async def test_deleting_one_accounts_passkey_does_not_affect_the_other(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    alice_tokens = await _signup(api, mails, device, "alice@example.com")
    await _signup(api, mails, device, "bob@example.com")
    # alice が 2 台目（別の端末）を足してから、最初の端末を消す
    second = FakeAuthenticator()
    assert (await _add_device(api, alice_tokens, second, "iPhone")).status_code == 201
    alice_first = next(
        p for p in await _passkeys_of("alice@example.com") if p.name == "Mac の Chrome"
    )
    deleted = await api.delete(f"/api/passkeys/{alice_first.id}", headers=_auth(alice_tokens))
    assert deleted.status_code == 204

    assert len(await _passkeys_of("alice@example.com")) == 1
    assert len(await _passkeys_of("bob@example.com")) == 1  # bob は変わらない
    assert (await _login(api, device, "bob@example.com")).status_code == 200


async def test_last_passkey_rule_counts_per_account(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    alice_tokens = await _signup(api, mails, device, "alice@example.com")
    await _signup(api, mails, device, "bob@example.com")
    # 全体では 2 つあるが、alice にとっては最後の 1 台
    alice_key = (await _passkeys_of("alice@example.com"))[0]
    resp = await api.delete(f"/api/passkeys/{alice_key.id}", headers=_auth(alice_tokens))
    assert resp.status_code == 409
    assert resp.json()["detail"] == "cannot delete the last passkey"
    # 他のアカウントのパスキーは、消せない（無いのと同じ 404）
    bob_key = (await _passkeys_of("bob@example.com"))[0]
    assert (
        await api.delete(f"/api/passkeys/{bob_key.id}", headers=_auth(alice_tokens))
    ).status_code == 404
    assert len(await _passkeys_of("bob@example.com")) == 1


# ── 5. 端末の管理 ─────────────────────────────────────────────


async def test_devices_list_rename_and_add(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    tokens = await _signup(api, mails, device, "dev@example.com")
    listed = (await api.get("/api/passkeys", headers=_auth(tokens))).json()
    assert [p["name"] for p in listed] == ["Mac の Chrome"]
    assert listed[0]["lastUsedAt"] is None
    assert "publicKey" not in listed[0]

    assert (await _add_device(api, tokens, FakeAuthenticator(), "iPhone")).status_code == 201
    listed = (await api.get("/api/passkeys", headers=_auth(tokens))).json()
    assert [p["name"] for p in listed] == ["Mac の Chrome", "iPhone"]

    renamed = await api.patch(
        f"/api/passkeys/{listed[1]['id']}", headers=_auth(tokens), json={"name": "  仕事の iPhone "}
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "仕事の iPhone"
    blank = await api.patch(
        f"/api/passkeys/{listed[1]['id']}", headers=_auth(tokens), json={"name": "   "}
    )
    assert blank.status_code == 422

    # 2 台あれば消せる。最後の 1 台は消せない
    assert (
        await api.delete(f"/api/passkeys/{listed[1]['id']}", headers=_auth(tokens))
    ).status_code == 204
    assert (
        await api.delete(f"/api/passkeys/{listed[0]['id']}", headers=_auth(tokens))
    ).status_code == 409


async def test_adding_the_same_device_again_is_excluded_in_options(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    tokens = await _signup(api, mails, FakeAuthenticator(), "dup@example.com")
    begin = (await api.post("/api/passkeys/register/begin", headers=_auth(tokens))).json()
    existing = (await _passkeys_of("dup@example.com"))[0].credential_id
    assert [c["id"] for c in begin["options"]["excludeCredentials"]] == [existing]


async def test_passkey_count_is_limited_per_account(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    tokens = await _signup(api, mails, FakeAuthenticator(), "many@example.com")
    for i in range(9):
        assert (await _add_device(api, tokens, FakeAuthenticator(), f"d{i}")).status_code == 201
    assert (await _add_device(api, tokens, FakeAuthenticator(), "over")).status_code == 409


async def test_device_endpoints_need_login(api: httpx.AsyncClient) -> None:
    assert (await api.get("/api/passkeys")).status_code in (401, 403)
    bad = await api.get("/api/passkeys", headers={"Authorization": "Bearer nope"})
    assert bad.status_code == 401


async def test_device_endpoints_are_closed_while_admin_views_as_user(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "viewed@example.com")
    user = (await _users())[0]
    async with AsyncSession(engine) as session:
        ws = (await session.exec(select(Workspace))).one()
        ws_id = ws.id
    token, _ = auth_utils.create_impersonation_token(user.id, ws_id, "admin")
    headers = {"Authorization": f"Bearer {token}"}
    assert (await api.get("/api/passkeys", headers=headers)).status_code == 403
    assert (await api.post("/api/passkeys/register/begin", headers=headers)).status_code == 403


# ── 6. 失くしたとき（メールの再登録リンク） ───────────────────


async def test_recover_link_adds_a_new_device_and_keeps_existing_sessions(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    old_device = FakeAuthenticator()
    tokens = await _signup(api, mails, old_device, "lost@example.com")
    mails.clear()
    await _request_link(api, "lost@example.com")
    purpose, link_token = _link_of(mails[0])
    assert purpose == "recover"
    begin = (await api.post("/api/auth/passkey/register/begin", json={"token": link_token})).json()
    assert begin["purpose"] == "recover"
    assert begin["email"] == "lost@example.com"
    # 持っている鍵は、端末に拒否させる
    assert len(begin["options"]["excludeCredentials"]) == 1

    new_device = FakeAuthenticator()
    finished = await api.post(
        "/api/auth/passkey/register/finish",
        json={
            "challengeId": begin["challengeId"],
            "credential": new_device.create(begin["options"]),
            "deviceName": "新しい Mac",
        },
    )
    assert finished.status_code == 200
    assert len(await _passkeys_of("lost@example.com")) == 2
    assert len(await _users()) == 1  # 新しい利用者は作らない
    # 今のログインは変わらない（メールの文面どおり）
    refreshed = await api.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert refreshed.status_code == 200
    assert (await _login(api, new_device, "lost@example.com")).status_code == 200


async def test_recover_link_expires_after_1_hour(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "hour@example.com")
    mails.clear()
    await _request_link(api, "hour@example.com")
    async with AsyncSession(engine) as session:
        row = (
            await session.exec(select(EmailToken).where(col(EmailToken.purpose) == "recover"))
        ).one()
        assert timedelta(minutes=55) < row.expires_at - row.created_at <= timedelta(hours=1)


# ── 7. 管理者のリセット ───────────────────────────────────────


async def _user_id(email: str) -> UUID:
    return next(u.id for u in await _users() if u.email == email)


async def test_admin_reset_revokes_sessions_deletes_passkeys_and_sends_link(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    tokens = await _signup(api, mails, device, "reset@example.com")
    mails.clear()
    headers = await _admin_headers(api)
    user_id = await _user_id("reset@example.com")

    resp = await api.post(f"/api/admin/users/{user_id}/reset", headers=headers, json={})
    assert resp.status_code == 200
    assert resp.json() == {"emailQueued": True}

    # 全端末のログインが終わる
    assert (
        await api.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    ).status_code == 401
    # パスキーは既定で削除される。端末のパスキーでは、もう入れない
    assert await _passkeys_of("reset@example.com") == []
    assert (await _login(api, device, "reset@example.com")).status_code == 401
    # 再登録のリンクが、利用者のアドレスへ届く
    assert [m.to for m in mails] == ["reset@example.com"]
    purpose, link_token = _link_of(mails[0])
    assert purpose == "recover"

    # リンクから新しい端末を登録すると、また入れる
    new_device = FakeAuthenticator()
    assert (await _register_finish(api, link_token, new_device)).status_code == 200
    assert (await _login(api, new_device, "reset@example.com")).status_code == 200
    assert len(await _users()) == 1  # 同じ利用者（データは残る）


async def test_admin_reset_can_keep_passkeys(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    tokens = await _signup(api, mails, FakeAuthenticator(), "keep@example.com")
    headers = await _admin_headers(api)
    user_id = await _user_id("keep@example.com")
    resp = await api.post(
        f"/api/admin/users/{user_id}/reset", headers=headers, json={"deletePasskeys": False}
    )
    assert resp.status_code == 200
    assert len(await _passkeys_of("keep@example.com")) == 1
    assert (
        await api.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    ).status_code == 401  # ログインは終了している


async def test_admin_reset_migrates_an_old_password_account(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    """パスキー導入前のパスワードの利用者（test1/test2 など）を、パスキーへ移せる。"""
    await create_user("old@example.com")
    async with AsyncSession(engine) as session:
        user = (await session.exec(select(User))).one()
        user.password_hash = auth_utils.hash_password("old-password-1")
        session.add(user)
        await session.commit()
    headers = await _admin_headers(api)
    user_id = await _user_id("old@example.com")
    assert (
        await api.post(f"/api/admin/users/{user_id}/reset", headers=headers, json={})
    ).status_code == 200
    assert (await _users())[0].password_hash is None  # パスワードのハッシュは消える
    _, link_token = _link_of(mails[-1])
    assert (await _register_finish(api, link_token, FakeAuthenticator())).status_code == 200
    assert len(await _passkeys_of("old@example.com")) == 1


async def test_admin_reset_requires_admin_and_known_user(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    tokens = await _signup(api, mails, FakeAuthenticator(), "guard@example.com")
    user_id = await _user_id("guard@example.com")
    assert (await api.post(f"/api/admin/users/{user_id}/reset", json={})).status_code in (401, 403)
    # 利用者のトークンでは、管理者の API を呼べない
    assert (
        await api.post(f"/api/admin/users/{user_id}/reset", headers=_auth(tokens), json={})
    ).status_code in (401, 403)
    headers = await _admin_headers(api)
    unknown = await api.post(
        "/api/admin/users/00000000-0000-0000-0000-000000000000/reset", headers=headers, json={}
    )
    assert unknown.status_code == 404


async def test_admin_reset_changes_nothing_when_mail_is_not_configured(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "nomail@example.com")
    settings.resend_api_key = SecretStr("")
    headers = await _admin_headers(api)
    user_id = await _user_id("nomail@example.com")
    resp = await api.post(f"/api/admin/users/{user_id}/reset", headers=headers, json={})
    assert resp.status_code == 503
    assert len(await _passkeys_of("nomail@example.com")) == 1  # 何も消えていない


async def test_admin_reset_changes_nothing_when_email_limit_is_reached(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "limit@example.com")
    for _ in range(2):  # 登録の 1 通と合わせて 3 通
        await _request_link(api, "limit@example.com")
    headers = await _admin_headers(api)
    user_id = await _user_id("limit@example.com")
    resp = await api.post(f"/api/admin/users/{user_id}/reset", headers=headers, json={})
    assert resp.status_code == 429
    assert len(await _passkeys_of("limit@example.com")) == 1


async def test_admin_user_list_shows_passkey_count_and_no_password_field(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    tokens = await _signup(api, mails, FakeAuthenticator(), "count@example.com")
    await _add_device(api, tokens, FakeAuthenticator(), "iPhone")
    headers = await _admin_headers(api)
    listing = (await api.get("/api/admin/users", headers=headers)).json()
    assert listing[0]["passkeyCount"] == 2
    assert "passwordHash" not in listing[0]
    # 管理者が、パスワードを設定する口は無い
    user_id = listing[0]["id"]
    patched = await api.patch(
        f"/api/admin/users/{user_id}", headers=headers, json={"password": "new-password-1"}
    )
    assert patched.status_code == 200
    async with AsyncSession(engine) as session:
        assert (await session.exec(select(User))).one().password_hash is None


async def test_deleting_a_user_removes_the_passkeys(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "gone@example.com")
    headers = await _admin_headers(api)
    user_id = await _user_id("gone@example.com")
    assert (await api.delete(f"/api/admin/users/{user_id}", headers=headers)).status_code == 204
    async with AsyncSession(engine) as session:
        assert (await session.exec(select(Passkey))).all() == []


# ── 8. 設定 ───────────────────────────────────────────────────


def test_rp_id_and_origin_come_from_frontend_url() -> None:
    saved = (settings.frontend_url, settings.webauthn_rp_id, settings.webauthn_origin)
    try:
        settings.webauthn_rp_id = ""
        settings.webauthn_origin = ""
        settings.frontend_url = "https://factoreye.hide23.link/"
        assert settings.passkey_rp_id == "factoreye.hide23.link"
        assert settings.passkey_origin == "https://factoreye.hide23.link"
        settings.webauthn_rp_id = "hide23.link"
        settings.webauthn_origin = "https://factoreye.hide23.link"
        assert settings.passkey_rp_id == "hide23.link"
    finally:
        settings.frontend_url, settings.webauthn_rp_id, settings.webauthn_origin = saved


def test_refresh_token_default_is_180_days() -> None:
    assert Settings.model_fields["jwt_refresh_expire_days"].default == 180
