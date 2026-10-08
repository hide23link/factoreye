"""Webhook 送信の上限（同時送信数・送信待ちの数）と、共有クライアントのテスト。

送信先は httpx.MockTransport で受け、実際の通信はしない。
"""

import asyncio
from collections.abc import AsyncGenerator, Callable

import httpx
import pytest
import pytest_asyncio

import app.webhooks as webhooks
from app.config import settings

URL = "https://hooks.example.com/abc"


@pytest.fixture(autouse=True)
def _public_target(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "webhook_allow_private_networks", False)
    monkeypatch.setattr(webhooks, "_addresses_for_host", lambda host: ["93.184.216.34"])


class _BlockingTarget:
    """リクエストを受けたまま、release されるまで応答しない送信先。"""

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.in_flight = 0
        self.max_in_flight = 0
        self.received = 0

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.received += 1
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        await self.gate.wait()
        self.in_flight -= 1
        return httpx.Response(200)


@pytest_asyncio.fixture
async def target() -> AsyncGenerator[_BlockingTarget, None]:
    t = _BlockingTarget()
    await webhooks.close_client()
    webhooks._client = httpx.AsyncClient(transport=httpx.MockTransport(t.handle))
    yield t
    t.gate.set()
    await webhooks.close_client()


async def _wait_until(condition: Callable[[], bool], timeout: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        assert asyncio.get_running_loop().time() < deadline, "timed out"
        await asyncio.sleep(0.01)


async def test_concurrent_sends_are_limited(target: _BlockingTarget) -> None:
    tasks = [asyncio.create_task(webhooks.send_webhook(URL, {"n": i})) for i in range(25)]
    await _wait_until(lambda: target.in_flight >= webhooks.MAX_CONCURRENT_SENDS)
    await asyncio.sleep(0.1)  # 上限を超えて送り始めないことを確かめる
    assert target.max_in_flight == webhooks.MAX_CONCURRENT_SENDS

    target.gate.set()
    await asyncio.gather(*tasks)
    assert target.received == 25


async def test_sends_over_backlog_are_dropped(
    target: _BlockingTarget, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(webhooks, "MAX_PENDING_SENDS", 12)
    tasks = [asyncio.create_task(webhooks.send_webhook(URL, {"n": i})) for i in range(20)]
    await _wait_until(lambda: target.in_flight >= webhooks.MAX_CONCURRENT_SENDS)

    target.gate.set()
    await asyncio.gather(*tasks)
    assert target.received == 12
    assert webhooks._pending_sends == 0


async def test_client_is_shared_and_recreated_after_close() -> None:
    await webhooks.close_client()
    first = webhooks._get_client()
    assert webhooks._get_client() is first
    assert first.follow_redirects is False

    await webhooks.close_client()
    assert first.is_closed
    second = webhooks._get_client()
    assert second is not first
    await webhooks.close_client()
