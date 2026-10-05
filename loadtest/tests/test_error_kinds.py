"""エラーの種類ごとの内訳のテスト（タイムアウト・接続切れ・HTTP のステータスを分けて数える）。"""
import asyncio

import httpx

from emulator.api_client import ApiClient
from emulator.metrics import Metrics


def test_error_kinds_split_http_status_and_transport_failures() -> None:
    m = Metrics()
    m.record("ingest", 202, 0.01)
    m.record("ingest", 429, 0.01)
    m.record("ingest", 500, 0.01)
    m.record("ingest", None, 0.01, transport_error="ReadTimeout")
    m.record("ingest", None, 0.01, transport_error="ReadTimeout")
    m.record("ingest", None, 0.01)  # 種類が不明な通信の失敗
    snap = m.snapshot()
    assert snap["errorKinds"] == {"http_429": 1, "http_500": 1, "ReadTimeout": 2, "TransportError": 1}
    ep = snap["endpoints"]["ingest"]  # type: ignore[index]
    assert ep["errorKinds"] == snap["errorKinds"]
    assert ep["errors"] == 5


def test_api_client_records_the_exception_name_on_transport_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async def run() -> dict[str, object]:
        m = Metrics()
        client = ApiClient("http://oss.invalid", m, transport=httpx.MockTransport(handler))
        assert await client.call("ingest", "POST", "/api/ingest/readings", json={}) is None
        await client.close()
        return m.snapshot()

    snap = asyncio.run(run())
    assert snap["errorKinds"] == {"ConnectError": 1}  # type: ignore[index]
