"""汎用Webhook通知（Phase 1: ノーコード連携用）。

app.notifications.send_alarm_discordはDiscord専用の固定フォーマットだが、こちらは
任意のURLへ素のJSONをPOSTするだけの汎用版。Zapier/Make/n8n等のノーコード自動化
サービスに繋ぐことを想定しており、利用者はコードを一切書かずに外部連携できる
（docs/factoreye-architecture.md §Webhook通知 参照）。

SSRF対策: 利用者が指定したURLへサーバー側から送信するため、内部ネットワーク
（ループバック・プライベートIP・メタデータ用アドレス等）を叩けないように検証する。
登録時（API）と送信時の両方で行う（送信時は、登録後にDNSの向きが変わる場合に備える）。
リダイレクトは追わない（httpxの既定どおり）。公開URLから内部へ転送されるのを防ぐため。
"""

import asyncio
import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class UnsafeWebhookUrl(ValueError):
    """Webhook送信先として許可できないURL（理由は例外メッセージに入る）。"""


def _addresses_for_host(host: str) -> list[str]:
    """ホスト名（またはIPリテラル）をIPアドレスの一覧に解決する。ブロッキング呼び出し。"""
    return [str(info[4][0]) for info in socket.getaddrinfo(host, None)]


def _is_public_address(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    # ::ffff:127.0.0.1 のようなIPv4射影アドレスは中身のIPv4で判定する
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    # is_global はループバック・プライベート・リンクローカル・共有アドレス(100.64/10)等を除外する
    return ip.is_global


def check_webhook_url(url: str) -> None:
    """送信先として安全か検証する。ブロッキング呼び出し（DNS解決を含む）。

    WEBHOOK_ALLOW_PRIVATE_NETWORKS=true のときは社内LANへの送信を許可する
    （自己ホストで社内の自動化基盤を使う場合の例外。httpも許可される）。
    """
    parsed = urlparse(url)
    host = parsed.hostname
    if not host:
        raise UnsafeWebhookUrl("URLにホスト名がありません")

    if settings.webhook_allow_private_networks:
        if parsed.scheme not in ("http", "https"):
            raise UnsafeWebhookUrl("http または https のURLを指定してください")
        return

    if parsed.scheme != "https":
        raise UnsafeWebhookUrl("https のURLを指定してください")

    try:
        addresses = _addresses_for_host(host)
    except socket.gaierror as exc:
        raise UnsafeWebhookUrl("ホスト名を解決できません") from exc

    if not addresses or not all(_is_public_address(a) for a in addresses):
        raise UnsafeWebhookUrl(
            "社内ネットワーク・ループバックなど公開されていない宛先は指定できません"
        )


async def assert_webhook_url_allowed(url: str) -> None:
    """check_webhook_url のasync版（DNS解決でイベントループを塞がないよう別スレッドで実行）。"""
    await asyncio.to_thread(check_webhook_url, url)


async def send_webhook(url: str, payload: dict[str, Any]) -> None:
    try:
        # 登録後に宛先が内部を指すよう変わった場合に備え、送信直前にも検証する
        await assert_webhook_url_allowed(url)
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
    except Exception:
        # 通知失敗でingest/flushパイプラインを落とさない（send_alarm_discordと同方針）
        logger.exception("failed to send webhook to %s", url)
