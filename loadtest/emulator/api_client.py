"""計測付きの HTTP クライアント。すべての通信をここ経由させて、件数・レイテンシを記録する。"""
import time

import httpx

from emulator.metrics import Metrics

# サーバー（uvicorn 既定 5 秒）より短くする
KEEPALIVE_EXPIRY_S = 3.0


class ApiClient:
    def __init__(
        self,
        base_url: str,
        metrics: Metrics,
        transport: httpx.AsyncBaseTransport | None = None,
        api_key: str | None = None,
    ) -> None:
        headers = {"X-API-Key": api_key} if api_key else {}
        # 使い回す接続の有効期限を、サーバー（uvicorn の keep-alive 既定 5 秒）より短くする。
        # サーバーが閉じた接続を再利用すると ReadError になるため
        limits = httpx.Limits(keepalive_expiry=KEEPALIVE_EXPIRY_S)
        self._http = httpx.AsyncClient(
            base_url=base_url, timeout=10.0, transport=transport, headers=headers, limits=limits
        )
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
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response | None:
        """応答を返す。通信自体が失敗した場合は None（エラーとして計測する）。"""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        headers.update(extra_headers or {})
        start = time.monotonic()
        try:
            response = await self._http.request(
                method, path, json=json, params=params, headers=headers
            )
        except httpx.HTTPError as exc:
            # 通信の失敗は、例外の種類（ReadTimeout・ConnectError など）で分けて数える
            self._metrics.record(
                name, None, time.monotonic() - start, transport_error=type(exc).__name__
            )
            return None
        self._metrics.record(name, response.status_code, time.monotonic() - start)
        return response

    async def close(self) -> None:
        await self._http.aclose()
