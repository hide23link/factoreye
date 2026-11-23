"""メールの 1 日の送信数の上限と、運用者への通知（Discord）の試験（AUTH_MODE=multi_tenant）。

上限の対象は、一般の依頼（登録・再登録・ログインリンク）のメールだけ。登録されていないアドレスの
ダミー行と、管理者のリセット（by_admin）は数えない。日の区切りは UTC。
fixture と操作の部品は、test_passkeys.py のものを使う。
"""
# ruff: noqa: F811 - 別のファイルから読み込んだ fixture を、引数の名前で受け取るため
import asyncio
import re
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import httpx
import pytest
from pydantic import SecretStr
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession
from test_passkeys import (  # noqa: F401 - fixture（_env・api・mails）を、この試験でも使う
    SentMail,
    _admin_headers,
    _env,
    _login,
    _request_link,
    _request_login_link,
    _signup,
    _user_id,
    api,
    mails,
)
from webauthn_fake import FakeAuthenticator

from app import notifications
from app import passkey_service as service
from app.config import settings
from app.db.models import EmailToken, OpsNoticeMark
from app.db.session import engine

WEBHOOK = "https://discord.com/api/webhooks/123456/dummy-token-for-tests"


@pytest.fixture(autouse=True)
def _cap_settings() -> Generator[None, None, None]:
    saved = (
        settings.email_daily_limit,
        settings.email_daily_warn_percent,
        settings.ops_discord_webhook_url,
    )
    settings.email_daily_limit = 3
    settings.email_daily_warn_percent = 80
    settings.ops_discord_webhook_url = SecretStr("")
    yield
    (
        settings.email_daily_limit,
        settings.email_daily_warn_percent,
        settings.ops_discord_webhook_url,
    ) = saved


class OpsNotices(list[str]):
    """捕まえた運用者への知らせ。ok を False にすると、送信の失敗を真似る。"""

    ok: bool = True


@pytest.fixture
def ops_notices(monkeypatch: pytest.MonkeyPatch) -> OpsNotices:
    """運用者への知らせを、送らずに捕まえる。"""
    sent = OpsNotices()

    async def fake_send(webhook_url: str, content: str) -> bool:
        sent.append(content)
        return sent.ok

    monkeypatch.setattr(notifications, "send_ops_discord", fake_send)
    return sent


async def _marks() -> list[OpsNoticeMark]:
    async with AsyncSession(engine) as session:
        return list((await session.exec(select(OpsNoticeMark))).all())


# ── 上限 ──────────────────────────────────────────────────────


async def test_requests_up_to_the_limit_succeed_and_the_next_one_is_503(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    for i in range(3):  # 上限ちょうど
        assert (await _request_link(api, f"u{i}@example.com")).status_code == 202
    assert len(mails) == 3

    over = await _request_link(api, "u3@example.com")

    assert over.status_code == 503
    assert over.json() == {"detail": "mail is busy"}
    assert "retry-after" not in {k.lower() for k in over.headers}  # Retry-After は付けない
    assert len(mails) == 3  # 送っていない


async def test_the_cap_covers_all_three_kinds_of_requests(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "known@example.com")  # 登録の依頼 1 通
    # ログインリンク
    assert (await _request_login_link(api, "known@example.com")).status_code == 202
    assert (await _request_link(api, "known@example.com")).status_code == 202  # 再登録
    assert len(mails) == 3

    assert (await _request_link(api, "new@example.com")).status_code == 503
    assert (await _request_login_link(api, "known@example.com")).status_code == 503


async def test_response_at_the_cap_is_identical_for_registered_and_unregistered(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "known@example.com")
    for i in range(2):
        await _request_link(api, f"fill{i}@example.com")
    assert len(mails) == 3  # 上限

    pairs = [
        (
            await _request_link(api, "known@example.com"),
            await _request_link(api, "nobody@example.com"),
        ),
        (
            await _request_login_link(api, "known@example.com"),
            await _request_login_link(api, "nobody@example.com"),
        ),
    ]
    for registered, unregistered in pairs:
        assert registered.status_code == unregistered.status_code == 503
        assert registered.text == unregistered.text
    assert len(mails) == 3


async def test_dummy_rows_for_unregistered_addresses_are_not_counted(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    for i in range(6):  # 登録されていないアドレスへのログインリンクの依頼（送らないダミー行）
        assert (await _request_login_link(api, f"ghost{i}@example.com")).status_code == 202
    assert mails == []
    async with AsyncSession(engine) as session:
        assert await service.count_general_mail_sent_today(session) == 0
    # 上限（3 通）は、まだ丸ごと残っている
    for i in range(3):
        assert (await _request_link(api, f"real{i}@example.com")).status_code == 202


async def test_per_address_hourly_limit_does_not_consume_the_cap(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    settings.email_daily_limit = 10
    responses = [await _request_link(api, "busy@example.com") for _ in range(6)]
    # アドレスごとの 3 通/時: 送らないが、応答は同じ
    assert {r.status_code for r in responses} == {202}
    assert len(mails) == 3
    async with AsyncSession(engine) as session:
        assert await service.count_general_mail_sent_today(session) == 3  # 送った分だけ数える


async def test_admin_reset_is_outside_the_cap_but_is_marked(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "own@example.com")  # 一般 1 通
    headers = await _admin_headers(api)
    user_id = await _user_id("own@example.com")
    for _ in range(5):  # 上限（3）を超える回数、リセットしても止まらない
        assert (
            await api.post(f"/api/admin/users/{user_id}/reset", headers=headers, json={})
        ).status_code == 200

    async with AsyncSession(engine) as session:
        assert await service.count_general_mail_sent_today(session) == 1  # リセットは数えない
        admin_rows = (
            await session.exec(select(EmailToken).where(col(EmailToken.by_admin).is_(True)))
        ).all()
        assert len(admin_rows) == 5
        assert all(row.mail_sent_at is not None for row in admin_rows)  # 印は付く
    # 一般の依頼は、あと 2 通送れる
    assert (await _request_link(api, "a@example.com")).status_code == 202
    assert (await _request_link(api, "b@example.com")).status_code == 202
    assert (await _request_link(api, "c@example.com")).status_code == 503


async def test_admin_reset_still_works_when_the_general_cap_is_reached(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    await _signup(api, mails, FakeAuthenticator(), "own@example.com")
    for i in range(2):
        await _request_link(api, f"fill{i}@example.com")
    assert (await _request_link(api, "over@example.com")).status_code == 503
    headers = await _admin_headers(api)
    user_id = await _user_id("own@example.com")

    resp = await api.post(f"/api/admin/users/{user_id}/reset", headers=headers, json={})

    assert resp.status_code == 200


async def test_passkey_login_is_not_affected_by_the_cap(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    device = FakeAuthenticator()
    tokens = await _signup(api, mails, device, "pk@example.com")
    for i in range(2):
        await _request_link(api, f"fill{i}@example.com")
    assert (await _request_link(api, "over@example.com")).status_code == 503

    assert (await _login(api, device, "pk@example.com")).status_code == 200
    refreshed = await api.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert refreshed.status_code == 200


async def test_a_limit_of_zero_or_less_means_no_limit(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    for limit in (0, -1):
        settings.email_daily_limit = limit
        for i in range(5):
            assert (await _request_link(api, f"l{limit}-{i}@example.com")).status_code == 202


async def test_the_cap_holds_under_concurrent_requests(
    api: httpx.AsyncClient, mails: list[SentMail]
) -> None:
    settings.email_daily_limit = 5
    results = await asyncio.gather(
        *[_request_link(api, f"c{i}@example.com") for i in range(15)]
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [202] * 5 + [503] * 10  # 同時でも、上限を超えない
    assert len(mails) == 5


# ── 日の区切り（UTC） ─────────────────────────────────────────


async def test_the_day_changes_at_utc_midnight(monkeypatch: pytest.MonkeyPatch) -> None:
    async with AsyncSession(engine) as session:
        for sent_at in (
            datetime(2026, 11, 23, 23, 59, 59, tzinfo=UTC),  # 前の日の最後
            datetime(2026, 11, 24, 0, 0, 0, tzinfo=UTC),  # 日が変わった瞬間
            datetime(2026, 11, 24, 8, 0, 0, tzinfo=UTC),
        ):
            session.add(
                EmailToken(
                    purpose="register",
                    email=f"{sent_at.hour}-{sent_at.minute}@example.com",
                    user_id=uuid4(),
                    token_hash="x" * 64,
                    expires_at=sent_at + timedelta(hours=1),
                    mail_sent_at=sent_at,
                )
            )
        await session.commit()

    async def count_at(moment: datetime) -> int:
        monkeypatch.setattr(service, "_now", lambda: moment)
        async with AsyncSession(engine) as session:
            return await service.count_general_mail_sent_today(session)

    assert await count_at(datetime(2026, 11, 23, 23, 59, 59, 500000, tzinfo=UTC)) == 1
    assert await count_at(datetime(2026, 11, 24, 0, 0, 0, tzinfo=UTC)) == 2  # 前の日の分は入らない
    assert await count_at(datetime(2026, 11, 24, 23, 59, 59, tzinfo=UTC)) == 2
    assert await count_at(datetime(2026, 11, 25, 0, 0, 0, tzinfo=UTC)) == 0  # また 0 から


async def test_tokens_from_before_the_upgrade_are_not_counted() -> None:
    """mail_sent_at が NULL の既存の行は、送ったものとして数えない。"""
    async with AsyncSession(engine) as session:
        session.add(
            EmailToken(
                purpose="register",
                email="old@example.com",
                user_id=uuid4(),
                token_hash="y" * 64,
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
        )
        await session.commit()
        assert await service.count_general_mail_sent_today(session) == 0


# ── 運用者への通知 ────────────────────────────────────────────


async def test_notices_at_80_and_100_percent_once_each_per_day(
    api: httpx.AsyncClient, mails: list[SentMail], ops_notices: OpsNotices
) -> None:
    settings.email_daily_limit = 10
    settings.ops_discord_webhook_url = SecretStr(WEBHOOK)

    for i in range(7):
        await _request_link(api, f"n{i}@example.com")
    assert ops_notices == []  # まだ 80% に達していない

    await _request_link(api, "n7@example.com")  # 8 通目 = 80%
    assert len(ops_notices) == 1
    assert re.fullmatch(
        r"FactorEye: 今日のメール送信が 8 / 10 通です（\d\d-\d\d \d\d:\d\d JST）", ops_notices[0]
    )

    await _request_link(api, "n8@example.com")  # 9 通目: 80% の通知は、もう送った
    assert len(ops_notices) == 1

    await _request_link(api, "n9@example.com")  # 10 通目 = 100%
    assert len(ops_notices) == 2
    assert "上限（10 / 10 通）に達しました" in ops_notices[1]
    assert re.search(r"\d\d-\d\d \d\d:\d\d JST", ops_notices[1])

    assert (await _request_link(api, "n10@example.com")).status_code == 503  # 超えた依頼
    assert len(ops_notices) == 2  # 100% の通知は、1 日 1 回
    assert sorted(m.kind for m in await _marks()) == ["email_limit", "email_warn"]


async def test_notice_is_sent_once_even_if_several_workers_race(
    api: httpx.AsyncClient, mails: list[SentMail], ops_notices: OpsNotices
) -> None:
    settings.email_daily_limit = 10
    settings.ops_discord_webhook_url = SecretStr(WEBHOOK)
    for i in range(8):
        await _request_link(api, f"w{i}@example.com")
    ops_notices.clear()
    async with AsyncSession(engine) as session:
        for mark in await _marks():
            await session.delete(mark)
        await session.commit()

    # 複数のワーカーの代わり
    await asyncio.gather(*[service.notify_email_usage() for _ in range(6)])

    assert len(ops_notices) == 1


async def test_a_new_day_notifies_again(
    api: httpx.AsyncClient, mails: list[SentMail], ops_notices: OpsNotices
) -> None:
    settings.email_daily_limit = 10
    settings.ops_discord_webhook_url = SecretStr(WEBHOOK)
    yesterday = (datetime.now(UTC) - timedelta(days=1)).date()
    async with AsyncSession(engine) as session:
        session.add(OpsNoticeMark(day=yesterday, kind="email_warn"))  # 昨日の印は、今日を止めない
        await session.commit()

    for i in range(8):
        await _request_link(api, f"d{i}@example.com")

    assert len(ops_notices) == 1


async def test_no_notice_when_the_webhook_url_is_empty(
    api: httpx.AsyncClient, mails: list[SentMail], ops_notices: OpsNotices
) -> None:
    settings.email_daily_limit = 10
    settings.ops_discord_webhook_url = SecretStr("")
    for i in range(10):
        assert (await _request_link(api, f"e{i}@example.com")).status_code == 202
    assert ops_notices == []
    assert await _marks() == []  # 印も付けない（URL を設定したあとに、通知できる）


async def test_a_failed_notice_does_not_stop_mail_and_is_retried_later(
    api: httpx.AsyncClient, mails: list[SentMail], ops_notices: OpsNotices
) -> None:
    settings.email_daily_limit = 10
    settings.ops_discord_webhook_url = SecretStr(WEBHOOK)
    ops_notices.ok = False

    for i in range(8):
        assert (await _request_link(api, f"f{i}@example.com")).status_code == 202
    assert len(mails) == 8  # メールは、通知が失敗しても送られる
    assert len(ops_notices) == 1  # 試みた
    assert await _marks() == []  # 失敗なので、印は戻る

    ops_notices.ok = True
    await _request_link(api, "f8@example.com")  # 次の依頼で、もう一度試す
    assert len(ops_notices) == 2
    assert len(await _marks()) == 1


async def test_admin_reset_is_not_in_the_notice_count(
    api: httpx.AsyncClient, mails: list[SentMail], ops_notices: OpsNotices
) -> None:
    settings.email_daily_limit = 10
    settings.ops_discord_webhook_url = SecretStr(WEBHOOK)
    await _signup(api, mails, FakeAuthenticator(), "own@example.com")
    headers = await _admin_headers(api)
    user_id = await _user_id("own@example.com")
    for _ in range(9):
        await api.post(f"/api/admin/users/{user_id}/reset", headers=headers, json={})
    await service.notify_email_usage()
    assert ops_notices == []  # 一般の送信は 1 通だけ。リセットは分母に入らない


# ── send_ops_discord ──────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def raise_for_status(self) -> None:
        if self.status >= 400:
            request = httpx.Request("POST", "https://discord.com/x")
            response = httpx.Response(self.status)
            raise httpx.HTTPStatusError("bad", request=request, response=response)


def _fake_client(status: int, calls: list[dict[str, Any]]) -> type:
    class FakeClient:
        def __init__(self, **_: object) -> None:
            pass

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def post(self, url: str, json: dict[str, Any]) -> _FakeResponse:
            calls.append({"url": url, "json": json})
            return _FakeResponse(status)

    return FakeClient


async def test_send_ops_discord_posts_the_message(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("app.notifications.httpx.AsyncClient", _fake_client(204, calls))
    assert await notifications.send_ops_discord(WEBHOOK, "本文") is True
    assert calls == [{"url": WEBHOOK, "json": {"content": "本文"}}]


async def test_send_ops_discord_failure_returns_false_without_leaking_the_url(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("app.notifications.httpx.AsyncClient", _fake_client(500, calls))
    assert await notifications.send_ops_discord(WEBHOOK, "本文") is False
    assert "dummy-token-for-tests" not in caplog.text  # URL（トークン）をログに出さない


async def test_send_ops_discord_rejects_internal_addresses_like_alarm_notices(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr("app.notifications.httpx.AsyncClient", _fake_client(204, calls))
    assert await notifications.send_ops_discord("http://127.0.0.1/hook", "本文") is False
    assert calls == []  # 検証で止まり、送っていない
