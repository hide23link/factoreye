"""メールの送信（Resend）と、登録・再登録のメールの文面。

送信は Resend の API（https://api.resend.com/emails）に、httpx で POST するだけ。
API キー（RESEND_API_KEY）が空なら、送らずに MailNotConfiguredError を出す
（API 側は 503 を返す）。キーはログ・エラー文に出さない。

【誰が使うか】passkey_service.py（メールの送信）、api/passkeys.py・api/admin.py（送信前の設定確認）。
文面は日本語と英語を併記する（承認済みのモックどおり）。
"""
import logging
from html import escape

import httpx

from app.config import settings

_logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"
# 送信の待ち時間（秒）。Resend が遅いときに、バックグラウンドの送信が溜まらないようにする
SEND_TIMEOUT_SECONDS = 10.0


class MailNotConfiguredError(Exception):
    """RESEND_API_KEY が未設定で、メールを送れない。"""


class MailSendError(Exception):
    """Resend がメールの受け付けを断った、または通信に失敗した。"""


def is_mail_configured() -> bool:
    """メールを送れる設定（API キー）があるか。"""
    return bool(settings.resend_api_key.get_secret_value())


async def send_mail(*, to: str, subject: str, text: str, html: str) -> None:
    """1 通送る。失敗したら MailSendError（理由はログに残し、API キーは出さない）。"""
    api_key = settings.resend_api_key.get_secret_value()
    if not api_key:
        raise MailNotConfiguredError("RESEND_API_KEY is not set")
    payload = {
        "from": settings.mail_from,
        "to": [to],
        "subject": subject,
        "text": text,
        "html": html,
    }
    try:
        async with httpx.AsyncClient(timeout=SEND_TIMEOUT_SECONDS) as client:
            response = await client.post(
                RESEND_API_URL, json=payload, headers={"Authorization": f"Bearer {api_key}"}
            )
    except httpx.HTTPError as exc:
        _logger.warning("mail send failed: %s", type(exc).__name__)
        raise MailSendError("could not reach the mail service") from exc
    if response.status_code >= 300:
        # 本文には、宛先などの情報が入ることがあるので、状態コードだけ記録する
        _logger.warning("mail send rejected: status=%s", response.status_code)
        raise MailSendError(f"mail service returned {response.status_code}")


def _button_html(link: str, label: str) -> str:
    """メール本文のボタン（リンク）。link は、こちらで作った URL だけを渡す。"""
    return (
        f'<p><a href="{escape(link)}" style="display:inline-block;background:#1f6fb2;color:#fff;'
        f'padding:10px 18px;border-radius:4px;text-decoration:none">{escape(label)}</a></p>'
    )


def build_register_mail(link: str) -> tuple[str, str, str]:
    """新規登録の確認メール。戻り値は（件名, テキスト, HTML）。リンクは 24 時間・1 回だけ有効。"""
    subject = "FactorEye の登録を完了してください"
    text = (
        "FactorEye へのご登録ありがとうございます。\n"
        "次のリンクを開くと、この端末にパスキーを登録して使い始められます。\n\n"
        f"{link}\n\n"
        "このリンクは 24 時間有効で、1 回だけ使えます。"
        "心当たりがないときは、このメールを無視してください。\n\n"
        "---\n"
        "Thanks for signing up for FactorEye. Open the link above to register a passkey "
        "on this device and get started. The link is valid for 24 hours and can be used once. "
        "If you didn't sign up, you can ignore this email.\n"
    )
    html = (
        "<p>FactorEye へのご登録ありがとうございます。<br>"
        "下のボタンを押すと、この端末にパスキーを登録して使い始められます。</p>"
        + _button_html(link, "登録を続ける")
        + f'<p style="font-size:12px;color:#5d7081;word-break:break-all">ボタンが開けないときは、'
        f"次の URL をブラウザに貼り付けてください。<br>{escape(link)}</p>"
        "<p>このリンクは 24 時間有効で、1 回だけ使えます。"
        "心当たりがないときは、このメールを無視してください。</p><hr>"
        '<p style="font-size:13px;color:#4a5b6b">Thanks for signing up for FactorEye. '
        "Use the button above to register a passkey on this device and get started. "
        "The link is valid for 24 hours and can be used once. "
        "If you didn't sign up, you can ignore this email.</p>"
    )
    return subject, text, html


def build_recover_mail(link: str) -> tuple[str, str, str]:
    """端末の再登録メール（失くしたとき・管理者のリセット）。リンクは 1 時間・1 回だけ有効。"""
    subject = "FactorEye の端末を登録し直してください"
    text = (
        "新しい端末にパスキーを登録するよう、依頼がありました。\n"
        "次のリンクを開いて、この端末を登録してください。\n\n"
        f"{link}\n\n"
        "このリンクは 1 時間有効で、1 回だけ使えます。"
        "心当たりがないときは、このメールを無視してください。今のログインは変わりません。\n\n"
        "---\n"
        "A request was made to register a new passkey for your FactorEye account. "
        "Open the link above to register this device. The link is valid for 1 hour and can be "
        "used once. If you didn't request it, ignore this email.\n"
    )
    html = (
        "<p>新しい端末にパスキーを登録するよう、依頼がありました。<br>"
        "下のボタンから、この端末を登録してください。</p>"
        + _button_html(link, "この端末を登録する")
        + f'<p style="font-size:12px;color:#5d7081;word-break:break-all">ボタンが開けないときは、'
        f"次の URL をブラウザに貼り付けてください。<br>{escape(link)}</p>"
        "<p>このリンクは 1 時間有効で、1 回だけ使えます。"
        "心当たりがないときは、このメールを無視してください。今のログインは変わりません。</p><hr>"
        '<p style="font-size:13px;color:#4a5b6b">A request was made to register a new passkey '
        "for your FactorEye account. The link is valid for 1 hour and can be used once. "
        "If you didn't request it, ignore this email.</p>"
    )
    return subject, text, html
