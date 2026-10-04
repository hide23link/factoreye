"""Webhook送信先のSSRF対策（app.webhooks.check_webhook_url）のテスト。

DNS解決は _addresses_for_host をモックし、宛先IPごとの判定を検証する。
登録API（422）と送信時（httpxを呼ばない）の両方を確かめる。
"""

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.config import settings
from app.webhooks import UnsafeWebhookUrl, check_webhook_url, send_webhook


def _resolve_to(monkeypatch: pytest.MonkeyPatch, addresses: list[str]) -> None:
    monkeypatch.setattr("app.webhooks._addresses_for_host", lambda host: addresses)


@pytest.fixture
def private_networks_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "webhook_allow_private_networks", False)


# ──────────────────────────────────────────────────────────────
# 既定（社内ネットワーク禁止）
# ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",  # ループバック
        "10.0.0.5",  # プライベート
        "172.16.0.1",
        "192.168.1.10",
        "169.254.169.254",  # クラウドのメタデータ用アドレス
        "100.64.0.1",  # 共有アドレス空間（CGNAT / Tailscale等）
        "0.0.0.0",
        "::1",
        "fe80::1",  # リンクローカル
        "fc00::1",  # ユニークローカル
        "::ffff:127.0.0.1",  # IPv4射影アドレスで内部を指す
        "::ffff:10.0.0.5",
    ],
)
def test_internal_address_is_rejected(
    monkeypatch: pytest.MonkeyPatch, private_networks_off: None, address: str
) -> None:
    _resolve_to(monkeypatch, [address])
    with pytest.raises(UnsafeWebhookUrl):
        check_webhook_url("https://example.com/hook")


def test_public_https_is_allowed(
    monkeypatch: pytest.MonkeyPatch, private_networks_off: None
) -> None:
    _resolve_to(monkeypatch, ["93.184.216.34"])
    check_webhook_url("https://hooks.example.com/abc")  # 例外なし


def test_hostname_resolving_to_mixed_addresses_is_rejected(
    monkeypatch: pytest.MonkeyPatch, private_networks_off: None
) -> None:
    # 1つでも内部を含めば拒否（別のアドレスが選ばれて内部に届くのを防ぐ）
    _resolve_to(monkeypatch, ["93.184.216.34", "10.0.0.5"])
    with pytest.raises(UnsafeWebhookUrl):
        check_webhook_url("https://example.com/hook")


def test_http_is_rejected_by_default(
    monkeypatch: pytest.MonkeyPatch, private_networks_off: None
) -> None:
    _resolve_to(monkeypatch, ["93.184.216.34"])
    with pytest.raises(UnsafeWebhookUrl):
        check_webhook_url("http://hooks.example.com/abc")


def test_unresolvable_host_is_rejected(
    monkeypatch: pytest.MonkeyPatch, private_networks_off: None
) -> None:
    import socket

    def _fail(host: str) -> list[str]:
        raise socket.gaierror("no such host")

    monkeypatch.setattr("app.webhooks._addresses_for_host", _fail)
    with pytest.raises(UnsafeWebhookUrl):
        check_webhook_url("https://no-such-host.invalid/hook")


def test_url_without_host_is_rejected(private_networks_off: None) -> None:
    with pytest.raises(UnsafeWebhookUrl):
        check_webhook_url("https:///hook")


# ──────────────────────────────────────────────────────────────
# 例外スイッチ（WEBHOOK_ALLOW_PRIVATE_NETWORKS=true: 自己ホストの社内LAN向け）
# ──────────────────────────────────────────────────────────────


def test_private_address_and_http_allowed_when_switch_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "webhook_allow_private_networks", True)
    _resolve_to(monkeypatch, ["192.168.1.10"])
    check_webhook_url("http://n8n.lan/webhook")  # 例外なし


def test_non_http_scheme_is_rejected_even_when_switch_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "webhook_allow_private_networks", True)
    _resolve_to(monkeypatch, ["192.168.1.10"])
    with pytest.raises(UnsafeWebhookUrl):
        check_webhook_url("ftp://n8n.lan/webhook")


# ──────────────────────────────────────────────────────────────
# 送信時の再検証（登録後にDNSが内部を指すよう変わった場合）
# ──────────────────────────────────────────────────────────────


async def test_send_webhook_does_not_post_to_internal_target(
    monkeypatch: pytest.MonkeyPatch, private_networks_off: None
) -> None:
    _resolve_to(monkeypatch, ["127.0.0.1"])
    with patch("app.webhooks.httpx.AsyncClient") as client_cls:
        await send_webhook("https://rebound.example.com/hook", {"event": "x"})
    client_cls.assert_not_called()


async def test_send_webhook_posts_to_public_target(
    monkeypatch: pytest.MonkeyPatch, private_networks_off: None
) -> None:
    _resolve_to(monkeypatch, ["93.184.216.34"])
    post = AsyncMock(return_value=httpx.Response(200, request=httpx.Request("POST", "https://x")))
    with patch("app.webhooks.httpx.AsyncClient") as client_cls:
        client_cls.return_value.__aenter__.return_value.post = post
        await send_webhook("https://hooks.example.com/abc", {"event": "x"})
    post.assert_awaited_once()


# ──────────────────────────────────────────────────────────────
# 登録API（422で理由を返す）
# ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "https://internal.example.com/hook",  # 解決先は下のモックで内部IP
        "http://hooks.example.com/abc",  # https以外
    ],
)
async def test_create_rejects_unsafe_url(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, private_networks_off: None, url: str
) -> None:
    _resolve_to(monkeypatch, ["10.0.0.5"])
    resp = await client.post(
        "/api/settings/webhooks", json={"eventType": "reading.received", "url": url}
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]
    listed = await client.get("/api/settings/webhooks")
    assert listed.json() == []


async def test_update_rejects_unsafe_url_and_keeps_previous(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, private_networks_off: None
) -> None:
    _resolve_to(monkeypatch, ["93.184.216.34"])
    created = await client.post(
        "/api/settings/webhooks",
        json={"eventType": "alarm.triggered", "url": "https://hooks.example.com/ok"},
    )
    assert created.status_code == 201
    webhook_id = created.json()["id"]

    _resolve_to(monkeypatch, ["169.254.169.254"])
    resp = await client.put(
        f"/api/settings/webhooks/{webhook_id}", json={"url": "https://metadata.example.com/"}
    )
    assert resp.status_code == 422

    listed = await client.get("/api/settings/webhooks")
    assert listed.json()[0]["url"] == "https://hooks.example.com/ok"
