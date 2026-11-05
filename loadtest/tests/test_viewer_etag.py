"""閲覧のセンサー一覧が、前の版（ETag）を送り、304 を正しく扱うことのテスト。"""
import asyncio

import httpx

from emulator.api_client import ApiClient
from emulator.metrics import Metrics
from emulator.scenario import Scenario
from emulator.vuser import VirtualUser


class FakeSource:
    def __init__(self) -> None:
        self.scenario = Scenario(target_url="http://oss.invalid", oss_mode=True, ingest_api_key="k")


class SensorsServer:
    """一覧の版（ETag）を持つ。送られた If-None-Match が一致すれば 304 を返す。"""

    def __init__(self) -> None:
        self.seen_if_none_match: list[str | None] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path != "/api/sensors":
            return httpx.Response(200, json=[])
        etag = '"v1"'
        self.seen_if_none_match.append(request.headers.get("if-none-match"))
        if request.headers.get("if-none-match") == etag:
            return httpx.Response(304, headers={"ETag": etag})
        return httpx.Response(200, json=[], headers={"ETag": etag})


def test_second_view_sends_the_etag_and_counts_304_as_success() -> None:
    async def run() -> tuple[SensorsServer, dict[str, object]]:
        server = SensorsServer()
        metrics = Metrics()
        client = ApiClient(
            "http://oss.invalid", metrics, transport=httpx.MockTransport(server.handler)
        )
        vu = VirtualUser(0, "abc123", FakeSource(), client, seed=1)  # type: ignore[arg-type]
        await vu._view_sensors()
        await vu._view_sensors()
        await client.close()
        return server, metrics.snapshot()

    server, snap = asyncio.run(run())
    assert server.seen_if_none_match == [None, '"v1"']
    assert snap["errors"] == 0  # 304 はエラーに数えない
    assert snap["endpoints"]["view_sensors"]["count"] == 2  # type: ignore[index]
