"""計測付きの HTTP クライアント。すべての通信をここ経由させて、件数・レイテンシを記録する。"""
import time

import httpx

from emulator.metrics import Metrics


class ApiClient:
    def __init__(
        self,
        base_url: str,
        metrics: Metrics,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(base_url=base_url, timeout=10.0, transport=transport)
        self._metrics = metrics

    async def call(
        self,
        name: str,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, str] | None = None,
        token: str | None = None,
    ) -> httpx.Response | None:
        """応答を返す。通信自体が失敗した場合は None（エラーとして計測する）。"""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        start = time.monotonic()
        try:
            response = await self._http.request(
                method, path, json=json, params=params, headers=headers
            )
        except httpx.HTTPError:
            self._metrics.record(name, None, time.monotonic() - start)
            return None
        self._metrics.record(name, response.status_code, time.monotonic() - start)
        return response

    async def close(self) -> None:
        await self._http.aclose()
