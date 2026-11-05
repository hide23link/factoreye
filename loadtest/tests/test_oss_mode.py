"""OSS 版（認証なし）モードのテスト。登録・ログインを送らず、取り込みに X-API-Key を付けることを確認する。"""
import asyncio
import json
import uuid

import httpx
import pytest

from emulator.runner import Runner
from emulator.scenario import Scenario

TARGET = "http://oss.invalid"
KEY = "test-ingest-key"


class OssServer:
    """認証なしの OSS 互換応答。認証系の呼び出しと、取り込みのヘッダーを記録する。"""

    def __init__(self) -> None:
        self.auth_calls = 0
        self.dashboard_calls = 0
        self.ingest_headers: list[str | None] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/api/auth/"):
            self.auth_calls += 1
            return httpx.Response(404, json={})
        if path == "/api/dashboards":
            self.dashboard_calls += 1
            return httpx.Response(201, json={})
        if path == "/api/sensors" and request.method == "POST":
            return httpx.Response(201, json={"id": str(uuid.uuid4())})
        if path == "/api/ingest/readings":
            self.ingest_headers.append(request.headers.get("X-API-Key"))
            return httpx.Response(202, json={"accepted": 1})
        return httpx.Response(200, json=[])


def _oss_scenario() -> Scenario:
    return Scenario(
        target_url=TARGET,
        users=2,
        sensors_per_user=2,
        send_interval_s=0.2,
        jitter_s=0.0,
        viewers_per_user=0,
        oss_mode=True,
        ingest_api_key=KEY,
    )


def test_oss_mode_skips_auth_and_sends_api_key() -> None:
    async def run() -> OssServer:
        server = OssServer()
        runner = Runner(transport=httpx.MockTransport(server.handler))
        await runner.start(_oss_scenario())
        await asyncio.sleep(1.0)
        await runner.stop()
        return server

    server = asyncio.run(run())
    assert server.auth_calls == 0
    assert server.dashboard_calls == 0
    assert server.ingest_headers, "取り込みが1回も送られていない"
    assert set(server.ingest_headers) == {KEY}


def test_oss_mode_requires_api_key() -> None:
    with pytest.raises(ValueError, match="ingest_api_key"):
        Scenario(target_url=TARGET, oss_mode=True).validate()


def test_api_key_is_not_exposed_in_status_dict() -> None:
    data = _oss_scenario().to_dict()
    assert "ingest_api_key" not in data
    assert data["oss_mode"] is True
    json.dumps(data)  # 画面・ステータスに出せる形であること
